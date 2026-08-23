import { getConfig } from "../config.js";
import { errors } from "../errors.js";
import { countSuperAdmins, assignRoleToUser } from "./rbac.js";
import { createUser, findUserByEmail } from "./user.js";
import { evaluatePassword } from "./password.js";
import { recordAudit } from "./audit.js";
import { recordSecurityEvent } from "./security-events.js";
import { sendNotificationEmail, welcomeEmail } from "./notification.js";

/**
 * First-run Super Admin bootstrap.
 *
 * Security rules:
 * - Refuses to run when any Super Admin already exists.
 * - Requires BOOTSTRAP_SECRET from the environment (never hardcoded).
 * - The bootstrap password is supplied by the operator, not stored in source.
 * - The account is created with PASSWORD_RESET_REQUIRED so the first sign-in
 *   forces a password change; MFA enrollment is required for privileged ops.
 */
export async function bootstrapSuperAdmin(input: {
  email: string;
  bootstrapSecret: string;
  password: string;
  fullName?: string;
}): Promise<{ userNumber: string; email: string; passwordResetRequired: boolean }> {
  const cfg = getConfig();
  const expectedEmail = (cfg.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase();

  if (await countSuperAdmins() > 0) {
    throw errors.conflict("Super Admin already exists. Bootstrap is disabled.");
  }

  // Constant-time-ish comparison of the bootstrap secret.
  const provided = Buffer.from(input.bootstrapSecret);
  const expected = Buffer.from(cfg.BOOTSTRAP_SECRET);
  if (provided.length !== expected.length || !provided.equals(expected)) {
    await recordSecurityEvent({
      eventType: "bootstrap.denied",
      severity: "critical",
      metadata: { reason: "invalid_bootstrap_secret" }
    });
    throw errors.forbidden("Invalid bootstrap secret");
  }

  if (expectedEmail && input.email.trim().toLowerCase() !== expectedEmail) {
    throw errors.forbidden("Bootstrap email does not match BOOTSTRAP_ADMIN_EMAIL");
  }

  const passwordCheck = evaluatePassword(input.password, {
    email: input.email,
    privileged: true
  });
  if (!passwordCheck.ok) {
    throw errors.validation(passwordCheck.errors.join("; "));
  }

  const existing = await findUserByEmail(input.email);
  if (existing) {
    throw errors.conflict("A user with this email already exists");
  }

  const user = await createUser({
    userType: "admin",
    email: input.email,
    password: input.password,
    fullName: input.fullName ?? "Super Admin",
    accountState: "PASSWORD_RESET_REQUIRED",
    mfaRequired: true,
    roles: []
  });

  await assignRoleToUser(user.id, "SUPER_ADMIN", null);

  await recordAudit({
    action: "SUPER_ADMIN_BOOTSTRAPPED",
    targetType: "user",
    targetId: user.id,
    targetLabel: user.email ?? user.user_number,
    after: { account_state: "PASSWORD_RESET_REQUIRED" }
  });
  await recordSecurityEvent({
    eventType: "bootstrap.success",
    severity: "critical",
    userId: user.id,
    metadata: { userNumber: user.user_number }
  });

  await sendNotificationEmail("welcome", welcomeEmail(input.fullName ?? "Super Admin"), { to: input.email });

  return {
    userNumber: user.user_number,
    email: user.email!,
    passwordResetRequired: true
  };
}
