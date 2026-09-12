import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const CANONICAL_DEPARTMENTS = ["IT", "CSE", "ECE", "EEE"];

// Legacy non-batch tables for backward compatibility.
const LEGACY_TABLES: Record<
  string,
  { students: string; attendance: string }
> = {
  CSE: { students: "cse_students", attendance: "cse_attendance" },
  ECE: { students: "ece_students", attendance: "ece_attendance" },
  EEE: { students: "eee_students", attendance: "eee_attendance" },
};

// ------------------------------------------------------------------
// DIRECT DATABASE ACCESS
// ------------------------------------------------------------------

async function runDb<T>(
  fn: (sql: ReturnType<typeof postgres>) => Promise<T>
): Promise<T> {
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) throw new Error("SUPABASE_DB_URL is not configured");
  const sql = postgres(dbUrl, { prepare: false });
  try {
    return await fn(sql);
  } finally {
    await sql.end().catch(() => {});
  }
}

async function tableExists(table: string): Promise<boolean> {
  return runDb(async (sql) => {
    const rows = await sql.unsafe(
      `select 1 from pg_catalog.pg_tables
       where schemaname = 'public' and tablename = $1`,
      [table]
    );
    return (rows || []).length > 0;
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ------------------------------------------------------------------
// RESOLVE STUDENT + ATTENDANCE TABLES
// ------------------------------------------------------------------

/**
 * Resolve student and attendance tables from a session.
 *
 * For batch-based sessions, session.batch_code is the authoritative
 * batch identifier. For legacy sessions without batch_code, the
 * batch is derived from session.year.
 */
async function resolveTables(
  session: any
): Promise<{
  studentTable: string;
  attendanceTable: string;
} | null> {
  const dept = String(session.department || "").toUpperCase();

  // For batch-based sessions, use session.batch_code directly.
  if (session.batch_code) {
    const batchKey = String(session.batch_code).trim();
    const studentTable = `${dept.toLowerCase()}_students_${batchKey}`;
    const attendanceTable = `${dept.toLowerCase()}_attendance_${batchKey}`;

    if (await tableExists(studentTable)) {
      return { studentTable, attendanceTable };
    }
    return null;
  }

  // Legacy fallback: derive batch from year.
  const yr = Number(session.year);
  if (!Number.isInteger(yr) || yr < 1 || yr > 4) return null;
  const currentYear = new Date().getFullYear();
  const batchStartYear = currentYear - (yr - 1);
  const batchKey = `${batchStartYear}_${batchStartYear + 4}`;

  const studentTable = `${dept.toLowerCase()}_students_${batchKey}`;
  const attendanceTable = `${dept.toLowerCase()}_attendance_${batchKey}`;

  if (await tableExists(studentTable)) {
    return { studentTable, attendanceTable };
  }

  // Fall back to legacy non-batch tables.
  const legacy = LEGACY_TABLES[dept];
  if (legacy && (await tableExists(legacy.students))) {
    return {
      studentTable: legacy.students,
      attendanceTable: legacy.attendance,
    };
  }

  return null;
}

// ------------------------------------------------------------------
// MAIN
// ------------------------------------------------------------------

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return json({ error: "Only POST requests are allowed" }, 405);
    }

    const { session_id } = await req.json();

    if (!session_id) {
      return json({ error: "session_id is required" }, 400);
    }

    // --------------------------------------------------
    // 1. FIND ATTENDANCE SESSION
    // --------------------------------------------------

    const { data: session, error: sessionError } = await supabase
      .from("attendance_sessions")
      .select("*")
      .eq("session_id", session_id)
      .maybeSingle();

    if (sessionError) {
      console.error("Session error:", sessionError);
      return json(
        {
          error: "Failed to find attendance session",
          details: sessionError.message,
        },
        500
      );
    }

    if (!session) {
      return json(
        { error: "Attendance session not found" },
        404
      );
    }

    // --------------------------------------------------
    // 2. CHECK SESSION STATUS
    // --------------------------------------------------

    if (!session.is_active) {
      return json(
        { error: "Attendance session is already finalized" },
        409
      );
    }

    // --------------------------------------------------
    // 3. CHECK OTP EXPIRY
    // --------------------------------------------------

    const now = new Date();
    const expiresAt = new Date(session.expires_at);

    if (now < expiresAt) {
      return json(
        {
          error: "Attendance session has not expired yet",
          expires_at: session.expires_at,
        },
        400
      );
    }

    // --------------------------------------------------
    // 4. VALIDATE DEPARTMENT AND BATCH
    // --------------------------------------------------

    const dept = String(session.department || "").toUpperCase();
    if (!CANONICAL_DEPARTMENTS.includes(dept)) {
      return json(
        { error: "Invalid department in attendance session" },
        400
      );
    }

    // For sessions targeting batch tables, batch_code must be present.
    if (!session.batch_code) {
      return json(
        { error: "Attendance session is missing batch_code" },
        400
      );
    }

    // --------------------------------------------------
    // 5. DETERMINE STUDENT AND ATTENDANCE TABLES
    // --------------------------------------------------

    const tables = await resolveTables(session);

    if (!tables) {
      return json(
        {
          error: `No student tables found for ${dept} year ${session.year}`,
        },
        400
      );
    }

    const { studentTable, attendanceTable } = tables;

    // --------------------------------------------------
    // 6. FIND STUDENTS BELONGING TO THIS SESSION
    // --------------------------------------------------

    const { data: students, error: studentsError } = await supabase
      .from(studentTable)
      .select("student_id, register_no, student_name")
      .eq("year", session.year)
      .eq("section", session.section);

    if (studentsError) {
      console.error("Student error:", studentsError);
      return json(
        {
          error: "Failed to find students",
          details: studentsError.message,
        },
        500
      );
    }

    if (!students || students.length === 0) {
      await supabase
        .from("attendance_sessions")
        .update({ is_active: false })
        .eq("session_id", session.session_id);

      return json({
        success: true,
        message: "Session finalized. No students found.",
        session_id: session.session_id,
      });
    }

    // --------------------------------------------------
    // 7. TODAY'S DATE
    // --------------------------------------------------

    const today = new Date().toISOString().split("T")[0];

    // --------------------------------------------------
    // 8. FIND EXISTING ATTENDANCE
    // --------------------------------------------------

    const {
      data: existingAttendance,
      error: existingError,
    } = await supabase
      .from(attendanceTable)
      .select("register_no, status")
      .eq("attendance_date", today)
      .eq("period", session.period)
      .eq("subject_id", session.subject_id);

    if (existingError) {
      console.error("Attendance lookup error:", existingError);
      return json(
        {
          error: "Failed to check existing attendance",
          details: existingError.message,
        },
        500
      );
    }

    // --------------------------------------------------
    // 9. CREATE SET OF STUDENTS ALREADY MARKED
    // --------------------------------------------------

    const attendanceRegisters = new Set(
      (existingAttendance || []).map((a) => a.register_no)
    );

    // --------------------------------------------------
    // 10. FIND STUDENTS WITHOUT ATTENDANCE
    // --------------------------------------------------

    const absentStudents = students.filter(
      (s) => !attendanceRegisters.has(s.register_no)
    );

    // --------------------------------------------------
    // 11. MARK ABSENT STUDENTS
    // --------------------------------------------------

    if (absentStudents.length > 0) {
      const absentRecords = absentStudents.map((s) => ({
        register_no: s.register_no,
        attendance_date: today,
        period: session.period,
        subject_id: session.subject_id,
        semester_subject_id: session.semester_subject_id || session.subject_id,
        subject_code: session.subject_code,
        subject_name: session.subject_name,
        semester: session.semester,
        status: "ABSENT",
        marked_at: new Date().toISOString(),
        session_id: session.session_id,
      }));

      const { error: absentInsertError } = await supabase
        .from(attendanceTable)
        .insert(absentRecords);

      if (absentInsertError) {
        console.error(
          "Absent insertion error:",
          absentInsertError
        );
        return json(
          {
            error: "Failed to mark absent students",
            details: absentInsertError.message,
          },
          500
        );
      }
    }

    // --------------------------------------------------
    // 12. DEACTIVATE SESSION
    // --------------------------------------------------

    const { error: deactivateError } = await supabase
      .from("attendance_sessions")
      .update({ is_active: false })
      .eq("session_id", session.session_id);

    if (deactivateError) {
      console.error("Session deactivate error:", deactivateError);
      return json(
        {
          error: "Failed to deactivate attendance session",
          details: deactivateError.message,
        },
        500
      );
    }

    // --------------------------------------------------
    // 13. CALCULATE SUMMARY
    // --------------------------------------------------

    const totalStudents = students.length;
    const absentCount = absentStudents.length;
    const presentCount = totalStudents - absentCount;

    return json({
      success: true,
      message: "Attendance session finalized successfully",
      session: {
        session_id: session.session_id,
        department: session.department,
        year: session.year,
        section: session.section,
        period: session.period,
        subject_id: session.subject_id,
        attendance_table: attendanceTable,
      },
      attendance_summary: {
        total_students: totalStudents,
        present_students: presentCount,
        absent_students: absentCount,
      },
    });
  } catch (error) {
    console.error("Unexpected error:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
