-- Migration number: 0008
-- Adds indexes for the OTP submission and login hot paths.
-- Without these, every OTP submit and every login performs a full table scan.

CREATE INDEX IF NOT EXISTS idx_attendance_od ON IT_Attendance_2024_2028(od);
CREATE INDEX IF NOT EXISTS idx_attendance_od_2025 ON IT_Attendance_2025_2029(od);

CREATE INDEX IF NOT EXISTS idx_attendance_session_register
  ON IT_Attendance_2024_2028(session_id, register_no);
CREATE INDEX IF NOT EXISTS idx_attendance_session_register_2025
  ON IT_Attendance_2025_2029(session_id, register_no);

CREATE INDEX IF NOT EXISTS idx_attendance_section_date_period
  ON IT_Attendance_2024_2028(section, attendance_date, period);
CREATE INDEX IF NOT EXISTS idx_attendance_section_date_period_2025
  ON IT_Attendance_2025_2029(section, attendance_date, period);

CREATE INDEX IF NOT EXISTS idx_students_auth_user_2024
  ON IT_Students_2024_2028(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_students_auth_user_2025
  ON IT_Students_2025_2029(auth_user_id);
