ALTER TABLE checkin_sessions ADD COLUMN access_code TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_checkin_sessions_access_code
  ON checkin_sessions(access_code, active, expires_at);

CREATE TABLE IF NOT EXISTS checkin_code_attempts (
  attempt_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_checkin_code_attempts_updated
  ON checkin_code_attempts(updated_at);
