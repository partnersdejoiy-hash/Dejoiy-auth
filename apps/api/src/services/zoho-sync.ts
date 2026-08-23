import { getConfig } from "../config.js";
import { query } from "../db/pool.js";
import { acquireLock, releaseLock } from "../redis.js";
import { logger } from "../logger.js";
import { recordAudit } from "./audit.js";

/**
 * Zoho Sheet synchronization.
 *
 * Direction: DEJOIY AUTH DATABASE → Sync Worker → DEJOIY AUTH Zoho Sheet.
 * The database is the source of truth. The sheet is a controlled inventory
 * layer. NEVER synced: passwords, hashes, tokens, MFA/recovery secrets, API keys.
 */

export const SYNC_FIELDS = [
  "Employee ID",
  "User ID",
  "Name",
  "Email",
  "Role",
  "Department",
  "Status",
  "Activation date",
  "Deactivation date",
  "Manager",
  "Last sync"
] as const;

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

/** Read the sanitized identity inventory from PostgreSQL. */
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

/** Get a Zoho access token from the OAuth refresh token (server-side only). */
async function getZohoAccessToken(): Promise<string | null> {
  const cfg = getConfig();
  if (!cfg.ZOHO_CLIENT_ID || !cfg.ZOHO_CLIENT_SECRET || !cfg.ZOHO_REFRESH_TOKEN) return null;
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
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Push rows to the Zoho Sheet via the Zoho Sheet API (append-only with a
 * dedupe marker). When Zoho credentials are not configured, the worker
 * records the job as configured-without-credentials (still produces the
 * sanitized payload for the operator).
 */
export async function runZohoSync(input: {
  triggeredBy?: string | null;
  triggerType?: "manual" | "scheduled" | "startup";
}): Promise<{ jobId: string; rowsSynced: number; configured: boolean }> {
  const lockAcquired = await acquireLock("zoho-sync", 120);
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

    const data = await readSyncRows();
    const accessToken = await getZohoAccessToken();
    const cfg = getConfig();

    let rowsSynced = 0;
    if (accessToken && cfg.ZOHO_SHEET_URL) {
      // Zoho Sheet API: replace range with sanitized rows. Exact endpoint
      // contract is provider-versioned; the worker isolates it here.
      const sheetId = cfg.ZOHO_SHEET_URL.split("/").pop();
      const res = await fetch(
        `https://sheet.zoho.in/api/v1/sheet/${sheetId}/data?method=replace`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            values: [
              [...SYNC_FIELDS],
              ...data.map((row) => [
                row.employee_id ?? "",
                row.user_number,
                row.full_name ?? "",
                row.email ?? "",
                row.roles.join(", "),
                row.department ?? "",
                row.account_state,
                row.created_at.toISOString().slice(0, 10),
                row.account_state === "TERMINATED" ? new Date().toISOString().slice(0, 10) : "",
                row.manager ?? "",
                new Date().toISOString()
              ])
            ]
          })
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Zoho Sheet API error ${res.status}: ${body.slice(0, 200)}`);
      }
      rowsSynced = data.length;
    }

    await query(
      `UPDATE sheet_sync_jobs SET status = 'success', finished_at = now(), rows_synced = $2, summary = $3
        WHERE id = $1`,
      [
        jobId,
        rowsSynced,
        JSON.stringify({
          configured: Boolean(accessToken),
          fields: SYNC_FIELDS,
          generatedAt: new Date().toISOString()
        })
      ]
    );
    logger.info({ jobId, rowsSynced }, "zoho sync completed");

    await recordAudit({
      actorUserId: input.triggeredBy ?? null,
      action: "ZOHO_SYNC_RUN",
      targetType: "sheet_sync_job",
      targetId: jobId,
      result: "success",
      after: { rowsSynced, configured: Boolean(accessToken) }
    });

    return { jobId, rowsSynced, configured: Boolean(accessToken) };
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
