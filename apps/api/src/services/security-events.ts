import { query } from "../db/pool.js";
import { newSecurityEventId } from "../errors.js";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface SecurityEventInput {
  eventType: string;
  severity: Severity;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
}

export const SECURITY_EVENT_TYPES = {
  LOGIN_SUCCESS: "login.success",
  LOGIN_FAILED: "login.failed",
  LOGIN_LOCKOUT: "login.lockout",
  LOGIN_SUSPICIOUS: "login.suspicious",
  REFRESH_TOKEN_REUSE: "refresh_token.reuse",
  REFRESH_TOKEN_REVOKED: "refresh_token.revoked",
  SESSION_REVOKED: "session.revoked",
  SESSION_REAUTH_REQUIRED: "session.reauth_required",
  PASSWORD_CHANGED: "password.changed",
  PASSWORD_RESET: "password.reset",
  PASSWORD_RESET_ABUSE: "password.reset_abuse",
  ACCOUNT_BLOCKED: "account.blocked",
  ACCOUNT_UNLOCKED: "account.unlocked",
  ACCOUNT_TERMINATED: "account.terminated",
  MFA_ENROLLED: "mfa.enrolled",
  MFA_RESET: "mfa.reset",
  MFA_FAILED: "mfa.failed",
  EMAIL_VERIFIED: "email.verified",
  PERMISSION_DENIED: "authorization.denied",
  GLOBAL_LOGOUT: "session.global_logout",
  ADMIN_ACTION: "admin.action",
  RATE_LIMITED: "rate_limit.exceeded",
  SUSPICIOUS_IP: "login.suspicious_ip"
} as const;

/** Record a security event. Never include secrets in metadata. */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<string> {
  const eventId = newSecurityEventId();
  await query(
    `INSERT INTO security_events
      (event_id, event_type, severity, user_id, ip, user_agent, metadata, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      eventId,
      input.eventType,
      input.severity,
      input.userId ?? null,
      input.ip ?? null,
      input.userAgent ?? null,
      input.metadata ? JSON.stringify(input.metadata) : "{}",
      input.correlationId ?? null
    ]
  );
  return eventId;
}

export async function listSecurityEvents(opts: {
  userId?: string;
  eventType?: string;
  severity?: Severity;
  limit: number;
  offset: number;
}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.userId) {
    params.push(opts.userId);
    where.push(`user_id = $${params.length}`);
  }
  if (opts.eventType) {
    params.push(opts.eventType);
    where.push(`event_type = $${params.length}`);
  }
  if (opts.severity) {
    params.push(opts.severity);
    where.push(`severity = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(opts.limit, opts.offset);
  const { rows } = await query(
    `SELECT * FROM security_events ${whereSql}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}
