-- ============================================================================
-- DEJOIY AUTH — event bus (Phases 20-23)
--
-- * event_log          — persisted domain events (who/what/when/correlation)
-- * webhook_deliveries — idempotency: one delivery row per (endpoint, event_id)
--
-- Events flow: domain action → emitEvent() → event_log + webhook dispatch
-- (HMAC-SHA256 signed, retried with backoff). Subscribers can safely receive
-- the same event more than once: deliveries are keyed on event_id.
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       text NOT NULL UNIQUE,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- sanitized, no secrets
  correlation_id text,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_actor ON event_log(actor_user_id, created_at DESC);

-- Idempotency: a single event can only ever produce one delivery row per endpoint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_deliveries_endpoint_event
  ON webhook_deliveries(endpoint_id, event_id);
