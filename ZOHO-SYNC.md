# DEJOIY AUTH — Zoho Sheet Synchronization

The Zoho Sheet is a **controlled operational data layer**, never the source of truth.
DEJOIY AUTH's PostgreSQL database is the authoritative identity source.

```
DEJOIY AUTH DATABASE ──▶ Sync Worker ──▶ DEJOIY AUTH Zoho Sheet
        ▲                                  │
        └────────── validated pull ◀───────┘
```

## Sync model — incremental upsert (never destructive)

Sync is **incremental**, keyed on the stable **User ID** (`DJY-…`):

- A user already present in the sheet → that **row is updated** (`worksheet.records.update`).
- A new user → **appended** (`worksheet.records.add`).
- A soft-deleted user → follows the **deletion policy** (below).
- Unrelated sheet data and extra columns are **never touched**. There is no
  `DELETE ALL → INSERT ALL` anywhere in the normal sync path.

Change detection on push uses a stable hash of the row's columns: identical rows
are skipped (no API writes). Pull uses per-record optimistic versioning via
`sheet_sync_records` (`version`, `last_synced_at`, `sheet_baseline`).

## Configuration (server-side only)

```env
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...           # Zoho OAuth refresh token (scopes: ZohoSheet.data.ALL)
ZOHO_SHEET_URL=https://sheet.zoho.in/sheet/open/t9x1641aa584211e6448798bfad7f1037c8d6
ZOHO_SHEET_WORKSHEET=            # worksheet name to sync; empty = first worksheet
ZOHO_SYNC_INTERVAL_SECONDS=3600
ZOHO_SYNC_MODE=scheduled         # scheduled | near-real-time
ZOHO_POLL_INTERVAL_SECONDS=60
ZOHO_SYNC_DELETION_POLICY=mark   # mark | keep | delete
ZOHO_API_MIN_INTERVAL_MS=350     # min spacing between Zoho API calls
ZOHO_SYNC_BATCH_SIZE=50          # batch size for record operations
ZOHO_SYNC_MAX_RETRIES=3          # retries with exponential backoff on 429/5xx
ZOHO_SYNC_BACKOFF_BASE_MS=1000
```

1. Create an OAuth client in the Zoho API console (`Zoho Sheet` scope).
2. Authorize once and store the **refresh token** in `.env` — never in the repository or the frontend.
3. The worker refreshes the access token itself; credentials never leave the server.

**Honest sync modes** — Zoho Sheet has no native outbound event for arbitrary cell
edits, so DEJOIY AUTH never claims real-time sync:

| Mode | Behaviour |
| --- | --- |
| `scheduled` | Runs every `ZOHO_SYNC_INTERVAL_SECONDS` (default 1h) |
| `near-real-time` | Incremental polling every `ZOHO_POLL_INTERVAL_SECONDS` (default 60s) |

Mode, poll interval and deletion policy can be changed from the Admin UI
(Admin → Zoho Sheet Sync) and take effect on the next tick — no restart needed.

## What is synced

| Column | Source | Default direction |
| --- | --- | --- |
| User ID (`DJY-…`) | `users.user_number` | DB → Sheet |
| Employee ID | `employee_profiles.employee_id` | DB → Sheet |
| Full Name | `user_profiles.full_name` | DB → Sheet |
| Email | `users.email` | DB → Sheet |
| Phone | `users.phone` | DB → Sheet |
| Department | `departments.name` | Bidirectional |
| Designation | `employee_profiles.designation` | DB → Sheet |
| Role | aggregated role names | Bidirectional (role must exist) |
| Manager | manager email | Bidirectional (matched by email) |
| Location | — (no DB column today) | DB → Sheet |
| Employment Type | `employee_profiles.employment_status` | DB → Sheet |
| Joining Date | `employee_profiles.hire_date` | DB → Sheet |
| Status | `users.account_state` | Bidirectional (strict validation) |
| Last Login | `users.last_login_at` | DB → Sheet |
| MFA Enabled | `users.mfa_enabled` | DB → Sheet |
| Account Risk | heuristic from account state | DB → Sheet |
| Created At / Updated At | `users.created_at` / `updated_at` | DB → Sheet |
| Sync Status / Sync Version | internal sync metadata | DB → Sheet |

## Field mapping (per-field direction)

Every column has a direction in `sync_field_mappings`:

- `db_to_sheet` — DB → Sheet only (sheet edits are ignored)
- `sheet_to_db` — Sheet → DB only
- `bidirectional` — both ways
- `never` — excluded from the sheet entirely

Security-sensitive data is **never a column**: passwords, password hashes, MFA
secrets, recovery codes, session tokens and API keys. Even if an admin flips a
sensitive field to `bidirectional`, `applySheetValue` refuses to pull it
(defense in depth). Read-only columns (`Email`, `User ID`, …) can never be
overwritten from the sheet.

## Conflict detection & resolution

Pull uses optimistic versioning (`sheet_sync_records.sheet_baseline`):

| Situation | Outcome |
| --- | --- |
| DB == Sheet | no-op |
| Only the sheet changed since last sync | applied (after validation) |
| Only the DB changed since last sync | DB wins; next push refreshes the sheet |
| **Both changed** | **conflict** — recorded in `sync_conflicts`, nothing overwritten |

The first sync against a fresh sheet **establishes a baseline only** — it never
blindly overwrites the DB.

Pending conflicts are shown in the Admin UI with per-field DB vs Sheet values.
The admin chooses:

- **Keep DB** — DB stands; the sheet is refreshed on the next push
- **Keep Sheet** — validated sheet value is applied to the DB
- **Skip** — ignore this field change

Every resolution is written to the audit log (`ZOHO_SYNC_CONFLICT_RESOLVED`).

## Deletion policy

For soft-deleted users (`deleted_at` set):

| Policy | Behaviour |
| --- | --- |
| `mark` (default) | Row Status → `TERMINATED`, Sync Status → `removed` |
| `keep` | Row left as-is |
| `delete` | Row deleted — matched **only** by our own User ID |

A deleted user that was never in the sheet is never introduced.

## Rate-limit safety

Zoho Sheet API is per-minute throttled. The worker:

- uses **batch reads/writes** (`records.add`/`update`/`delete` with aligned arrays)
- spaces calls at least `ZOHO_API_MIN_INTERVAL_MS` apart
- honors `Retry-After` and retries with **exponential backoff** up to
  `ZOHO_SYNC_MAX_RETRIES`
- counts failed batches (`failed_records`) instead of silently dropping them
- skips unchanged rows entirely (hash comparison) to avoid pointless writes

## API endpoints

| Endpoint | Method | Permission | Description |
| --- | --- | --- | --- |
| `/api/v1/sync/zoho-sheet` | POST | `sync.zoho.run` | Run sync (`direction`: push/pull/bidirectional) |
| `/api/v1/sync/zoho-sheet` | GET | `sync.zoho.read` | Job history |
| `/api/v1/sync/zoho-sheet/status` | GET | `sync.zoho.read` | Configured state + last job |
| `/api/v1/sync/zoho-sheet/stats` | GET | `sync.zoho.read` | Health totals, pending conflicts, mode |
| `/api/v1/sync/zoho-sheet/config` | GET / PUT | `read` / `sync.zoho.update` | Field mappings + mode + deletion policy |
| `/api/v1/sync/zoho-sheet/test` | POST | `sync.zoho.update` | Test Zoho connection (token, workbook, latency) |
| `/api/v1/sync/zoho-sheet/conflicts` | GET | `sync.zoho.read` | List conflicts (`status=pending\|resolved\|all`) |
| `/api/v1/sync/zoho-sheet/conflicts/:id/resolve` | POST | `sync.zoho.resolve` | Resolve: `keep_db` \| `keep_sheet` \| `skip` |
| `/api/v1/sync/zoho-sheet/generate-demo` | POST | `sync.zoho.generate` | Queue synthetic demo dataset (`count`) |
| `/api/v1/sync/zoho-sheet/generate-demo/:id` | GET | `sync.zoho.generate` | Demo generation progress |

## Safety

- **Distributed lock** (`lock:zoho-sync`) prevents overlapping runs.
- Each run records a `sheet_sync_jobs` row with per-run stats
  (`rows_added`, `rows_updated`, `rows_deleted`, `conflicts`, `failed_records`).
- The scheduler re-reads mode/interval each tick; failures are logged with the job id and retried.
- When Zoho credentials are absent the worker still records the job as
  `configured: false` so operators can see sync health before credentials arrive.

## Manual sync

Admin → Zoho Sheet Sync → "Run Sync Now", or `POST /api/v1/sync/zoho-sheet` with `sync.zoho.run`.
