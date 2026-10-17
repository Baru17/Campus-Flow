import { Hono } from "hono";
import {
  requireAuth,
  requireStudent,
  requireStaff,
  requireClassAdvisor,
} from "../middleware/auth";
import { isTransientD1Error } from "../utils/databaseErrors";
import { buildAttendanceReport, studentMatchesAttendanceClass } from "../utils/attendance";
import {
  OD_ELIGIBLE_STATUS,
  parseOdDateList,
  studentsCoveredByApprovedOd,
} from "../utils/odEligibility";
import {
  assertAllowedAttendanceTable,
  assertAllowedStudentTable,
  listAllowedStudentTables,
  normalizeBatch,
  normalizeDepartment,
  resolveSessionTables,
  resolveTables,
} from "../utils/tableResolver";

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
  /** Department the session was generated for. Resolves the tables it may touch. */
  department: string;
  /** Admission batch the session was generated for, e.g. "2024_2028". */
  batch: string;
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

/*
|--------------------------------------------------------------------------
| Helper: confirm a stored session may use its attendance table
|--------------------------------------------------------------------------
|
| Table names cannot be bound as SQL parameters, so every attendance and
| student query resolves its identifiers through utils/tableResolver against a
| static allow-list. See that module for the supported (department, batch)
| pairs.
|
*/

/**
 * Confirms a stored session's `attendance_table` still matches what the resolver
 * allows for that session, so a row cannot be used to query an arbitrary table.
 */
function getSupportedAttendanceTable(
  tableName: string,
  session: { department?: unknown; batch?: unknown },
): string | null {
  const tables = resolveSessionTables(session);
  return tables && tables.attendanceTable === tableName ? tableName : null;
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
        department?: string;
        batch?: string;
      }>();

      const subjectCode = body.subject_code?.trim();
      const period = Number(body.period);
      const section = body.section?.trim().toUpperCase();
      const requestedDepartment = normalizeDepartment(body.department);
      const requestedBatch = normalizeBatch(body.batch);
      const year = Number(body.year);

      /*
       * Validate request
       */

      if (
        !subjectCode ||
        !Number.isInteger(period) ||
        period <= 0 ||
        !Number.isInteger(year) ||
        !section ||
        !requestedDepartment ||
        !requestedBatch
      ) {
        return c.json(
          {
            success: false,
            error:
              "subject_code, valid period, year, section, department and batch are required",
            code: "invalid-request",
          },
          400
        );
      }

      /*
       * Verify staff
       *
       * The staff record has to exist. Its department is deliberately NOT read
       * here: any signed-in staff member may take attendance for any configured
       * department, so the department on the staff row is never a prerequisite
       * for the request and is not validated against the supported list. The
       * department in the form is the class being marked, not an assertion about
       * who is allowed to mark it.
       *
       * What authorises the request is the role check in the middleware plus the
       * allow-list below: only department+batch pairs that resolve to real tables
       * are accepted, so an unconfigured department is still refused. The staff
       * row's own department stays meaningful for the staff profile and for
       * class-advisor assignments, which read it elsewhere.
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
            code: "staff-not-found",
          },
          404
        );
      }

      /*
       * Find attendance tables for the selected department and batch.
       *
       * The batch the staff member chose identifies the tables. The year is not
       * consulted here - it only narrows the class within the batch.
       */

      const batchTables = resolveTables(requestedDepartment, requestedBatch);

      if (!batchTables) {
        return c.json(
          {
            success: false,
            error: `Attendance is not configured for ${requestedDepartment} batch ${requestedBatch} yet`,
            code: "batch-not-configured",
          },
          400
        );
      }

      const attendanceTable = assertAllowedAttendanceTable(batchTables.attendanceTable);

      /*
       * Verify subject
       *
       * A subject is a global catalog row, so the only question is whether the
       * code exists. It used to be matched against the session's department and
       * year as well, which is what made the subject list feel scoped to a class.
       * Dropping those columns is the point of the change: a staff member marks
       * a class for whichever subject is running in that period, and the batch
       * they picked still decides the table the mark lands in.
       *
       * The name is taken from the database rather than the request body, so what
       * gets stored on the attendance row and the session is the catalog's name
       * for that code and cannot be spoofed by the client.
       */

      const subject = await c.env.DB
        .prepare(
          `SELECT subject_code, subject_name
           FROM subjects
           WHERE subject_code = ?
           LIMIT 1`
        )
        .bind(subjectCode)
        .first() as SubjectRecord | null;

      if (!subject) {
        return c.json(
          {
            success: false,
            error: "Subject not found",
            code: "subject-not-found",
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
             department,
             batch,
             status
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`
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
          attendanceTable,
          requestedDepartment,
          requestedBatch
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
          department: requestedDepartment,
          batch: requestedBatch,
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
| SESSION REPORT (staff)
|--------------------------------------------------------------------------
|
| GET /api/attendance/session/:sessionId
|
| The report for one OTP session, readable by the staff member who generated it.
| This is the session-scoped counterpart to the Class Advisor report route: the
| class-advisor routes are gated on the `class_advisor` role, so a plain staff
| account got a 403 there even for a session it had just created itself.
|
| Ownership, not class, is the check. A session records its creator in
| `created_by` (the auth user id written by /generate), so a staff member may
| read exactly the sessions they created and no others. A class advisor is also
| a staff member and passes the same check for their own sessions; their
| class-wide view keeps using the class-advisor routes unchanged.
|
| The report text comes from the shared `buildAttendanceReport`, so what is shown
| and copied here is byte-for-byte what the Class Advisor copies.
|
|--------------------------------------------------------------------------
*/

attendance.get(
  "/session/:sessionId",
  requireAuth,
  requireStaff,
  async (c) => {
    try {
      const authUser = (c as any).get("authUser") as { auth_user_id: string };
      const sessionId = c.req.param("sessionId");

      const session = await c.env.DB
        .prepare("SELECT * FROM attendance_session WHERE session_id = ? LIMIT 1")
        .bind(sessionId)
        .first() as AttendanceSession | null;

      if (!session) {
        return c.json(
          { success: false, error: "Session not found", code: "session-not-found" },
          404
        );
      }

      const staff = await c.env.DB
        .prepare("SELECT staff_id, staff_name, department FROM staff WHERE auth_user_id = ? LIMIT 1")
        .bind(authUser.auth_user_id)
        .first() as StaffRecord | null;

      /*
       * `created_by` is written as the auth user id by /generate. The staff_id
       * comparison additionally covers any historical row written the other way,
       * without ever matching a session belonging to someone else.
       */
      const ownsSession =
        session.created_by === authUser.auth_user_id ||
        (staff !== null && session.created_by === staff.staff_id);

      if (!ownsSession) {
        return c.json(
          {
            success: false,
            error: "You can only view a session you generated",
            code: "forbidden",
          },
          403
        );
      }

      const tables = resolveSessionTables(session);
      if (!tables) {
        return c.json(
          {
            success: false,
            error: "This session's class is not configured for attendance.",
            code: "session-tables-not-found",
          },
          400
        );
      }

      const attendanceTable = assertAllowedAttendanceTable(tables.attendanceTable);
      const studentTable = assertAllowedStudentTable(tables.studentTable);

      const students = await c.env.DB
        .prepare(
          `SELECT student_id, register_no, student_name
           FROM ${studentTable}
           WHERE year = ? AND section = ?
           ORDER BY register_no`
        )
        .bind(session.year, session.section)
        .all();

      const attendanceRows = await c.env.DB
        .prepare(
          `SELECT register_no, status, od FROM ${attendanceTable} WHERE session_id = ?`
        )
        .bind(session.session_id)
        .all();

      const attendanceByRegister: Record<string, { status: string; od: string }> = {};
      for (const row of attendanceRows.results as { register_no: string; status: string; od: string }[]) {
        attendanceByRegister[row.register_no] = { status: row.status, od: row.od };
      }

      const studentList = (students.results ?? []) as {
        student_id: string;
        register_no: string;
        student_name: string;
      }[];

      const report = buildAttendanceReport({
        date: session.attendance_date,
        department: session.department,
        section: session.section,
        subjectName: session.subject_name,
        students: studentList,
        attendanceByRegister,
      });

      const unmarkedCount = Math.max(
        report.totalStrength - report.presentCount - report.absentCount - report.odCount,
        0
      );

      return c.json({
        success: true,
        data: {
          session_id: session.session_id,
          subject_code: session.subject_code,
          subject_name: session.subject_name,
          year: session.year,
          section: session.section,
          period: session.period,
          attendance_date: session.attendance_date,
          department: session.department,
          batch: session.batch,
          status: session.status,
          students: studentList.map((s) => ({
            ...s,
            status: attendanceByRegister[s.register_no]?.status ?? null,
            od: attendanceByRegister[s.register_no]?.od ?? null,
          })),
          summary: {
            totalStrength: report.totalStrength,
            presentCount: report.presentCount,
            absentCount: report.absentCount,
            odCount: report.odCount,
            unmarkedCount,
            percentage: report.percentage,
          },
          report: report.report,
        },
      });
    } catch (error) {
      console.error("Session report error:", error);
      const transient = isTransientD1Error(error);
      return c.json(
        {
          success: false,
          error: transient
            ? "Attendance service is temporarily busy. Please retry."
            : "Failed to load the attendance report",
          code: transient ? "database-busy" : "session-report-failed",
        },
        transient ? 503 : 500
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| SESSION MARK (staff)
|--------------------------------------------------------------------------
|
| PATCH /api/attendance/session/:sessionId
|
| Edits one student's PRESENT/ABSENT mark for a session the caller generated.
| This is the staff counterpart to the class-advisor PATCH: the class-advisor
| routes are gated on the `class_advisor` role, so a plain staff account could
| not correct a mark on its own session. Ownership is checked exactly as on the
| report route above, and the student is verified to belong to the session's
| class before anything is written.
|
| The mark is upserted on UNIQUE(session_id, register_no), so a correction lands
| on the existing row rather than creating a second one, and a student who was
| never marked gets a row without needing a pre-read.
|
|--------------------------------------------------------------------------
*/

attendance.patch(
  "/session/:sessionId",
  requireAuth,
  requireStaff,
  async (c) => {
    try {
      const authUser = (c as any).get("authUser") as { auth_user_id: string };
      const sessionId = c.req.param("sessionId");
      const body = await c.req.json<{ register_no?: string; status?: string }>();

      const registerNo = body.register_no?.trim();
      const status = body.status?.trim().toUpperCase();

      if (!registerNo || !status || !["PRESENT", "ABSENT"].includes(status)) {
        return c.json(
          {
            success: false,
            error: "register_no and valid status (PRESENT/ABSENT) are required",
            code: "invalid-request",
          },
          400
        );
      }

      const session = await c.env.DB
        .prepare("SELECT * FROM attendance_session WHERE session_id = ? LIMIT 1")
        .bind(sessionId)
        .first() as AttendanceSession | null;

      if (!session) {
        return c.json(
          { success: false, error: "Session not found", code: "session-not-found" },
          404
        );
      }

      const staff = await c.env.DB
        .prepare("SELECT staff_id, staff_name, department FROM staff WHERE auth_user_id = ? LIMIT 1")
        .bind(authUser.auth_user_id)
        .first() as StaffRecord | null;

      const ownsSession =
        session.created_by === authUser.auth_user_id ||
        (staff !== null && session.created_by === staff.staff_id);

      if (!ownsSession) {
        return c.json(
          {
            success: false,
            error: "You can only edit attendance for a session you generated",
            code: "forbidden",
          },
          403
        );
      }

      const tables = resolveSessionTables(session);
      if (!tables) {
        return c.json(
          {
            success: false,
            error: "This session's class is not configured for attendance.",
            code: "session-tables-not-found",
          },
          400
        );
      }

      const attendanceTable = assertAllowedAttendanceTable(tables.attendanceTable);
      const studentTable = assertAllowedStudentTable(tables.studentTable);

      const student = await c.env.DB
        .prepare(
          `SELECT register_no, section FROM ${studentTable}
           WHERE register_no = ? AND year = ? AND section = ? LIMIT 1`
        )
        .bind(registerNo, session.year, session.section)
        .first() as { register_no: string; section: string } | null;

      if (!student) {
        return c.json(
          {
            success: false,
            error: "Student does not belong to this class",
            code: "student-not-in-class",
          },
          403
        );
      }

      const existing = await c.env.DB
        .prepare(
          `SELECT id FROM ${attendanceTable} WHERE session_id = ? AND register_no = ? LIMIT 1`
        )
        .bind(sessionId, registerNo)
        .first() as { id: number } | null;

      if (existing) {
        await c.env.DB
          .prepare(`UPDATE ${attendanceTable} SET status = ?, marked_at = ? WHERE id = ?`)
          .bind(status, new Date().toISOString(), existing.id)
          .run();
      } else {
        await c.env.DB
          .prepare(
            `INSERT INTO ${attendanceTable} (attendance_id, register_no, section, attendance_date, period, subject_code, subject_name, marked_at, session_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, register_no) DO UPDATE
             SET status = excluded.status, marked_at = excluded.marked_at`
          )
          .bind(
            crypto.randomUUID(),
            registerNo,
            student.section,
            session.attendance_date,
            session.period,
            session.subject_code,
            session.subject_name,
            new Date().toISOString(),
            sessionId,
            status
          )
          .run();
      }

      const updated = await c.env.DB
        .prepare(
          `SELECT register_no, status, od FROM ${attendanceTable} WHERE session_id = ? AND register_no = ? LIMIT 1`
        )
        .bind(sessionId, registerNo)
        .first() as { register_no: string; status: string; od: string } | null;

      return c.json({ success: true, attendance: updated });
    } catch (error) {
      console.error("Session mark error:", error);
      const transient = isTransientD1Error(error);
      return c.json(
        {
          success: false,
          error: transient
            ? "Attendance service is temporarily busy. Please retry."
            : "Failed to update attendance",
          code: transient ? "database-busy" : "session-mark-failed",
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
             department,
             batch,
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

      /*
       * Resolve the tables from the session's own department and batch, so an
       * OTP can only ever mark the students of the class it was generated for.
       * Scoping the student lookup to that table is also what keeps a student
       * from one department out of another department's session.
       */

      const sessionTables = resolveSessionTables(session);

      if (!sessionTables) {
        return c.json(
          {
            success: false,
            present: false,
            error: "This attendance session is not configured for any known department batch",
            code: "session-batch-unavailable",
          },
          500
        );
      }

      const studentTable = assertAllowedStudentTable(sessionTables.studentTable);

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
            code: "student-not-found",
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
        session
      );

      if (!attendanceTable) {
        return c.json(
          {
            success: false,
            present: false,
            error: "Attendance session table is not supported",
            code: "attendance-table-not-supported",
          },
          500
        );
      }

      const studentPayload = {
        student_id: student.student_id,
        register_no: student.register_no,
        student_name: student.student_name,
        department: sessionTables.department,
      };

      const sessionPayload = {
        session_id: session.session_id,
        subject_code: session.subject_code,
        subject_name: session.subject_name,
        year: session.year,
        section: session.section,
        period: session.period,
        department: sessionTables.department,
        batch: sessionTables.batch,
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

/*
|--------------------------------------------------------------------------
| OD LOOKUP FOR FINALIZATION
|--------------------------------------------------------------------------
|
| Whether `od_requests` exists at all is checked before it is read, because the
| table is the reviewed artefact of the OD feature and a database that has not
| been migrated (a fresh local one, or the attendance integration suite, which
| applies migrations 0001..0016) simply has no OD requests. Treating a missing
| table as "no approved OD" is the safe way to be wrong: finalization still
| writes ABSENT exactly as it did before the feature existed.
|
| The lookup itself is a plain read, outside the finalize batch. Only the writes
| need to be atomic -- a request approved in the microseconds after this read
| makes the student ABSENT for one session, which is the pre-existing behaviour,
| not a corrupt state.
|
*/

async function odRequestsTableExists(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'od_requests' LIMIT 1")
    .first<{ hit: number }>();
  return Boolean(row);
}

/**
 * The student ids in one cohort with an approved OD request covering `sessionDate`.
 *
 * Scoped by `student_table` because a student id is unique only within its cohort.
 * Only `status = 'APPROVED'` rows are read, so pending, partially approved and
 * rejected requests grant nothing, and the day test itself lives in
 * `utils/odEligibility.ts` so the finalizer and the tests share one rule.
 */
async function loadApprovedOdStudentIds(
  db: D1Database,
  studentTable: string,
  sessionDate: string
): Promise<Set<string>> {
  if (!(await odRequestsTableExists(db))) return new Set();

  const { results } = await db
    .prepare(
      `SELECT student_id, od_dates
       FROM od_requests
       WHERE student_table = ? AND status = ?`
    )
    .bind(studentTable, OD_ELIGIBLE_STATUS)
    .all<{ student_id: string; od_dates: string }>();

  const periods = (results ?? []).map((row) => ({
    studentId: row.student_id,
    odDates: parseOdDateList(row.od_dates),
  }));

  return studentsCoveredByApprovedOd(periods, sessionDate);
}

export async function finalizeSession(db: D1Database, sessionId: string): Promise<{ success: boolean; message: string; session_id: string; total_students: number; present: number; absent: number; od: number }> {
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
           department,
           batch,
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
        department: string;
        batch: string;
        status: string;
        expire_at: string;
      } | null;

    if (!session) {
      return { success: false, message: "Attendance session not found", session_id: sessionId, total_students: 0, present: 0, absent: 0, od: 0 };
    }

    const sessionTables = resolveSessionTables(session);

    if (!sessionTables) {
      return { success: false, message: "Attendance session table is not supported", session_id: sessionId, total_students: 0, present: 0, absent: 0, od: 0 };
    }

    const attendanceTable = getSupportedAttendanceTable(session.attendance_table, session);

    if (!attendanceTable) {
      return { success: false, message: "Attendance session table is not supported", session_id: sessionId, total_students: 0, present: 0, absent: 0, od: 0 };
    }

    const studentTable = assertAllowedStudentTable(sessionTables.studentTable);

    if (session.status !== "FINALIZED" && session.expire_at > new Date().toISOString()) {
      return { success: false, message: "Attendance session has not expired", session_id: sessionId, total_students: 0, present: 0, absent: 0, od: 0 };
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

      /*
       * OD rows are counted the same way PRESENT is -- distinct register numbers
       * joined to the class -- so a re-run of an already-finalized session reports
       * the same split the first run wrote, and `absent` never includes an OD
       * student.
       */
      const odResult = await db
        .prepare(
          `SELECT COUNT(DISTINCT attendance.register_no) AS od
           FROM ${attendanceTable} attendance
           JOIN ${studentTable} students
             ON students.register_no = attendance.register_no
           WHERE attendance.session_id = ?
             AND attendance.status = 'OD'
             AND students.year = ?
             AND students.section = ?`
        )
        .bind(sessionId, session.year, session.section)
        .first() as { od: number };

      const totalStudents = Number(totalResult?.total_students || 0);
      const present = Number(presentResult?.present || 0);
      const od = Number(odResult?.od || 0);

      return { success: true, message: "Attendance session already finalized", session_id: sessionId, total_students: totalStudents, present, absent: Math.max(totalStudents - present - od, 0), od };
    }

    const studentQuery = await db
      .prepare(
        `SELECT student_id, register_no
         FROM ${studentTable}
         WHERE year = ?
           AND section = ?
         ORDER BY register_no`
      )
      .bind(session.year, session.section)
      .all();

    const students = studentQuery.results as unknown as { student_id: string; register_no: string }[];

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

    /*
     * The students who were on approved duty for this session's date. Read once,
     * then consulted per student below. A student who already has a row -- a real
     * PRESENT scan, or an ABSENT an advisor wrote during the session -- keeps it:
     * this change only decides the status of the rows finalization is about to
     * create, so it can never overwrite a verified mark.
     */
    const odCoveredStudentIds = await loadApprovedOdStudentIds(
      db,
      studentTable,
      session.attendance_date
    );

    const statements: D1PreparedStatement[] = [];
    let odCreated = 0;

    for (const student of students) {
      if (presentSet.has(student.register_no)) {
        continue;
      }
      if (existingSet.has(student.register_no)) {
        continue;
      }

      /*
       * An eligible OD request makes this student OD instead of ABSENT for the day.
       * OD is a status on the row, not a second row, so `ON CONFLICT ... DO NOTHING`
       * plus the unique `(session_id, register_no)` index still guarantees at most
       * one record per student per session.
       */
      const status = odCoveredStudentIds.has(student.student_id) ? "OD" : "ABSENT";
      if (status === "OD") odCreated += 1;

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
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            sessionId,
            status
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

    /*
     * `absent` is everything that is neither present nor on duty. An unmarked
     * student cannot occur here: finalization writes a row for every student in the
     * class, so present + od + absent always equals the class strength.
     */
    return { success: true, message: "Attendance finalized successfully", session_id: sessionId, total_students: students.length, present, absent: Math.max(students.length - present - odCreated, 0), od: odCreated };
  } catch (error) {
    console.error("Finalize session error:", error);
    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| Helpers: path-supplied table names
|--------------------------------------------------------------------------
|
| These routes take a table name in the path, so the name is matched back
| against the resolver's allow-list rather than checked against a hand-written
| list. Only attendance tables are accepted: a student table has no
| session/period columns, so accepting one here would just produce a confusing
| SQL error. Matching the name also yields the department and batch, which the
| subject join and the section lookup both need.
|
*/

function resolveRequestedTables(table: string | undefined) {
  if (!table) return null;
  return (
    listAllowedStudentTables().find((tables) => tables.attendanceTable === table) ?? null
  );
}

function getSectionFromStudents(
  c: any,
  registerNo: string,
  tables: { department: string; batch: string; studentTable: string; attendanceTable: string }
): string | null {
  const result = c.env.DB
    .prepare(`SELECT section FROM ${assertAllowedStudentTable(tables.studentTable)} WHERE register_no = ?`)
    .bind(registerNo)
    .first() as { section: string } | null;
  return result?.section ?? null;
}

attendance.get(
  "/:table/subjects",
  requireAuth,
  requireClassAdvisor,
  async (c) => {
    const table = c.req.param("table");
    const tables = resolveRequestedTables(table);
    if (!tables) {
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
          `SELECT DISTINCT s.subject_id, s.subject_code, s.subject_name
           FROM ${tables.attendanceTable} a
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
    const tables = resolveRequestedTables(table);
    if (!tables) {
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
           FROM ${tables.attendanceTable} a
           JOIN subjects s ON a.subject_code = s.subject_code
           WHERE a.attendance_date = ? AND a.period = ? AND s.subject_id = ?`
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
    const tables = resolveRequestedTables(table);
    if (!tables) {
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
           FROM ${tables.attendanceTable} a
           JOIN subjects s ON a.subject_code = s.subject_code
           WHERE a.register_no = ? AND a.attendance_date = ? AND a.period = ? AND s.subject_id = ?
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
    const tables = resolveRequestedTables(table);
    if (!tables) {
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
        .prepare("SELECT subject_code, subject_name FROM subjects WHERE subject_id = ? LIMIT 1")
        .bind(subject_id)
        .first() as { subject_code: string; subject_name: string } | null;
      if (!subject) {
        return c.json({ data: null, error: { code: "subject_not_found", message: "Subject not found" } }, 404);
      }
      const sectionFromDb = section || (await getSectionFromStudents(c, register_no || "", tables)) || null;
      const newAttendanceId = crypto.randomUUID();
      await c.env.DB
        .prepare(
          `INSERT INTO ${tables.attendanceTable} (attendance_id, register_no, section, attendance_date, period, subject_code, subject_name, marked_at, status)
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
    const tables = resolveRequestedTables(table);
    if (!tables) {
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
        .prepare("SELECT subject_code, subject_name FROM subjects WHERE subject_id = ? LIMIT 1")
        .bind(subject_id)
        .first() as { subject_code: string; subject_name: string } | null;
      if (!subject) {
        return c.json({ data: null, error: { code: "subject_not_found", message: "Subject not found" } }, 404);
      }
      const sectionFromDb = section || (await getSectionFromStudents(c, register_no || "", tables)) || null;
      await c.env.DB
        .prepare(
          `UPDATE ${tables.attendanceTable}
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