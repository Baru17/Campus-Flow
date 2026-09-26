-- Migration number: 0006

ALTER TABLE attendance_session ADD COLUMN subject_code TEXT;
ALTER TABLE attendance_session ADD COLUMN subject_name TEXT;
ALTER TABLE attendance_session ADD COLUMN year INTEGER;
ALTER TABLE attendance_session ADD COLUMN section TEXT;
ALTER TABLE attendance_session ADD COLUMN period INTEGER;
ALTER TABLE attendance_session ADD COLUMN attendance_date TEXT;
ALTER TABLE attendance_session ADD COLUMN attendance_table TEXT;
ALTER TABLE attendance_session ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE attendance_session ADD COLUMN finalized_at TEXT;

CREATE INDEX IF NOT EXISTS idx_attendance_session_status
ON attendance_session(status);

CREATE INDEX IF NOT EXISTS idx_attendance_session_otp_status
ON attendance_session(otp, status);

CREATE INDEX IF NOT EXISTS idx_attendance_session_expire_at
ON attendance_session(expire_at);