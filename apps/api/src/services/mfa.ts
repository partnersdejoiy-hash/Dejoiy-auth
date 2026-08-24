import { query, withTransaction } from "../db/pool.js";
import { getConfig } from "../config.js";
import { encryptSecret, hashToken, randomToken } from "../crypto.js";
import { generateTotpSecret, otpauthUri, verifyTOTP } from "./totp.js";
import { errors } from "../errors.js";
import { recordAudit } from "./audit.js";
import { recordSecurityEvent, SECURITY_EVENT_TYPES } from "./security-events.js";
import { emitEvent } from "./events.js";

/**
 * MFA-ready architecture:
 * - TOTP factors (enroll, verify, revoke, reset)
 * - Recovery codes (single-use, hashed at rest)
 * - WebAuthn seam (factor_type 'webauthn' reserved)
 */

export interface EnrollTotpResult {
  factorId: string;
  secret: string;          // shown once for authenticator enrollment
  otpauthUri: string;
  recoveryCodes: string[]; // shown once, hashed at rest
}

export async function enrollTotp(
  userId: string,
  ctx?: { correlationId?: string | null; ip?: string | null }
): Promise<EnrollTotpResult> {
  const cfg = getConfig();
  const existing = await query("SELECT 1 FROM mfa_factors WHERE user_id = $1 AND status = 'active'", [userId]);
  if (existing.rows.length > 0) {
    throw errors.conflict("An active MFA factor already exists");
  }

  const secret = generateTotpSecret();
  const encrypted = encryptSecret(secret, cfg.DATA_ENCRYPTION_KEY);
  const user = await query<{ email: string | null; user_number: string }>(
    "SELECT email, user_number FROM users WHERE id = $1",
    [userId]
  );
  const account = user.rows[0]?.email ?? user.rows[0]?.user_number ?? "DEJOIY User";

  const { rows } = await query<{ id: string }>(
    `INSERT INTO mfa_factors (user_id, factor_type, label, secret_encrypted, status)
     VALUES ($1,'totp',$2,$3,'active') RETURNING id`,
    [userId, "Authenticator App", encrypted]
  );
  const factorId = rows[0]!.id;

  // Generate recovery codes
  const recoveryCodes: string[] = [];
  await withTransaction(async (client) => {
    for (let i = 0; i < 10; i++) {
      const code = `DJY-${randomToken(6).toUpperCase()}-${randomToken(4).toUpperCase()}`;
      recoveryCodes.push(code);
      await client.query(
        `INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1,$2)`,
        [userId, hashToken(code)]
      );
    }
  });

  await query("UPDATE users SET mfa_enabled = true WHERE id = $1", [userId]);
  await recordAudit({
    actorUserId: userId,
    action: "MFA_ENROLLED",
    targetType: "user",
    targetId: userId,
    correlationId: ctx?.correlationId ?? null,
    ip: ctx?.ip ?? null,
    after: { factorType: "totp" }
  });
  await recordSecurityEvent({
    eventType: SECURITY_EVENT_TYPES.MFA_ENROLLED,
    severity: "medium",
    userId,
    ip: ctx?.ip ?? null,
    correlationId: ctx?.correlationId
  });
  await emitEvent("mfa.enabled", {
    userId,
    factorType: "totp"
  }, { correlationId: ctx?.correlationId, actorUserId: userId });

  return {
    factorId,
    secret,
    otpauthUri: otpauthUri({ secret, account, issuer: "DEJOIY AUTH" }),
    recoveryCodes
  };
}

/** Verify a TOTP code against the user's active factor (used for re-auth). */
export async function verifyTotpForUser(userId: string, code: string): Promise<boolean> {
  const { rows } = await query<{ id: string; secret_encrypted: string | null }>(
    `SELECT id, secret_encrypted FROM mfa_factors WHERE user_id = $1 AND factor_type = 'totp' AND status = 'active' LIMIT 1`,
    [userId]
  );
  const factor = rows[0];
  if (!factor?.secret_encrypted) return false;
  const { decryptSecret } = await import("../crypto.js");
  const secret = decryptSecret(factor.secret_encrypted, getConfig().DATA_ENCRYPTION_KEY);
  if (!secret) return false;
  const ok = verifyTOTP(secret, code);
  if (ok) {
    await query("UPDATE mfa_factors SET last_used_at = now() WHERE id = $1", [factor.id]);
  }
  return ok;
}

/** Use a recovery code (single-use, hashed at rest). */
export async function useRecoveryCode(userId: string, code: string): Promise<boolean> {
  const codeHash = hashToken(code.trim().toUpperCase());
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())`,
    [userId, codeHash]
  );
  if (rows.length === 0) return false;
  await query("UPDATE recovery_codes SET used_at = now() WHERE id = $1", [rows[0]!.id]);
  return true;
}

export async function resetMfa(
  userId: string,
  actor?: { id?: string; role?: string; ip?: string; correlationId?: string }
): Promise<void> {
  const target = await query("SELECT email, user_number FROM users WHERE id = $1", [userId]);
  if (target.rows.length === 0) throw errors.notFound("User not found");

  await query("UPDATE mfa_factors SET status = 'revoked' WHERE user_id = $1 AND status = 'active'", [userId]);
  await query("DELETE FROM recovery_codes WHERE user_id = $1", [userId]);
  await query("UPDATE users SET mfa_enabled = false WHERE id = $1", [userId]);

  await recordAudit({
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: "MFA_RESET",
    targetType: "user",
    targetId: userId,
    targetLabel: target.rows[0]?.email ?? target.rows[0]?.user_number,
    correlationId: actor?.correlationId ?? null,
    ip: actor?.ip ?? null
  });
  await recordSecurityEvent({
    eventType: SECURITY_EVENT_TYPES.MFA_RESET,
    severity: "high",
    userId,
    ip: actor?.ip ?? null,
    correlationId: actor?.correlationId ?? null
  });
  await emitEvent("mfa.reset", {
    userId,
    actorUserId: actor?.id ?? null
  }, { correlationId: actor?.correlationId, actorUserId: actor?.id });
}

export async function listMfaStatus(userId: string) {
  const { rows } = await query(
    `SELECT id, factor_type, label, status, last_used_at, created_at
       FROM mfa_factors WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  const { rows: codes } = await query<{ unused: number }>(
    `SELECT count(*)::int AS unused FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  return { factors: rows, unusedRecoveryCodes: codes[0]?.unused ?? 0 };
}
