import { randomToken } from "../crypto.js";
import { getConfig } from "../config.js";
import { query, withTransaction } from "../db/pool.js";
import { redisIncrEx, redisGet, redisSetEx, redisDel } from "../redis.js";
import { errors } from "../errors.js";
import { verifyPassword } from "../crypto.js";
import { evaluatePassword } from "./password.js";
import {
  findUserByIdentifier, findUserByEmail, getUserById, updatePassword,
  isPasswordReused, setAccountState
} from "./user.js";
import { getRolesForUser, getPermissionsForUser } from "./rbac.js";
import {
  createSession, rotateRefreshToken, logoutSession, revokeAllUserSessions, getSessionById
} from "./session.js";
import { issueAccessToken } from "./jwt.js";
import {
  recordSecurityEvent, SECURITY_EVENT_TYPES
} from "./security-events.js";
import {
  sendNotificationEmail, welcomeEmail, passwordResetEmail, passwordChangedEmail,
  newLoginEmail, suspiciousLoginEmail, accountLockedEmail, verifyEmailEmail
} from "./notification.js";
import { recordAudit } from "./audit.js";

export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
  clientNonce?: string;
  correlationId: string | null;
  sessionId?: string | null;
}

// ---- Rate limiting / throttling -------------------------------------------------

const ACCOUNT_ATTEMPTS_KEY = (userId: string) => `auth:attempts:${userId}`;
const IP_ATTEMPTS_KEY = (ip: string) => `auth:ip:${ip}`;
const LOCK_KEY = (userId: string) => `auth:lock:${userId}`;
const RESET_KEY = (email: string) => `auth:reset:${email}`;
const VERIFY_KEY = (userId: string) => `auth:verify:${userId}`;

async function checkAccountLock(userId: string): Promise<void> {
  const lockTtl = await redisGet(LOCK_KEY(userId));
  if (lockTtl) throw errors.locked();
}

/** Progressive delay proportional to recent failures (per IP). */
async function progressiveDelay(ip: string): Promise<void> {
  const cfg = getConfig();
  const attempts = Number(await redisGet(IP_ATTEMPTS_KEY(ip)) ?? 0);
  if (attempts > 1) {
    const ms = Math.min(5000, (attempts - 1) * cfg.LOGIN_PROGRESSIVE_DELAY_STEP_MS);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }
}

async function recordLoginAttempt(input: {
  userId?: string | null;
  identifier?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  success: boolean;
  failureReason?: string | null;
  correlationId?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO login_attempts (user_id, identifier, ip, user_agent, success, failure_reason, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.userId ?? null,
      input.identifier ?? null,
      input.ip ?? null,
      input.userAgent ?? null,
      input.success,
      input.failureReason ?? null,
      input.correlationId ?? null
    ]
  );
}

// ---- Login -----------------------------------------------------------------------

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: {
    id: string;
    userNumber: string;
    email: string | null;
    fullName: string | null;
    roles: string[];
    permissions: string[];
    mfaRequired: boolean;
  };
  mfaChallenge?: { factorId: string; challenge: string; expiresIn: number };
}

const MFA_CHALLENGE_TTL = 300;

export async function login(
  identifier: string,
  password: string,
  ctx: LoginContext
): Promise<LoginResult> {
  const cfg = getConfig();
  const correlationId = ctx.correlationId;

  // Generic failure to avoid user enumeration on the wire.
  const fail = async (
    reason: string,
    eventType: string,
    severity: "low" | "medium" | "high" = "medium"
  ): Promise<never> => {
    await recordLoginAttempt({
      identifier, ip: ctx.ip, userAgent: ctx.userAgent, success: false,
      failureReason: reason, correlationId
    });
    await recordSecurityEvent({
      eventType, severity, ip: ctx.ip, userAgent: ctx.userAgent,
      metadata: { reason }, correlationId
    });
    throw errors.invalidCredentials();
  };

  await progressiveDelay(ctx.ip ?? "unknown");

  const user = await findUserByIdentifier(identifier);
  if (!user) {
    // Rate-limit the identifier even when it does not exist (prevents enumeration spikes).
    await redisIncrEx(`auth:unknown:${identifier.toLowerCase()}`, cfg.LOGIN_LOCKOUT_WINDOW_SECONDS);
    await fail("user_not_found", SECURITY_EVENT_TYPES.LOGIN_FAILED, "low");
  }
  if (!user) throw errors.invalidCredentials();

  await checkAccountLock(user.id);

  const passwordOk = user.password_hash ? await verifyPassword(user.password_hash, password) : false;
  if (!passwordOk) {
    const attempts = await redisIncrEx(ACCOUNT_ATTEMPTS_KEY(user.id), cfg.LOGIN_LOCKOUT_WINDOW_SECONDS);
    await redisIncrEx(IP_ATTEMPTS_KEY(ctx.ip ?? "unknown"), cfg.LOGIN_LOCKOUT_WINDOW_SECONDS);

    if (attempts >= cfg.LOGIN_MAX_ATTEMPTS) {
      await redisSetEx(LOCK_KEY(user.id), cfg.LOGIN_LOCKOUT_DURATION_SECONDS, "1");
      await setAccountState(user.id, "LOCKED");
      await recordSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.LOGIN_LOCKOUT,
        severity: "high", userId: user.id, ip: ctx.ip, userAgent: ctx.userAgent,
        metadata: { attempts }, correlationId
      });
      await sendNotificationEmail("account_locked", accountLockedEmail(user.email ?? user.user_number), { to: user.email ?? user.user_number });
      await fail("account_locked", SECURITY_EVENT_TYPES.LOGIN_FAILED, "high");
    }

    await recordLoginAttempt({
      userId: user.id, identifier, ip: ctx.ip, userAgent: ctx.userAgent, success: false,
      failureReason: "invalid_password", correlationId
    });
    await recordSecurityEvent({
      eventType: SECURITY_EVENT_TYPES.LOGIN_FAILED, severity: "low", userId: user.id,
      ip: ctx.ip, userAgent: ctx.userAgent, metadata: { attempts }, correlationId
    });
    throw errors.invalidCredentials();
  }

  // Password OK — clear attempt counters.
  await redisDel(ACCOUNT_ATTEMPTS_KEY(user.id), LOCK_KEY(user.id));

  // Account state gate.
  const lockedStates = new Set(["BLOCKED", "TERMINATED", "DISABLED", "SUSPENDED"]);
  if (lockedStates.has(user.account_state)) {
    await fail("account_" + user.account_state.toLowerCase(), SECURITY_EVENT_TYPES.LOGIN_FAILED, "high");
  }

  // MFA challenge (enrolled factor) — do not issue tokens yet.
  const activeFactor = await getActiveMfaFactor(user.id);
  if (activeFactor) {
    const challenge = randomToken(24);
    await redisSetEx(`auth:mfa:${user.id}`, MFA_CHALLENGE_TTL, JSON.stringify({ challenge, passwordOk: true }));
    await recordSecurityEvent({
      eventType: "login.mfa_challenge", severity: "info", userId: user.id,
      ip: ctx.ip, userAgent: ctx.userAgent, correlationId
    });
    return {
      accessToken: "",
      refreshToken: "",
      sessionId: "",
      user: await buildUserPayload(user.id),
      mfaChallenge: { factorId: activeFactor.id, challenge, expiresIn: MFA_CHALLENGE_TTL }
    };
  }

  return finalizeLogin(user.id, ctx, { wasSuspicious: false });
}

export async function verifyMfaAndLogin(
  identifier: string,
  mfaCode: string,
  challenge: string,
  ctx: LoginContext
): Promise<LoginResult> {
  const user = await findUserByIdentifier(identifier);
  if (!user) throw errors.invalidCredentials();

  const storedRaw = await redisGet(`auth:mfa:${user.id}`);
  if (!storedRaw) throw errors.unauthorized("MFA challenge expired or missing");
  const stored = JSON.parse(storedRaw) as { challenge: string; passwordOk: boolean };
  if (stored.challenge !== challenge) throw errors.unauthorized("Invalid MFA challenge");

  const ok = await verifyMfaCode(user.id, mfaCode);
  if (!ok) {
    await recordSecurityEvent({
      eventType: SECURITY_EVENT_TYPES.MFA_FAILED, severity: "high", userId: user.id,
      ip: ctx.ip, userAgent: ctx.userAgent, correlationId: ctx.correlationId
    });
    throw errors.unauthorized("Invalid MFA code");
  }

  await redisDel(`auth:mfa:${user.id}`);
  return finalizeLogin(user.id, ctx, { wasSuspicious: false });
}

async function finalizeLogin(
  userId: string,
  ctx: LoginContext,
  opts: { wasSuspicious: boolean }
): Promise<LoginResult> {
  const user = await getUserById(userId);
  if (!user) throw errors.unauthorized();

  const session = await createSession({
    userId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    clientNonce: ctx.clientNonce
  });

  await query(
    "UPDATE users SET last_login_at = now(), last_login_ip = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1",
    [userId, ctx.ip ?? null]
  );

  const payload = await buildUserPayload(userId);

  await recordLoginAttempt({
    userId, identifier: user.email ?? user.user_number, ip: ctx.ip, userAgent: ctx.userAgent,
    success: true, correlationId: ctx.correlationId
  });
  await recordSecurityEvent({
    eventType: SECURITY_EVENT_TYPES.LOGIN_SUCCESS, severity: "info", userId,
    ip: ctx.ip, userAgent: ctx.userAgent,
    metadata: { sessionId: session.sessionId, suspicious: opts.wasSuspicious },
    correlationId: ctx.correlationId
  });

  // New-login + suspicious-login notifications (best-effort, async-safe).
  void sendNotificationEmail("new_login", newLoginEmail(payload.fullName ?? "there", ctx.ip, ctx.userAgent), { to: payload.email ?? undefined });
  if (opts.wasSuspicious) {
    void sendNotificationEmail("suspicious_login", suspiciousLoginEmail(payload.fullName ?? "there", ctx.ip, ctx.userAgent), { to: payload.email ?? undefined });
  }

  const accessToken = await issueAccessToken({
    userId,
    userNumber: payload.userNumber,
    role: payload.roles[0] ?? "CUSTOMER",
    permissions: payload.permissions,
    sessionId: session.sessionId
  });

  return {
    accessToken,
    refreshToken: session.refreshToken,
    sessionId: session.sessionId,
    user: payload
  };
}

export async function buildUserPayload(userId: string): Promise<LoginResult["user"]> {
  const user = await getUserById(userId);
  if (!user) throw errors.unauthorized();
  const [roles, permissions, profile] = await Promise.all([
    getRolesForUser(userId),
    getPermissionsForUser(userId),
    query<{ full_name: string | null }>("SELECT full_name FROM user_profiles WHERE user_id = $1", [userId])
  ]);
  return {
    id: user.id,
    userNumber: user.user_number,
    email: user.email,
    fullName: profile.rows[0]?.full_name ?? null,
    roles: roles.map((r) => r.name),
    permissions: [...permissions],
    mfaRequired: user.mfa_required
  };
}

// ---- Refresh / logout -------------------------------------------------------------

export async function refresh(
  refreshToken: string,
  ctx: LoginContext
): Promise<{ accessToken: string; refreshToken: string; userId: string; sessionId: string; permissions: string[]; roles: string[] }> {
  const rotated = await rotateRefreshToken(refreshToken, ctx);
  const session = await getSessionById(rotated.sessionId);
  if (!session) throw errors.unauthorized("Session not found");
  if (session.user_id !== rotated.userId) throw errors.unauthorized("Session mismatch");

  const user = await getUserById(rotated.userId);
  if (!user) throw errors.unauthorized();
  if (user.account_state === "BLOCKED" || user.account_state === "TERMINATED" || user.account_state === "DISABLED") {
    await logoutSession(rotated.sessionId);
    throw errors.forbidden("Account is not active");
  }

  const [roles, permissions] = await Promise.all([
    getRolesForUser(rotated.userId),
    getPermissionsForUser(rotated.userId)
  ]);
  const accessToken = await issueAccessToken({
    userId: rotated.userId,
    userNumber: user.user_number,
    role: roles[0]?.name ?? "CUSTOMER",
    permissions: [...permissions],
    sessionId: rotated.sessionId
  });
  return {
    accessToken,
    refreshToken: rotated.refreshToken,
    userId: rotated.userId,
    sessionId: rotated.sessionId,
    permissions: [...permissions],
    roles: roles.map((r) => r.name)
  };
}

export async function logout(sessionId: string): Promise<void> {
  await logoutSession(sessionId);
}

// ---- Password recovery --------------------------------------------------------------

export async function forgotPassword(email: string, ctx: LoginContext): Promise<void> {
  const cfg = getConfig();
  const normalized = email.trim().toLowerCase();
  // Prevent reset-token flooding per address.
  const last = await redisGet(RESET_KEY(normalized));
  if (last) return; // silent: never reveal whether the address exists

  const user = await findUserByEmail(normalized);
  if (!user) {
    // Still burn the rate-limit to prevent enumeration via timing.
    await redisSetEx(RESET_KEY(normalized), 60, "1");
    return;
  }

  const token = randomToken(32);
  const tokenHash = (await import("../crypto.js")).hashToken(token);
  const ttlSeconds = 900; // 15 minutes
  await query(
    `INSERT INTO password_resets (user_id, token_hash, reset_type, expires_at, requested_ip)
     VALUES ($1,$2,'self',$3,$4)`,
    [user.id, tokenHash, new Date(Date.now() + ttlSeconds * 1000), ctx.ip ?? null]
  );
  await redisSetEx(RESET_KEY(normalized), 60, "1");

  const resetUrl = `${cfg.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await sendNotificationEmail("password_reset", passwordResetEmail(resetUrl, 15), { to: user.email ?? undefined });
  await recordSecurityEvent({
    eventType: SECURITY_EVENT_TYPES.PASSWORD_RESET, severity: "info", userId: user.id,
    ip: ctx.ip, userAgent: ctx.userAgent, correlationId: ctx.correlationId
  });
}

export async function resetPassword(
  token: string,
  newPassword: string,
  ctx: LoginContext
): Promise<void> {
  const tokenHash = (await import("../crypto.js")).hashToken(token);
  const { rows } = await query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
    `SELECT * FROM password_resets WHERE token_hash = $1`,
    [tokenHash]
  );
  const record = rows[0];
  if (!record || record.used_at) {
    await recordSecurityEvent({
      eventType: SECURITY_EVENT_TYPES.PASSWORD_RESET_ABUSE, severity: "high",
      ip: ctx.ip, correlationId: ctx.correlationId
    });
    throw errors.unauthorized("Invalid or expired reset token");
  }
  if (record.expires_at.getTime() < Date.now()) {
    throw errors.unauthorized("Reset token expired");
  }

  const user = await getUserById(record.user_id);
  if (!user) throw errors.notFound("User not found");

  const check = evaluatePassword(newPassword, {
    email: user.email ?? undefined,
    username: user.username ?? undefined
  });
  if (!check.ok) throw errors.validation(check.errors.join("; "));
  if (await isPasswordReused(user.id, newPassword)) {
    throw errors.validation("Password was used recently. Choose a different password.");
  }

  await updatePassword(user.id, newPassword, { correlationId: ctx.correlationId ?? undefined, ip: ctx.ip });
  await query("UPDATE password_resets SET used_at = now() WHERE id = $1", [record.id]);
  // Password changed → revoke all other sessions.
  await revokeAllUserSessions(user.id, "password_changed", { actor: { correlationId: ctx.correlationId ?? undefined } });
  await recordSecurityEvent({
    eventType: SECURITY_EVENT_TYPES.PASSWORD_CHANGED, severity: "info", userId: user.id,
    ip: ctx.ip, correlationId: ctx.correlationId
  });
  await sendNotificationEmail("password_changed", passwordChangedEmail(), { to: user.email ?? undefined });
}

// ---- Email verification -------------------------------------------------------------

export async function requestEmailVerification(userId: string, ctx: LoginContext): Promise<void> {
  const user = await getUserById(userId);
  if (!user?.email) throw errors.badRequest("No email on this account");

  const last = await redisGet(VERIFY_KEY(userId));
  if (last) throw errors.rateLimited("Verification email already sent. Check your inbox.");

  const token = randomToken(32);
  const tokenHash = (await import("../crypto.js")).hashToken(token);
  await query(
    `INSERT INTO email_verifications (user_id, token_hash, email, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [user.id, tokenHash, user.email, new Date(Date.now() + 3600 * 1000)]
  );
  await redisSetEx(VERIFY_KEY(userId), 60, "1");

  const verifyUrl = `${getConfig().APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await sendNotificationEmail("verify_email", verifyEmailEmail(verifyUrl, 60), { to: user.email });
}

export async function verifyEmail(token: string, ctx: LoginContext): Promise<void> {
  const tokenHash = (await import("../crypto.js")).hashToken(token);
  const { rows } = await query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
    `SELECT * FROM email_verifications WHERE token_hash = $1`,
    [tokenHash]
  );
  const record = rows[0];
  if (!record || record.used_at) throw errors.unauthorized("Invalid verification token");
  if (record.expires_at.getTime() < Date.now()) throw errors.unauthorized("Verification token expired");

  await query("UPDATE email_verifications SET used_at = now() WHERE id = $1", [record.id]);
  await query(
    `INSERT INTO system_settings (key, value, description) VALUES ('email_verified:' || $1, 'true', 'email verified')
     ON CONFLICT (key) DO UPDATE SET value = 'true'`,
    [record.user_id]
  );
  await recordSecurityEvent({
    eventType: SECURITY_EVENT_TYPES.EMAIL_VERIFIED, severity: "info", userId: record.user_id,
    ip: ctx.ip, correlationId: ctx.correlationId
  });
}

// ---- MFA (TOTP-ready) -------------------------------------------------------------------

interface MfaFactorRow {
  id: string;
  factor_type: string;
  secret_encrypted: string | null;
  status: string;
}

export async function getActiveMfaFactor(userId: string): Promise<MfaFactorRow | null> {
  const { rows } = await query<MfaFactorRow>(
    `SELECT * FROM mfa_factors WHERE user_id = $1 AND status = 'active' LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function verifyMfaCode(userId: string, code: string): Promise<boolean> {
  const factor = await getActiveMfaFactor(userId);
  if (!factor) return false;
  if (factor.factor_type === "totp" && factor.secret_encrypted) {
    const { decryptSecret } = await import("../crypto.js");
    const secret = decryptSecret(factor.secret_encrypted, getConfig().DATA_ENCRYPTION_KEY);
    if (!secret) return false;
    try {
      const { verifyTOTP } = await import("./totp.js");
      const ok = verifyTOTP(secret, code);
      if (ok) {
        await query("UPDATE mfa_factors SET last_used_at = now() WHERE id = $1", [factor.id]);
      }
      return ok;
    } catch {
      return false;
    }
  }
  // WebAuthn seam: factor_type 'webauthn' handled by a future assertion endpoint.
  return false;
}

/** Change own password (authenticated). Revokes other sessions. */
export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ctx: LoginContext
): Promise<void> {
  const user = await getUserById(userId);
  if (!user?.password_hash) throw errors.badRequest("Account has no password set");
  if (!(await verifyPassword(user.password_hash, currentPassword))) {
    throw errors.invalidCredentials("Current password is incorrect");
  }
  const check = evaluatePassword(newPassword, {
    email: user.email ?? undefined,
    username: user.username ?? undefined
  });
  if (!check.ok) throw errors.validation(check.errors.join("; "));
  if (await isPasswordReused(user.id, newPassword)) {
    throw errors.validation("Password was used recently. Choose a different password.");
  }
  await updatePassword(user.id, newPassword, { id: userId, correlationId: ctx.correlationId ?? undefined, ip: ctx.ip });
  await revokeAllUserSessions(userId, "password_changed", {
    exceptSessionId: ctx.sessionId ?? undefined,
    actor: { id: userId, correlationId: ctx.correlationId ?? undefined }
  });
  await recordAudit({
    actorUserId: userId, action: "PASSWORD_CHANGED_SELF", targetType: "user", targetId: userId,
    correlationId: ctx.correlationId, ip: ctx.ip
  });
  await sendNotificationEmail("password_changed", passwordChangedEmail(), { to: user.email ?? undefined });
}

export { welcomeEmail };
