# DEJOIY AUTH — Webhook System

Outbound webhooks let any DEJOIY application subscribe to identity and security events
in real-time. Webhooks are delivered via HTTPS POST with HMAC-SHA256 signed payloads.

## Configuration

Webhook delivery is always enabled. No additional environment variables are required beyond the base configuration. Optional tuning:

```env
WEBHOOK_MAX_RETRIES=5
WEBHOOK_RETRY_DELAY_MS=5000
WEBHOOK_TIMEOUT_MS=10000
```

## Event Types

| Event | Description |
| --- | --- |
| `user.created` | New identity created |
| `user.updated` | User modified |
| `user.activated` | Account activated |
| `user.suspended` | Account suspended |
| `user.blocked` | Account blocked |
| `user.unblocked` | Account unblocked |
| `user.unlocked` | Account unlocked |
| `user.disabled` | Account disabled |
| `user.terminated` | Account terminated |
| `user.deleted` | Account soft-deleted |
| `login.success` | Successful sign-in |
| `login.failed` | Failed sign-in attempt |
| `login.suspicious` | Suspicious login detected |
| `account.locked` | Account locked (brute-force) |
| `password.changed` | Password changed |
| `password.reset.requested` | Password reset email sent |
| `password.reset.completed` | Password reset completed |
| `mfa.enabled` | MFA enrolled |
| `mfa.disabled` | MFA removed |
| `mfa.reset` | MFA factors revoked |
| `session.created` | New session |
| `session.revoked` | Session revoked |
| `session.global_logout` | All sessions revoked |
| `device.registered` | New device fingerprint |
| `device.revoked` | Device revoked |
| `role.changed` | Role assignment changed |
| `permission.changed` | Permission changed |
| `application.created` | OAuth application created |
| `application.updated` | Application updated |
| `application.disabled` | Application disabled |
| `oauth.client.created` | OAuth client created |
| `oauth.client.secret_rotated` | Client secret rotated |
| `wfm.employee.created` | WFM onboarding |
| `wfm.employee.activated` | WFM activation |
| `wfm.employee.deactivated` | WFM deactivation |
| `wfm.access.changed` | Access eligibility changed |
| `security.alert` | Security alert |
| `security.incident` | Security incident |

## API Endpoints

### Create webhook endpoint

```http
POST /api/v1/webhooks
Authorization: Bearer <token>

{
  "url": "https://your-app.dejoiy.com/webhook",
  "description": "Production webhook for marketplace",
  "events": ["user.created", "login.success", "login.suspicious"],
  "applicationId": "optional-uuid"
}
```

**Response** (201):

```json
{
  "endpoint": {
    "id": "uuid",
    "url": "https://your-app.dejoiy.com/webhook",
    "events": ["user.created", "login.success", "login.suspicious"],
    "is_active": true,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "secret": "whsec_..."
}
```

⚠️ **The secret is only shown once on creation. Store it securely.**

### List endpoints

```http
GET /api/v1/webhooks
GET /api/v1/webhooks?applicationId=uuid
```

### Update endpoint

```http
PATCH /api/v1/webhooks/:id
{
  "events": ["user.created", "user.activated"],
  "is_active": true
}
```

### Delete endpoint

```http
DELETE /api/v1/webhooks/:id
```

### Rotate secret

```http
POST /api/v1/webhooks/:id/rotate-secret
```

### Get delivery history

```http
GET /api/v1/webhooks/:id/deliveries?limit=50&offset=0
```

### Test delivery

```http
POST /api/v1/webhooks/:id/test
```

### Verify signature

```http
POST /api/v1/webhooks/verify-signature
{
  "secret": "whsec_...",
  "payload": "{\"event\":\"user.created\",...}",
  "signature": "hmac-sha256-hex"
}
```

## Webhook Payload

Every delivery includes:

```json
{
  "event": "user.created",
  "event_id": "evt_1705312200000_a1b2c3d4",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "correlation_id": "req-uuid",
  "data": {
    "userId": "uuid",
    "userNumber": "DJY-EMP-000428",
    "email": "user@dejoiy.com",
    "fullName": "John Doe"
  }
}
```

## Headers

| Header | Description |
| --- | --- |
| `X-DEJOIY-EVENT` | Event type (e.g. `user.created`) |
| `X-DEJOIY-EVENT-ID` | Unique event ID (replay protection) |
| `X-DEJOIY-TIMESTAMP` | ISO 8601 delivery timestamp |
| `X-DEJOIY-SIGNATURE` | HMAC-SHA256 hex signature |
| `X-DEJOIY-CORRELATION-ID` | Request correlation ID (if available) |

## Signature Verification

```typescript
import { createHmac } from "node:crypto";

function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

// In your webhook handler:
app.post("/webhook", (req, res) => {
  const signature = req.headers["x-dejoiy-signature"];
  if (!verifyWebhookSignature(SECRET, JSON.stringify(req.body), signature)) {
    return res.status(401).send("Invalid signature");
  }
  // Process event...
  res.status(200).send("OK");
});
```

## Event Bus (idempotent, event-driven)

Domain actions emit events through the event bus (`services/events.ts`):

```
DOMAIN ACTION (login, user lifecycle, MFA, roles, applications, sessions)
        │
        ▼
     emitEvent()
        ├──► event_log (PostgreSQL — persisted, sanitized, auditable)
        └──► webhook dispatch (HMAC-SHA256, background, non-blocking)
```

- Every event carries a unique `event_id` (idempotency key).
- **Idempotency**: deliveries are keyed on `(endpoint_id, event_id)` — replaying
  the same event never creates a duplicate delivery or a duplicate update.
- Payloads are sanitized before persistence and delivery (no passwords, tokens,
  MFA secrets, API keys, client secrets).
- Emission never blocks the caller (login, session creation, …): webhook
  delivery runs in the background.

### Event log viewer

```http
GET /api/v1/events?eventType=user.created&limit=50&offset=0
Authorization: Bearer <token>   # requires audit.read
```

Returns `{ rows, total }` with `event_id`, `event_type`, `payload`, `correlation_id`,
`actor_user_id` and `created_at`. `GET /api/v1/events/types` lists all event types.

## Retry Policy

Failed deliveries (non-2xx response or timeout) are retried with exponential backoff:

| Attempt | Delay |
| --- | --- |
| 1 | 5 seconds |
| 2 | 10 seconds |
| 3 | 20 seconds |
| 4 | 40 seconds |
| 5 | 80 seconds (dead if failed) |

After `WEBHOOK_MAX_RETRIES` attempts, the delivery is marked as **dead** and no further retries are attempted.

## Security

- **HTTPS only** in production — webhook URLs must use HTTPS
- **HMAC-SHA256** signatures on every payload
- **Replay protection** via unique event IDs and timestamps
- **Secret rotation** supported without downtime
- **Payload sanitization** — passwords, tokens, MFA secrets, API keys are never sent
- **Constant-time signature comparison** to prevent timing attacks
- **Delivery timeout** prevents hanging connections
- **Dead-letter state** after max retries

## Data Isolation

Webhook payloads and the event log **never** contain:
- Passwords or password hashes
- Access tokens or refresh tokens
- MFA secrets or recovery codes
- API keys or client secrets
- Cookie values
- Internal session identifiers

## Database

Webhook data is stored in PostgreSQL:

| Table | Purpose |
| --- | --- |
| `webhook_endpoints` | Registered webhook URLs, events, secrets |
| `webhook_deliveries` | Delivery attempts, status, response data |

Both tables are fully auditable and included in backup procedures.
