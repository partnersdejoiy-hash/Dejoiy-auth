import { query } from "../db/pool.js";
import { getConfig } from "../config.js";
import { sendMail } from "./mail/provider.js";
import { logger } from "../logger.js";
import { newErrorId } from "../errors.js";

export const EMAIL_EVENTS = {
  WELCOME: "welcome",
  VERIFY_EMAIL: "verify_email",
  PASSWORD_RESET: "password_reset",
  PASSWORD_CHANGED: "password_changed",
  NEW_LOGIN: "new_login",
  SUSPICIOUS_LOGIN: "suspicious_login",
  ACCOUNT_LOCKED: "account_locked",
  ACCOUNT_BLOCKED: "account_blocked",
  ACCOUNT_ACTIVATED: "account_activated",
  ACCOUNT_DEACTIVATED: "account_deactivated",
  MFA_ENABLED: "mfa_enabled",
  MFA_RESET: "mfa_reset",
  ADMIN_ACTION_ALERT: "admin_action_alert",
  SECURITY_ALERT: "security_alert",
  SYSTEM_ERROR: "system_error"
} as const;

export type EmailEvent = (typeof EMAIL_EVENTS)[keyof typeof EMAIL_EVENTS];

export interface EmailTemplateInput {
  subject: string;
  text: string;
  html?: string;
  correlationId?: string;
}

/**
 * Send a notification email through the configured provider.
 * payload must never contain secrets — templates are built from safe inputs.
 */
export async function sendNotificationEmail(
  event: EmailEvent,
  input: EmailTemplateInput,
  opts?: { isError?: boolean; to?: string }
): Promise<void> {
  const cfg = getConfig();
  const from = opts?.isError ? cfg.MAIL_ERRORS_FROM : cfg.MAIL_FROM;
  const to = opts?.to ?? "";

  let eventId: string | null = null;
  try {
    const { rows } = await query(
      `INSERT INTO notification_events (event_type, recipients, payload, status, correlation_id)
       VALUES ($1,$2,$3,'queued',$4) RETURNING id`,
      [event, JSON.stringify([to]), JSON.stringify({ subject: input.subject }), input.correlationId ?? null]
    );
    eventId = rows[0]?.id ?? null;

    await sendMail({
      to: to ? [to] : [],
      subject: input.subject,
      text: input.text,
      html: input.html,
      from,
      correlationId: input.correlationId
    });

    if (eventId) {
      await query(
        `UPDATE notification_events SET status = 'sent', sent_at = now() WHERE id = $1`,
        [eventId]
      );
    }
  } catch (err) {
    const errorId = newErrorId();
    logger.error({ err, event, errorId }, "notification send failed");
    if (eventId) {
      await query(
        `UPDATE notification_events SET status = 'failed', error = $2 WHERE id = $1`,
        [eventId, `ERR-${errorId}`]
      );
    }
    // Never rethrow secrets; a failed notification must not break auth flows.
  }
}

// ---- Templates ------------------------------------------------------------------

function baseHtml(body: string, title: string): string {
  const brand = "#00E5FF";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0B0B0B;font-family:Inter,Arial,sans-serif;color:#E8ECF4">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="text-align:center;margin-bottom:24px">
      <span style="font-size:20px;font-weight:700;letter-spacing:2px;color:${brand}">DEJOIY AUTH</span>
    </div>
    <div style="background:#0F1A2B;border:1px solid rgba(0,229,255,.25);border-radius:14px;padding:28px">
      <h1 style="font-size:18px;margin:0 0 12px;color:#FFFFFF">${title}</h1>
      <div style="font-size:14px;line-height:1.6">${body}</div>
    </div>
    <p style="font-size:12px;color:#7A8AA3;text-align:center;margin-top:20px">
      DEJOIY INDIA PRIVATE LIMITED · Security notice · Do not share codes or links.
    </p>
  </div></body></html>`;
}

export function welcomeEmail(name: string, verifyUrl?: string): EmailTemplateInput {
  const body = `
    <p>Welcome to DEJOIY, <strong>${esc(name)}</strong>. Your identity account is ready.</p>
    ${verifyUrl ? `<p><a href="${esc(verifyUrl)}" style="color:#00E5FF">Verify your email address</a></p>` : ""}
    <p>If you did not create this account, contact DEJOIY IT immediately.</p>`;
  return {
    subject: "Welcome to DEJOIY",
    text: `Welcome to DEJOIY, ${name}. Your identity account is ready.${verifyUrl ? `\nVerify your email: ${verifyUrl}` : ""}`,
    html: baseHtml(body, "Welcome to DEJOIY")
  };
}

export function verifyEmailEmail(verifyUrl: string, expiresMinutes = 60): EmailTemplateInput {
  const body = `<p>Confirm this email address to finish setting up your DEJOIY identity.</p>
    <p style="text-align:center"><a href="${esc(verifyUrl)}" style="display:inline-block;background:linear-gradient(90deg,#0099FF,#00E5FF);color:#06121F;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700">Verify email</a></p>
    <p>This link expires in ${expiresMinutes} minutes.</p>`;
  return {
    subject: "Verify your DEJOIY email",
    text: `Verify your email: ${verifyUrl} (expires in ${expiresMinutes} minutes)`,
    html: baseHtml(body, "Email verification")
  };
}

export function passwordResetEmail(resetUrl: string, expiresMinutes = 15): EmailTemplateInput {
  const body = `<p>We received a password reset request for your DEJOIY account.</p>
    <p style="text-align:center"><a href="${esc(resetUrl)}" style="display:inline-block;background:linear-gradient(90deg,#0099FF,#00E5FF);color:#06121F;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700">Reset password</a></p>
    <p>If you did not request this, ignore this email. The link expires in ${expiresMinutes} minutes.</p>`;
  return {
    subject: "Reset your DEJOIY password",
    text: `Reset your password: ${resetUrl} (expires in ${expiresMinutes} minutes). If you did not request this, ignore this email.`,
    html: baseHtml(body, "Password reset")
  };
}

export function passwordChangedEmail(): EmailTemplateInput {
  const body = `<p>Your DEJOIY password was changed. If this was not you, <strong>reset your password immediately</strong> and contact DEJOIY IT.</p>`;
  return {
    subject: "Your DEJOIY password was changed",
    text: "Your DEJOIY password was changed. If this was not you, reset your password immediately and contact DEJOIY IT.",
    html: baseHtml(body, "Password changed")
  };
}

export function newLoginEmail(name: string, ip: string | null | undefined, userAgent: string | null | undefined, location = "Unknown"): EmailTemplateInput {
  const body = `<p>Hi <strong>${esc(name)}</strong>, a new sign-in was detected on your DEJOIY account.</p>
    <ul><li>IP: ${esc(ip ?? "Unknown")}</li><li>Device: ${esc(userAgent ?? "Unknown")}</li><li>Location: ${esc(location)}</li></ul>
    <p>If this was you, no action is needed. Otherwise, secure your account now.</p>`;
  return {
    subject: "New sign-in to your DEJOIY account",
    text: `New sign-in detected. IP: ${ip ?? "Unknown"} · Device: ${userAgent ?? "Unknown"}. If this wasn't you, secure your account.`,
    html: baseHtml(body, "New sign-in detected")
  };
}

export function suspiciousLoginEmail(name: string, ip: string | null | undefined, userAgent: string | null | undefined): EmailTemplateInput {
  const body = `<p><strong style="color:#FF5C7A">Suspicious sign-in blocked or flagged</strong> on your DEJOIY account.</p>
    <ul><li>IP: ${esc(ip ?? "Unknown")}</li><li>Device: ${esc(userAgent ?? "Unknown")}</li></ul>
    <p>DEJOIY security may require re-authentication. Contact DEJOIY IT if this was you.</p>`;
  return {
    subject: "Suspicious sign-in on your DEJOIY account",
    text: `Suspicious sign-in flagged. IP: ${ip ?? "Unknown"}. Contact DEJOIY IT if this was you.`,
    html: baseHtml(body, "Suspicious sign-in")
  };
}

export function accountLockedEmail(name: string): EmailTemplateInput {
  const body = `<p>Your DEJOIY account was temporarily <strong>locked</strong> after repeated failed sign-in attempts.</p>
    <p>It will unlock automatically, or an administrator can unlock it. Contact DEJOIY IT if you need help.</p>`;
  return {
    subject: "Your DEJOIY account was locked",
    text: "Your DEJOIY account was locked after repeated failed sign-in attempts.",
    html: baseHtml(body, "Account locked")
  };
}

export function securityAlertEmail(subject: string, detail: string): EmailTemplateInput {
  const body = `<p>${detail}</p><p>This is an automated security notification from DEJOIY AUTH.</p>`;
  return { subject, text: detail, html: baseHtml(body, "Security alert") };
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
