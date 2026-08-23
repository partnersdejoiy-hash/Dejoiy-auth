import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/pool.js";
import { getConfig } from "../config.js";
import { hashToken, randomToken, sha256, deviceFingerprint } from "../crypto.js";
import { errors } from "../errors.js";
import { recordAudit } from "./audit.js";
import { recordSecurityEvent, SECURITY_EVENT_TYPES } from "./security-events.js";

export interface SessionInput {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  clientNonce?: string;
}

export interface RefreshTokenRecord {
  id: string;
  user_id: string;
  session_id: string;
  token_family: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_from_id: string | null;
}

const REFRESH_TOKEN_BYTES = 48;

/** Create a session + device record and issue an opaque refresh token. */
export async function createSession(input: SessionInput): Promise<{
  sessionId: string;
  refreshToken: string;
  deviceId: string | null;
  fingerprint: string | null;
}> {
  const cfg = getConfig();
  const now = Date.now();
  const sessionId = randomUUID();
  const refreshToken = randomToken(REFRESH_TOKEN_BYTES);
  const tokenHash = hashToken(refreshToken);

  const fingerprint = input.userAgent
    ? deviceFingerprint(input.userAgent, input.ip ?? "", input.clientNonce ?? "")
    : null;
  let deviceId: string | null = null;

  await withTransaction(async (client) => {
    if (fingerprint) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO devices (user_id, fingerprint, label, last_seen_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (user_id, fingerprint) DO UPDATE SET last_seen_at = now()
         RETURNING id`,
        [input.userId, fingerprint, input.userAgent?.slice(0, 80) ?? null]
      );
      deviceId = rows[0]?.id ?? null;
    }

    await client.query(
      `INSERT INTO sessions
        (id, user_id, session_token_hash, device_id, ip, user_agent,
         expires_at, idle_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        sessionId,
        input.userId,
        sha256(randomToken(32)),
        deviceId,
        input.ip ?? null,
        input.userAgent ?? null,
        new Date(now + cfg.SESSION_ABSOLUTE_TTL_SECONDS * 1000),
        new Date(now + cfg.SESSION_IDLE_TTL_SECONDS * 1000)
      ]
    );

    await client.query(
      `INSERT INTO refresh_tokens
        (user_id, session_id, token_family, token_hash, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.userId,
        sessionId,
        randomUUID(),
        tokenHash,
        new Date(now + cfg.REFRESH_TOKEN_TTL_SECONDS * 1000),
        input.ip ?? null,
        input.userAgent ?? null
      ]
    );
  });

  return { sessionId, refreshToken, deviceId, fingerprint };
}

/**
 * Rotate a refresh token. Returns a new token or throws on reuse/expiry.
 * Reuse of a previously rotated token revokes the whole family.
 */
export async function rotateRefreshToken(
  presentedToken: string,
  meta: { ip?: string | null; userAgent?: string | null; correlationId?: string | null }
): Promise<{ refreshToken: string; userId: string; sessionId: string }> {
  const cfg = getConfig();
  const presentedHash = hashToken(presentedToken);

  return withTransaction(async (client) => {
    const { rows } = await client.query<RefreshTokenRecord>(
      `SELECT * FROM refresh_tokens WHERE token_hash = $1`,
      [presentedHash]
    );
    const record = rows[0];

    // Unknown token — not in our records at all.
    if (!record) {
      throw errors.unauthorized("Invalid refresh token");
    }

    // Reuse detection: a token that was already rotated away was presented again.
    if (record.revoked_at || record.rotated_from_id) {
      await revokeTokenFamily(record.token_family, "REUSE_DETECTED", meta);
      await recordSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.REFRESH_TOKEN_REUSE,
        severity: "critical",
        userId: record.user_id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { tokenFamily: record.token_family, sessionId: record.session_id },
        correlationId: meta.correlationId
      });
      throw errors.unauthorized("Refresh token invalidated");
    }

    if (record.expires_at.getTime() < Date.now()) {
      await client.query("UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = 'expired' WHERE id = $1", [record.id]);
      throw errors.unauthorized("Refresh token expired");
    }

    // Issue a fresh token in the same family.
    const newToken = randomToken(REFRESH_TOKEN_BYTES);
    const newHash = hashToken(newToken);
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO refresh_tokens
         (user_id, session_id, token_family, token_hash, rotated_from_id, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        record.user_id,
        record.session_id,
        record.token_family,
        newHash,
        record.id,
        new Date(Date.now() + cfg.REFRESH_TOKEN_TTL_SECONDS * 1000),
        meta.ip ?? null,
        meta.userAgent ?? null
      ]
    );
    // Mark the presented token as rotated (now unusable).
    await client.query(
      "UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = 'rotated', last_used_at = now() WHERE id = $1",
      [record.id]
    );
    void inserted;

    // Touch session activity.
    await client.query(
      `UPDATE sessions SET last_active_at = now(), idle_expires_at = now() + ($2 || ' seconds')::interval
        WHERE id = $1 AND revoked_at IS NULL`,
      [record.session_id, cfg.SESSION_IDLE_TTL_SECONDS]
    );

    return { refreshToken: newToken, userId: record.user_id, sessionId: record.session_id };
  });
}

async function revokeTokenFamily(
  family: string,
  reason: string,
  meta: { ip?: string | null; userAgent?: string | null; correlationId?: string | null }
): Promise<void> {
  await query(
    "UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = $2 WHERE token_family = $1 AND revoked_at IS NULL",
    [family, reason]
  );
  await query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
      WHERE id IN (SELECT DISTINCT session_id FROM refresh_tokens WHERE token_family = $1)`,
    [family, reason]
  );
  await recordSecurityEvent({
    eventType: SECURITY_EVENT_TYPES.REFRESH_TOKEN_REVOKED,
    severity: "high",
    metadata: { tokenFamily: family, reason },
    correlationId: meta.correlationId
  });
}

export async function revokeSession(
  sessionId: string,
  reason: string,
  actor?: { id?: string; correlationId?: string }
): Promise<void> {
  await query("UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL", [sessionId, reason]);
  await query("UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = $2 WHERE session_id = $1 AND revoked_at IS NULL", [sessionId, reason]);
  await recordAudit({
    actorUserId: actor?.id ?? null,
    action: "SESSION_REVOKED",
    targetType: "session",
    targetId: sessionId,
    correlationId: actor?.correlationId ?? null,
    reason
  });
}

/** Revoke all sessions for a user (global logout / password change). */
export async function revokeAllUserSessions(
  userId: string,
  reason: string,
  opts?: { exceptSessionId?: string; actor?: { id?: string; correlationId?: string } }
): Promise<number> {
  const params: unknown[] = [userId, reason];
  let exceptSql = "";
  if (opts?.exceptSessionId) {
    params.push(opts.exceptSessionId);
    exceptSql = `AND id <> $${params.length}`;
  }
  const { rows } = await query<{ id: string }>(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL ${exceptSql} RETURNING id`,
    params
  );
  const sessionIds = rows.map((r) => r.id);
  if (sessionIds.length > 0) {
    await query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = $2
        WHERE session_id = ANY($1) AND revoked_at IS NULL`,
      [sessionIds, reason]
    );
  }
  await recordAudit({
    actorUserId: opts?.actor?.id ?? null,
    action: "SESSIONS_REVOKED",
    targetType: "user",
    targetId: userId,
    correlationId: opts?.actor?.correlationId ?? null,
    reason,
    after: { revoked: sessionIds.length }
  });
  return sessionIds.length;
}

export async function listUserSessions(userId: string) {
  const { rows } = await query(
    `SELECT s.id, s.ip, s.user_agent, s.created_at, s.last_active_at, s.expires_at,
            s.revoked_at, s.revoke_reason, s.requires_reauth,
            d.label AS device_label, d.fingerprint
       FROM sessions s
       LEFT JOIN devices d ON d.id = s.device_id
      WHERE s.user_id = $1
      ORDER BY s.last_active_at DESC`,
    [userId]
  );
  return rows;
}

export async function listUserDevices(userId: string) {
  const { rows } = await query(
    `SELECT d.id, d.label, d.fingerprint, d.first_seen_at, d.last_seen_at, d.revoked_at,
            (SELECT count(*)::int FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL) AS active_sessions
       FROM devices d
      WHERE d.user_id = $1
      ORDER BY d.last_seen_at DESC`,
    [userId]
  );
  return rows;
}

export async function revokeDevice(
  deviceId: string,
  userId: string,
  actor?: { id?: string; correlationId?: string }
): Promise<void> {
  await query("UPDATE devices SET revoked_at = now() WHERE id = $1 AND user_id = $2", [deviceId, userId]);
  await query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = 'device_revoked'
      WHERE device_id = $1 AND revoked_at IS NULL`,
    [deviceId]
  );
  await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = 'device_revoked'
      WHERE session_id IN (SELECT id FROM sessions WHERE device_id = $1) AND revoked_at IS NULL`,
    [deviceId]
  );
  await recordAudit({
    actorUserId: actor?.id ?? null,
    action: "DEVICE_REVOKED",
    targetType: "device",
    targetId: deviceId,
    correlationId: actor?.correlationId ?? null
  });
}

/** Validate a session row is still usable (not revoked/expired/idle-expired). */
export function sessionUsable(session: {
  revoked_at: Date | null;
  expires_at: Date;
  idle_expires_at: Date;
  requires_reauth?: boolean;
}): boolean {
  if (session.revoked_at) return false;
  if (session.expires_at.getTime() < Date.now()) return false;
  if (session.idle_expires_at.getTime() < Date.now()) return false;
  return true;
}

export async function getSessionById(id: string) {
  const { rows } = await query("SELECT * FROM sessions WHERE id = $1", [id]);
  return rows[0] ?? null;
}

/** Revoke the current user's own session (logout). */
export async function logoutSession(sessionId: string): Promise<void> {
  await query("UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
  await query("UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = 'logout' WHERE session_id = $1 AND revoked_at IS NULL", [sessionId]);
}
