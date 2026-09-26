DROP INDEX IF EXISTS idx_attendance_session_register;
DROP INDEX IF EXISTS idx_attendance_session_register_2025;

CREATE UNIQUE INDEX idx_attendance_session_register
  ON IT_Attendance_2024_2028(session_id, register_no);
CREATE UNIQUE INDEX idx_attendance_session_register_2025
  ON IT_Attendance_2025_2029(session_id, register_no);

CREATE INDEX IF NOT EXISTS idx_students_class_register_2024
  ON IT_Students_2024_2028(year, section, register_no);
CREATE INDEX IF NOT EXISTS idx_students_class_register_2025
  ON IT_Students_2025_2029(year, section, register_no);

CREATE INDEX IF NOT EXISTS idx_attendance_session_class_period_date
  ON attendance_session(year, section, period, attendance_date, created_at);
CREATE INDEX IF NOT EXISTS idx_attendance_session_status_expiry
  ON attendance_session(status, expire_at);