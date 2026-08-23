# DEJOIY AUTH

**Enterprise self-hosted centralized identity and access platform for DEJOIY INDIA PRIVATE LIMITED.**

DEJOIY AUTH is the central identity system that authenticates and authorizes every current and future
DEJOIY application — Marketplace, Seller/Vendor Portal, Customer Portal, Employee Portal, BPO, WFM,
Workmail, Support, internal SaaS, and future web/mobile apps.

```
DEJOIY App ──▶ DEJOIY AUTH ──▶ Authentication ──▶ Session/Token ──▶ RBAC/Permission Engine ──▶ DEJOIY App
```

It is fully self-hosted and has **zero runtime dependency** on any AI builder. DEJOIY infrastructure
runs everything.

---

## Highlights

- **Authentication** — Argon2id password hashing, secure sessions, short-lived access tokens, rotating
  refresh tokens with reuse detection, HttpOnly/secure/SameSite cookies, CSRF protection, strict CORS.
- **Brute-force protection** — Redis-backed rate limiting, per-account + per-IP throttling, progressive
  login delays, account lockout.
- **RBAC** — roles are *not* permissions. Roles map to configurable fine-grained permissions, enforced
  server-side on every endpoint.
- **User lifecycle** — PENDING / ACTIVE / SUSPENDED / BLOCKED / LOCKED / DISABLED / TERMINATED /
  PASSWORD_RESET_REQUIRED with full admin, IT and WFM workflows.
- **Panels** — separate **Admin**, **IT** and **WFM** panels, each governed by RBAC.
- **Audit & security events** — every privileged action is audited; security events feed a monitoring
  dashboard.
- **Mail abstraction** — pluggable providers (DEJOIY Swiss Mail API, SMTP, SES, Zoho, console) with no
  auth-logic rewiring.
- **Zoho Sheet sync** — one-way controlled synchronization layer (`DB → Sync Worker → Sheet`). The
  database is always the source of truth. No secrets ever leave the server.
- **OIDC/OAuth2-ready** — authorization code + PKCE flow, service accounts, API clients, scopes,
  redirect-URI validation, and a reusable integration SDK.
- **MFA-ready architecture** — TOTP factor model, recovery codes, WebAuthn-ready seam, privileged-action
  re-authentication.

---

## Repository layout

```
apps/api        Fastify + TypeScript backend (PostgreSQL + Redis)
apps/web        React + Vite + TypeScript frontend (Admin / IT / WFM panels)
packages/sdk    Reusable DEJOIY AUTH integration client for DEJOIY applications
deploy          Reverse-proxy and deployment assets
```

## Quick start (development)

```bash
pnpm install
cp .env.example .env            # fill in secrets
docker compose up -d postgres redis
pnpm db:migrate && pnpm db:seed
pnpm bootstrap                  # creates the initial Super Admin (see DEPLOYMENT.md)
pnpm dev:api                    # http://localhost:8080
pnpm dev:web                    # http://localhost:5173
```

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, data flow, security model |
| [SECURITY.md](SECURITY.md) | Security design, threat model, incident response |
| [API.md](API.md) | REST API reference |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production deployment, bootstrap, backup/recovery |
| [INTEGRATION.md](INTEGRATION.md) | How to integrate a DEJOIY application |
| [RBAC.md](RBAC.md) | Roles, permissions, matrices, custom roles |
| [WFM.md](WFM.md) | Employee-centric WFM panel |
| [ZOHO-SYNC.md](ZOHO-SYNC.md) | Zoho Sheet synchronization |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | Mail/notification providers |

## Status

Active development. See commit history for milestone progress.
