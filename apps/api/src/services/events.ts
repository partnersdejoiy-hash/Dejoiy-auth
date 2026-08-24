import { randomBytes } from "node:crypto";
import { query } from "../db/pool.js";
import { logger } from "../logger.js";
import { dispatchEvent, sanitizePayload, type WebhookEvent } from "./webhook.js";

/**
 * Event bus (Phases 20-23).
 *
 * `emitEvent` is the single entry point for domain events:
 *
 *   DOMAIN ACTION → emitEvent() → event_log (persisted) + webhook dispatch
 *
 * - Every event carries a unique `event_id` (idempotency key). Subscribers
 *   and webhook deliveries can safely receive the same event more than once
 *   — deliveries are keyed on (endpoint_id, event_id).
 * - Payloads are sanitized before persistence and delivery: passwords,
 *   tokens, MFA secrets, API keys, client secrets are never included.
 * - Never throws: failures are logged, the caller (login, user lifecycle,
 *   …) is never blocked by webhook delivery. Webhook dispatch runs in the
 *   background.
 */

export function newEventId(): string {
  return `evt_${Date.now()}_${randomBytes(6).toString("hex")}`;
}

export async function emitEvent(
  eventType: WebhookEvent,
  payload: Record<string, unknown>,
  opts?: { correlationId?: string | null; actorUserId?: string | null }
): Promise<string> {
  const eventId = newEventId();
  try {
    await query(
      `INSERT INTO event_log (event_id, event_type, payload, correlation_id, actor_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        eventId,
        eventType,
        JSON.stringify(sanitizePayload(payload)),
        opts?.correlationId ?? null,
        opts?.actorUserId ?? null
      ]
    );
    // Background delivery — never blocks the caller (login, session, etc.).
    void dispatchEvent(eventType, payload, opts?.correlationId ?? undefined, eventId);
  } catch (err) {
    logger.error({ err, eventType }, "event emission failed");
  }
  return eventId;
}

/** Paginated event log for admin/audit views. */
export async function listEvents(opts: {
  eventType?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  const params: unknown[] = [];
  let where = "";
  if (opts.eventType) {
    params.push(opts.eventType);
    where = "WHERE event_type = $1";
  }
  const { rows: countRows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM event_log ${where}`,
    params
  );
  params.push(opts.limit, opts.offset);
  const { rows } = await query(
    `SELECT event_id, event_type, payload, correlation_id, actor_user_id, created_at
       FROM event_log ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows, total: countRows[0]?.n ?? 0 };
}
