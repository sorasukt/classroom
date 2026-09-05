-- Phase 2A is opt-in. No changes to existing teacher accounts or QR device bindings.
CREATE TABLE student_access_settings (
 tenant_key TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'auth' CHECK(mode IN ('auth','code')),
 allow_override INTEGER NOT NULL DEFAULT 0, require_evidence INTEGER NOT NULL DEFAULT 0,
 allow_private INTEGER NOT NULL DEFAULT 0, auto_domain INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE student_class_access (
 classroom_id INTEGER PRIMARY KEY REFERENCES classrooms(id) ON DELETE CASCADE,
 mode TEXT CHECK(mode IN ('auth','code')), require_evidence INTEGER NOT NULL DEFAULT 0,
 allow_private INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE student_invites (
 id TEXT PRIMARY KEY, tenant_key TEXT NOT NULL, classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, student_id INTEGER REFERENCES student_profiles(id),
 expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX student_invites_room ON student_invites(tenant_key,classroom_id);
CREATE TABLE student_identities (
 sub TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE student_portal_sessions (
 token_hash TEXT PRIMARY KEY, sub TEXT, student_id INTEGER, classroom_id INTEGER,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 CHECK ((sub IS NOT NULL AND student_id IS NULL) OR (sub IS NULL AND student_id IS NOT NULL AND classroom_id IS NOT NULL))
);
CREATE INDEX student_portal_expiry ON student_portal_sessions(expires_at);
CREATE TABLE student_applications (
 id TEXT PRIMARY KEY, tenant_key TEXT NOT NULL, classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
 student_id INTEGER NOT NULL REFERENCES student_profiles(id), sub TEXT NOT NULL REFERENCES student_identities(sub),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','more','approved','rejected','cancelled','expired')),
 require_evidence INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, reviewed_at INTEGER, reviewed_by TEXT,
 UNIQUE(classroom_id,student_id,sub)
);
CREATE INDEX student_applications_tenant ON student_applications(tenant_key,status);
CREATE TABLE student_account_bindings (
 tenant_key TEXT NOT NULL, student_id INTEGER NOT NULL REFERENCES student_profiles(id), sub TEXT NOT NULL REFERENCES student_identities(sub),
 active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant_key,student_id), UNIQUE(tenant_key,sub)
);
CREATE TABLE student_room_members (
 classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE, sub TEXT NOT NULL,
 student_id INTEGER NOT NULL REFERENCES student_profiles(id), active INTEGER NOT NULL DEFAULT 1, reauth_after INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(classroom_id,sub), UNIQUE(classroom_id,student_id)
);
CREATE TABLE student_review_teachers (
 tenant_key TEXT NOT NULL, classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
 sub TEXT NOT NULL REFERENCES student_identities(sub), PRIMARY KEY(classroom_id,sub)
);
-- No original filenames, document text, thumbnails or image content in D1/audit backups.
CREATE TABLE student_evidence (
 id TEXT PRIMARY KEY, application_id TEXT NOT NULL, -- tombstones survive deletion of a classroom/application
 object_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at<=created_at+604800000),
 state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','revoked','deleted'))
);
CREATE INDEX student_evidence_cleanup ON student_evidence(state,expires_at);
CREATE TABLE student_access_attempts (
 bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
