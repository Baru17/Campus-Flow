-- Migration number: 0015
-- Simplify subjects to a reusable academic subject.
--
-- A subject is a catalog entry: something with a code and a name. It is not a
-- property of a department or a year of study, and it must never decide which
-- attendance table a mark is written to. That is the batch's job, and the batch
-- is the staff member's selection.
--
-- `subjects.department` and `subjects.year` existed so the subject dropdown could
-- be filtered to the class being taken. That coupled a subject to a cohort: the
-- same subject taught to two departments, or to a department in two different
-- years, needed two rows that had to be kept in step by hand, and
-- "Database Management Systems" for CSE year 1 did not exist at all until a test
-- row was invented for it. Removing the columns makes one row per subject and
-- lets the staff member search the whole catalog.
--
-- Only the subject entity changes here. `attendance_session`, the student tables,
-- the staff table and the attendance tables all keep their department, year,
-- batch and section columns, and table routing is untouched: still
-- department + batch -> resolveTables().
--
-- SQLite cannot drop two columns from a table in place and still guarantee the
-- rows and ids survive, so the table is rebuilt. The rebuild is explicit about
-- preserving data rather than relying on a bare DROP TABLE:
--
--   1. build the replacement with the three target columns
--   2. copy every row across, carrying the old id across as subject_id
--   3. drop the old table (which also drops its indexes)
--   4. rename the replacement into place
--   5. recreate the index the search and ordering rely on
--
-- `id` becomes `subject_id` rather than being reissued, because client code and
-- stored `subject_id` query parameters already refer to these values. Renaming
-- the column keeps every one of them pointing at the same subject. A new id
-- would silently re-point every historical reference at a different subject.
--
-- The old indexes `idx_subjects_year_name` on (year, subject_name) and
-- `idx_subjects_department_year` on (department, year) are dropped along with the
-- table. Both are built on columns that no longer exist, so neither is recreated
-- in a form that would preserve their meaning. `subject_code` keeps its UNIQUE
-- constraint, which supplies the index the lookups actually use.
--
-- No subject row is deleted or altered: every existing subject is carried over
-- with its id, code and name unchanged.

DROP TABLE IF EXISTS subjects_simplified;

CREATE TABLE subjects_simplified (
    subject_id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_code TEXT NOT NULL UNIQUE,
    subject_name TEXT NOT NULL
);

INSERT INTO subjects_simplified (subject_id, subject_code, subject_name)
SELECT id, subject_code, subject_name FROM subjects;

DROP TABLE subjects;

ALTER TABLE subjects_simplified RENAME TO subjects;

-- Supports the catalog ordering and the name half of the staff search filter.
CREATE INDEX IF NOT EXISTS idx_subjects_name
  ON subjects(subject_name);

-- ============================================
-- CSE year 1 test subject
--
-- Moved here from 0014, which seeded it while the table still carried a
-- department and a year. A subject no longer has either, so the row is now just
-- one more catalog entry and is treated exactly like any other subject: nothing
-- in the code branches on it.
--
-- This is seed data, not curriculum. Production CSE subjects are a real academic
-- record and are not invented here; this row exists so the CSE flow has a subject
-- to select. The code is deliberately not shaped like a real subject code so it
-- cannot be mistaken for curriculum, and it is safe to delete once real CSE
-- subjects exist.
-- ============================================

INSERT OR IGNORE INTO subjects (subject_code, subject_name)
VALUES ('CSETST101', 'CSE Year 1 Test Subject');
