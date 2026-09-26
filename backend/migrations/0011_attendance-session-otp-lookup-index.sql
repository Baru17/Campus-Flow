-- Cover the OTP lookup performed by POST /api/attendance/verify.
--
-- That lookup filters on otp + status, requires expire_at > ?, and orders by
-- created_at DESC. When this index is used, SQLite resolves the filter and
-- the sort from the index alone:
--
--   SEARCH attendance_session USING INDEX idx_attendance_session_otp_status_created (otp=? AND status=?)
--
-- versus the plan chosen today, which filters on the low-cardinality status
-- column and then pays for the ordering separately:
--
--   SEARCH attendance_session USING INDEX idx_attendance_session_status_expiry (status=? AND expire_at>?)
--   USE TEMP B-TREE FOR ORDER BY
--
-- Note: on the current dataset the planner still prefers
-- idx_attendance_session_status_expiry, because the table is small enough that
-- the two plans cost about the same. The index is kept so the OTP path stops
-- depending on the selectivity of status as the table grows.
CREATE INDEX IF NOT EXISTS idx_attendance_session_otp_status_created
  ON attendance_session(otp, status, created_at);
