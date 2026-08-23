-- ============================================================================
-- DEJOIY AUTH — initial schema
-- PostgreSQL is the source of truth for identity.
-- ============================================================================

-- ---------- Extensions ---------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Enums -----------------------------------------------------------

CREATE TYPE account_state AS ENUM (
  'PENDING', 'ACTIVE', 'SUSPENDED', 'BLOCKED', 'LOCKED',
  'DISABLED', 'TERMINATED', 'PASSWORD_RESET_REQUIRED'
);

CREATE TYPE user_type AS ENUM ('customer', 'seller', 'employee', 'admin', 'service_account');

CREATE TYPE severity AS ENUM ('info', 'low', 'medium', 'high', 'critical');

CREATE TYPE sync_status AS ENUM ('pending', 'running', 'success', 'failed');

-- ---------- Updated-at trigger ----------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- Departments / teams ----------------------------------------------

CREATE TABLE departments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,
  code          text UNIQUE,
  description   text,
  manager_id    uuid,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  name          text NOT NULL,
  manager_id    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, name)
);

-- ---------- Roles / permissions ----------------------------------------------

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  resource    text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_role_permissions_permission ON role_permissions(permission_id);

-- ---------- Users ------------------------------------------------------------

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_number           text NOT NULL UNIQUE,            -- DJY-CUS-000001 etc.
  user_type             user_type NOT NULL,
  email                 citext UNIQUE,
  phone                 text UNIQUE,
  username              text UNIQUE,
  password_hash         text,
  account_state         account_state NOT NULL DEFAULT 'PENDING',
  mfa_enabled           boolean NOT NULL DEFAULT false,
  mfa_required          boolean NOT NULL DEFAULT false,
  password_changed_at   timestamptz,
  last_login_at         timestamptz,
  last_login_ip         text,
  failed_login_count    integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz                      -- soft delete
);

CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_state ON users(account_state);
CREATE INDEX idx_users_type ON users(user_type);

-- ---------- User profiles ----------------------------------------------------

CREATE TABLE user_profiles (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name    text,
  avatar_url   text,
  title        text,
  locale       text NOT NULL DEFAULT 'en-IN',
  timezone     text NOT NULL DEFAULT 'Asia/Kolkata',
  birthday     date,
  gender       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- Role assignment ----------------------------------------------------

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_user_roles_role ON user_roles(role_id);

-- ---------- Employee / WFM ------------------------------------------------------

CREATE TABLE employee_profiles (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_id         text UNIQUE,
  department_id       uuid REFERENCES departments(id) ON DELETE SET NULL,
  team_id             uuid REFERENCES teams(id) ON DELETE SET NULL,
  manager_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  hire_date           date,
  termination_date    date,
  employment_status   text NOT NULL DEFAULT 'active',   -- active | resigned | terminated | absconded
  designation         text,
  onboarding_status   text NOT NULL DEFAULT 'pending',  -- pending | onboarded | deactivated
  absconded_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wfm_profiles (
  user_id                  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  agent_status             text NOT NULL DEFAULT 'offline',  -- offline | available | busy | break
  shift_id                 text,
  access_eligibility       boolean NOT NULL DEFAULT false,
  attendance_provider_id   text,
  last_status_change_at    timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ---------- Applications / OAuth -------------------------------------------------

CREATE TABLE applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  type            text NOT NULL DEFAULT 'web',   -- web | spa | native | service
  description     text,
  redirect_uris   jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_scopes  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'active',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE oauth_clients (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id            uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  client_id                 text NOT NULL UNIQUE,
  client_secret_hash        text,
  grant_types               jsonb NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb,
  token_endpoint_auth_method text NOT NULL DEFAULT 'client_secret_basic',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_scopes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL UNIQUE,
  description    text,
  application_id uuid REFERENCES applications(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Sessions / devices / tokens -------------------------------------------

CREATE TABLE devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  label       text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  UNIQUE (user_id, fingerprint)
);

CREATE INDEX idx_devices_user ON devices(user_id);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL UNIQUE,
  device_id        uuid REFERENCES devices(id) ON DELETE SET NULL,
  ip               text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_active_at   timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  idle_expires_at  timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoke_reason    text,
  requires_reauth  boolean NOT NULL DEFAULT false,
  reauth_at        timestamptz
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE refresh_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_family     uuid NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  rotated_from_id  uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoke_reason    text,
  last_used_at     timestamptz,
  ip               text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(token_family);
CREATE INDEX idx_refresh_tokens_session ON refresh_tokens(session_id);

-- ---------- Authentication records ------------------------------------------------

CREATE TABLE login_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  identifier     text,
  ip             text,
  user_agent     text,
  success        boolean NOT NULL DEFAULT false,
  failure_reason text,
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_login_attempts_user ON login_attempts(user_id, created_at DESC);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip, created_at DESC);

CREATE TABLE password_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  changed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_history_user ON password_history(user_id, created_at DESC);

CREATE TABLE password_resets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE,
  reset_type     text NOT NULL DEFAULT 'self',   -- self | admin | emergency
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  requested_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_ip   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_resets_user ON password_resets(user_id, created_at DESC);

CREATE TABLE email_verifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  email      text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- MFA --------------------------------------------------------------------

CREATE TABLE mfa_factors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  factor_type      text NOT NULL,              -- totp | webauthn
  label            text,
  secret_encrypted text,                       -- AES-256-GCM with DATA_ENCRYPTION_KEY
  status           text NOT NULL DEFAULT 'active',  -- active | pending | revoked
  last_used_at     timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mfa_user ON mfa_factors(user_id);

CREATE TABLE recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recovery_codes_user ON recovery_codes(user_id);

-- ---------- Observability ------------------------------------------------------------

CREATE TABLE security_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       text NOT NULL UNIQUE,          -- SEC-XXXXXXXX
  event_type     text NOT NULL,
  severity       severity NOT NULL DEFAULT 'info',
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  ip             text,
  user_agent     text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_security_events_user ON security_events(user_id, created_at DESC);
CREATE INDEX idx_security_events_type ON security_events(event_type, created_at DESC);

CREATE TABLE audit_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role     text,
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  target_label   text,
  correlation_id text,
  ip             text,
  result         text NOT NULL DEFAULT 'success',   -- success | failure | denied
  reason         text,
  before         jsonb,
  after          jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);

-- ---------- Notifications -------------------------------------------------------------

CREATE TABLE notification_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  text NOT NULL,
  recipients  jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- sanitized, no secrets
  status      text NOT NULL DEFAULT 'queued',       -- queued | sent | failed
  error       text,
  correlation_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  event_id       uuid REFERENCES notification_events(id) ON DELETE SET NULL,
  type           text NOT NULL,
  channel        text NOT NULL DEFAULT 'email',
  subject        text,
  body           text,
  status         text NOT NULL DEFAULT 'queued',
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

-- ---------- Zoho sync ------------------------------------------------------------------

CREATE TABLE sheet_sync_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status         sync_status NOT NULL DEFAULT 'pending',
  started_at     timestamptz,
  finished_at    timestamptz,
  rows_synced    integer NOT NULL DEFAULT 0,
  error          text,
  triggered_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  trigger_type   text NOT NULL DEFAULT 'manual',   -- manual | scheduled | startup
  summary        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sheet_sync_jobs_status ON sheet_sync_jobs(status, created_at DESC);

-- ---------- System settings --------------------------------------------------------------

CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Triggers -----------------------------------------------------------------------

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_profiles_updated_at BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_departments_updated_at BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employee_profiles_updated_at BEFORE UPDATE ON employee_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_wfm_profiles_updated_at BEFORE UPDATE ON wfm_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_applications_updated_at BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_oauth_clients_updated_at BEFORE UPDATE ON oauth_clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_mfa_factors_updated_at BEFORE UPDATE ON mfa_factors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_system_settings_updated_at BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

