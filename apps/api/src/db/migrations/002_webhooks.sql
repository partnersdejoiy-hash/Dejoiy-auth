-- ============================================================================
-- DEJOIY AUTH — Webhook System Migration
-- ============================================================================

-- Webhook endpoints (receivers)
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid REFERENCES applications(id) ON DELETE CASCADE,
  url             text NOT NULL,
  description     text DEFAULT '',
  secret          text NOT NULL,           -- HMAC-SHA256 signing secret (encrypted)
  events          text[] NOT NULL DEFAULT '{}',  -- subscribed event types
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_delivery_at timestamptz,
  last_delivery_status text DEFAULT 'pending', -- pending | success | failed
  failure_count   integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_application ON webhook_endpoints(application_id);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_active ON webhook_endpoints(is_active) WHERE is_active = true;

-- Webhook delivery attempts / logs
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  event_id        text NOT NULL,           -- unique event identifier (replay protection)
  payload         jsonb NOT NULL,          -- sanitized event payload (no secrets)
  signature       text NOT NULL,           -- HMAC-SHA256 signature
  status          text NOT NULL DEFAULT 'pending',  -- pending | success | failed | dead
  response_status integer,                 -- HTTP response code
  response_time_ms integer,               -- round-trip time
  error_message   text,                   -- failure reason
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  next_retry_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event ON webhook_deliveries(event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event_id ON webhook_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending ON webhook_deliveries(status) WHERE status = 'pending';
