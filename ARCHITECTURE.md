# DEJOIY AUTH — Architecture

## 1. System overview

DEJOIY AUTH is a centralized identity and access management (IAM) platform. It is the single source of
truth for who a user is, what roles they hold, and what they are allowed to do across every DEJOIY
application.

```
                        ┌────────────────────────────────────────────┐
                        │              DEJOIY AUTH                    │
                        │                                            │
  DEJOIY App ─────┐     │  ┌──────────┐   ┌───────────┐              │
  (web/mobile)    ├────▶│  │   API    │──▶│  AuthN    │──┐           │
                  │     │  │ Fastify  │   │  Service  │  │           │
                  │     │  └────┬─────┘   └───────────┘  ▼           │
                  │     │       │                         ┌────────┐ │
  Admin / IT /    │     │       │        ┌────────────────┤  RBAC  │ │
  WFM panels ─────┤     │       │        │                └────────┘ │
                  │     │       ▼        ▼                            │
                  │     │  ┌────────────────────┐   ┌──────────────┐  │
                  │     │  │     PostgreSQL     │   │    Redis     │  │
                  │     │  │  (source of truth) │   │ (ephemeral)  │  │
                  │     │  └────────────────────┘   └──────────────┘  │
                  │     │       │                        ▲            │
                  │     │       ▼                        │            │
                  │     │  ┌───────────────┐   ┌─────────┴───────┐    │
                  │     │  │  Sync Worker  │   │  Mail Adapter   │    │
                  │     │  └───────┬───────┘   └────────┬────────┘    │
                  │     └──────────┼────────────────────┼─────────────┘
                  │                ▼                    ▼
                  │       Zoho Sheet (sync layer)  DEJOIY Swiss Mail / SMTP / SES
                  ▼
        Access token + user + roles + permissions
```

## 2. Trust boundaries

1. **Public boundary** — login, password recovery, email verification, OIDC discovery. Rate limited.
2. **Authenticated boundary** — any valid access token. Enforces session validity and user state.
3. **Privileged boundary** — admin/IT/WFM APIs. Enforces RBAC permissions server-side.
4. **System boundary** — service-to-service (API clients / service accounts), Zoho sync worker,
   mail provider. Never exposed to browsers.

## 3. Data stores

| Store | Role | Source of truth |
| --- | --- | --- |
| PostgreSQL | Users, roles, permissions, sessions, devices, audit, security events, applications | **Yes** |
| Redis | Rate limits, login throttling, short-lived tokens (OTP/recovery), distributed locks | No (ephemeral) |
| Zoho Sheet | Controlled synchronization layer for identity inventory | No |

## 4. Authentication flow (password)

```
POST /auth/login
  ├─ validate input
  ├─ rate-limit (account + IP, Redis)
  ├─ progressive delay on repeated failures
  ├─ fetch user (by email/employee id/username)
  ├─ check account state (ACTIVE / PASSWORD_RESET_REQUIRED / ...)
  ├─ verify Argon2id hash
  ├─ record login_attempts + security events
  ├─ create session + device record (fingerprint)
  ├─ issue access token (short-lived JWT) + refresh token (opaque, rotated)
  └─ set HttpOnly cookie + return token payload
```

Refresh tokens are **opaque, stored hashed, and rotated on every use**. Reuse of a previously rotated
token triggers **reuse detection**: the whole token family is revoked and the user is alerted.

## 5. Authorization

- `roles` — named sets of permissions (e.g. `SUPER_ADMIN`, `IT_ADMIN`, `WFM_MANAGER`).
- `permissions` — fine-grained capabilities such as `user.delete`, `ticket.update`.
- `role_permissions` — many-to-many. Editable from the Admin panel.
- `user_roles` — users can hold multiple roles where the architecture allows.
- Every protected endpoint declares the permission(s) it requires; the RBAC hook enforces them.
  Frontend checks are only cosmetic — the backend always enforces.

## 6. Sessions & devices

- A login creates a `session` row and a `device` row (privacy-conscious fingerprint: SHA-256 of
  normalized UA + IP prefix + a client-issued nonce).
- Sessions carry: created/last-active/expires times, IP + UA metadata, re-auth state, revocation.
- Password change revokes all sessions except the current one. Admins can revoke any session or force
  a global logout.

## 7. Audit & security events

- `audit_logs` — every privileged action (actor, action, target, correlation ID, result, state deltas).
- `security_events` — suspicious-login detection, lockouts, reuse detection, blocked actions, anomalies.
- Logs are write-once as practical (no update paths), never contain secrets, and are surfaced in the
  Admin → Security screens.

## 8. Background workers

| Worker | Purpose | Trigger |
| --- | --- | --- |
| Zoho sync worker | Push sanitized identity inventory `DB → Sheet` | Interval + manual (admin) |
| Notification worker | Queue email events through the configured provider | On-demand |
| Session sweeper | Expire stale sessions / refresh tokens | Interval |

## 8.5 Event bus

Every domain action emits an event through a single `emitEvent()` entry point:

```
USER UPDATED IN DEJOIY AUTH
        │
        ▼
     emitEvent() ──► event_log (persisted, sanitized)
        │
        └──► webhook subscribers (HMAC-SHA256, idempotent by event_id)
        └──► audit log
```

- Events: `user.*`, `login.*`, `account.locked`, `password.*`, `mfa.*`,
  `session.*`, `role.changed`, `permission.changed`, `application.*`,
  `oauth.client.*`, `security.*`.
- **Idempotency**: every event has an `event_id`; webhook deliveries are keyed
  on `(endpoint_id, event_id)` so replays never duplicate.
- Emission is non-blocking for the caller (login/session hot paths unaffected).

## 9. Integration model

DEJOIY applications integrate via:

1. **OIDC authorization code + PKCE** — best for browser apps.
2. **API clients / service accounts** — server-to-server with scoped tokens.
3. **The DEJOIY AUTH SDK** (`packages/sdk`) — thin client for the above.

Every integration is registered as an `application` with validated redirect URIs and scopes.

## 10. Observability

- `GET /health/live` and `GET /health/ready` endpoints.
- Structured JSON logs with correlation IDs; error IDs and security event IDs.
- Log redaction of tokens/secrets/passwords everywhere.
