CREATE TABLE IF NOT EXISTS practicum_portfolios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_sub TEXT NOT NULL,
  document_key TEXT NOT NULL CHECK(document_key IN ('school_observation','assistant_teacher_report','daily_logbook')),
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','needs_revision','approved')),
  submitted_at TEXT,
  reviewed_at TEXT,
  reviewer_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_sub, document_key)
);
CREATE INDEX IF NOT EXISTS idx_practicum_portfolios_user ON practicum_portfolios(user_sub, updated_at);

CREATE TABLE IF NOT EXISTS practicum_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_sub TEXT NOT NULL,
  work_date TEXT NOT NULL,
  time_in TEXT NOT NULL DEFAULT '',
  time_out TEXT NOT NULL DEFAULT '',
  activity TEXT NOT NULL DEFAULT '',
  reflection TEXT NOT NULL DEFAULT '',
  hours REAL NOT NULL DEFAULT 0 CHECK(hours >= 0 AND hours <= 24),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','needs_revision')),
  mentor_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_practicum_logs_user_date ON practicum_logs(user_sub, work_date DESC);
