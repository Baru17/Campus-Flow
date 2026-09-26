import { Hono } from "hono";
import {
  requireAuth,
  requireStudent,
  requireStaff,
  requireClassAdvisor,
} from "../middleware/auth";
import { isTransientD1Error } from "../utils/databaseErrors";
import { studentMatchesAttendanceClass } from "../utils/attendance";

type Bindings = {
  DB: D1Database;
};

type StudentRecord = {
  student_id: string;
  register_no: string;
  student_name: string;
  year: number;
  section: string;
};

type SubjectRecord = {
  subject_code: string;
  subject_name: string;
  year: number;
};

type StaffRecord = {
  staff_id: string;
  staff_name: string;
  department: string;
};

type AttendanceSession = {
  session_id: string;
  created_by: string;
  otp: string;
  subject_code: string;
  subject_name: string;
  year: number;
  section: string;
  period: number;
  attendance_date: string;
  attendance_table: string;
  created_at: string;
  expire_at: string;
  status: string;
  finalized_at?: string | null;
};

const attendance = new Hono<{ Bindings: Bindings }>();

/*
|--------------------------------------------------------------------------
| Helper: Generate 6-digit OTP
|--------------------------------------------------------------------------
*/

function generateOtp(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);

  return (100000 + (random[0] % 900000)).toString();
}

/*
|--------------------------------------------------------------------------
| Helper: Generate session ID
|--------------------------------------------------------------------------
*/

function generateSessionId(): string {
  return crypto.randomUUID();
}

/*
|--------------------------------------------------------------------------
| Helper: Attendance table by year
|--------------------------------------------------------------------------
*/

function getAttendanceTable(year: number): string | null {
  const tables: Record<number, string> = {
    2: "IT_Attendance_2025_2029",
    3: "IT_Attendance_2024_2028",
  };

  return tables[year] || null;
}

/*
|--------------------------------------------------------------------------
| Helper: Student table by year
|--------------------------------------------------------------------------
*/

function getStudentTable(year: number): string | null {
  const tables: Record<number, string> = {
    2: "IT_Students_2025_2029",
    3: "IT_Students_2024_2028",
  };

  return tables[year] || null;
}

function getSupportedAttendanceTable(tableName: string, year: number): string | null {
  return getAttendanceTable(year) === tableName ? tableName : null;
}

/*
|--------------------------------------------------------------------------
| GENERATE OTP
|--------------------------------------------------------------------------
|
| POST /api/attendance/generate
|
| Staff sends:
|
| {
|   "subject_code": "BE23IT404",
|   "period": 1,
|   "year": 3,
|   "section": "A"
| }
|
|--------------------------------------------------------------------------
*/

attendance.post(
  "/generate",
  requireAuth,
  requireStaff,
  async (c) => {
    try {
      const authUser = (c as any).get("authUser") as {
        auth_user_id: string;
        role: string;
      };

      const body = await c.req.json<{
        subject_code?: string;
        period?: number;
        year?: number;
        section?: string;
      }>();

      const subjectCode = body.subject_code?.trim();
      const period = Number(body.period);
      const year = Number(body.year);
      const section = body.section?.trim().toUpperCase();

      /*
       * Validate request
       */

      if (
        !subjectCode ||
        !Number.isInteger(period) ||
        period <= 0 ||
        !Number.isInteger(year) ||
        !section
      ) {
        return c.json(
          {
            success: false,
            error:
              "subject_code, valid period, year and section are required",
          },
          400
        );
      }

      /*
       * Find attendance table
       */

      const attendanceTable = getAttendanceTable(year);

      if (!attendanceTable) {
        return c.json(
          {
            success: false,
            error: "Unsupported year",
          },
          400
        );
      }

      /*
       * Verify subject
       */

      const subject = await c.env.DB
        .prepare(
          `SELECT subject_code, subject_name, year
           FROM subjects
           WHERE subject_code = ?
             AND year = ?
           LIMIT 1`
        )
        .bind(subjectCode, year)
        .first() as SubjectRecord | null;

      if (!subject) {
        return c.json(
          {
            success: false,
            error: "Subject not found",
          },
          404
        );
      }

      /*
       * Verify staff
       */

      const staff = await c.env.DB
        .prepare(
          `SELECT staff_id, staff_name, department
           FROM staff
           WHERE auth_user_id = ?
           LIMIT 1`
        )
        .bind(authUser.auth_user_id)
        .first() as StaffRecord | null;

      if (!staff) {
        return c.json(
          {
            success: false,
            error: "Staff record not found",
          },
          404
        );
      }

      /*
       * Generate OTP and session
       */

      const otp = generateOtp();
      const sessionId = generateSessionId();

      const createdAt = new Date();

      const expireAt = new Date(createdAt.getTime() + 20 * 1000);

      const createdAtIso = createdAt.toISOString();
      const expireAtIso = expireAt.toISOString();

      const attendanceDate = createdAtIso.slice(0, 10);

      /*
       * Create attendance session
       */

      await c.env.DB
        .prepare(
          `INSERT INTO attendance_session (
             session_id,
             created_by,
             otp,
             created_at,
             expire_at,
             subject_code,
             subject_name,
             year,
             section,
             period,
             attendance_date,
             attendance_table,
             status
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`
        )
        .bind(
          sessionId,
          authUser.auth_user_id,
          otp,
          createdAtIso,
          expireAtIso,
          subject.subject_code,
          subject.subject_name,
          year,
          section,
          period,
          attendanceDate,
          attendanceTable
        )
        .run();

      /*
       * Return session information to staff
       */

      return c.json({
        success: true,
        session: {
          session_id: sessionId,
          otp,
          subject_code: subject.subject_code,
          subject_name: subject.subject_name,
          year,
          section,
          period,
          attendance_date: attendanceDate,
          created_at: createdAtIso,
          expire_at: expireAtIso,
          status: "ACTIVE",
          created_by: staff.staff_id,
          created_by_name: staff.staff_name,
        },
      });
    } catch (error) {
      console.error("Generate OTP error:", error);
      const transient = isTransientD1Error(error);

      return c.json(
        {
          success: false,
          error: transient ? "Attendance service is temporarily busy. Please retry." : "Failed to generate attendance OTP",
          code: transient ? "database-busy" : "attendance-generation-failed",
        },
        transient ? 503 : 500
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| ATTENDANCE WRITE GUARD
|--------------------------------------------------------------------------
|
| PRESENT is only ever written while the owning session is still ACTIVE.
| The EXISTS subquery is evaluated as part of the same atomic statement, so
| a session that is finalized between the caller's session lookup and this
| write cannot gain a PRESENT row.
|
| UNIQUE(session_id, register_no) remains the duplicate guard and
| DO NOTHING keeps a repeat submission idempotent, so callers never need a
| pre-read before writing.
|
| Returns the number of rows actually written: 1 on a fresh mark, 0 when the
| row already exists or the session is no longer ACTIVE.
|
|--------------------------------------------------------------------------
*/

export async function markPresentIfSessionActive(
  db: D1Database,
  row: {
    attendanceTable: string;
    sessionId: string;
    registerNo: string;
    section: string;
    attendanceDate: string;
    period: number;
    subjectCode: string;
    subjectName: string;
    markedAt: string;
  }
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO ${row.attendanceTable} (
         attendance_id,
         register_no,
         section,
         attendance_date,
         period,
         subject_code,
         subject_name,
         marked_at,
         session_id,
         status
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PRESENT'
       WHERE EXISTS (
         SELECT 1 FROM attendance_session
         WHERE session_id = ? AND status = 'ACTIVE'
       )
       ON CONFLICT(session_id, register_no) DO NOTHING`
    )
    .bind(
      crypto.randomUUID(),
      row.registerNo,
      row.section,
      row.attendanceDate,
      row.period,
      row.subjectCode,
      row.subjectName,
      row.markedAt,
      row.sessionId,
      row.sessionId
    )
    .run();

  return result.meta.changes ?? 0;
}

/*
|--------------------------------------------------------------------------
| ABSENT -> PRESENT PROMOTION
|--------------------------------------------------------------------------
|
| Finalization writes ABSENT rows for every student in the class, so a student
| who scans an OTP after a session has already closed normally collides with
| an ABSENT row rather than inserting a fresh one. The flip therefore carries
| the same ACTIVE guard: without it, closing a session would create the very
| rows that a late request could then resurrect.
|
| Returns the number of rows updated, 0 when the row is no longer ABSENT or
| the session is no longer ACTIVE.
|
|--------------------------------------------------------------------------
*/

export async function promoteAbsentToPresentIfSessionActive(
  db: D1Database,
  row: {
    attendanceTable: string;
    sessionId: string;
    rowId: number;
    markedAt: string;
  }
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE ${row.attendanceTable}
       SET status = 'PRESENT',
           marked_at = ?
       WHERE id = ?
         AND status = 'ABSENT'
         AND EXISTS (
           SELECT 1 FROM attendance_session
           WHERE session_id = ? AND status = 'ACTIVE'
         )`
    )
    .bind(row.markedAt, row.rowId, row.sessionId)
    .run();

  return result.meta.changes ?? 0;
}

/*
|--------------------------------------------------------------------------
| VERIFY OTP
|--------------------------------------------------------------------------
|
| POST /api/attendance/verify
|
| Student sends an OTP. The logged-in student is resolved from auth.
| The student's year and section must match the attendance session.
|
|--------------------------------------------------------------------------
*/

attendance.post(
  "/verify",
  requireAuth,
  requireStudent,
  async (c) => {
    try {
      const authUser = (c as any).get("authUser") as {
        auth_user_id: string;
      };

      const body = await c.req.json<{
        otp?: string;
      }>();

      const otp = body.otp?.trim();

      if (!otp || !/^\d{6}$/.test(otp)) {
        return c.json(
          {
            success: false,
            error: "OTP must contain exactly six digits",
            code: "invalid-otp-format",
          },
          400
        );
      }

      const now = new Date().toISOString();

      /*
      * The OTP identifies the active session; the authenticated student's
      * year and section are checked after the session is found.
       */

      const session = await c.env.DB
        .prepare(
          `SELECT
             session_id,
             created_by,
             otp,
             subject_code,
             subject_name,
             year,
             section,
             period,
             attendance_date,
             attendance_table,
             created_at,
             expire_at,
             status
           FROM attendance_session
           WHERE otp = ?
             AND status = 'ACTIVE'
             AND expire_at > ?
           ORDER BY created_at DESC
           LIMIT 1`
        )
        .bind(otp, now)
        .first() as AttendanceSession | null;

      /*
       * OTP not found
       */

      if (!session) {
        const previousSession = await c.env.DB
          .prepare(
            `SELECT status, expire_at
             FROM attendance_session
             WHERE otp = ?
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .bind(otp)
          .first() as { status: string; expire_at: string } | null;

        if (previousSession && (previousSession.status === "FINALIZED" || previousSession.expire_at <= now)) {
          return c.json(
            {
              success: false,
              present: false,
              error: "OTP session has expired",
              code: "otp-expired",
            },
            400
          );
        }

        return c.json(
          {
            success: false,
            present: false,
            error: "Invalid OTP",
            code: "invalid-otp",
          },
          400
        );
      }

      const studentTable = getStudentTable(session.year);

      if (!studentTable) {
        return c.json(
          {
            success: false,
            present: false,
            error: "Attendance session year is not supported",
          },
          500
        );
      }

      const student = await c.env.DB
        .prepare(
          `SELECT
             student_id,
             register_no,
             student_name,
             year,
             section
           FROM ${studentTable}
           WHERE auth_user_id = ?
           LIMIT 1`
        )
        .bind(authUser.auth_user_id)
        .first() as StudentRecord | null;

      if (!student) {
        return c.json(
          {
            success: false,
            present: false,
            error: "Student record not found",
          },
          404
        );
      }

      if (!studentMatchesAttendanceClass(student, session)) {
        return c.json(
          {
            success: false,
            present: false,
            error: "This OTP belongs to a different class or section",
            code: "session-class-mismatch",
          },
          403
        );
      }

      const attendanceTable = getSupportedAttendanceTable(
        session.attendance_table,
        session.year
      );

      if (!attendanceTable) {
        return c.json(
          {
            success: false,
            present: false,
            error: "Attendance session table is not supported",
          },
          500
        );
      }

      const studentPayload = {
        student_id: student.student_id,
        register_no: student.register_no,
        student_name: student.student_name,
      };

      const sessionPayload = {
        session_id: session.session_id,
        subject_code: session.subject_code,
        subject_name: session.subject_name,
        year: session.year,
        section: session.section,
        period: session.period,
      };

      /*
       * Write PRESENT only while the session is still ACTIVE. The guard is
       * inside the statement, so a session finalized between the lookup above
       * and this insert can never gain a new PRESENT row.
       */

      const inserted = await markPresentIfSessionActive(c.env.DB, {
        attendanceTable,
        sessionId: session.session_id,
        registerNo: student.register_no,
        section: session.section,
        attendanceDate: session.attendance_date,
        period: session.period,
        subjectCode: session.subject_code,
        subjectName: session.subject_name,
        markedAt: new Date().toISOString(),
      });

      if (inserted > 0) {
        return c.json({
          success: true,
          present: true,
          already_marked: false,
          message: "Attendance marked PRESENT",
          student: studentPayload,
          session: sessionPayload,
        });
      }

      /*
       * Nothing was written, which means either the session was finalized
       * between the lookup and the insert, or a row already exists for this
       * student. One read distinguishes the two.
       */

      const existing = await c.env.DB
        .prepare(
          `SELECT id, status
           FROM ${attendanceTable}
           WHERE session_id = ?
             AND register_no = ?
           LIMIT 1`
        )
        .bind(session.session_id, student.register_no)
        .first() as { id: number; status: string } | null;

      if (!existing) {
        return c.json(
          {
            success: false,
            present: false,
            error: "OTP session has expired",
            code: "otp-expired",
          },
          400
        );
      }

      if (existing.status === "PRESENT") {
        return c.json({
          success: true,
          present: true,
          already_marked: true,
          message: "Attendance already marked",
          student: studentPayload,
          session: sessionPayload,
        });
      }

      /*
       * An ABSENT row already exists, for example because an advisor marked
       * the student absent during the session. Flip it to PRESENT, but only
       * while the session is still ACTIVE: finalization writes ABSENT rows,
       * so an unguarded update here would resurrect a student on a session
       * that had already closed. The stored value is read back afterwards so
       * a 200 is only ever returned when the database really holds PRESENT.
       */

      await promoteAbsentToPresentIfSessionActive(c.env.DB, {
        attendanceTable,
        sessionId: session.session_id,
        rowId: existing.id,
        markedAt: new Date().toISOString(),
      });

      const confirmed = await c.env.DB
        .prepare(
          `SELECT status
           FROM ${attendanceTable}
           WHERE session_id = ?
             AND register_no = ?
           LIMIT 1`
        )
        .bind(session.session_id, student.register_no)
        .first<{ status: string }>();

      if (confirmed?.status !== "PRESENT") {
        return c.json(
          {
            success: false,
            present: false,
            error: "Attendance record could not be saved",
            code: "attendance-conflict",
          },
          409
        );
      }

      return c.json({
        success: true,
        present: true,
        already_marked: false,
        message: "Attendance updated to PRESENT",
        student: studentPayload,
        session: sessionPayload,
      });
    } catch (error) {
      console.error("Verify OTP error:", error);
      const transient = isTransientD1Error(error);

      return c.json(
        {
          success: false,
          error: transient ? "Attendance service is temporarily busy. Please retry." : "Failed to verify attendance OTP",
          code: transient ? "database-busy" : "attendance-verification-failed",
        },
        transient ? 503 : 500
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| FINALIZE SESSION
|--------------------------------------------------------------------------
|
| POST /api/attendance/finalize/:sessionId
|
| After the OTP expires:
|
| PRESENT students → remain PRESENT
| Everyone else    → ABSENT
|
|--------------------------------------------------------------------------
*/

attendance.post(
  "/finalize/:sessionId",
  requireAuth,
  requireStaff,
  async (c) => {
    try {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) {
        return c.json({ success: false, error: "Session ID is required" }, 400);
      }
      const result = await finalizeSession(c.env.DB, sessionId);
      if (!result.success) {
        const notFound = result.message === "Attendance session not found";
        const notExpired = result.message === "Attendance session has not expired";
        return c.json({ success: false, error: result.message }, notFound ? 404 : notExpired ? 409 : 500);
      }
      return c.json(result);
    } catch (error) {
      console.error(
        "Finalize attendance error:",
        error
      );
      const transient = isTransientD1Error(error);

      return c.json(
        {
          success: false,
          error: transient ? "Attendance service is temporarily busy. Please retry." : "Failed to finalize attendance",
          code: transient ? "database-busy" : "attendance-finalization-failed",
        },
        transient ? 503 : 500
      );
    }
  }
);

export async function finalizeSession(db: D1Database, sessionId: string): Promise<{ success: boolean; message: string; session_id: string; total_students: number; present: number; absent: number }> {
  try {
    const session = await db
      .prepare(
        `SELECT
           session_id,
           created_by,
           subject_code,
           subject_name,
           year,
           section,
           period,
           attendance_date,
           attendance_table,
           status,
           expire_at
         FROM attendance_session
         WHERE session_id = ?
         LIMIT 1`
      )
      .bind(sessionId)
      .first() as {
        session_id: string;
        created_by: string;
        subject_code: string;
        subject_name: string;
        year: number;
        section: string;
        period: number;
        attendance_date: string;
        attendance_table: string;
        status: string;
        expire_at: string;
      } | null;

    if (!session) {
      return { success: false, message: "Attendance session not found", session_id: sessionId, total_students: 0, present: 0, absent: 0 };
    }

    const attendanceTable = getSupportedAttendanceTable(session.attendance_table, session.year);
    const studentTable = getStudentTable(session.year);

    if (!attendanceTable || !studentTable) {
      return { success: false, message: "Attendance session table is not supported", session_id: sessionId, total_students: 0, present: 0, absent: 0 };
    }

    if (session.status !== "FINALIZED" && session.expire_at > new Date().toISOString()) {
      return { success: false, message: "Attendance session has not expired", session_id: sessionId, total_students: 0, present: 0, absent: 0 };
    }

    if (session.status === "FINALIZED") {
      const totalResult = await db
        .prepare(
          `SELECT COUNT(*) AS total_students
           FROM ${studentTable}
           WHERE year = ? AND section = ?`
        )
        .bind(session.year, session.section)
        .first() as { total_students: number };

      const presentResult = await db
        .prepare(
          `SELECT COUNT(DISTINCT attendance.register_no) AS present
           FROM ${attendanceTable} attendance
           JOIN ${studentTable} students
             ON students.register_no = attendance.register_no
           WHERE attendance.session_id = ?
             AND attendance.status = 'PRESENT'
             AND students.year = ?
             AND students.section = ?`
        )
        .bind(sessionId, session.year, session.section)
        .first() as { present: number };

      const totalStudents = Number(totalResult?.total_students || 0);
      const present = Number(presentResult?.present || 0);

      return { success: true, message: "Attendance session already finalized", session_id: sessionId, total_students: totalStudents, present, absent: totalStudents - present };
    }

    const studentQuery = await db
      .prepare(
        `SELECT register_no
         FROM ${studentTable}
         WHERE year = ?
           AND section = ?
         ORDER BY register_no`
      )
      .bind(session.year, session.section)
      .all();

    const students = studentQuery.results as unknown as { register_no: string }[];

    const existingQuery = await db
      .prepare(
        `SELECT register_no, status
         FROM ${attendanceTable}
         WHERE session_id = ?`
      )
      .bind(sessionId)
      .all();

    const existingRecords = existingQuery.results as unknown as { register_no: string; status: string }[];

    const presentSet = new Set(
      existingRecords
        .filter((record) => record.status === "PRESENT")
        .map((record) => record.register_no)
    );
    const existingSet = new Set(
      existingRecords.map((record) => record.register_no)
    );

    const statements: D1PreparedStatement[] = [];

    for (const student of students) {
      if (presentSet.has(student.register_no)) {
        continue;
      }
      if (existingSet.has(student.register_no)) {
        continue;
      }

      const attendanceId = crypto.randomUUID();

      statements.push(
        db
          .prepare(
            `INSERT INTO ${attendanceTable} (
               attendance_id,
               register_no,
               section,
               attendance_date,
               period,
               subject_code,
               subject_name,
               marked_at,
               session_id,
               status
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ABSENT')
             ON CONFLICT(session_id, register_no) DO NOTHING`
          )
          .bind(
            attendanceId,
            student.register_no,
            session.section,
            session.attendance_date,
            session.period,
            session.subject_code,
            session.subject_name,
            new Date().toISOString(),
            sessionId
          )
      );
    }

    statements.push(
      db
        .prepare(
          `UPDATE attendance_session
           SET status = 'FINALIZED',
               finalized_at = ?
           WHERE session_id = ?
             AND status = 'ACTIVE'`
        )
        .bind(
          new Date().toISOString(),
          sessionId
        )
    );

    await db.batch(statements);

    const present = students.filter((student) =>
      presentSet.has(student.register_no)
    ).length;

    return { success: true, message: "Attendance finalized successfully", session_id: sessionId, total_students: students.length, present, absent: students.length - present };
  } catch (error) {
    console.error("Finalize session error:", error);
    throw error;
  }
}

const VALID_ATTENDANCE_TABLES = new Set([
  "IT_Attendance_2025_2029", "IT_Attendance_2024_2028",
  "CSE_Attendance_2025_2029", "CSE_Attendance_2024_2028",
  "ECE_Attendance_2025_2029", "ECE_Attendance_2024_2028",
  "EEE_Attendance_2025_2029", "EEE_Attendance_2024_2028",
]);
const VALID_STUDENT_TABLES = new Set([
  "IT_Students_2025_2029", "IT_Students_2024_2028",
  "CSE_Students_2025_2029", "CSE_Students_2024_2028",
  "ECE_Students_2025_2029", "ECE_Students_2024_2028",
  "EEE_Students_2025_2029", "EEE_Students_2024_2028",
]);

function validateTableName(table: string | undefined): boolean {
  if (!table) return false;
  return VALID_ATTENDANCE_TABLES.has(table) || VALID_STUDENT_TABLES.has(table);
}

function getStudentTableForYear(year: number): string | null {
  const tables: Record<number, string> = {
    2: "IT_Students_2025_2029",
    3: "IT_Students_2024_2028",
  };
  return tables[year] || null;
}

function getSectionFromStudents(c: any, registerNo: string, year: number): string | null {
  const table = getStudentTableForYear(year);
  if (!table) return null;
  const result = c.env.DB
    .prepare(`SELECT section FROM ${table} WHERE register_no = ?`)
    .bind(registerNo)
    .first() as { section: string } | null;
  return result?.section ?? null;
}

function getAttendanceTableForYear(year: number): string | null {
  const tables: Record<number, string> = {
    2: "IT_Attendance_2025_2029",
    3: "IT_Attendance_2024_2028",
  };
  return tables[year] || null;
}

attendance.get(
  "/:table/subjects",
  requireAuth,
  requireClassAdvisor,
  async (c) => {
    const table = c.req.param("table");
    if (!validateTableName(table)) {
      return c.json({ data: null, error: { code: "invalid_table", message: "Invalid attendance table" } }, 400);
    }
    const date = c.req.query("date");
    const periodParam = c.req.query("period");
    const period = Number(periodParam);
    if (!date || !Number.isInteger(period) || period <= 0) {
      return c.json({ data: null, error: { code: "missing_params", message: "Date and period are required" } }, 400);
    }
    try {
      const results = await c.env.DB
        .prepare(
          `SELECT DISTINCT s.id AS subject_id, s.subject_code, s.subject_name
           FROM ${table} a
           JOIN subjects s ON a.subject_code = s.subject_code
           WHERE a.attendance_date = ? AND a.period = ?`
        )
        .bind(date, period)
        .all();
      return c.json({ data: results.results, error: null });
    } catch (error) {
      console.error("Get slot subjects error:", error);
      return c.json({ data: null, error: { code: "db_error", message: "Failed to load subjects" } }, 500);
    }
  }
);

attendance.get(
  "/:table/rows",
  requireAuth,
  requireClassAdvisor,
  async (c) => {
    const table = c.req.param("table");
    if (!validateTableName(table)) {
      return c.json({ data: null, error: { code: "invalid_table", message: "Invalid attendance table" } }, 400);
    }
    const date = c.req.query("date");
    const periodParam = c.req.query("period");
    const subjectIdParam = c.req.query("subject_id");
    const period = Number(periodParam);
    const subjectId = Number(subjectIdParam);
    if (!date || !Number.isInteger(period) || !Number.isInteger(subjectId) || period <= 0 || subjectId <= 0) {
      return c.json({ data: null, error: { code: "missing_params", message: "Date, period and subject_id are required" } }, 400);
    }
    try {
      const results = await c.env.DB
        .prepare(
          `SELECT a.register_no, a.status
           FROM ${table} a
           JOIN subjects s ON a.subject_code = s.subject_code
           WHERE a.attendance_date = ? AND a.period = ? AND s.id = ?`
        )
        .bind(date, period, subjectId)
        .all();
      return c.json({ data: results.results, error: null });
    } catch (error) {
      console.error("Get attendance rows error:", error);
      return c.json({ data: null, error: { code: "db_error", message: "Failed to load attendance rows" } }, 500);
    }
  }
);

attendance.get(
  "/:table/find",
  requireAuth,
  requireClassAdvisor,
  async (c) => {
    const table = c.req.param("table");
    if (!validateTableName(table)) {
      return c.json({ data: null, error: { code: "invalid_table", message: "Invalid attendance table" } }, 400);
    }
    const registerNo = c.req.query("register_no");
    const date = c.req.query("date");
    const periodParam = c.req.query("period");
    const subjectIdParam = c.req.query("subject_id");
    const period = Number(periodParam);
    const subjectId = Number(subjectIdParam);
    if (!registerNo || !date || !Number.isInteger(period) || !Number.isInteger(subjectId)) {
      return c.json({ data: null, error: { code: "missing_params", message: "Missing query parameters" } }, 400);
    }
    try {
      const result = await c.env.DB
        .prepare(
          `SELECT a.attendance_id, a.register_no, a.section, a.status, a.marked_at
           FROM ${table} a
           JOIN subjects s ON a.subject_code = s.subject_code
           WHERE a.register_no = ? AND a.attendance_date = ? AND a.period = ? AND s.id = ?
           LIMIT 1`
        )
        .bind(registerNo, date, period, subjectId)
        .first();
      return c.json({ data: result || null, error: null });
    } catch (error) {
      console.error("Find attendance record error:", error);
      return c.json({ data: null, error: { code: "db_error", message: "Failed to find attendance record" } }, 500);
    }
  }
);

attendance.post(
  "/:table",
  requireAuth,
  requireClassAdvisor,
  async (c) => {
    const table = c.req.param("table");
    if (!validateTableName(table)) {
      return c.json({ data: null, error: { code: "invalid_table", message: "Invalid attendance table" } }, 400);
    }
    const body = await c.req.json<{
      register_no?: string;
      attendance_date?: string;
      period?: number;
      subject_id?: number;
      status?: string;
      marked_at?: string;
      section?: string;
    }>();
    const { register_no, attendance_date, period, subject_id, status, marked_at, section } = body;
    if (!register_no || !attendance_date || !Number.isInteger(period) || !subject_id || !status) {
      return c.json({ data: null, error: { code: "missing_params", message: "Missing required fields" } }, 400);
    }
    try {
      const subject = await c.env.DB
        .prepare("SELECT subject_code, subject_name, year FROM subjects WHERE id = ? LIMIT 1")
        .bind(subject_id)
        .first() as { subject_code: string; subject_name: string; year: number } | null;
      if (!subject) {
        return c.json({ data: null, error: { code: "subject_not_found", message: "Subject not found" } }, 404);
      }
      const sectionFromDb = section || (await getSectionFromStudents(c, register_no || "", subject.year)) || null;
      const newAttendanceId = crypto.randomUUID();
      await c.env.DB
        .prepare(
          `INSERT INTO ${table} (attendance_id, register_no, section, attendance_date, period, subject_code, subject_name, marked_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(newAttendanceId, register_no, sectionFromDb, attendance_date, period, subject.subject_code, subject.subject_name, marked_at || new Date().toISOString(), status.toUpperCase())
        .run();
      return c.json({ data: { success: true, message: "Attendance record created" }, error: null });
    } catch (error) {
      console.error("Insert attendance error:", error);
      return c.json({ data: null, error: { code: "db_error", message: "Failed to create attendance record" } }, 500);
    }
  }
);

attendance.put(
  "/:table",
  requireAuth,
  requireClassAdvisor,
  async (c) => {
    const table = c.req.param("table");
    if (!validateTableName(table)) {
      return c.json({ data: null, error: { code: "invalid_table", message: "Invalid attendance table" } }, 400);
    }
    const body = await c.req.json<{
      attendance_id?: string;
      register_no?: string;
      attendance_date?: string;
      period?: number;
      subject_id?: number;
      status?: string;
      marked_at?: string;
      section?: string;
    }>();
    const { attendance_id, register_no, attendance_date, period, subject_id, status, marked_at, section } = body;
    if (!attendance_id || !Number.isInteger(period) || !subject_id || !status) {
      return c.json({ data: null, error: { code: "missing_params", message: "Missing required fields" } }, 400);
    }
    try {
      const subject = await c.env.DB
        .prepare("SELECT subject_code, subject_name, year FROM subjects WHERE id = ? LIMIT 1")
        .bind(subject_id)
        .first() as { subject_code: string; subject_name: string; year: number } | null;
      if (!subject) {
        return c.json({ data: null, error: { code: "subject_not_found", message: "Subject not found" } }, 404);
      }
      const sectionFromDb = section || (await getSectionFromStudents(c, register_no || "", subject.year)) || null;
      await c.env.DB
        .prepare(
          `UPDATE ${table}
           SET register_no = ?, section = ?, attendance_date = ?, period = ?, subject_code = ?, subject_name = ?, marked_at = ?, status = ?
           WHERE attendance_id = ?`
        )
        .bind(register_no, sectionFromDb, attendance_date, period, subject.subject_code, subject.subject_name, marked_at || new Date().toISOString(), status.toUpperCase(), attendance_id)
        .run();
      return c.json({ data: { success: true, message: "Attendance record updated" }, error: null });
    } catch (error) {
      console.error("Update attendance error:", error);
      return c.json({ data: null, error: { code: "db_error", message: "Failed to update attendance record" } }, 500);
    }
  }
);

export default attendance;