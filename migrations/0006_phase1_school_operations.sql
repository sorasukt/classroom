-- Phase 1: central student directory, classroom enrollments and timetable.
-- Existing profile IDs are preserved so attendance and QR device bindings retain history.

CREATE TABLE student_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL,
  student_code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  homeroom TEXT NOT NULL DEFAULT '',
  guardian_name TEXT NOT NULL DEFAULT '',
  guardian_phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Reuse the oldest profile when the same non-empty student code already appears
-- in more than one legacy classroom of the same tenant.
INSERT INTO student_profiles(id,tenant_key,student_code,name,note,created_at)
SELECT s.id,c.tenant_key,s.student_code,s.name,s.note,s.created_at
FROM students s JOIN classrooms c ON c.id=s.classroom_id
WHERE s.student_code='' OR s.id=(
  SELECT MIN(s2.id) FROM students s2 JOIN classrooms c2 ON c2.id=s2.classroom_id
  WHERE c2.tenant_key=c.tenant_key AND s2.student_code=s.student_code
);

CREATE TABLE student_profile_migration_map (
  old_student_id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL
);
INSERT INTO student_profile_migration_map(old_student_id,student_id)
SELECT s.id,CASE WHEN s.student_code='' THEN s.id ELSE (
  SELECT MIN(s2.id) FROM students s2 JOIN classrooms c2 ON c2.id=s2.classroom_id
  WHERE c2.tenant_key=c.tenant_key AND s2.student_code=s.student_code
) END
FROM students s JOIN classrooms c ON c.id=s.classroom_id;

CREATE UNIQUE INDEX idx_student_profiles_code
  ON student_profiles(tenant_key,student_code) WHERE student_code<>'';
CREATE INDEX idx_student_profiles_tenant
  ON student_profiles(tenant_key,active,name);

CREATE TABLE classroom_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  classroom_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  student_no TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  enrolled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(classroom_id,student_id),
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY(student_id) REFERENCES student_profiles(id) ON DELETE CASCADE
);

INSERT INTO classroom_enrollments(classroom_id,student_id,student_no,enrolled_at)
SELECT s.classroom_id,m.student_id,s.student_no,s.created_at
FROM students s JOIN student_profile_migration_map m ON m.old_student_id=s.id;

CREATE INDEX idx_classroom_enrollments_classroom
  ON classroom_enrollments(classroom_id,active,student_no);
CREATE INDEX idx_classroom_enrollments_student
  ON classroom_enrollments(student_id,active);

CREATE TABLE attendance_phase1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','late','absent','leave')),
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id,student_id),
  FOREIGN KEY(session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(student_id) REFERENCES student_profiles(id) ON DELETE CASCADE
);
INSERT INTO attendance_phase1(id,session_id,student_id,status,note,updated_at)
SELECT a.id,a.session_id,m.student_id,a.status,a.note,a.updated_at
FROM attendance a JOIN student_profile_migration_map m ON m.old_student_id=a.student_id;

CREATE TABLE checkin_devices_phase1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL,
  classroom_id INTEGER NOT NULL,
  device_hash TEXT NOT NULL,
  student_id INTEGER NOT NULL,
  bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reset_after TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_key,classroom_id,device_hash),
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY(student_id) REFERENCES student_profiles(id) ON DELETE CASCADE
);
INSERT INTO checkin_devices_phase1(id,tenant_key,classroom_id,device_hash,student_id,bound_at,reset_after,last_seen_at)
SELECT cd.id,cd.tenant_key,cd.classroom_id,cd.device_hash,m.student_id,cd.bound_at,cd.reset_after,cd.last_seen_at
FROM checkin_devices cd JOIN student_profile_migration_map m ON m.old_student_id=cd.student_id;

DROP TABLE checkin_devices;
DROP TABLE attendance;
DROP TABLE students;
ALTER TABLE attendance_phase1 RENAME TO attendance;
ALTER TABLE checkin_devices_phase1 RENAME TO checkin_devices;
DROP TABLE student_profile_migration_map;

CREATE INDEX idx_attendance_student ON attendance(student_id);
CREATE INDEX idx_checkin_devices_student ON checkin_devices(student_id);

CREATE TABLE timetable_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL,
  classroom_id INTEGER NOT NULL,
  weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  teacher_name TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(classroom_id,weekday,start_time),
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO timetable_entries(tenant_key,classroom_id,weekday,start_time,room)
SELECT c.tenant_key,c.id,CAST(j.value AS INTEGER),c.start_time,c.room
FROM classrooms c,json_each('[' || c.schedule_days || ']') j
WHERE c.schedule_days<>'' AND c.start_time<>'';

CREATE INDEX idx_timetable_tenant_day
  ON timetable_entries(tenant_key,weekday,active,start_time);
