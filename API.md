# DEJOIY AUTH — API Reference

Base URL: `https://auth.dejoiy.com/api/v1` (dev: `http://localhost:8096/api/v1`)

Authentication: `Authorization: Bearer <accessToken>` for protected endpoints.
Errors use the envelope `{ "error": { "code", "message", "details?", "correlationId", "errorId?" } }`.

## Authentication

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/login` | – | Password sign-in. Returns `accessToken`, `refreshToken`, `user`, or `mfaChallenge` when TOTP is enrolled. |
| POST | `/auth/mfa/verify` | – | Complete sign-in with `identifier`, `code`, `challenge`. |
| POST | `/auth/refresh` | – | Rotate `refreshToken`. Reuse detection revokes the token family. |
| POST | `/auth/logout` | ✔ | Revoke the current session. |
| POST | `/auth/forgot-password` | – | Request a password reset email (uniform response, no enumeration). |
| POST | `/auth/reset-password` | – | `token` + `password` (single-use, 15 min TTL). Revokes other sessions. |
| POST | `/auth/verify-email` | – | Verify with emailed `token`. |
| POST | `/auth/resend-verification` | ✔ | Re-send verification email. |
| POST | `/auth/change-password` | ✔ | `currentPassword` + `newPassword`. Revokes other sessions. |
| GET | `/auth/me` | ✔ | Current identity: `{ id, userNumber, email, fullName, roles, permissions, mfaRequired }`. |
| GET | `/auth/session-status` | ✔ | `{ valid, sessionId }`. |

## Users (RBAC enforced)

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/users?search=&state=&userType=&role=&limit=&offset=` | `user.read` | List identities |
| GET | `/users/:id` | `user.read` | Full user detail (profile, roles, employee, wfm) |
| POST | `/users` | `user.create` | Create identity |
| PATCH | `/users/:id` | `user.update` | Update profile fields |
| POST | `/users/:id/activate` `/suspend` `/block` `/disable` `/terminate` | lifecycle perms | Change account state |
| POST | `/users/:id/unblock` | `user.unblock` | Unblock (→ ACTIVE) |
| POST | `/users/:id/unlock` | `user.unlock` | Clear lock + Redis throttle |
| POST | `/users/:id/force-logout` | `user.force_logout` | Revoke all sessions |
| POST | `/users/:id/roles` | `role.assign` | Set roles `{ roles: [...] }` |
| POST | `/users/:id/reset-password` | `user.reset_password` | Admin password reset (+`forceChange`) |
| POST | `/users/:id/reset-mfa` | `user.reset_mfa` | Revoke MFA factors + recovery codes |
| DELETE | `/users/:id` | `user.delete` | Soft delete |
| GET | `/users/:id/sessions` | `session.read` | Sessions |
| GET | `/users/:id/devices` | `device.read` | Devices |

## Roles & Permissions

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/roles` | `role.read` (includes each role's permissions) |
| POST | `/roles` | `role.create` |
| PATCH | `/roles/:id` | `role.update` / `permission.assign` |
| DELETE | `/roles/:id` | `role.delete` |
| GET | `/permissions` | `permission.read` |
| POST | `/permissions` | `permission.assign` |

## Sessions & Devices

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/sessions/me` | own |
| DELETE | `/sessions/me/:id` | own |
| DELETE | `/sessions/:id` | `session.revoke` |
| POST | `/sessions/global-logout` | `session.global_logout` |
| GET | `/devices/me` · DELETE `/devices/me/:id` | own |
| DELETE | `/devices/:id?userId=` | `device.revoke` |

## MFA

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/mfa/totp/enroll` | own — returns `secret`, `otpauthUri`, one-time `recoveryCodes` |
| POST | `/mfa/totp/verify` | own |
| POST | `/mfa/recovery/use` | own |
| GET | `/mfa/status` | own |

## Security & Audit

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/security/events` | `security.read` |
| GET | `/security/dashboard` | `security.read` / `audit.read` |
| GET | `/security/system-health` | `system.config.read` |
| GET | `/audit/logs` · `/audit` | `audit.read` |

## Applications & OAuth

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/applications` | `application.read` |
| POST | `/applications` | `application.create` — returns one-time `clientSecret` |
| PATCH/DELETE | `/applications/:id` | `application.update` / `application.delete` |
| POST | `/oauth/clients/:clientId/rotate-secret` | `oauth.client.manage` |

## OIDC

| Method | Path |
| --- | --- |
| GET | `/oidc/.well-known/openid-configuration` |
| GET | `/oidc/jwks` — public Ed25519 keys for external token verification |
| GET | `/oidc/authorize` (authenticated browser redirect) |
| POST | `/oidc/token` (`authorization_code` + PKCE, `refresh_token`, `client_credentials`) |
| GET | `/oidc/userinfo` |
| POST | `/oidc/rotate-keys` — rotate JWT signing keys (admin only) |
| GET | `/oidc/pkce/new` · POST `/oidc/pkce` |

## WFM

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/wfm/employees` | `wfm.employee.manage` / `user.read` |
| POST | `/wfm/employees` | `wfm.employee.manage` (onboarding) |
| GET | `/wfm/activation-queue` | `wfm.employee.manage` |
| POST | `/wfm/bulk-lifecycle` | `wfm.employee.manage` |
| POST | `/wfm/employees/:id/absconded` | `wfm.employee.manage` |
| POST | `/wfm/employees/:id/access-eligibility` | `wfm.access_eligibility.manage` |
| POST | `/wfm/me/status` | own |
| GET | `/wfm/employees/:id` | `wfm.employee.manage` / `user.read` |
| GET | `/wfm/departments` · `/wfm/shifts` | `user.read` / `wfm.shift.read` |

## IT

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/it/health` | `system.config.read` |
| GET | `/it/incidents` | `security.read` |
| GET | `/it/notifications` | `notification.read` |
| GET | `/it/logs` | `system.config.read` |
| GET | `/it/sync-jobs` | `sync.zoho.read` |
| POST | `/it/users/:id/force-logout` | `user.force_logout` |

## Sync & System

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/sync/zoho-sheet` | `sync.zoho.run` |
| GET | `/sync/zoho-sheet` · `/sync/zoho-sheet/fields` | `sync.zoho.read` |
| POST | `/bootstrap/super-admin` | first-run only |

## Health (no /api prefix)

`GET /health/live` · `GET /health/ready` · `GET /health` · `GET /health/system` · `GET /version`

## Webhooks (admin)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/webhooks` | `webhook.read` |
| GET | `/api/v1/webhooks/events` | `webhook.read` — list all event types |
| POST | `/api/v1/webhooks` | `webhook.create` |
| PATCH | `/api/v1/webhooks/:id` | `webhook.update` |
| DELETE | `/api/v1/webhooks/:id` | `webhook.delete` |
| POST | `/api/v1/webhooks/:id/rotate-secret` | `webhook.update` |
| POST | `/api/v1/webhooks/:id/test` | `webhook.test` |
| GET | `/api/v1/webhooks/:id/deliveries` | `webhook.read` |
| POST | `/api/v1/webhooks/verify-signature` | `webhook.read` |
