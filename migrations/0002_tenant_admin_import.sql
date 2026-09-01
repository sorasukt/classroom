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

CREATE TABLE IF NOT EXISTS school_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_key, email)
);

CREATE INDEX IF NOT EXISTS idx_school_members_tenant ON school_members(tenant_key, active, email);

CREATE TABLE IF NOT EXISTS system_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
