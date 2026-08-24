import { randomBytes, createHmac } from "node:crypto";
import { query } from "../db/pool.js";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";

// ─── Event Types ────────────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
  "user.created",
  "user.updated",
  "user.activated",
  "user.suspended",
  "user.blocked",
  "user.unblocked",
  "user.unlocked",
  "user.disabled",
  "user.terminated",
  "user.deleted",
  "login.success",
  "login.failed",
  "login.suspicious",
  "account.locked",
  "password.changed",
  "password.reset.requested",
  "password.reset.completed",
  "mfa.enabled",
  "mfa.disabled",
  "mfa.reset",
  "session.created",
  "session.revoked",
  "session.global_logout",
  "device.registered",
  "device.revoked",
  "role.changed",
  "permission.changed",
  "application.created",
  "application.updated",
  "application.disabled",
  "oauth.client.created",
  "oauth.client.secret_rotated",
  "wfm.employee.created",
  "wfm.employee.activated",
  "wfm.employee.deactivated",
  "wfm.access.changed",
  "security.alert",
  "security.incident"
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// ─── Endpoint Management ─────────────────────────────────────────────────────

export interface WebhookEndpoint {
  id: string;
  application_id: string | null;
  url: string;
  description: string;
  events: string[];
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  last_delivery_at: string | null;
  last_delivery_status: string;
  failure_count: number;
}

/**
 * Create a webhook endpoint. Returns the endpoint with the secret (shown once).
 */
export async function createEndpoint(input: {
  url: string;
  description?: string;
  events: string[];
  applicationId?: string;
  createdBy?: string;
}): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  // Validate events
  const invalid = input.events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (invalid.length > 0) {
    throw new Error(`Invalid event types: ${invalid.join(", ")}`);
  }

  // Validate URL — HTTPS only in production
  const url = new URL(input.url);
  if (getConfig().NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Webhook URLs must use HTTPS in production");
  }

  const secret = `whsec_${randomBytes(32).toString("hex")}`;

  const { rows } = await query<WebhookEndpoint>(
    `INSERT INTO webhook_endpoints (url, description, secret, events, application_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, application_id, url, description, events, is_active, created_by, created_at,
               last_delivery_at, last_delivery_status, failure_count`,
    [input.url, input.description ?? "", secret, input.events, input.applicationId ?? null, input.createdBy ?? null]
  );

  return { endpoint: rows[0]!, secret };
}

/**
 * Update a webhook endpoint.
 */
export async function updateEndpoint(
  id: string,
  updates: { url?: string; description?: string; events?: string[]; is_active?: boolean }
): Promise<WebhookEndpoint> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.url !== undefined) {
    const url = new URL(updates.url);
    const cfg = getConfig();
    if (cfg.NODE_ENV === "production" && url.protocol !== "https:") {
      throw new Error("Webhook URLs must use HTTPS in production");
    }
    sets.push(`url = $${idx++}`);
    values.push(updates.url);
  }
  if (updates.description !== undefined) {
    sets.push(`description = $${idx++}`);
    values.push(updates.description);
  }
  if (updates.events !== undefined) {
    const invalid = updates.events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (invalid.length > 0) throw new Error(`Invalid event types: ${invalid.join(", ")}`);
    sets.push(`events = $${idx++}`);
    values.push(updates.events);
  }
  if (updates.is_active !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(updates.is_active);
  }

  if (sets.length === 0) throw new Error("No updates provided");

  sets.push(`updated_at = now()`);
  values.push(id);

  const { rows } = await query<WebhookEndpoint>(
    `UPDATE webhook_endpoints SET ${sets.join(", ")} WHERE id = $${idx}
     RETURNING id, application_id, url, description, events, is_active, created_by, created_at,
               last_delivery_at, last_delivery_status, failure_count`,
    values
  );

  if (rows.length === 0) throw new Error("Webhook endpoint not found");
  return rows[0]!;
}

/**
 * Delete a webhook endpoint and its delivery logs.
 */
export async function deleteEndpoint(id: string): Promise<void> {
  await query("DELETE FROM webhook_endpoints WHERE id = $1", [id]);
}

/**
 * Rotate the secret for a webhook endpoint.
 */
export async function rotateSecret(id: string): Promise<{ secret: string }> {
  const secret = `whsec_${randomBytes(32).toString("hex")}`;
  const { rowCount } = await query(
    "UPDATE webhook_endpoints SET secret = $1, updated_at = now() WHERE id = $2",
    [secret, id]
  );
  if (rowCount === 0) throw new Error("Webhook endpoint not found");
  return { secret };
}

/**
 * List webhook endpoints, optionally filtered by application.
 */
export async function listEndpoints(applicationId?: string): Promise<WebhookEndpoint[]> {
  if (applicationId) {
    const { rows } = await query<WebhookEndpoint>(
      `SELECT id, application_id, url, description, events, is_active, created_by, created_at,
              last_delivery_at, last_delivery_status, failure_count
       FROM webhook_endpoints WHERE application_id = $1 ORDER BY created_at DESC`,
      [applicationId]
    );
    return rows;
  }
  const { rows } = await query<WebhookEndpoint>(
    `SELECT id, application_id, url, description, events, is_active, created_by, created_at,
            last_delivery_at, last_delivery_status, failure_count
     FROM webhook_endpoints ORDER BY created_at DESC`
  );
  return rows;
}

// ─── Event Dispatch ──────────────────────────────────────────────────────────

/**
 * Dispatch a webhook event to all subscribed endpoints.
 * Non-blocking: failures are logged but never throw.
 *
 * When `eventId` is provided (event bus), deliveries are idempotent: a
 * second dispatch of the same event to the same endpoint is skipped.
 */
export async function dispatchEvent(
  eventType: WebhookEvent,
  payload: Record<string, unknown>,
  correlationId?: string,
  eventId?: string
): Promise<void> {
  const { rows: endpoints } = await query<{
    id: string;
    url: string;
    secret: string;
    events: string[];
  }>(
    `SELECT id, url, secret, events FROM webhook_endpoints
     WHERE is_active = true AND $1 = ANY(events)`,
    [eventType]
  );

  if (endpoints.length === 0) return;

  const resolvedEventId = eventId ?? `evt_${Date.now()}_${randomBytes(8).toString("hex")}`;

  for (const endpoint of endpoints) {
    try {
      // Sanitize payload — never send secrets
      const sanitized = sanitizePayload(payload);
      const body = JSON.stringify({
        event: eventType,
        event_id: resolvedEventId,
        timestamp: new Date().toISOString(),
        correlation_id: correlationId ?? null,
        data: sanitized
      });

      const signature = computeSignature(endpoint.secret, body);
      const cfg = getConfig();

      // Store delivery attempt — idempotent per (endpoint_id, event_id).
      const { rows: deliveryRows } = await query<{ id: string }>(
        `INSERT INTO webhook_deliveries (endpoint_id, event_type, event_id, payload, signature, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (endpoint_id, event_id) DO NOTHING
         RETURNING id`,
        [endpoint.id, eventType, resolvedEventId, JSON.parse(body), signature, cfg.WEBHOOK_MAX_RETRIES]
      );
      const deliveryId = deliveryRows[0]?.id;
      if (!deliveryId) continue; // already delivered (idempotent replay)


      // Deliver (with timeout)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), cfg.WEBHOOK_TIMEOUT_MS);
      const start = Date.now();

      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          "X-DEJOIY-EVENT": eventType,
          "X-DEJOIY-EVENT-ID": resolvedEventId,
          "X-DEJOIY-TIMESTAMP": new Date().toISOString(),
            "X-DEJOIY-SIGNATURE": signature,
            ...(correlationId ? { "X-DEJOIY-CORRELATION-ID": correlationId } : {})
          },
          body,
          signal: controller.signal
        });
        clearTimeout(timeout);
        const responseTimeMs = Date.now() - start;

        const success = response.status >= 200 && response.status < 300;

        await query(
          `UPDATE webhook_deliveries
           SET status = $1, response_status = $2, response_time_ms = $3,
               attempts = attempts + 1, delivered_at = now()
           WHERE id = $4`,
          [success ? "success" : "failed", response.status, responseTimeMs, deliveryId]
        );

        await query(
          `UPDATE webhook_endpoints
           SET last_delivery_at = now(), last_delivery_status = $1,
               failure_count = CASE WHEN $1 = 'failed' THEN failure_count + 1 ELSE 0 END
           WHERE id = $2`,
          [success ? "success" : "failed", endpoint.id]
        );

        if (!success) {
          logger.warn(
            { endpointId: endpoint.id, status: response.status, eventType },
            "Webhook delivery failed"
          );
          await scheduleRetry(deliveryId, endpoint.id, 1);
        }
      } catch (err) {
        clearTimeout(timeout);
        const responseTimeMs = Date.now() - start;

        await query(
          `UPDATE webhook_deliveries
           SET status = 'failed', error_message = $1, response_time_ms = $2,
               attempts = attempts + 1
           WHERE id = $3`,
          [String(err), responseTimeMs, deliveryId]
        );

        await query(
          `UPDATE webhook_endpoints
           SET last_delivery_at = now(), last_delivery_status = 'failed',
               failure_count = failure_count + 1
           WHERE id = $1`,
          [endpoint.id]
        );

        await scheduleRetry(deliveryId, endpoint.id, 1);
      }
    } catch (err) {
      logger.error({ endpointId: endpoint.id, eventType, err }, "Webhook dispatch error");
    }
  }
}

/**
 * Retry a failed delivery with exponential backoff.
 */
async function scheduleRetry(deliveryId: string, endpointId: string, attempt: number): Promise<void> {
  const cfg = getConfig();
  if (attempt >= cfg.WEBHOOK_MAX_RETRIES) {
    await query("UPDATE webhook_deliveries SET status = 'dead' WHERE id = $1", [deliveryId]);
    return;
  }

  const delayMs = cfg.WEBHOOK_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
  const nextRetry = new Date(Date.now() + delayMs);

  await query(
    "UPDATE webhook_deliveries SET next_retry_at = $1 WHERE id = $2",
    [nextRetry, deliveryId]
  );
}

// ─── Delivery History ────────────────────────────────────────────────────────

export interface DeliveryLog {
  id: string;
  endpoint_id: string;
  event_type: string;
  event_id: string;
  status: string;
  response_status: number | null;
  response_time_ms: number | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  delivered_at: string | null;
}

export async function getDeliveryHistory(
  endpointId: string,
  limit = 50,
  offset = 0
): Promise<DeliveryLog[]> {
  const { rows } = await query<DeliveryLog>(
    `SELECT id, endpoint_id, event_type, event_id, status, response_status,
            response_time_ms, error_message, attempts, created_at, delivered_at
     FROM webhook_deliveries
     WHERE endpoint_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [endpointId, limit, offset]
  );
  return rows;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 */
export function computeSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Verify an incoming webhook signature (for testing).
 */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = computeSignature(secret, body);
  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Sanitize a payload before sending via webhook or persisting to the event log.
 * Never include passwords, tokens, MFA secrets, etc.
 */
export function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set([
    "password",
    "passwordHash",
    "password_hash",
    "refreshToken",
    "refresh_token",
    "accessToken",
    "access_token",
    "mfaSecret",
    "mfa_secret",
    "recoveryCodes",
    "recovery_codes",
    "apiKey",
    "api_key",
    "secret",
    "clientSecret",
    "client_secret"
  ]);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (blocked.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
