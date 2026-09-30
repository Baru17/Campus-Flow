-- Migration number: 0014
-- CSE 2026-2030 batch provisioning and controlled test seed.
--
-- This provisions the first non-IT department so the multi-department
-- attendance architecture can be verified end to end: a CSE staff member logs
-- in, resolves a CSE batch, and every read and write lands in CSE tables while
-- the IT tables stay untouched.
--
-- Two things are provisioned together, because a batch is only usable when both
-- halves exist:
--
--     CSE_Students_2026_2030      the cohort
--     CSE_Attendance_2026_2030    the marks taken for that cohort
--
-- The batch is the source of truth for both table names. The batch key
-- "2026_2030" is written explicitly and is never derived from a year of study:
-- `year` here is 1, but a year is a student's current academic level and changes
-- every year, whereas the batch and its two physical tables are permanent. Next
-- academic year this cohort is still batch 2026_2030 with year 2, and the tables
-- are still these two.
--
-- Column definitions are copied from the existing IT tables, including the
-- constraints they carry. Nothing is invented and no IT table is read or
-- written here.
--
-- Index names are suffixed `_cse`. SQLite index names are global to the
-- database, not per table, so the unsuffixed names used by the IT tables
-- (idx_attendance_od and friends) are already taken. This matches the existing
-- `_2025` convention.
--
-- Re-running is safe: every insert is `INSERT OR IGNORE` against a UNIQUE
-- constraint, so a partially applied migration can be re-applied without
-- duplicating rows or disturbing the ones already present.
--
-- Seed identifiers are fixed literals rather than generated values so that
-- applying this migration twice produces byte-identical rows. Nothing is read
-- from the clock.

-- ============================================
-- 1. CSE student table
--
-- Identical shape to IT_Students_2024_2028 / IT_Students_2025_2029.
-- ============================================

CREATE TABLE IF NOT EXISTS CSE_Students_2026_2030 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL UNIQUE,
    register_no TEXT NOT NULL UNIQUE,
    student_name TEXT NOT NULL,
    year INTEGER NOT NULL,
    section TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    auth_user_id TEXT
);

-- ============================================
-- 2. CSE attendance table
--
-- Identical shape to IT_Attendance_2024_2028, including the `status` column
-- added in 0003 and the `od` column added in 0007. Declared inline here because
-- this table is created once, complete, rather than being built up by a chain of
-- ALTER TABLE statements.
--
-- `session_id` + `register_no` carries the unique index below, which is what
-- makes a second PRESENT for the same student in the same session impossible.
-- ============================================

CREATE TABLE IF NOT EXISTS CSE_Attendance_2026_2030 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id TEXT NOT NULL,
    register_no TEXT NOT NULL,
    section TEXT NOT NULL,
    attendance_date TEXT NOT NULL,
    period INTEGER NOT NULL,
    subject_code TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    marked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ABSENT',
    od TEXT DEFAULT 'NO'
);

-- ============================================
-- 3. Indexes, mirroring the IT tables
-- ============================================

-- Duplicate protection: one row per (session, student).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cse_attendance_session_register
  ON CSE_Attendance_2026_2030(session_id, register_no);

-- Hot path for the class/period/date report reads.
CREATE INDEX IF NOT EXISTS idx_cse_attendance_section_date_period
  ON CSE_Attendance_2026_2030(section, attendance_date, period);

CREATE INDEX IF NOT EXISTS idx_cse_attendance_od
  ON CSE_Attendance_2026_2030(od);

-- Roster lookup: year and section select the class inside this batch.
CREATE INDEX IF NOT EXISTS idx_cse_students_class_register
  ON CSE_Students_2026_2030(year, section, register_no);

-- Student login resolves the row by auth_user_id.
CREATE INDEX IF NOT EXISTS idx_cse_students_auth_user
  ON CSE_Students_2026_2030(auth_user_id);

-- ============================================
-- 4. CSE students (10, year 1, section A)
--
-- student_name is required and has no default. Real student names are not
-- fabricated for seed data, so these are clearly marked as test identities.
--
-- The auth_user_id values are fixed UUIDs so the seed is reproducible; they are
-- linked to auth_users in step 6.
-- ============================================

INSERT OR IGNORE INTO CSE_Students_2026_2030
  (student_id, register_no, student_name, year, section, email, created_at, auth_user_id)
VALUES
  ('2k26cse001', '611226104001', 'CSE Test Student 01', 1, 'A', '2k26cse001@kiot.ac.in', '2026-09-29 00:00:00', 'c5e50001-0000-4000-8000-000000000001'),
  ('2k26cse002', '611226104002', 'CSE Test Student 02', 1, 'A', '2k26cse002@kiot.ac.in', '2026-09-29 00:00:00', 'c5e50002-0000-4000-8000-000000000002'),
  ('2k26cse003', '611226104003', 'CSE Test Student 03', 1, 'A', '2k26cse003@kiot.ac.in', '2026-09-29 00:00:00', 'c5e50003-0000-4000-8000-000000000003'),
  ('2k26cse004', '611226104004', 'CSE Test Student 04', 1, 'A', '2k26cse004@kiot.ac.in', '2026-09-29 00:00:00', 'c5e50004-0000-4000-8000-000000000004'),
  ('2k26cse005', '611226104005', 'CSE Test Student 05', 1, 'A', '2k26cse005@kiot.ac.in', '2026-09-29 00:00:00', 'c5e50005-0000-4000-8000-000000000005'),
  ('2k26cse006', '611226104006', 'CSE Test Student 06', 1, 'A', '2k26cse006@kiot.ac.in', '2026-09-29 00:00:00', 'c5e50006-0000-4000-8000-000000000006'),
  ('2k26cse007', '611226104007', 'CSE Test Student 07', 1, 'A', '2k26cse007@kiot.ac.in', '2026-09-29 00:00:00', 'c5e50007-0000-4000-8000-000000000007'),
  ('2k26cse008', '611226104008', 'CSE Test Student 08', 1, 'A', '2k26cse008@kiot.ac.in', '2026-09-29 00:00:00', 'c5e50008-0000-4000-8000-000000000008'),
  ('2k26cse009', '611226104009', 'CSE Test Student 09', 1, 'A', '2k26cse009@kiot.ac.in', '2026-09-29 00:00:00', 'c5e50009-0000-4000-8000-000000000009'),
  ('2k26cse010', '611226104010', 'CSE Test Student 10', 1, 'A', '2k26cse010@kiot.ac.in', '2026-09-29 00:00:00', 'c5e5000a-0000-4000-8000-00000000000a');

-- ============================================
-- 5. CSE staff (4)
--
-- staff_id is 101-104. The existing IT staff occupy 1-4, and auth_users.user_name
-- is UNIQUE and holds the staff_id for staff logins, so reusing 1-4 would collide
-- and break authentication for real accounts. 101-104 is free.
--
-- `class_advisor` is TEXT and holds '1' for the advisor, matching the existing IT
-- rows. It is a label on the staff record; the route guard reads the role from
-- auth_users instead, so both are set consistently in step 6.
--
-- Only the advisor carries an advisor_batch / advisor_year / advisor_section.
-- The other three are deliberately left NULL: /api/class-advisors/students
-- requires all three to be present, so a NULL is what keeps them out of the
-- advisor routes.
--
-- advisor_batch is written as the literal '2026_2030'. It is not derived from
-- advisor_year.
-- ============================================

INSERT OR IGNORE INTO staff
  (staff_id, staff_name, email, department, class_advisor, created_at, auth_user_id,
   advisor_year, advisor_section, advisor_batch)
VALUES
  ('101', 'CSE Faculty 1',            'cse.faculty1@kiot.ac.in', 'CSE', NULL, '2026-09-29 00:00:00', 'c5e5f001-0000-4000-8000-000000000001', NULL, NULL, NULL),
  ('102', 'CSE Faculty 2',            'cse.faculty2@kiot.ac.in', 'CSE', NULL, '2026-09-29 00:00:00', 'c5e5f002-0000-4000-8000-000000000002', NULL, NULL, NULL),
  ('103', 'CSE Faculty 3',            'cse.faculty3@kiot.ac.in', 'CSE', NULL, '2026-09-29 00:00:00', 'c5e5f003-0000-4000-8000-000000000003', NULL, NULL, NULL),
  ('104', 'CSE Class Advisor',        'cse.advisor@kiot.ac.in',  'CSE', '1',   '2026-09-29 00:00:00', 'c5e5f004-0000-4000-8000-000000000004', 1,    'A',    '2026_2030');

-- ============================================
-- 6. Login rows in auth_users
--
-- The existing login flow is unchanged: the password row lives in auth_users,
-- the account is looked up by user_name or email, and the bcrypt hash is
-- compared in the Worker. No auth_sessions row is created here; a session is
-- only ever created by an actual login.
--
-- user_name follows the existing convention for each kind of account:
--   students -> the student_id, so a student logs in with their ID or email
--   staff    -> the staff_id, so staff log in with their ID or email
--
-- The student_id values themselves are the required lowercase identifiers and
-- are not altered: `CSE_Students_2026_2030.student_id` and every email keep
-- `2k26cse001` exactly as specified.
--
-- Only `auth_users.user_name` is uppercased, because the login route uppercases a
-- non-email identifier before it looks the account up:
--
--     const lookupUser = isEmail ? user_name.toLowerCase() : user_name.toUpperCase();
--
-- Storing the login key in the same case the lookup produces is what makes the
-- account reachable by ID. This is not a cosmetic choice: seeding the lowercase
-- form would create accounts that exist in the table but can never be logged
-- into by ID. The existing IT students store `2K24IT001` for the same reason.
--
-- The hash is bcrypt cost 10 over the project's documented seed password and is
-- stored as a hash only. The plaintext is never written to the database.
-- ============================================

INSERT OR IGNORE INTO auth_users (auth_user_id, user_name, pwd_hash, role, email, created_at)
SELECT
  auth_user_id,
  UPPER(student_id),
  '$2b$10$8a0YU6SImHiebzcjVLXfrOf8Am2tFoLgip3kOyiMlYhFCrzZ4Jc3C',
  'student',
  email,
  '2026-09-29 00:00:00'
FROM CSE_Students_2026_2030;

-- Role mirrors the staff record: one class_advisor, three plain staff.
-- Both are accepted by the staff login route, but only 'class_advisor' passes
-- the class-advisor route guard.
INSERT OR IGNORE INTO auth_users (auth_user_id, user_name, pwd_hash, role, email, created_at)
VALUES
  ('c5e5f001-0000-4000-8000-000000000001', '101', '$2b$10$8a0YU6SImHiebzcjVLXfrOf8Am2tFoLgip3kOyiMlYhFCrzZ4Jc3C', 'staff',          'cse.faculty1@kiot.ac.in', '2026-09-29 00:00:00'),
  ('c5e5f002-0000-4000-8000-000000000002', '102', '$2b$10$8a0YU6SImHiebzcjVLXfrOf8Am2tFoLgip3kOyiMlYhFCrzZ4Jc3C', 'staff',          'cse.faculty2@kiot.ac.in', '2026-09-29 00:00:00'),
  ('c5e5f003-0000-4000-8000-000000000003', '103', '$2b$10$8a0YU6SImHiebzcjVLXfrOf8Am2tFoLgip3kOyiMlYhFCrzZ4Jc3C', 'staff',          'cse.faculty3@kiot.ac.in', '2026-09-29 00:00:00'),
  ('c5e5f004-0000-4000-8000-000000000004', '104', '$2b$10$8a0YU6SImHiebzcjVLXfrOf8Am2tFoLgip3kOyiMlYhFCrzZ4Jc3C', 'class_advisor', 'cse.advisor@kiot.ac.in',  '2026-09-29 00:00:00');

-- ============================================
-- 7. A CSE year 1 subject
--
-- Seeded by migration 0015 instead, which is where the subjects table is
-- simplified to subject_id / subject_code / subject_name. A subject carries no
-- department or year any more, so it cannot be scoped to a year here, and an
-- insert naming those columns would no longer be replayable after 0015 runs.
-- ============================================
