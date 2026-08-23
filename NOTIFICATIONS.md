# DEJOIY AUTH — Notifications & Mail Providers

## Architecture

```
Auth / lifecycle event
      │
      ▼
Notification Service ──▶ Mail Provider Adapter ──▶ Configured provider
```

The authentication logic never depends on a concrete mail vendor. Switching providers is
**configuration only** — no code changes.

## Providers

| `MAIL_PROVIDER` | Backend | Required env |
| --- | --- | --- |
| `console` | Logs messages (dev) | — |
| `smtp` | Nodemailer | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` |
| `dejoiy-swiss` | DEJOIY Swiss Mail API | `DEJOIY_MAIL_API_URL`, `DEJOIY_MAIL_API_KEY` |
| `ses` | AWS SES | `AWS_SES_REGION`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` |

Sender addresses (configurable):

```env
MAIL_FROM=no-reply@dejoiy.com
MAIL_ERRORS_FROM=errors@dejoiy.com
```

## DEJOIY Swiss Mail API

The adapter calls `POST {DEJOIY_MAIL_API_URL}/v1/mail/send` with `Authorization: Bearer {key}` and
`{ to, subject, text, html, from }`. Point `DEJOIY_MAIL_API_URL` + `DEJOIY_MAIL_API_KEY` at the Swiss
Mail API when it is available — no code changes required.

## Email events

welcome · verify_email · password_reset · password_changed · new_login · suspicious_login ·
account_locked · account_blocked · account_activated · account_deactivated · mfa_enabled ·
mfa_reset · admin_action_alert · security_alert · system_error

## Error emails

Application errors are **sanitized** before notification:

- Error ID (`ERR-…`), timestamp, service, environment, severity, correlation ID, safe stack.
- Never: passwords, tokens, cookies, API keys, MFA secrets.

## Delivery tracking

Every send records a `notification_events` row (event type, recipients, status, error, correlation id)
visible in the IT panel (`/it/notifications`). Failed sends never break the auth flow they accompany.

## Security

- SMTP credentials / API keys live only in server env — never in the frontend or the sheet.
- Emails never contain raw reset secrets; links use short-lived single-use tokens.
