/**
 * Physical table provisioning for a (department, batch) pair.
 *
 * The Admin Dashboard is the thing that creates a cohort's tables, so that adding
 * a batch is an administrative act rather than a source edit and a deploy. This
 * module is the only place that emits a `CREATE TABLE` statement.
 *
 * Two rules are load-bearing:
 *
 *   1. Identifiers are never taken from the request. A caller passes a normalised
 *      department and a batch that has already passed `validateBatchInput`, and
 *      the names are built from those two values by `buildTableNames`. There is no
 *      path by which a client-supplied string reaches the DDL.
 *   2. The schemas are the ones already in production. A new cohort has to behave
 *      identically to an existing one, or the attendance code -- which reads a
 *      fixed set of columns -- would break for it. The one place they deliberately
 *      differ is the student table's trailing `mentor_email`, which the existing
 *      cohorts also carry; it is documented on `studentTableDdl`.
 *
 * D1 has no `CREATE TABLE IF NOT EXISTS` rollback: DDL is auto-committed
 * separately from DML, so a batch of statements containing DDL is not a
 * transaction. Provisioning therefore runs in two explicit phases, and the
 * registry row is written only after both tables exist. The phase split is
 * described on `provisionBatchTables`.
 */

import { buildTableNames, type Department } from "./tableResolver";

/**
 * The student roster schema.
 *
 * The three UNIQUE constraints are what make re-importing the same file safe:
 * a second upload collides at the database rather than creating a near-duplicate
 * row. `auth_user_id` is nullable and indexed because a student can be added to a
 * roster before, or without, an account, and login resolves through it.
 *
 * `mentor_email` is the one column a new cohort gets that the cohorts this schema
 * was first copied from did not have. It is appended last, which is where the
 * existing tables carry it: they gained the column after the fact, so a
 * column-ordered comparison between a new cohort and an old one only matches if
 * the addition goes at the end rather than being slotted into the middle.
 *
 * It is deliberately declared with no `NOT NULL` and no `DEFAULT`, which is what
 * makes it optional in both senses that matter:
 *
 *   - the column list here is the whole contract, so a reader can see at a glance
 *     that a student table is not obliged to carry a mentor;
 *   - `mentor_email` is absent from the student INSERT in `api/admin.ts`, so an
 *     imported student gets SQL's implicit NULL rather than being asked for a
 *     value. Adding it to the admin import would have made a mentor a required
 *     field of a student record, which it is not.
 *
 * No statement anywhere alters an existing cohort. Provisioning only ever runs
 * `CREATE TABLE IF NOT EXISTS`, so a table that already exists is left exactly as
 * it is -- this column reaches cohorts created from here on, and the ones that
 * predate it keep whatever shape they already had.
 */
function studentTableDdl(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL UNIQUE,
    register_no TEXT NOT NULL UNIQUE,
    student_name TEXT NOT NULL,
    year INTEGER NOT NULL,
    section TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    auth_user_id TEXT,
    mentor_email TEXT
  )`;
}

/**
 * The attendance schema, identical to `IT_Attendance_2024_2028`.
 *
 * `status` and `od` were added by later migrations to the IT tables, so they are
 * part of the baseline here rather than a follow-up migration: a table created
 * without them would fail the finalizer, which writes ABSENT rows and sets `od`.
 */
function attendanceTableDdl(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
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
  )`;
}

/**
 * Indexes for a provisioned pair, matching the ones migrations 0008-0011 gave the
 * IT tables. Without these the OTP submit path and login each full-scan the new
 * table, and `(session_id, register_no)` must be UNIQUE to stop one student being
 * marked twice in a session.
 */
function indexStatements(studentTable: string, attendanceTable: string): string[] {
  const suffix = `${attendanceTable}_${studentTable}`.slice(-24);
  return [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_session_register_${suffix}
       ON ${attendanceTable}(session_id, register_no)`,
    `CREATE INDEX IF NOT EXISTS idx_attendance_section_date_period_${suffix}
       ON ${attendanceTable}(section, attendance_date, period)`,
    `CREATE INDEX IF NOT EXISTS idx_attendance_od_${suffix}
       ON ${attendanceTable}(od)`,
    `CREATE INDEX IF NOT EXISTS idx_students_auth_user_${suffix}
       ON ${studentTable}(auth_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_students_class_register_${suffix}
       ON ${studentTable}(year, section, register_no)`,
  ];
}

export interface ProvisionedTables {
  department: Department;
  batch: string;
  studentTable: string;
  attendanceTable: string;
  /** False when both tables were already present, so nothing was created. */
  created: boolean;
}

/** Whether a table of this exact name exists. Used to report created vs reused. */
async function tableExists(db: D1Database, table: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .bind(table)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * Creates the student and attendance tables for a pair, plus their indexes.
 *
 * The caller must pass a department that has passed `normalizeDepartment` and a
 * batch that has passed `validateBatchInput`; the names are derived here and
 * never read from the request. Every statement is `IF NOT EXISTS`, so this is
 * idempotent and safe to run against a pair that already exists.
 *
 * The three tables and the five indexes are issued as two D1 batches: the DDL and
 * then the indexes. D1 auto-commits DDL outside a transaction, so a single batch
 * would not have been atomic anyway, and separating them means a failure in index
 * creation cannot leave the roster table itself missing. If the second batch
 * fails, the tables still exist and the caller reports the index error rather than
 * a half-created cohort.
 */
export async function provisionBatchTables(
  db: D1Database,
  department: Department,
  batch: string
): Promise<ProvisionedTables> {
  const { studentTable, attendanceTable } = buildTableNames(department, batch);

  const [studentExisted, attendanceExisted] = await Promise.all([
    tableExists(db, studentTable),
    tableExists(db, attendanceTable),
  ]);

  await db.batch([
    db.prepare(studentTableDdl(studentTable)),
    db.prepare(attendanceTableDdl(attendanceTable)),
  ]);

  await db.batch(indexStatements(studentTable, attendanceTable).map((sql) => db.prepare(sql)));

  return {
    department,
    batch,
    studentTable,
    attendanceTable,
    created: !(studentExisted && attendanceExisted),
  };
}
