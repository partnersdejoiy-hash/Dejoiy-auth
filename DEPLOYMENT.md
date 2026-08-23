# DEJOIY AUTH — Deployment

This guide covers production deployment, the initial Super Admin bootstrap, backups, and recovery.

## 1. Prerequisites

- Linux host (Ubuntu 22.04+/24.04 recommended) with Docker + Docker Compose, or bare Node 20+/PostgreSQL 16+/Redis 7.
- A domain (e.g. `auth.dejoiy.com`) with DNS A record pointing to the host.
- TLS certificate (Let's Encrypt via certbot or the reverse proxy).

## 2. Environment

```bash
git clone https://github.com/partnersdejoiy-hash/Dejoiy-auth.git
cd Dejoiy-auth
cp .env.example .env
# Generate strong secrets:
openssl rand -hex 32   # ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET, DATA_ENCRYPTION_KEY
openssl rand -hex 16   # COOKIE_SECRET, BOOTSTRAP_SECRET
```

Set `NODE_ENV=production`, `APP_URL=https://auth.dejoiy.com`, `DATABASE_URL`, `REDIS_URL`,
`CORS_ORIGINS` (real origins only), and mail provider settings (see `NOTIFICATIONS.md`).

## 3. Database

```bash
pnpm install
pnpm db:migrate     # applies SQL migrations
pnpm db:seed        # idempotent seed of roles + permissions
```

## 4. First-run Super Admin bootstrap

The initial Super Admin is **not hardcoded**. Bootstrap uses `BOOTSTRAP_ADMIN_EMAIL` +
`BOOTSTRAP_SECRET`:

```bash
pnpm bootstrap
# or with a one-time token:
curl -X POST $APP_URL/api/v1/bootstrap/super-admin \
  -H 'Content-Type: application/json' \
  -d '{"email":"deepak.sharma@dejoiy.com","bootstrapSecret":"<BOOTSTRAP_SECRET>","password":"<strong-14+char-password>"}'
```

The bootstrap endpoint refuses to run when any Super Admin already exists. After success:

1. Remove `BOOTSTRAP_SECRET` from `.env` (or rotate it).
2. The Super Admin must enroll MFA (enforced before privileged actions) and will be asked to change the
   bootstrap password on first sign-in if `PASSWORD_RESET_REQUIRED`.

## 5. Run (Docker)

```bash
docker compose up -d --build
```

| Service | Internal | External |
| --- | --- | --- |
| postgres | 5432 | private |
| redis | 6379 | private |
| api | 8080 | 127.0.0.1:8080 |
| web | 80 (nginx) | 127.0.0.1:8081 |

## 6. Reverse proxy (recommended)

Terminate TLS in front of the web service:

```nginx
server {
  listen 443 ssl http2;
  server_name auth.dejoiy.com;

  ssl_certificate     /etc/letsencrypt/live/auth.dejoiy.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/auth.dejoiy.com/privkey.pem;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
server {
  listen 80;
  server_name auth.dejoiy.com;
  return 301 https://$host$request_uri;
}
```

## 7. Verification

```bash
curl https://auth.dejoiy.com/health/live
curl https://auth.dejoiy.com/health/ready
curl https://auth.dejoiy.com/api/v1/oidc/.well-known/openid-configuration
```

## 8. Backups

- **PostgreSQL**: `pg_dump` daily, store encrypted (e.g. `age`/`gpg`) off-host. Test restores.
- **Redis**: ephemeral by design; nothing identity-critical lives only in Redis.
- **Zoho Sheet**: a sync artifact, not a backup — the DB is the source of truth.

## 9. Recovery drills

- Restore a `pg_dump` into a fresh container and verify a login + audit trail.
- Rotate `ACCESS_TOKEN_SECRET` (forces all access tokens invalid) and `REFRESH_TOKEN_SECRET`
  (invalidates all refresh envelopes — treat as emergency).
- Simulate a compromised admin: block user, revoke sessions, force password reset, rotate secrets.

## 10. Scaling notes

- Stateless API → scale horizontally behind the reverse proxy.
- PostgreSQL → managed HA (e.g. Patroni) when required; Redis → managed cluster.
- Background workers (Zoho sync, notifications) run as separate processes in production.
