import { createHash } from "node:crypto";
import { getConfig } from "../config.js";
import { query } from "../db/pool.js";
import { acquireLock, releaseLock } from "../redis.js";
import { logger } from "../logger.js";
import { recordAudit } from "./audit.js";
import { AppError, errors } from "../errors.js";

/**
 * Zoho Sheet synchronization — production-grade, incremental (Phases 2-7).
 *
 * DEJOIY AUTH DATABASE is the authoritative identity source. The sheet is a
 * controlled operational data layer. NEVER synced: passwords, hashes, MFA /
 * recovery secrets, session tokens, API keys — these are not even columns.
 *
 * Sync model:
 *   - Incremental UPSERT by stable identifier (User ID / DJY-…). Existing rows
 *     are UPDATEd, new users are INSERTed, soft-deleted users follow the
 *     configured deletion policy (mark | keep | delete-row). Never a
 *     DELETE-ALL → INSERT-ALL. Unrelated sheet data is never touched.
 *   - Per-field direction from `sync_field_mappings`
 *     (never | db_to_sheet | sheet_to_db | bidirectional).
 *   - Optimistic conflict detection on pull using per-record metadata
 *     (sheet_sync_records.sheet_baseline + version). Both sides changed since
 *     last sync → conflict row for admin resolution; DB-only change → DB wins;
 *     sheet-only change → applied when valid.
 *   - Rate-limit safety: min spacing between API calls, Retry-After handling,
 *     exponential backoff, batch reads/writes, failed batches counted and
 *     surfaced (never silent).
 *
 * API: Zoho Sheet Data API v2
 *      Base URL: https://sheet.zoho.in/api/v2/{SHEET_TOKEN}
 *      Auth:     Authorization: Zoho-oauthtoken {access_token}
 */

export const SHEET_COLUMNS = [
  "User ID",
  "Employee ID",
  "Full Name",
  "Email",
  "Phone",
  "Department",
  "Designation",
  "Role",
  "Manager",
  "Location",
  "Employment Type",
  "Joining Date",
  "Status",
  "Last Login",
  "MFA Enabled",
  "Account Risk",
  "Created At",
  "Updated At",
  "Sync Status",
  "Sync Version"
] as const;

export const SYNC_FIELDS = [...SHEET_COLUMNS];

// ── Field direction helpers (pure, exported for tests) ─────────────────────

export type FieldDirection = "never" | "db_to_sheet" | "sheet_to_db" | "bidirectional";

export const FIELD_DIRECTIONS: FieldDirection[] = [
  "never", "db_to_sheet", "sheet_to_db", "bidirectional"
];

export function normalizeDirection(value: string): FieldDirection {
  return FIELD_DIRECTIONS.includes(value as FieldDirection)
    ? (value as FieldDirection)
    : "db_to_sheet";
}

export function pushEnabled(direction: FieldDirection): boolean {
  return direction === "db_to_sheet" || direction === "bidirectional";
}

export function pullEnabled(direction: FieldDirection): boolean {
  return direction === "sheet_to_db" || direction === "bidirectional";
}

/** Stable hash over a record's entries (sorted) — push change detection. */
export function computeRecordHash(values: Record<string, string>): string {
  const entries = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Extract only the given columns from a raw sheet record. */
export function sheetRecordValues(
  record: Record<string, unknown>,
  columns: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of columns) {
    const value = record[column];
    out[column] = value === undefined || value === null ? "" : String(value);
  }
  return out;
}

export type FieldChange = "noop" | "apply" | "db_wins" | "conflict";

/**
 * Classify a field-level change for pull (optimistic versioning).
 *  - dbValue === sheetValue           → noop
 *  - dbValue === lastKnownSheetValue  → only the sheet changed → apply
 *  - sheetValue === lastKnownSheetValue → only the DB changed → db_wins
 *  - otherwise                        → both changed → conflict
 */
export function classifyFieldChange(input: {
  dbValue: string;
  sheetValue: string;
  lastKnownSheetValue: string;
}): FieldChange {
  const { dbValue, sheetValue, lastKnownSheetValue } = input;
  if (dbValue === sheetValue) return "noop";
  if (dbValue === lastKnownSheetValue) return "apply";
  if (sheetValue === lastKnownSheetValue) return "db_wins";
  return "conflict";
}

// ── Zoho API helpers ──────────────────────────────────────────────────────

interface SheetRecord {
  row_index?: number;
  [key: string]: unknown;
}

interface ZohoLimiter {
  throttle(): Promise<void>;
  noteBackoff(ms: number): void;
  state(): { lastCallAt: string | null; backoffMs: number };
}

function makeLimiter(): ZohoLimiter {
  let lastCallAt = 0;
  let backoffMs = 0;
  return {
    async throttle() {
      const cfg = getConfig();
      const wait = Math.max(backoffMs, cfg.ZOHO_API_MIN_INTERVAL_MS);
      const since = Date.now() - lastCallAt;
      if (since < wait) await sleep(wait - since);
      lastCallAt = Date.now();
    },
    noteBackoff(ms) {
      backoffMs = ms;
    },
    state() {
      return {
        lastCallAt: lastCallAt ? new Date(lastCallAt).toISOString() : null,
        backoffMs
      };
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** Extract the sheet resource_id from the ZOHO_SHEET_URL. */
function extractSheetToken(url: string): string | null {
  if (!url) return null;
  // https://sheet.zoho.in/sheet/open/t9x1641aa...8d6?sheetid=0&range=A1
  const match = url.match(/\/open\/([a-zA-Z0-9]+)/);
  return match?.[1] ?? null;
}

/** Get a fresh Zoho access token via refresh_token (server-side only). */
export async function getZohoAccessToken(): Promise<string | null> {
  const cfg = getConfig();
  if (!cfg.ZOHO_CLIENT_ID || !cfg.ZOHO_CLIENT_SECRET || !cfg.ZOHO_REFRESH_TOKEN)
    return null;
  try {
    const res = await fetch("https://accounts.zoho.in/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cfg.ZOHO_CLIENT_ID,
        client_secret: cfg.ZOHO_CLIENT_SECRET,
        refresh_token: cfg.ZOHO_REFRESH_TOKEN
      })
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Zoho token refresh failed");
      return null;
    }
    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch (err) {
    logger.warn({ err }, "Zoho token refresh error");
    return null;
  }
}

/**
 * Call Zoho Sheet Data API v2 with rate-limit safety: min spacing between
 * calls, Retry-After handling, exponential backoff with retries.
 */
async function zohoApi(
  accessToken: string,
  sheetToken: string,
  method: string,
  params: Record<string, string> = {},
  limiter: ZohoLimiter,
  attempt = 1
): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  await limiter.throttle();

  const body = new URLSearchParams({ method, ...params });
  const res = await fetch(`https://sheet.zoho.in/api/v2/${sheetToken}`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (res.status === 429 || res.status >= 500) {
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    if (attempt <= cfg.ZOHO_SYNC_MAX_RETRIES) {
      const backoff = retryAfterMs ?? cfg.ZOHO_SYNC_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      limiter.noteBackoff(backoff);
      logger.warn({ method, status: res.status, attempt, backoff }, "Zoho API throttled — backing off");
      await sleep(backoff);
      return zohoApi(accessToken, sheetToken, method, params, limiter, attempt + 1);
    }
  }

  if (!res.ok) {
    throw new Error(`Zoho API HTTP ${res.status} (${method})`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (data.status === "failure" || data.error_code) {
    throw new Error(
      `Zoho API error (${method}): ${data.error_message ?? JSON.stringify(data)}`
    );
  }
  limiter.noteBackoff(0);
  return data;
}

/** Resolve the target worksheet id: configured name, else first worksheet. */
async function resolveWorksheetId(
  accessToken: string,
  sheetToken: string,
  limiter: ZohoLimiter
): Promise<string> {
  const cfg = getConfig();
  if (cfg.ZOHO_SHEET_WORKSHEET) {
    try {
      const data = await zohoApi(accessToken, sheetToken, "worksheet.list", {}, limiter);
      const worksheets = (data.worksheets as { worksheet_id?: string; worksheet_name?: string }[]) ?? [];
      const found = worksheets.find((w) => w.worksheet_name === cfg.ZOHO_SHEET_WORKSHEET);
      if (found?.worksheet_id) return found.worksheet_id;
      logger.warn(
        { name: cfg.ZOHO_SHEET_WORKSHEET },
        "configured Zoho worksheet not found — falling back to first worksheet"
      );
    } catch (err) {
      logger.warn({ err }, "worksheet.list failed — falling back to first worksheet");
    }
  }
  return "0#";
}

function deriveHeaders(records: SheetRecord[]): string[] {
  if (records.length === 0) return [];
  return Object.keys(records[0]!).filter((k) => k !== "row_index");
}

async function expandHeaders(
  accessToken: string,
  sheetToken: string,
  worksheetId: string,
  currentColumnCount: number,
  missing: string[],
  limiter: ZohoLimiter
): Promise<void> {
  for (let i = 0; i < missing.length; i++) {
    await zohoApi(accessToken, sheetToken, "cell.content.set", {
      worksheet_id: worksheetId,
      row: "1",
      column: String(currentColumnCount + i + 1),
      content: missing[i] ?? ""
    }, limiter);
  }
  logger.info({ added: missing.length }, "Zoho sheet headers expanded");
}

// ── Field mappings / settings ─────────────────────────────────────────────

async function getFieldMappings(): Promise<Record<string, FieldDirection>> {
  const { rows } = await query<{ field: string; direction: string }>(
    `SELECT field, direction FROM sync_field_mappings`
  );
  const map: Record<string, FieldDirection> = {};
  for (const row of rows) map[row.field] = normalizeDirection(row.direction);
  return map;
}

interface SyncSettings {
  mode: "scheduled" | "near-real-time";
  deletionPolicy: "mark" | "keep" | "delete";
  pollIntervalSeconds: number;
}

/** Effective settings: DB overrides (admin-configurable) fall back to env. */
export async function getSyncSettings(): Promise<SyncSettings> {
  const cfg = getConfig();
  const { rows } = await query<{ key: string; value: Record<string, unknown> }>(
    `SELECT key, value FROM system_settings
      WHERE key IN ('zoho.sync.mode','zoho.sync.deletion_policy','zoho.poll_interval_seconds')`
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    mode:
      (map.get("zoho.sync.mode")?.mode as SyncSettings["mode"] | undefined) ??
      cfg.ZOHO_SYNC_MODE,
    deletionPolicy:
      (map.get("zoho.sync.deletion_policy")?.deletionPolicy as SyncSettings["deletionPolicy"] | undefined) ??
      cfg.ZOHO_SYNC_DELETION_POLICY,
    pollIntervalSeconds:
      (map.get("zoho.poll_interval_seconds")?.pollIntervalSeconds as number | undefined) ??
      cfg.ZOHO_POLL_INTERVAL_SECONDS
  };
}

// ── Database reads ─────────────────────────────────────────────────────────

interface SyncRow {
  user_id: string;
  employee_id: string | null;
  user_number: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  roles: string[];
  department: string | null;
  designation: string | null;
  employment_status: string | null;
  hire_date: Date | null;
  account_state: string;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
  mfa_enabled: boolean;
  failed_login_count: number;
  manager: string | null;
  deleted_at: Date | null;
  metadata: Record<string, unknown>;
  version: number | null;
}

async function readSyncRows(): Promise<SyncRow[]> {
  const { rows } = await query(
    `SELECT
       u.id AS user_id,
       ep.employee_id,
       u.user_number,
       p.full_name,
       u.email,
       u.phone,
       COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
       d.name AS department,
       ep.designation,
       ep.employment_status,
       ep.hire_date,
       u.account_state,
       u.created_at,
       u.updated_at,
       u.last_login_at,
       u.mfa_enabled,
       u.failed_login_count,
       m.email AS manager,
       u.deleted_at,
       u.metadata,
       sr.version
     FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     LEFT JOIN employee_profiles ep ON ep.user_id = u.id
     LEFT JOIN departments d ON d.id = ep.department_id
     LEFT JOIN users m ON m.id = ep.manager_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     LEFT JOIN sheet_sync_records sr ON sr.user_id = u.id
     GROUP BY u.id, p.full_name, d.name, m.email, ep.employee_id, ep.designation,
              ep.employment_status, ep.hire_date, sr.version
     ORDER BY u.created_at`,
    []
  );
  return rows.map((r) => ({
    user_id: r.user_id,
    employee_id: r.employee_id,
    user_number: r.user_number,
    full_name: r.full_name,
    email: r.email,
    phone: r.phone,
    roles: r.roles ?? [],
    department: r.department,
    designation: r.designation,
    employment_status: r.employment_status,
    hire_date: r.hire_date,
    account_state: r.account_state,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_login_at: r.last_login_at,
    mfa_enabled: r.mfa_enabled,
    failed_login_count: r.failed_login_count,
    manager: r.manager,
    deleted_at: r.deleted_at,
    metadata: r.metadata ?? {},
    version: r.version ?? 0
  }));
}

type PullUser = Pick<
  SyncRow,
  "user_id" | "user_number" | "full_name" | "phone" | "account_state" |
  "department" | "designation" | "employment_status" | "roles" | "manager"
>;

async function readUserMap(): Promise<Map<string, PullUser>> {
  const rows = await readSyncRows();
  const map = new Map<string, PullUser>();
  for (const row of rows) {
    if (row.deleted_at) continue; // never pull changes onto soft-deleted users
    map.set(row.user_number, {
      user_id: row.user_id,
      user_number: row.user_number,
      full_name: row.full_name,
      phone: row.phone,
      account_state: row.account_state,
      department: row.department,
      designation: row.designation,
      employment_status: row.employment_status,
      roles: row.roles,
      manager: row.manager
    });
  }
  return map;
}

async function readSyncMetaMap(): Promise<Map<string, { version: number; sheet_baseline: Record<string, string> }>> {
  const { rows } = await query<{ user_number: string; version: number; sheet_baseline: unknown }>(
    `SELECT user_number, version, sheet_baseline FROM sheet_sync_records`
  );
  const map = new Map<string, { version: number; sheet_baseline: Record<string, string> }>();
  for (const row of rows) {
    map.set(row.user_number, {
      version: row.version ?? 0,
      sheet_baseline: (row.sheet_baseline as Record<string, string> | null) ?? {}
    });
  }
  return map;
}

// ── Record building ─────────────────────────────────────────────────────────

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

function fmtDateTime(d: Date | null): string {
  return d ? d.toISOString().slice(0, 19).replace("T", " ") : "";
}

function accountRisk(row: SyncRow): string {
  if (["TERMINATED", "BLOCKED", "LOCKED"].includes(row.account_state)) return "HIGH";
  if (["SUSPENDED", "DISABLED", "PASSWORD_RESET_REQUIRED"].includes(row.account_state)) return "MEDIUM";
  if (row.failed_login_count >= 3) return "MEDIUM";
  return "LOW";
}

/** Convert a DB row to a sheet record, respecting field directions. */
function toRecord(
  row: SyncRow,
  now: Date,
  mappings: Record<string, FieldDirection>,
  syncVersion: string,
  removed: boolean
): Record<string, string> {
  const out: Record<string, string> = {};
  const push = (field: string, value: string) => {
    if (pushEnabled(mappings[field] ?? "db_to_sheet")) out[field] = value;
  };

  push("User ID", row.user_number);
  push("Employee ID", row.employee_id ?? "");
  push("Full Name", row.full_name ?? "");
  push("Email", row.email ?? "");
  push("Phone", row.phone ?? "");
  push("Department", row.department ?? "");
  push("Designation", row.designation ?? "");
  push("Role", row.roles.join(", "));
  push("Manager", row.manager ?? "");
  push("Location", ""); // no DB column today — informational
  push("Employment Type", row.employment_status ?? "");
  push("Joining Date", fmtDate(row.hire_date));
  push("Status", removed ? "TERMINATED" : row.account_state);
  push("Last Login", fmtDateTime(row.last_login_at));
  push("MFA Enabled", row.mfa_enabled ? "YES" : "NO");
  push("Account Risk", accountRisk(row));
  push("Created At", fmtDateTime(row.created_at));
  push("Updated At", fmtDateTime(row.updated_at));
  push("Sync Status", removed ? "removed" : "synced");
  push("Sync Version", syncVersion);
  void now;
  return out;
}

// ── Push (DB → Sheet): incremental upsert ──────────────────────────────────

interface MetaEntry {
  userId: string;
  userNumber: string;
  version: number;
  hash: string;
  status: string;
  baseline?: Record<string, string>;
}

interface PushResult {
  rowsAdded: number;
  rowsUpdated: number;
  rowsDeleted: number;
  failedRecords: number;
}

interface PendingOp {
  type: "add" | "update" | "delete";
  rowIndex?: number;
  values?: Record<string, string>;
  meta?: MetaEntry;
}

async function flushOps(
  accessToken: string,
  sheetToken: string,
  worksheetId: string,
  ops: PendingOp[],
  limiter: ZohoLimiter
): Promise<{ successMeta: MetaEntry[]; failed: number }> {
  const successMeta: MetaEntry[] = [];
  let failed = 0;
  const batchSize = getConfig().ZOHO_SYNC_BATCH_SIZE;

  for (let i = 0; i < ops.length; i += batchSize) {
    const batch = ops.slice(i, i + batchSize);
    const type = batch[0]!.type;
    try {
      if (type === "add") {
        await zohoApi(accessToken, sheetToken, "worksheet.records.add", {
          worksheet_id: worksheetId,
          json_data: JSON.stringify(batch.map((o) => o.values))
        }, limiter);
      } else if (type === "update") {
        await zohoApi(accessToken, sheetToken, "worksheet.records.update", {
          worksheet_id: worksheetId,
          row_array: JSON.stringify(batch.map((o) => o.rowIndex)),
          json_data: JSON.stringify(batch.map((o) => o.values))
        }, limiter);
      } else {
        await zohoApi(accessToken, sheetToken, "worksheet.records.delete", {
          worksheet_id: worksheetId,
          row_array: JSON.stringify(batch.map((o) => o.rowIndex))
        }, limiter);
      }
      for (const op of batch) if (op.meta) successMeta.push(op.meta);
    } catch (err) {
      failed += batch.length;
      logger.error({ err, type, batchIndex: i / batchSize }, "Zoho batch failed");
    }
  }
  return { successMeta, failed };
}

async function upsertPushMeta(meta: MetaEntry[]): Promise<void> {
  if (meta.length === 0) return;
  const userIds = meta.map((m) => m.userId);
  const numbers = meta.map((m) => m.userNumber);
  const versions = meta.map((m) => m.version);
  const hashes = meta.map((m) => m.hash);
  const statuses = meta.map((m) => m.status);
  const now = new Date().toISOString();
  const timestamps = meta.map(() => now);
  await query(
    `INSERT INTO sheet_sync_records (user_id, user_number, version, last_synced_at, sync_status, record_hash)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::int[], $4::timestamptz[], $5::text[], $6::text[])
     ON CONFLICT (user_number) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       version = EXCLUDED.version,
       last_synced_at = EXCLUDED.last_synced_at,
       sync_status = EXCLUDED.sync_status,
       record_hash = EXCLUDED.record_hash,
       updated_at = now()`,
    [userIds, numbers, versions, timestamps, statuses, hashes]
  );
}

async function syncDbToSheet(
  accessToken: string,
  sheetToken: string,
  worksheetId: string,
  limiter: ZohoLimiter
): Promise<PushResult> {
  const mappings = await getFieldMappings();
  const settings = await getSyncSettings();
  const pushColumns = SHEET_COLUMNS.filter((c) => pushEnabled(mappings[c] ?? "db_to_sheet"));

  // Bulk read existing sheet rows (never cleared).
  const data = await zohoApi(accessToken, sheetToken, "worksheet.records.fetch", {
    worksheet_id: worksheetId
  }, limiter);
  const records = (data.records as SheetRecord[]) ?? [];

  // Expand headers for any columns not present (one-time; never touches extras).
  const currentHeaders = deriveHeaders(records);
  const missing = SHEET_COLUMNS.filter((c) => !currentHeaders.includes(c));
  if (missing.length > 0) {
    await expandHeaders(accessToken, sheetToken, worksheetId, currentHeaders.length, missing, limiter);
  }

  // Index existing rows by stable User ID → row_index + value hash.
  const sheetMap = new Map<string, { rowIndex: number; hash: string }>();
  for (const rec of records) {
    const uid = String(rec["User ID"] ?? "").trim();
    if (!uid) continue;
    const values = sheetRecordValues(rec, pushColumns);
    sheetMap.set(uid, {
      rowIndex: typeof rec.row_index === "number" ? rec.row_index : 0,
      hash: computeRecordHash(values)
    });
  }

  const dbRows = await readSyncRows();
  const now = new Date();
  const ops: PendingOp[] = [];

  for (const row of dbRows) {
    const existing = sheetMap.get(row.user_number);

    if (row.deleted_at) {
      if (!existing) continue; // never introduce removed users
      if (settings.deletionPolicy === "delete") {
        ops.push({
          type: "delete",
          rowIndex: existing.rowIndex,
          meta: { userId: row.user_id, userNumber: row.user_number, version: (row.version ?? 0) + 1, hash: "", status: "removed" }
        });
        continue;
      }
      if (settings.deletionPolicy === "keep") {
        ops.push({
          type: "update",
          rowIndex: existing.rowIndex,
          values: toRecord(row, now, mappings, String(row.version ?? 0), true),
          meta: { userId: row.user_id, userNumber: row.user_number, version: row.version ?? 0, hash: existing.hash, status: "removed" }
        });
        continue;
      }
      // policy "mark": fall through — Status=TERMINATED, Sync Status=removed
    }

    const isNew = !existing;
    const newVersion = isNew ? 1 : (row.version ?? 0) + 1;
    const record = toRecord(row, now, mappings, String(newVersion), Boolean(row.deleted_at));

    if (existing) {
      const newHash = computeRecordHash(record);
      if (newHash !== existing.hash) {
        ops.push({
          type: "update",
          rowIndex: existing.rowIndex,
          values: record,
          meta: { userId: row.user_id, userNumber: row.user_number, version: newVersion, hash: newHash, status: "synced" }
        });
      } else {
        ops.push({
          type: "update",
          rowIndex: existing.rowIndex,
          values: record,
          meta: { userId: row.user_id, userNumber: row.user_number, version: row.version ?? 0, hash: existing.hash, status: "synced" }
        });
      }
    } else {
      ops.push({
        type: "add",
        values: record,
        meta: { userId: row.user_id, userNumber: row.user_number, version: 1, hash: computeRecordHash(record), status: "synced" }
      });
    }
  }

  const { successMeta, failed } = await flushOps(accessToken, sheetToken, worksheetId, ops, limiter);
  await upsertPushMeta(successMeta);

  const counts = { rowsAdded: 0, rowsUpdated: 0, rowsDeleted: 0, failedRecords: failed };
  for (const op of ops) {
    if (op.type === "add") counts.rowsAdded++;
    else if (op.type === "update") counts.rowsUpdated++;
    else counts.rowsDeleted++;
  }

  logger.info({ ...counts }, "Zoho DB→Sheet incremental push completed");
  return counts;
}

// ── Pull (Sheet → DB): validated, conflict-aware ───────────────────────────

interface PullResult {
  rowsUpdated: number;
  conflicts: number;
}

interface ConflictRow {
  userNumber: string;
  field: string;
  dbValue: string | null;
  sheetValue: string;
  source: "pull" | "push";
}

function dbFieldValue(user: PullUser, field: string): string | undefined {
  switch (field) {
    case "Status": return user.account_state;
    case "Department": return user.department ?? "";
    case "Manager": return user.manager ?? "";
    case "Role": return user.roles.join(", ");
    case "Full Name": return user.full_name ?? "";
    case "Phone": return user.phone ?? "";
    case "Designation": return user.designation ?? "";
    case "Employment Type": return user.employment_status ?? "";
    default: return undefined; // not writable from the sheet
  }
}

/**
 * Apply a validated sheet value to the DB. Returns false when the value is
 * invalid or the field is read-only (defense in depth — Email, MFA, etc.
 * can never be pulled even if an admin flips the direction).
 */
async function applySheetValue(user: PullUser, field: string, value: string): Promise<boolean> {
  const audit = {
    action: "ZOHO_SYNC_SHEET_TO_DB",
    targetType: "user" as const,
    targetId: user.user_id,
    result: "success" as const,
    after: { field, value, source: "zoho_sheet" }
  };

  switch (field) {
    case "Status": {
      const v = value.toUpperCase();
      const valid = [
        "PENDING", "ACTIVE", "SUSPENDED", "BLOCKED", "LOCKED",
        "DISABLED", "TERMINATED", "PASSWORD_RESET_REQUIRED"
      ];
      if (!valid.includes(v)) return false;
      await query(
        `UPDATE users SET account_state = $1::account_state, updated_at = now() WHERE id = $2`,
        [v, user.user_id]
      );
      await recordAudit(audit);
      return true;
    }
    case "Department": {
      const { rows } = await query(`SELECT id FROM departments WHERE name = $1`, [value]);
      if (rows.length === 0) return false;
      await query(
        `INSERT INTO employee_profiles (user_id, department_id) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET department_id = EXCLUDED.department_id`,
        [user.user_id, rows[0]!.id]
      );
      await recordAudit(audit);
      return true;
    }
    case "Manager": {
      const { rows } = await query(
        `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, [value]
      );
      if (rows.length === 0) return false;
      await query(
        `INSERT INTO employee_profiles (user_id, manager_id) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET manager_id = EXCLUDED.manager_id`,
        [user.user_id, rows[0]!.id]
      );
      await recordAudit(audit);
      return true;
    }
    case "Role": {
      const { rows } = await query(`SELECT id FROM roles WHERE name = $1`, [value]);
      if (rows.length === 0) return false;
      await query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [user.user_id, rows[0]!.id]
      );
      await recordAudit(audit);
      return true;
    }
    case "Full Name": {
      await query(
        `INSERT INTO user_profiles (user_id, full_name) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
        [user.user_id, value]
      );
      await recordAudit(audit);
      return true;
    }
    case "Phone": {
      if (!value || value.length > 32) return false;
      await query(`UPDATE users SET phone = $1, updated_at = now() WHERE id = $2`, [value, user.user_id]);
      await recordAudit(audit);
      return true;
    }
    case "Designation": {
      await query(
        `INSERT INTO employee_profiles (user_id, designation) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET designation = EXCLUDED.designation`,
        [user.user_id, value]
      );
      await recordAudit(audit);
      return true;
    }
    case "Employment Type": {
      const valid = ["active", "resigned", "terminated", "absconded"];
      if (!valid.includes(value.toLowerCase())) return false;
      await query(
        `UPDATE employee_profiles SET employment_status = $1 WHERE user_id = $2`,
        [value.toLowerCase(), user.user_id]
      );
      await recordAudit(audit);
      return true;
    }
    default:
      return false; // read-only / security fields
  }
}

async function insertConflicts(rows: ConflictRow[], jobId: string | null): Promise<void> {
  if (rows.length === 0) return;
  const jobIds = rows.map(() => jobId);
  const numbers = rows.map((r) => r.userNumber);
  const fields = rows.map((r) => r.field);
  const dbValues = rows.map((r) => r.dbValue);
  const sheetValues = rows.map((r) => r.sheetValue);
  const sources = rows.map((r) => r.source);
  await query(
    `INSERT INTO sync_conflicts (job_id, user_number, field, db_value, sheet_value, source)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])`,
    [jobIds, numbers, fields, dbValues, sheetValues, sources]
  );
}

async function upsertPullMeta(meta: MetaEntry[]): Promise<void> {
  if (meta.length === 0) return;
  const userIds = meta.map((m) => m.userId);
  const numbers = meta.map((m) => m.userNumber);
  const versions = meta.map((m) => m.version);
  const statuses = meta.map((m) => m.status);
  const baselines = meta.map((m) => m.baseline ?? {});
  const now = new Date().toISOString();
  const timestamps = meta.map(() => now);
  const hashes = meta.map(() => null);
  await query(
    `INSERT INTO sheet_sync_records (user_id, user_number, version, last_synced_at, sync_status, record_hash, sheet_baseline)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::int[], $4::timestamptz[], $5::text[], $6::text[], $7::jsonb[])
     ON CONFLICT (user_number) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       version = EXCLUDED.version,
       last_synced_at = EXCLUDED.last_synced_at,
       sync_status = EXCLUDED.sync_status,
       sheet_baseline = EXCLUDED.sheet_baseline,
       updated_at = now()`,
    [userIds, numbers, versions, timestamps, statuses, hashes, baselines]
  );
}

async function syncSheetToDb(
  accessToken: string,
  sheetToken: string,
  worksheetId: string,
  jobId: string,
  limiter: ZohoLimiter
): Promise<PullResult> {
  const mappings = await getFieldMappings();
  const pullColumns = SHEET_COLUMNS.filter((c) => pullEnabled(mappings[c] ?? "db_to_sheet"));

  const data = await zohoApi(accessToken, sheetToken, "worksheet.records.fetch", {
    worksheet_id: worksheetId
  }, limiter);
  const records = (data.records as SheetRecord[]) ?? [];

  const users = await readUserMap();
  const metaMap = await readSyncMetaMap();

  let rowsUpdated = 0;
  let conflictCount = 0;
  const conflictRows: ConflictRow[] = [];
  const metaUpdates: MetaEntry[] = [];

  for (const rec of records) {
    const userNumber = String(rec["User ID"] ?? "").trim();
    if (!userNumber) continue;

    const user = users.get(userNumber);
    const meta = metaMap.get(userNumber);

    if (!user) {
      const status = String(rec["Status"] ?? "").toUpperCase();
      if (status && status !== "PENDING") {
        conflictRows.push({
          userNumber,
          field: "(user)",
          dbValue: null,
          sheetValue: `Sheet row exists but no DB user (Status=${status})`,
          source: "pull"
        });
        conflictCount++;
      }
      continue;
    }

    const baseline: Record<string, string> = { ...(meta?.sheet_baseline ?? {}) };
    let changed = false;
    let userConflicts = 0;

    for (const field of pullColumns) {
      const sheetValue = String(rec[field] ?? "").trim();
      const dbValue = dbFieldValue(user, field);
      if (dbValue === undefined) continue; // read-only field

      if (!meta) {
        // First sync: establish baseline only — never blindly overwrite the DB.
        baseline[field] = sheetValue;
        continue;
      }

      const change = classifyFieldChange({
        dbValue,
        sheetValue,
        lastKnownSheetValue: baseline[field] ?? dbValue
      });

      if (change === "noop" || change === "db_wins") {
        baseline[field] = sheetValue; // DB authoritative; push refreshes the sheet
        continue;
      }
      if (change === "apply") {
        const ok = await applySheetValue(user, field, sheetValue);
        if (ok) {
          rowsUpdated++;
          changed = true;
          baseline[field] = sheetValue;
        } else {
          conflictRows.push({ userNumber, field, dbValue, sheetValue, source: "pull" });
          userConflicts++;
          conflictCount++;
        }
      } else {
        conflictRows.push({ userNumber, field, dbValue, sheetValue, source: "pull" });
        userConflicts++;
        conflictCount++;
      }
    }

    metaUpdates.push({
      userId: user.user_id,
      userNumber,
      version: (meta?.version ?? 0) + (changed ? 1 : 0),
      hash: "",
      status: userConflicts > 0 ? "conflict" : "synced",
      baseline
    });
  }

  if (conflictRows.length > 0) await insertConflicts(conflictRows, jobId);
  await upsertPullMeta(metaUpdates);

  logger.info({ rowsUpdated, conflictCount }, "Zoho Sheet→DB pull completed");
  return { rowsUpdated, conflicts: conflictCount };
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function runZohoSync(input: {
  triggeredBy?: string | null;
  triggerType?: "manual" | "scheduled" | "startup";
  direction?: "push" | "pull" | "bidirectional";
}): Promise<{
  jobId: string;
  rowsSynced: number;
  configured: boolean;
  direction: string;
  details?: Record<string, unknown>;
}> {
  const direction = input.direction ?? "bidirectional";
  const lockAcquired = await acquireLock("zoho-sync", 180);
  if (!lockAcquired) {
    throw errors.conflict("Zoho sync is already running");
  }

  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO sheet_sync_jobs (status, started_at, triggered_by, trigger_type)
       VALUES ('running', now(), $1, $2) RETURNING id`,
      [input.triggeredBy ?? null, input.triggerType ?? "manual"]
    );
    const jobId = rows[0]!.id;

    const accessToken = await getZohoAccessToken();
    const cfg = getConfig();
    const sheetToken = extractSheetToken(cfg.ZOHO_SHEET_URL);
    const limiter = makeLimiter();

    let rowsSynced = 0;
    let details: Record<string, unknown> = {};
    let failedRecords = 0;
    let conflicts = 0;

    if (accessToken && sheetToken) {
      try {
        const worksheetId = await resolveWorksheetId(accessToken, sheetToken, limiter);
        details.worksheetId = worksheetId;

        if (direction === "push" || direction === "bidirectional") {
          const push = await syncDbToSheet(accessToken, sheetToken, worksheetId, limiter);
          rowsSynced += push.rowsAdded + push.rowsUpdated;
          failedRecords += push.failedRecords;
          details = { ...details, ...push };
          logger.info({ jobId, ...push }, "Zoho DB→Sheet push completed");
        }

        if (direction === "pull" || direction === "bidirectional") {
          const pull = await syncSheetToDb(accessToken, sheetToken, worksheetId, jobId, limiter);
          rowsSynced += pull.rowsUpdated;
          conflicts += pull.conflicts;
          details = { ...details, ...pull };
          logger.info({ jobId, ...pull }, "Zoho Sheet→DB pull completed");
        }
      } catch (apiErr) {
        logger.error({ jobId, err: apiErr }, "Zoho API error during sync");
        await query(
          `UPDATE sheet_sync_jobs SET status = 'failed', finished_at = now(),
           error = $2 WHERE id = $1`,
          [jobId, String(apiErr).slice(0, 500)]
        );
        throw apiErr;
      }
    }

    const settings = await getSyncSettings();
    await query(
      `UPDATE sheet_sync_jobs SET status = 'success', finished_at = now(),
       rows_synced = $2, rows_added = $3, rows_updated = $4, rows_deleted = $5,
       conflicts = $6, failed_records = $7, summary = $8 WHERE id = $1`,
      [
        jobId,
        rowsSynced,
        details.rowsAdded ?? 0,
        details.rowsUpdated ?? 0,
        details.rowsDeleted ?? 0,
        conflicts,
        failedRecords,
        JSON.stringify({
          configured: Boolean(accessToken && sheetToken),
          direction,
          mode: settings.mode,
          deletionPolicy: settings.deletionPolicy,
          fields: SYNC_FIELDS,
          ...details,
          limiter: limiter.state(),
          generatedAt: new Date().toISOString()
        })
      ]
    );

    await recordAudit({
      actorUserId: input.triggeredBy ?? null,
      action: "ZOHO_SYNC_RUN",
      targetType: "sheet_sync_job",
      targetId: jobId,
      result: "success",
      after: { rowsSynced, direction, conflicts, failedRecords, configured: Boolean(accessToken && sheetToken) }
    });

    return {
      jobId,
      rowsSynced,
      configured: Boolean(accessToken && sheetToken),
      direction,
      details
    };
  } finally {
    await releaseLock("zoho-sync");
  }
}

export async function listSyncJobs(limit = 20, offset = 0) {
  const { rows } = await query(
    `SELECT * FROM sheet_sync_jobs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

// ── Connection test ────────────────────────────────────────────────────────

export async function testZohoConnection(): Promise<{
  ok: boolean;
  latencyMs?: number;
  workbook?: string;
  worksheet?: string;
  error?: string;
}> {
  const start = Date.now();
  const accessToken = await getZohoAccessToken();
  if (!accessToken) {
    return { ok: false, latencyMs: Date.now() - start, error: "Zoho OAuth not configured or token refresh failed" };
  }
  const sheetToken = extractSheetToken(getConfig().ZOHO_SHEET_URL);
  if (!sheetToken) {
    return { ok: false, latencyMs: Date.now() - start, error: "ZOHO_SHEET_URL is not set or invalid" };
  }
  const limiter = makeLimiter();
  try {
    const data = await zohoApi(accessToken, sheetToken, "workbook.list", {}, limiter);
    const workbook = (data.workbook as { workbook_name?: string } | undefined)?.workbook_name;
    const worksheetId = await resolveWorksheetId(accessToken, sheetToken, limiter);
    return {
      ok: true,
      latencyMs: Date.now() - start,
      workbook,
      worksheet: worksheetId === "0#" ? "first worksheet" : worksheetId
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Zoho connection test failed"
    };
  }
}

// ── Sync configuration (field mappings + mode + policy) ───────────────────

export async function getSyncConfig() {
  const cfg = getConfig();
  const { rows } = await query<{ field: string; direction: string; description: string | null }>(
    `SELECT field, direction, description FROM sync_field_mappings ORDER BY id`
  );
  const settings = await getSyncSettings();
  return {
    fields: rows.map((r) => ({ field: r.field, direction: r.direction, description: r.description })),
    ...settings,
    intervalSeconds: cfg.ZOHO_SYNC_INTERVAL_SECONDS,
    batchSize: cfg.ZOHO_SYNC_BATCH_SIZE,
    worksheet: cfg.ZOHO_SHEET_WORKSHEET || "(first worksheet)"
  };
}

export async function updateSyncConfig(
  input: {
    fields?: { field: string; direction: string }[];
    mode?: "scheduled" | "near-real-time";
    deletionPolicy?: "mark" | "keep" | "delete";
    pollIntervalSeconds?: number;
  },
  updatedBy: string
): Promise<void> {
  if (input.fields) {
    for (const f of input.fields) {
      const direction = normalizeDirection(f.direction);
      const { rowCount } = await query(
        `UPDATE sync_field_mappings SET direction = $1, updated_by = $2, updated_at = now() WHERE field = $3`,
        [direction, updatedBy, f.field]
      );
      if (rowCount === 0) throw errors.badRequest(`Unknown sync field: ${f.field}`);
    }
  }
  if (input.mode) {
    await query(
      `INSERT INTO system_settings (key, value, description, updated_by)
       VALUES ('zoho.sync.mode', $1, 'Zoho sync mode', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [JSON.stringify({ mode: input.mode }), updatedBy]
    );
  }
  if (input.deletionPolicy) {
    await query(
      `INSERT INTO system_settings (key, value, description, updated_by)
       VALUES ('zoho.sync.deletion_policy', $1, 'Zoho sync deletion policy', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [JSON.stringify({ deletionPolicy: input.deletionPolicy }), updatedBy]
    );
  }
  if (input.pollIntervalSeconds !== undefined) {
    if (input.pollIntervalSeconds < 30 || input.pollIntervalSeconds > 3600) {
      throw errors.badRequest("pollIntervalSeconds must be between 30 and 3600");
    }
    await query(
      `INSERT INTO system_settings (key, value, description, updated_by)
       VALUES ('zoho.poll_interval_seconds', $1, 'Zoho near-real-time poll interval', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [JSON.stringify({ pollIntervalSeconds: input.pollIntervalSeconds }), updatedBy]
    );
  }
  await recordAudit({
    actorUserId: updatedBy,
    action: "ZOHO_SYNC_CONFIG_UPDATED",
    targetType: "sync_config",
    targetId: "zoho",
    after: input as unknown as Record<string, unknown>
  });
}

// ── Conflicts ──────────────────────────────────────────────────────────────

export async function listConflicts(
  status: "pending" | "resolved" | "all" = "pending",
  limit = 50,
  offset = 0
) {
  const params: unknown[] = [limit, offset];
  const where = status === "all" ? "" : "WHERE status = $1";
  if (status !== "all") params.unshift(status);
  const { rows } = await query(
    `SELECT * FROM sync_conflicts ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

export async function resolveConflict(
  conflictId: string,
  resolution: "keep_db" | "keep_sheet" | "skip",
  resolvedBy: string
): Promise<{ ok: true; resolution: string }> {
  const { rows } = await query<{ user_number: string; field: string; sheet_value: string | null }>(
    `SELECT user_number, field, sheet_value FROM sync_conflicts WHERE id = $1 AND status = 'pending'`,
    [conflictId]
  );
  if (rows.length === 0) throw errors.notFound("Conflict not found or already resolved");
  const conflict = rows[0]!;

  if (resolution === "keep_sheet") {
    const user = (await readUserMap()).get(conflict.user_number);
    if (!user) throw errors.badRequest("DB user no longer exists — cannot apply sheet value");
    const ok = await applySheetValue(user, conflict.field, conflict.sheet_value ?? "");
    if (!ok) {
      throw errors.badRequest("Sheet value could not be applied (invalid or read-only field)");
    }
  }

  // Acknowledge the current sheet state as the new baseline so the pull
  // classifier stops re-flagging this field. DB-only changes still win on
  // the next push (DB remains authoritative).
  await query(
    `UPDATE sheet_sync_records
       SET sheet_baseline = jsonb_set(COALESCE(sheet_baseline, '{}'::jsonb), $1, to_jsonb($2::text)),
           sync_status = 'synced',
           updated_at = now()
     WHERE user_number = $3`,
    [`{${conflict.field}}`, conflict.sheet_value ?? "", conflict.user_number]
  );

  await query(
    `UPDATE sync_conflicts SET status = 'resolved', resolution = $1, resolved_by = $2, resolved_at = now()
     WHERE id = $3`,
    [resolution, resolvedBy, conflictId]
  );

  await recordAudit({
    actorUserId: resolvedBy,
    action: "ZOHO_SYNC_CONFLICT_RESOLVED",
    targetType: "sync_conflict",
    targetId: conflictId,
    after: { userNumber: conflict.user_number, field: conflict.field, resolution }
  });

  return { ok: true, resolution };
}

// ── Health stats ───────────────────────────────────────────────────────────

export async function getSyncStats() {
  const lastJob = (await listSyncJobs(1, 0))[0] ?? null;
  const { rows: totals } = await query<{
    added: number; updated: number; deleted: number; conflicts: number; failed: number;
  }>(
    `SELECT COALESCE(SUM(rows_added), 0)::int AS added,
            COALESCE(SUM(rows_updated), 0)::int AS updated,
            COALESCE(SUM(rows_deleted), 0)::int AS deleted,
            COALESCE(SUM(conflicts), 0)::int AS conflicts,
            COALESCE(SUM(failed_records), 0)::int AS failed
       FROM sheet_sync_jobs WHERE status = 'success'`
  );
  const { rows: pending } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sync_conflicts WHERE status = 'pending'`
  );
  const { rows: tracked } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sheet_sync_records`
  );
  const cfg = getConfig();
  const settings = await getSyncSettings();
  return {
    configured: Boolean(cfg.ZOHO_CLIENT_ID && cfg.ZOHO_CLIENT_SECRET && cfg.ZOHO_REFRESH_TOKEN && cfg.ZOHO_SHEET_URL),
    lastJob,
    totals: totals[0] ?? { added: 0, updated: 0, deleted: 0, conflicts: 0, failed: 0 },
    pendingConflicts: pending[0]?.n ?? 0,
    trackedRecords: tracked[0]?.n ?? 0,
    settings,
    worksheet: cfg.ZOHO_SHEET_WORKSHEET || "(first worksheet)"
  };
}
