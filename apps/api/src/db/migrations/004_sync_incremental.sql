-- ============================================================================
-- DEJOIY AUTH — incremental Zoho sync (Phases 3-5, 7, 11)
--
-- * sync_field_mappings  — per-field sync direction (never | db_to_sheet |
--                          sheet_to_db | bidirectional)
-- * sheet_sync_records   — per-user sync metadata (version, last_synced_at,
--                          record hash, sheet baseline for conflict detection)
-- * sync_conflicts       — detected field conflicts + resolution audit
-- * demo_generation_jobs — synthetic dataset generator progress
-- * sheet_sync_jobs      — + rows_added / rows_updated / rows_deleted /
--                          conflicts / failed_records statistics
-- * users.metadata       — jsonb marker (e.g. synthetic demo users)
-- ============================================================================

-- ---------- Field mappings (Phase 4) ----------------------------------------

CREATE TABLE IF NOT EXISTS sync_field_mappings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field       text NOT NULL UNIQUE,
  direction   text NOT NULL DEFAULT 'db_to_sheet',
  description text,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_field_mappings_direction ON sync_field_mappings(direction);

-- ---------- Per-record sync metadata (Phase 5) --------------------------------

CREATE TABLE IF NOT EXISTS sheet_sync_records (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  user_number    text NOT NULL UNIQUE,
  version        integer NOT NULL DEFAULT 0,
  last_synced_at timestamptz,
  sync_status    text NOT NULL DEFAULT 'pending',   -- pending | synced | conflict | failed | removed
  record_hash    text,                              -- hash of last pushed values (push change detection)
  sheet_baseline jsonb NOT NULL DEFAULT '{}'::jsonb, -- field -> sheet value at last sync (pull conflict detection)
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sheet_sync_records_status ON sheet_sync_records(sync_status);

-- ---------- Conflicts (Phase 5) ------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid REFERENCES sheet_sync_jobs(id) ON DELETE SET NULL,
  user_number  text NOT NULL,
  field        text NOT NULL,
  db_value     text,
  sheet_value  text,
  source       text NOT NULL DEFAULT 'pull',        -- pull | push
  status       text NOT NULL DEFAULT 'pending',     -- pending | resolved | skipped
  resolution   text,                                -- keep_db | keep_sheet | skip
  resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON sync_conflicts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user ON sync_conflicts(user_number);

-- ---------- Job statistics (Phase 7 / UI) ----------------------------------------

ALTER TABLE sheet_sync_jobs
  ADD COLUMN IF NOT EXISTS rows_added     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rows_updated   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rows_deleted   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conflicts      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_records integer NOT NULL DEFAULT 0;

-- ---------- Synthetic demo users (Phase 11) ---------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS demo_generation_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text NOT NULL DEFAULT 'queued',       -- queued | running | success | failed
  requested   integer NOT NULL DEFAULT 0,
  inserted    integer NOT NULL DEFAULT 0,
  updated     integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  error       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- ---------- Default field mapping seed (Phase 4) -----------------------------------
-- Security-sensitive fields are absent by design: passwords, hashes, MFA secrets,
-- recovery codes, session tokens and API keys NEVER appear in the sheet columns.

INSERT INTO sync_field_mappings (field, direction, description) VALUES
  ('User ID',          'db_to_sheet',    'Stable identifier (DJY-…) — DB → Sheet only'),
  ('Employee ID',      'db_to_sheet',    'DB → Sheet only'),
  ('Full Name',        'db_to_sheet',    'DB → Sheet only by default; enable bidirectional explicitly'),
  ('Email',            'db_to_sheet',    'DB → Sheet only'),
  ('Phone',            'db_to_sheet',    'DB → Sheet only by default; enable bidirectional explicitly'),
  ('Department',       'bidirectional',  'Bidirectional'),
  ('Designation',      'db_to_sheet',    'DB → Sheet only by default'),
  ('Role',             'bidirectional',  'Bidirectional — role must exist; authorized admins only'),
  ('Manager',          'bidirectional',  'Bidirectional — matched by email'),
  ('Location',         'db_to_sheet',    'DB → Sheet only (no DB column today — informational)'),
  ('Employment Type',  'db_to_sheet',    'DB → Sheet only by default'),
  ('Joining Date',     'db_to_sheet',    'DB → Sheet only'),
  ('Status',           'bidirectional',  'Bidirectional only with strict validation'),
  ('Last Login',       'db_to_sheet',    'DB → Sheet only'),
  ('MFA Enabled',      'db_to_sheet',    'DB → Sheet only (never pulled)'),
  ('Account Risk',     'db_to_sheet',    'DB → Sheet only'),
  ('Created At',       'db_to_sheet',    'DB → Sheet only'),
  ('Updated At',       'db_to_sheet',    'DB → Sheet only'),
  ('Sync Status',      'db_to_sheet',    'Internal sync metadata — DB → Sheet only'),
  ('Sync Version',     'db_to_sheet',    'Internal sync metadata — DB → Sheet only')
ON CONFLICT (field) DO NOTHING;

-- ---------- Permissions ---------------------------------------------------------

INSERT INTO permissions (name, resource, description) VALUES
  ('sync.zoho.update',   'sync', 'Configure Zoho sync (field mappings, mode, deletion policy)'),
  ('sync.zoho.resolve',  'sync', 'Resolve Zoho sync conflicts'),
  ('sync.zoho.generate', 'sync', 'Generate synthetic demo dataset')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
 CROSS JOIN permissions p
 WHERE r.name = 'IT_ADMIN'
   AND p.name IN ('sync.zoho.update', 'sync.zoho.resolve', 'sync.zoho.generate')
ON CONFLICT DO NOTHING;
