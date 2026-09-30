-- Migration number: 0013
-- Department-aware attendance sessions and subjects.
--
-- Students and attendance rows are stored in physically separate tables per
-- department and batch, so a session that does not record which one it belongs
-- to cannot be finalized, reported on, or edited by a class advisor without
-- guessing. Previously `year` alone implied the table, which silently pinned
-- every department to IT.
--
-- `department` and `batch` are stored on the session so finalization reads the
-- exact table the session was created against instead of re-deriving it.
-- `subjects` becomes department-aware for the same reason.
--
-- Existing rows predate this migration, so their batch is recovered from the
-- table they were actually written to, never guessed from a year of study. Rows
-- that cannot be resolved that way keep a NULL batch and are refused at runtime.

ALTER TABLE attendance_session ADD COLUMN department TEXT NOT NULL DEFAULT 'IT';

ALTER TABLE attendance_session ADD COLUMN batch TEXT;

-- Recover the batch for historical sessions.
--
-- `attendance_table` records the exact table the session was actually used
-- against, so the batch is read straight off it:
--
--     IT_Attendance_2024_2028 -> 2024_2028
--     IT_Attendance_2025_2029 -> 2025_2029
--
-- The year of study is deliberately not consulted. Deriving a batch from a year
-- would assert a table the session may never have touched, which is a guess; the
-- table it was written to is not.
--
-- A session whose `attendance_table` is not one of the verified tables keeps a
-- NULL batch. `resolveSessionTables` then refuses it with "batch not configured"
-- instead of routing it to a guessed table, which is the safe outcome.
--
-- `department` is left at its 'IT' default. That is not a guess: IT is the only
-- department that has student and attendance tables, so no other value is
-- possible for a row that can exist today.
UPDATE attendance_session
SET batch = CASE attendance_table
      WHEN 'IT_Attendance_2024_2028' THEN '2024_2028'
      WHEN 'IT_Attendance_2025_2029' THEN '2025_2029'
    END
WHERE batch IS NULL
  AND attendance_table IN ('IT_Attendance_2024_2028', 'IT_Attendance_2025_2029');

CREATE INDEX IF NOT EXISTS idx_attendance_session_department_class
ON attendance_session(department, batch, year, section, period, attendance_date);

ALTER TABLE subjects ADD COLUMN department TEXT NOT NULL DEFAULT 'IT';

CREATE INDEX IF NOT EXISTS idx_subjects_department_year
ON subjects(department, year);

-- A class advisor is assigned a department, a year of study and a section. That
-- is not enough to find their tables under the department + batch rule, so the
-- assignment gains a batch too. `advisor_year` is kept because it still selects
-- the class; it is never used to pick tables.
ALTER TABLE staff ADD COLUMN advisor_batch TEXT;

-- Historical data migration only, and deliberately limited to IT.
--
-- IT is the only department that has student and attendance tables, so a batch
-- can only be derived for an IT advisor. Constraining the UPDATE to
-- `department = 'IT'` means an advisor in any other department is left with a
-- NULL advisor_batch instead of being handed a batch that was never theirs.
--
-- `advisor_year` is used here because `staff` records no table name, unlike
-- `attendance_session.attendance_table`. It is the same value that previously
-- determined this advisor's tables, so this preserves their existing assignment
-- rather than moving them to another one.
--
-- An IT advisor with a year other than 2 or 3, or no year at all, is left NULL.
UPDATE staff
SET advisor_batch = CASE advisor_year
      WHEN 2 THEN '2025_2029'
      WHEN 3 THEN '2024_2028'
    END
WHERE advisor_batch IS NULL
  AND advisor_year IS NOT NULL
  AND department = 'IT';

CREATE INDEX IF NOT EXISTS idx_staff_advisor_batch
ON staff(advisor_batch);
