# DEJOIY AUTH — Zoho Sheet Synchronization

The Zoho Sheet is a **controlled synchronization layer**, never the source of truth.

```
DEJOIY AUTH DATABASE ──▶ Sync Worker ──▶ DEJOIY AUTH Zoho Sheet
```

## Configuration (server-side only)

```env
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...           # Zoho OAuth refresh token (scopes: ZohoSheet.data.ALL)
ZOHO_SHEET_URL=https://sheet.zoho.in/sheet/open/t9x1641aa584211e6448798bfad7f1037c8d6
ZOHO_SYNC_INTERVAL_SECONDS=3600
```

1. Create an OAuth client in the Zoho API console (`Zoho Sheet` scope).
2. Authorize once and store the **refresh token** in `.env` — never in the repository or the frontend.
3. The worker refreshes the access token itself; credentials never leave the server.

## What is synced

| Column | Source |
| --- | --- |
| Employee ID | `employee_profiles.employee_id` |
| User ID | `users.user_number` (DJY-…) |
| Name | `user_profiles.full_name` |
| Email | `users.email` |
| Role | aggregated role names |
| Department | `departments.name` |
| Status | `users.account_state` |
| Activation date | `users.created_at` (date) |
| Deactivation date | termination date when terminated |
| Manager | manager email |
| Last sync | job timestamp |

## Never synced

Passwords · password hashes · refresh tokens · MFA secrets · recovery codes · API keys ·
session tokens. The worker builds the payload from an explicit, sanitized query only.

## Safety

- **Distributed lock** (`lock:zoho-sync`) prevents overlapping runs.
- Each run records a `sheet_sync_jobs` row: status, rows, error, trigger, actor, summary.
- Retry: the scheduled worker simply runs again next interval; failures are logged with the job id.
- When Zoho credentials are absent the worker still records the job as `configured: false` so
  operators can see sync health before credentials arrive.

## Manual sync

Admin → System → "Run sync now", or `POST /api/v1/sync/zoho-sheet` with `sync.zoho.run`.

## Conflict detection

The database is authoritative; the sheet is a mirror. Field conflicts are resolved by the next sync
(database wins). Audit entries record every manual/scheduled run with its correlation id.
