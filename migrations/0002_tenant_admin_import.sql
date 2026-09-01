ALTER TABLE classrooms ADD COLUMN tenant_key TEXT NOT NULL DEFAULT '';
ALTER TABLE classrooms ADD COLUMN created_by TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_classrooms_tenant ON classrooms(tenant_key, created_at);

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_key TEXT PRIMARY KEY,
  organization_name TEXT NOT NULL DEFAULT '',
  academic_year TEXT NOT NULL DEFAULT '',
  term TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
