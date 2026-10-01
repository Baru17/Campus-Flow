/**
 * Resolving the authenticated student, and nothing else.
 *
 * Students live in a separate physical table per (department, batch) pair, so a
 * student is not addressable until the table is known -- and the table is not
 * something the client gets to say. This module is the single place that turns the
 * `auth_user_id` on a session into a student plus the department and batch it
 * belongs to, and it does so by walking the registry the application already
 * maintains (`listAllowedStudentTables`), never by parsing an identifier and never
 * by accepting a department from the request.
 *
 * That is why the student-side OD and mentor routes take no student identity at
 * all. The browser is told nothing it can influence: it asks "who am I" and gets
 * an answer, and the department that answer depends on came from the row the
 * student actually occupies.
 *
 * The email in a student id is therefore never read here. A student's address
 * happens to contain their department in this college, but "happens to" is not a
 * rule: the same lookup has to be correct for an address that does not follow the
 * convention, and the student table is the only thing that knows the answer.
 */

import {
  assertAllowedStudentTable,
  listAllowedStudentTables,
  type Department,
} from "./tableResolver";

export interface StudentRecord {
  student_id: string;
  register_no: string;
  student_name: string;
  year: number;
  section: string;
  email: string;
  /**
   * The optional mentor. Read here so every student-side surface agrees on where it
   * comes from, and so no route has to remember the column name.
   *
   * Nullable by design: a student who has not allocated a mentor has NULL, and
   * allocation is what fills it.
   */
  mentor_email: string | null;
}

/** A student, together with the cohort the row was found in. */
export interface AuthenticatedStudent {
  /** The session's `auth_user_id`, carried so an insert can be attributed. */
  authUserId: string;
  department: Department;
  batch: string;
  /** The physical table the row lives in. Never from the request. */
  studentTable: string;
  student: StudentRecord;
}

/*
 * The projection.
 *
 * `mentor_email` is named explicitly rather than selected with `*`, so the shape of
 * this row cannot grow by accident and no future sensitive column is picked up by a
 * forgotten `SELECT *`.
 */
const BASE_STUDENT_COLUMNS = "student_id, register_no, student_name, year, section, email";

/**
 * Which student tables carry `mentor_email`.
 *
 * Not every table in a deployment necessarily has it. `provisioning.ts` puts it on
 * every table it creates and production's existing cohorts have it, but a table created
 * by anything else -- an old migration, a restored backup, a hand-made table -- will not,
 * and a query that assumed the column would throw `no such column` and take the whole
 * student-facing feature down for that student.
 *
 * So the columns are checked per table, once, and the answer cached for the isolate.
 * A student on such a table resolves normally and reports a null mentor, which is the
 * truthful answer: nobody has allocated one, because there is nowhere to record it.
 *
 * `pragma_table_info` is parameterised, so the table name is bound rather than
 * interpolated -- the same rule the rest of this module follows.
 */
const mentorColumnSupport = new Map<string, boolean>();

async function hasMentorColumn(db: D1Database, table: string): Promise<boolean> {
  const cached = mentorColumnSupport.get(table);
  if (cached !== undefined) return cached;

  const row = await db
    .prepare("SELECT name FROM pragma_table_info(?) WHERE name = ?")
    .bind(table, "mentor_email")
    .first<{ name: string }>();

  const supported = row !== null;
  mentorColumnSupport.set(table, supported);
  return supported;
}

/** Exports the cache so a test can start from a known state. */
export function resetStudentColumnCache(): void {
  mentorColumnSupport.clear();
}

/**
 * Finds the student a session belongs to.
 *
 * Returns null when no cohort holds a row for that account, which is the one failure
 * the callers have to distinguish: an account that is not a student is not the same as
 * a student whose cohort tables are missing, and only the second is worth telling an
 * administrator about.
 *
 * `LIMIT 1` so a duplicate link across cohorts stops at the first rather than reading
 * every table; the unique `auth_user_id` link makes a second match something to
 * investigate rather than to serve.
 */
export async function resolveAuthenticatedStudent(
  db: D1Database,
  authUserId: string
): Promise<AuthenticatedStudent | null> {
  if (!authUserId) return null;

  for (const tables of listAllowedStudentTables()) {
    const studentTable = assertAllowedStudentTable(tables.studentTable);
    const hasMentor = await hasMentorColumn(db, studentTable);
    const projection = hasMentor
      ? `${BASE_STUDENT_COLUMNS}, mentor_email`
      : BASE_STUDENT_COLUMNS;

    const row = await db
      .prepare(
        `SELECT ${projection} FROM ${studentTable} WHERE auth_user_id = ? LIMIT 1`
      )
      .bind(authUserId)
      .first<StudentRecord>();
    if (row) {
      return {
        authUserId,
        department: tables.department,
        batch: tables.batch,
        studentTable,
        student: {
          student_id: row.student_id,
          register_no: row.register_no,
          student_name: row.student_name,
          year: row.year,
          section: row.section,
          email: row.email,
          mentor_email: hasMentor ? row.mentor_email ?? null : null,
        },
      };
    }
  }

  return null;
}