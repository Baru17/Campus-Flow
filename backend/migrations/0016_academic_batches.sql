-- Migration number: 0016
-- Persistent academic batch registry.
--
-- Until now, a (department, batch) pair existed only as a literal in
-- `backend/src/utils/tableResolver.ts`. Adding a cohort therefore meant a source
-- edit and a deploy, which is why the only provisioned pairs are IT 2024_2028,
-- IT 2025_2029 and CSE 2026_2030. `src/constants.js` mirrored that literal list,
-- so the pair was declared twice and could drift.
--
-- This table is the single place a batch is registered. It holds the resolved
-- table names alongside the pair, so the resolver can hydrate from it at runtime
-- and a new batch no longer requires a code change.
--
-- The table names are *stored*, not derived from request input: the resolver
-- still only ever builds a name from a department in its fixed allow-list and a
-- batch matching `^\d{4}_\d{4}$`, and this table is only ever written by that
-- same construction. A row here is a record that provisioning already happened,
-- never a licence to name a table arbitrarily.
--
-- `start_year` and `end_year` are the admission years the label is built from.
-- They are stored rather than parsed back out of `batch` so that future metadata
-- can be added without changing the meaning of an existing row. Neither is ever
-- used to route a mark: routing stays department + batch -> physical table.
--
-- The three existing pairs are seeded with the exact table names already in use
-- in production, so this migration changes no behaviour and no existing table is
-- touched. It is configuration only.

CREATE TABLE IF NOT EXISTS academic_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    batch TEXT NOT NULL,
    start_year INTEGER NOT NULL,
    end_year INTEGER NOT NULL,
    student_table TEXT NOT NULL,
    attendance_table TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    UNIQUE (department, batch)
);

-- Supports listing the cohorts of one department for the admin batch picker.
CREATE INDEX IF NOT EXISTS idx_academic_batches_department
    ON academic_batches(department, batch);

-- The three pairs that are already provisioned in production. Recorded, not
-- created: these tables exist and their data is not touched by this migration.
INSERT OR IGNORE INTO academic_batches
    (department, batch, start_year, end_year, student_table, attendance_table, created_by)
VALUES
    ('IT',  '2024_2028', 2024, 2028, 'IT_Students_2024_2028',   'IT_Attendance_2024_2028',   'migration-0016'),
    ('IT',  '2025_2029', 2025, 2029, 'IT_Students_2025_2029',   'IT_Attendance_2025_2029',   'migration-0016'),
    ('CSE', '2026_2030', 2026, 2030, 'CSE_Students_2026_2030', 'CSE_Attendance_2026_2030', 'migration-0016');
