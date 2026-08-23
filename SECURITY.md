# DEJOIY AUTH — Security

DEJOIY AUTH implements **defense-in-depth**. No system is "unhackable"; this document describes the
layers we control, the threat model we defend against, and how to respond when something goes wrong.

## 1. Core principles

1. **The database is the source of truth.** Never store identity secrets in Zoho Sheet, logs, emails,
   dashboards or frontend bundles.
2. **No plaintext secrets anywhere.** Passwords are Argon2id-hashed. Refresh tokens, recovery codes and
   MFA secrets are stored hashed or encrypted.
3. **Backend enforces everything.** Frontend checks are cosmetic.
4. **Least privilege.** Roles are not permissions; every endpoint declares required permissions.
5. **Auditable.** Every privileged action leaves an audit trail with correlation IDs.

## 2. Password storage

- **Argon2id** with OWASP-recommended parameters (memory 19 MiB, iterations 2, parallelism 1; type 2,
  Argon2id variant) — configurable via env.
- Password history (configurable depth, default 10) prevents reuse.
- Common-password blocklist, breached-password detection hook (e.g. HaveIBeenPwned k-anonymity via the
  provider seam — configured by the operator), sequential/repeated character detection, and
  username/email/company-token blocking.

## 3. Token & session security

| Token | Lifetime | Storage | Notes |
| --- | --- | --- | --- |
| Access token (JWT) | 15 min default | Memory (client) or HttpOnly cookie | Stateless, signed HS256 with `ACCESS_TOKEN_SECRET` |
| Refresh token | 30 days default | DB (SHA-256 hash) | Opaque, rotated on every use |
| Authorization code | 5 min | Redis (encrypted) | OIDC/OAuth2, PKCE-verified |
| Password reset token | 15 min | Redis (hashed) | Single-use |
| Recovery code | 30 days | DB (hashed) | Single-use |

- **Refresh-token reuse detection**: if a rotated token is presented again, the entire token family is
  revoked and a security event fires.
- Password change revokes all sessions except the current one (configurable).
- Session/device tracking with last-active, IP and user-agent metadata; idle + absolute expiry.
- Re-authentication is required for privileged actions (super admin dangerous operations).

## 4. Transport & cookie security

- HTTPS-only in production (`DEPLOYMENT.md`).
- Cookies: `HttpOnly`, `Secure`, `SameSite=Lax` (with `SameSite=None` option for cross-site OIDC when
  explicitly configured), signed.
- Strict CORS allow-list, CSRF protection for cookie-authenticated mutation endpoints.

## 5. HTTP security headers

Applied by the API and the web server:

- `Content-Security-Policy` (script-src self, no inline except nonce where needed, `frame-ancestors 'none'`)
- `Strict-Transport-Security` (HSTS, configurable max-age, includes subdomains)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (aligned with frame-ancestors)
- `Referrer-Policy: no-referrer`
- `Permissions-Policy` (camera/mic/geolocation disabled)

## 6. Abuse protection

- Redis-backed rate limiting: global + per-route buckets (auth endpoints stricter).
- Per-account failed-attempt counter with lockout; per-IP throttling with progressive delays.
- Suspicious-login detection heuristics (new device + new geo/ASN, impossible travel placeholder,
  tor/proxy heuristics seam).
- Account lockout state `LOCKED` with admin unlock flow.
- All login attempts recorded in `login_attempts`; failures in `security_events`.

## 7. Input/output hygiene

- All inputs validated with Zod (typed schemas per route).
- SQL via parameterized queries only (`pg` with bound params) — no string interpolation.
- Output sanitized; no secrets in any response payload.
- Open-redirect protection: `redirect_uri` must exactly match a registered application URI.
- SSRF guardrails on the Zoho sync worker and mail adapters (allow-listed hosts, no user-supplied URLs).

## 8. Logging

- Structured JSON logs with `correlationId`, `requestId`, `errorId`, `securityEventId`.
- Automatic redaction of: passwords, tokens, cookies, authorization headers, MFA secrets, API keys.
- Error emails contain only safe metadata (error ID, timestamp, service, severity, correlation ID).

## 9. Known-configuration checklist (production)

- [ ] `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `DATA_ENCRYPTION_KEY`, `COOKIE_SECRET` replaced
      with `openssl rand -hex 32` values.
- [ ] `BOOTSTRAP_SECRET` replaced and then the first-run bootstrap completed; env removed after.
- [ ] PostgreSQL and Redis on private networks only.
- [ ] TLS termination at the reverse proxy with HSTS on.
- [ ] `CORS_ORIGINS` narrowed to real origins.
- [ ] `MAIL_PROVIDER` set to a real provider (not `console`).
- [ ] `ZOHO_*` credentials filled server-side only.
- [ ] Backups encrypted and tested (`DEPLOYMENT.md`).

## 10. Incident response basics

1. **Contain** — revoke the affected sessions (`DELETE /sessions`), block the user or IP, suspend the
   account.
2. **Assess** — pull `audit_logs` and `security_events` for the affected correlation IDs/time window.
3. **Notify** — trigger the security-alert mail event to `MAIL_ERRORS_FROM` recipients.
4. **Recover** — force password reset, reset MFA, rotate the affected token family (automatic on reuse
   detection).
5. **Learn** — update policies, permissions, or heuristics; document in `SECURITY.md`.

## 11. Reporting a vulnerability

Contact DEJOIY security operations directly. Include the affected version, steps to reproduce, and
impact. Do not share credentials or live data.
