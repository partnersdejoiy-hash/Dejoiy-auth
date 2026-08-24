-- ============================================================================
-- DEJOIY AUTH — grant Zoho sync run permission to IT_ADMIN
-- The IT panel is the operations surface for sync; IT_ADMIN could already
-- view sync status (sync.zoho.read) but not trigger a run. Applies to
-- existing databases where seed() will not re-run (production).
-- ============================================================================

INSERT INTO permissions (name, resource, description)
VALUES ('sync.zoho.run', 'sync', 'Run Zoho Sheet sync')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
 CROSS JOIN permissions p
 WHERE r.name = 'IT_ADMIN'
   AND p.name = 'sync.zoho.run'
ON CONFLICT DO NOTHING;
