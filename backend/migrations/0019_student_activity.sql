-- Migration number: 0019
-- Live "active students" counter for the staff dashboard.
--
-- One row per student account, holding nothing but the moment that account was last
-- seen. It is deliberately its own table rather than a column on an existing one:
--
--   * `auth_sessions` is one row per sign-in, so counting it would count devices and
--     tabs rather than accounts. Reusing it would also have meant writing to the table
--     the authentication middleware reads on every request.
--   * the per-cohort student tables are the roster, not a signal, and there is one per
--     cohort -- there is no single place to record "this account is active right now".
--   * `attendance_session` belongs to the OTP workflow and must not be extended to
--     carry monitoring state.
--
-- Additive only: it creates one new table and one index, and touches no existing
-- table, column or row. Dropping it removes the counter and nothing else.

CREATE TABLE IF NOT EXISTS student_activity (
    auth_user_id TEXT PRIMARY KEY,
    last_active_at TEXT NOT NULL
);

-- The count is "recently seen", so the table is always read as a range on this
-- column. The primary key already indexes `auth_user_id` for the upsert.
CREATE INDEX IF NOT EXISTS idx_student_activity_last_active_at
    ON student_activity(last_active_at);
