ALTER TABLE students ADD COLUMN student_code TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_classroom_code ON students(classroom_id, student_code) WHERE student_code <> '';

CREATE TABLE IF NOT EXISTS checkin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  tenant_key TEXT NOT NULL,
  classroom_id INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checkin_sessions_classroom ON checkin_sessions(classroom_id, session_date);

CREATE TABLE IF NOT EXISTS checkin_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL,
  classroom_id INTEGER NOT NULL,
  device_hash TEXT NOT NULL,
  student_id INTEGER NOT NULL,
  bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reset_after TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_key, classroom_id, device_hash),
  FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checkin_devices_student ON checkin_devices(student_id);
