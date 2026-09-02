-- Production may already have recorded migration 0002 before school_members
-- was added to that file. Keep this migration idempotent so both upgraded and
-- newly-created databases converge on the same schema.
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
