import { getConfig } from "../config.js";
import { query } from "../db/pool.js";
import { acquireLock, releaseLock } from "../redis.js";
import { logger } from "../logger.js";
import { recordAudit } from "./audit.js";

/**
 * Zoho Sheet synchronization — bidirectional.
 *
 * Database is the source of truth. The sheet is a controlled reporting layer.
 * NEVER synced: passwords, hashes, tokens, MFA/recovery secrets, API keys.
 *
 * API: Zoho Sheet Data API v2
 *      Base URL: https://sheet.zoho.in/api/v2/{SHEET_TOKEN}
 *      Auth:     Authorization: Zoho-oauthtoken {access_token}
 *      Methods:  workbook.list, worksheet.list, cell.content.set,
 *                worksheet.records.fetch, worksheet.records.add,
 *                worksheet.records.update, worksheet.records.delete
 */

const HEADERS = [
  "User ID",
  "Name",
  "Email",
  "Role",
  "Department",
  "Status",
  "Activation Date",
  "Deactivation Date",
  "Manager",
  "Employee ID",
  "Last Sync"
] as const;

export const SYNC_FIELDS = [...HEADERS];

// ── Zoho API helpers ──────────────────────────────────────────────────────

/** Extract the sheet resource_id from the ZOHO_SHEET_URL. */
function extractSheetToken(url: string): string | null {
  if (!url) return null;
  // https://sheet.zoho.in/sheet/open/t9x1641aa...8d6?sheetid=0&range=A1
  const match = url.match(/\/open\/([a-zA-Z0-9]+)/);
  return match?.[1] ?? null;
}

/** Get a fresh Zoho access token via refresh_token. */
async function getZohoAccessToken(): Promise<string | null> {
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

/** Call Zoho Sheet Data API v2. */
async function zohoApi(
  accessToken: string,
  sheetToken: string,
  method: string,
  params: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ method, ...params });
  const res = await fetch(`https://sheet.zoho.in/api/v2/${sheetToken}`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (data.status === "failure" || data.error_code) {
    throw new Error(
      `Zoho API error (${method}): ${data.error_message ?? JSON.stringify(data)}`
    );
  }
  return data;
}

// ── Database read ──────────────────────────────────────────────────────────

interface SyncRow {
  employee_id: string | null;
  user_number: string;
  full_name: string | null;
  email: string | null;
  roles: string[];
  department: string | null;
  account_state: string;
  created_at: Date;
  manager: string | null;
}

async function readSyncRows(): Promise<SyncRow[]> {
  const { rows } = await query(
    `SELECT
       ep.employee_id,
       u.user_number,
       p.full_name,
       u.email,
       COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
       d.name AS department,
       u.account_state,
       u.created_at,
       m.email AS manager
     FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     LEFT JOIN employee_profiles ep ON ep.user_id = u.id
     LEFT JOIN departments d ON d.id = ep.department_id
     LEFT JOIN users m ON m.id = ep.manager_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.deleted_at IS NULL
     GROUP BY u.id, p.full_name, d.name, m.email, ep.employee_id
     ORDER BY u.created_at`,
    []
  );
  return rows.map((r) => ({
    employee_id: r.employee_id,
    user_number: r.user_number,
    full_name: r.full_name,
    email: r.email,
    roles: r.roles ?? [],
    department: r.department,
    account_state: r.account_state,
    created_at: r.created_at,
    manager: r.manager
  }));
}

/** Convert a DB row to the sheet record shape. */
function toRecord(row: SyncRow, now: Date): Record<string, string> {
  return {
    "User ID": row.user_number,
    Name: row.full_name ?? "",
    Email: row.email ?? "",
    Role: row.roles.join(", "),
    Department: row.department ?? "",
    Status: row.account_state,
    "Activation Date": row.created_at.toISOString().slice(0, 10),
    "Deactivation Date":
      row.account_state === "TERMINATED"
        ? now.toISOString().slice(0, 10)
        : "",
    Manager: row.manager ?? "",
    "Employee ID": row.employee_id ?? "",
    "Last Sync": now.toISOString().slice(0, 19).replace("T", " ")
  };
}

// ── Core sync ──────────────────────────────────────────────────────────────

async function ensureHeaders(
  accessToken: string,
  sheetToken: string
): Promise<void> {
  // Check if the sheet already has records (which implies headers exist)
  const data = await zohoApi(accessToken, sheetToken, "worksheet.records.fetch", {
    worksheet_id: "0#"
  });
  const records = (data.records as unknown[]) ?? [];
  if (records.length > 0) return; // Headers already set

  // Set header row cell by cell (the only reliable method for empty sheets)
  for (let i = 0; i < HEADERS.length; i++) {
    await zohoApi(accessToken, sheetToken, "cell.content.set", {
      worksheet_id: "0#",
      row: "1",
      column: String(i + 1),
      content: HEADERS[i] ?? ""
    });
  }
  logger.info("Zoho sheet headers initialized");
}

/**
 * DB → Sheet: push all DB users to the sheet.
 * Strategy: clear existing data rows, then insert fresh.
 */
async function pushDbToSheet(
  accessToken: string,
  sheetToken: string
): Promise<{ rowsPushed: number; rowsCleared: number }> {
  await ensureHeaders(accessToken, sheetToken);

  // Fetch existing records to clear
  const existing = await zohoApi(accessToken, sheetToken, "worksheet.records.fetch", {
    worksheet_id: "0#"
  });
  const existingRecords = (existing.records as { row_index?: number }[]) ?? [];
  const rowsCleared = existingRecords.length;

  // Delete existing data rows (batch by row indices, descending)
  if (rowsCleared > 0) {
    const rowIndices = existingRecords
      .map((r) => r.row_index)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => b - a);
    // Delete in batches of 100
    for (let i = 0; i < rowIndices.length; i += 100) {
      const batch = rowIndices.slice(i, i + 100);
      await zohoApi(accessToken, sheetToken, "worksheet.records.delete", {
        worksheet_id: "0#",
        row_array: JSON.stringify(batch)
      });
    }
  }

  // Read DB users and add all
  const dbRows = await readSyncRows();
  const now = new Date();
  const records = dbRows.map((row) => toRecord(row, now));

  if (records.length > 0) {
    await zohoApi(accessToken, sheetToken, "worksheet.records.add", {
      worksheet_id: "0#",
      json_data: JSON.stringify(records)
    });
  }

  return { rowsPushed: records.length, rowsCleared };
}

/**
 * Sheet → DB: read sheet changes and update DB.
 * Only updates safe fields: Status, Department, Manager, Role.
 * Never overwrites: email, user_id, password, or security fields.
 */
async function pullSheetToDb(
  accessToken: string,
  sheetToken: string
): Promise<{ rowsUpdated: number; conflicts: string[] }> {
  const data = await zohoApi(accessToken, sheetToken, "worksheet.records.fetch", {
    worksheet_id: "0#"
  });
  const sheetRecords = (data.records as Record<string, string>[]) ?? [];
  let rowsUpdated = 0;
  const conflicts: string[] = [];

  for (const record of sheetRecords) {
    const userNumber = record["User ID"];
    if (!userNumber) continue;

    // Find user in DB
    const { rows: userRows } = await query(
      `SELECT id, account_state FROM users WHERE user_number = $1 AND deleted_at IS NULL`,
      [userNumber]
    );
    if (userRows.length === 0) {
      // Sheet has a user not in DB — record as conflict for admin review
      if (record["Status"] && record["Status"] !== "PENDING") {
        conflicts.push(
          `Sheet row "${userNumber}" (${record["Email"] ?? "unknown"}) has no matching DB user`
        );
      }
      continue;
    }

    const dbUser = userRows[0]!;
    const sheetStatus = record["Status"]?.toUpperCase();

    // Only update if sheet status differs from DB status
    if (sheetStatus && sheetStatus !== dbUser.account_state) {
      // Validate the status value
      const validStates = [
        "PENDING", "ACTIVE", "SUSPENDED", "BLOCKED",
        "LOCKED", "DISABLED", "TERMINATED", "PASSWORD_RESET_REQUIRED"
      ];
      if (validStates.includes(sheetStatus)) {
        await query(
          `UPDATE users SET account_state = $1::account_state, updated_at = now() WHERE id = $2`,
          [sheetStatus, dbUser.id]
        );
        rowsUpdated++;
        await recordAudit({
          action: "ZOHO_SYNC_SHEET_TO_DB",
          targetType: "user",
          targetId: dbUser.id,
          result: "success",
          after: { account_state: sheetStatus, source: "zoho_sheet" }
        });
      }
    }

    // Update department if changed (via employee_profiles)
    if (record["Department"]) {
      const { rows: deptRows } = await query(
        `SELECT id FROM departments WHERE name = $1`, [record["Department"]]
      );
      if (deptRows.length > 0) {
        await query(
          `INSERT INTO employee_profiles (user_id, department_id) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET department_id = EXCLUDED.department_id`,
          [dbUser.id, deptRows[0]!.id]
        );
      }
    }
  }

  return { rowsUpdated, conflicts };
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
    throw new Error("Zoho sync already running");
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

    let rowsSynced = 0;
    let details: Record<string, unknown> = {};

    if (accessToken && sheetToken) {
      try {
        if (direction === "push" || direction === "bidirectional") {
          const pushResult = await pushDbToSheet(accessToken, sheetToken);
          rowsSynced += pushResult.rowsPushed;
          details = { ...details, ...pushResult };
          logger.info({ jobId, ...pushResult }, "Zoho DB→Sheet push completed");
        }

        if (direction === "pull" || direction === "bidirectional") {
          const pullResult = await pullSheetToDb(accessToken, sheetToken);
          rowsSynced += pullResult.rowsUpdated;
          details = { ...details, ...pullResult };
          logger.info({ jobId, ...pullResult }, "Zoho Sheet→DB pull completed");
        }
      } catch (apiErr) {
        logger.error({ jobId, err: apiErr }, "Zoho API error during sync");
        await query(
          `UPDATE sheet_sync_jobs SET status = 'error', finished_at = now(),
           error_message = $2 WHERE id = $1`,
          [jobId, String(apiErr).slice(0, 500)]
        );
        throw apiErr;
      }
    }

    await query(
      `UPDATE sheet_sync_jobs SET status = 'success', finished_at = now(),
       rows_synced = $2, summary = $3 WHERE id = $1`,
      [
        jobId,
        rowsSynced,
        JSON.stringify({
          configured: Boolean(accessToken && sheetToken),
          direction,
          fields: SYNC_FIELDS,
          ...details,
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
      after: { rowsSynced, direction, configured: Boolean(accessToken && sheetToken) }
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
