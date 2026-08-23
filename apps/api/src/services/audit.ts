import { query } from "../db/pool.js";

export interface AuditEntry {
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  correlationId?: string | null;
  ip?: string | null;
  result?: "success" | "failure" | "denied";
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Write an audit log row. `before`/`after` must never contain secrets —
 * callers pass only safe state deltas.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  await query(
    `INSERT INTO audit_logs
      (actor_user_id, actor_role, action, target_type, target_id, target_label,
       correlation_id, ip, result, reason, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      entry.actorUserId ?? null,
      entry.actorRole ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.targetLabel ?? null,
      entry.correlationId ?? null,
      entry.ip ?? null,
      entry.result ?? "success",
      entry.reason ?? null,
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null
    ]
  );
}

export interface AuditListOptions {
  actorUserId?: string;
  action?: string;
  targetType?: string;
  limit: number;
  offset: number;
}

export async function listAuditLogs(opts: AuditListOptions) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.actorUserId) {
    params.push(opts.actorUserId);
    where.push(`actor_user_id = $${params.length}`);
  }
  if (opts.action) {
    params.push(opts.action);
    where.push(`action = $${params.length}`);
  }
  if (opts.targetType) {
    params.push(opts.targetType);
    where.push(`target_type = $${params.length}`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(opts.limit, opts.offset);
  const { rows } = await query(
    `SELECT * FROM audit_logs ${whereSql}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}
