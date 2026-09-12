import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CANONICAL_DEPARTMENTS = ["IT", "CSE", "ECE", "EEE"];

// Legacy non-batch tables for backward compatibility.
const LEGACY_STUDENT_TABLES: Record<string, string> = {
  CSE: "cse_students",
  ECE: "ece_students",
  EEE: "eee_students",
};

// ------------------------------------------------------------------
// DIRECT DATABASE ACCESS (for dynamic batch table discovery)
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

async function listStudentTablesForDept(
  department: string
): Promise<string[]> {
  const prefix = `${department.toLowerCase()}_students_`;
  return runDb(async (sql) => {
    const rows = await sql.unsafe(
      `select tablename from pg_catalog.pg_tables
       where schemaname = 'public'
         and tablename like '${prefix}%'`
    );
    return (rows || []).map((row) => String(row.tablename));
  });
}

/**
 * Derive the batch key from a student table name.
 * e.g. "it_students_2027_2031" => "2027_2031"
 */
function batchFromStudentTable(
  department: string,
  table: string
): string | null {
  const prefix = `${department.toLowerCase()}_students_`;
  if (!table.startsWith(prefix)) return null;
  return table.slice(prefix.length);
}

/**
 * For a given department + year, compute which batch should contain
 * students of that year based on the current academic calendar.
 *
 * Formula: batchStartYear = currentYear - (year - 1)
 * e.g. currentYear=2026, year=2 => 2025 => batch 2025_2029
 */
function batchKeyForYear(
  department: string,
  year: number
): string | null {
  if (!Number.isInteger(year) || year < 1 || year > 4) return null;
  const currentYear = new Date().getFullYear();
  const batchStartYear = currentYear - (year - 1);
  return `${batchStartYear}_${batchStartYear + 4}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// ------------------------------------------------------------------
// MAIN FUNCTION
// ------------------------------------------------------------------

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (req.method !== "POST") {
      return json({ error: "Only POST requests are allowed" }, 405);
    }

    const { student_id, otp } = await req.json();

    if (!student_id || !otp) {
      return json(
        { error: "Student ID and OTP are required" },
        400
      );
    }

    // --------------------------------------------------
    // 1. FIND STUDENT ACROSS ALL DEPARTMENT BATCH TABLES
    // --------------------------------------------------

    let student: any = null;
    let studentDepartment = "";
    let studentBatch = "";
    let studentTable = "";

    for (const dept of CANONICAL_DEPARTMENTS) {
      // First, try batch tables discovered from the database.
      let batchTables: string[] = [];
      try {
        batchTables = await listStudentTablesForDept(dept);
      } catch (error) {
        console.error(
          `Failed to list ${dept} batch tables:`,
          error
        );
      }

      for (const table of batchTables) {
        const { data: found, error: findError } = await supabase
          .from(table)
          .select(
            "student_id, register_no, student_name, year, section, auth_user_id"
          )
          .ilike("student_id", student_id)
          .maybeSingle();

        if (findError) {
          console.error(
            `${dept} student lookup error in ${table}:`,
            findError
          );
          continue;
        }

        if (found) {
          student = found;
          studentDepartment = dept;
          studentTable = table;
          studentBatch =
            batchFromStudentTable(dept, table) || "";
          break;
        }
      }

      // If not found in batch tables, try the legacy non-batch table.
      if (!student && LEGACY_STUDENT_TABLES[dept]) {
        const legacyTable = LEGACY_STUDENT_TABLES[dept];
        const { data: found, error: findError } = await supabase
          .from(legacyTable)
          .select(
            "student_id, register_no, student_name, year, section, auth_user_id"
          )
          .ilike("student_id", student_id)
          .maybeSingle();

        if (findError) {
          console.error(
            `${dept} legacy student lookup error:`,
            findError
          );
        }

        if (found) {
          student = found;
          studentDepartment = dept;
          studentTable = legacyTable;
          studentBatch = "";
          break;
        }
      }

      if (student) break;
    }

    if (!student) {
      return json({ error: "Student not found" }, 404);
    }

    // --------------------------------------------------
    // 2. VERIFY AUTHENTICATED STUDENT IDENTITY
    // --------------------------------------------------

    const authHeader = req.headers.get("authorization");

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const { data: userData } =
        await supabase.auth.getUser(token);

      if (userData?.user) {
        // Search all batch tables for this department to find
        // the row matching the auth user.
        let linkedStudent: { student_id: string } | null = null;

        let deptTables: string[] = [];
        try {
          deptTables = await listStudentTablesForDept(
            studentDepartment
          );
        } catch {
          deptTables = [];
        }

        for (const table of deptTables) {
          const { data } = await supabase
            .from(table)
            .select("student_id")
            .eq("auth_user_id", userData.user.id)
            .maybeSingle();

          if (data) {
            linkedStudent = data;
            break;
          }
        }

        // Also check legacy table.
        if (
          !linkedStudent &&
          LEGACY_STUDENT_TABLES[studentDepartment]
        ) {
          const { data } = await supabase
            .from(LEGACY_STUDENT_TABLES[studentDepartment])
            .select("student_id")
            .eq("auth_user_id", userData.user.id)
            .maybeSingle();
          if (data) linkedStudent = data;
        }

        if (
          linkedStudent &&
          linkedStudent.student_id.toLowerCase() !==
            student.student_id.toLowerCase()
        ) {
          return json(
            { error: "Student identity does not match" },
            403
          );
        }
      }
    }

    // --------------------------------------------------
    // 3. FIND ALL ACTIVE ATTENDANCE SESSIONS
    // --------------------------------------------------

    const {
      data: sessions,
      error: sessionError,
    } = await supabase
      .from("attendance_sessions")
      .select("*")
      .eq("is_active", true)
      .eq("department", studentDepartment)
      .eq("year", student.year)
      .order("created_at", { ascending: false });

    if (sessionError) {
      console.error("Session lookup error:", sessionError);
      return json(
        {
          error: "Failed to find attendance sessions",
          details: sessionError.message,
        },
        500
      );
    }

    if (!sessions || sessions.length === 0) {
      return json(
        { error: "No active attendance session" },
        404
      );
    }

    // --------------------------------------------------
    // 4. CHECK OTP
    // --------------------------------------------------

    const now = new Date();
    let matchedSession: any = null;

    for (const currentSession of sessions) {
      const expiresAt = new Date(currentSession.expires_at);

      if (now >= expiresAt) {
        await supabase
          .from("attendance_sessions")
          .update({ is_active: false })
          .eq("session_id", currentSession.session_id);
        continue;
      }

      if (
        otp.toString().trim() ===
        currentSession.otp.toString().trim()
      ) {
        matchedSession = currentSession;
        break;
      }
    }

    if (!matchedSession) {
      return json(
        { error: "Invalid or expired OTP" },
        400
      );
    }

    // --------------------------------------------------
    // 5. VERIFY SESSION BELONGS TO STUDENT
    // --------------------------------------------------

    if (
      matchedSession.department.toUpperCase() !==
      studentDepartment.toUpperCase()
    ) {
      return json(
        { error: "Student does not belong to this department" },
        403
      );
    }

    if (
      Number(matchedSession.year) !== Number(student.year)
    ) {
      return json(
        { error: "Student does not belong to this year" },
        403
      );
    }

    // --------------------------------------------------
    // 5b. VALIDATE BATCH_CODE
    // --------------------------------------------------

    if (studentBatch) {
      if (!matchedSession.batch_code) {
        return json(
          { error: "Session is missing batch information" },
          400
        );
      }
      if (studentBatch !== matchedSession.batch_code) {
        return json(
          { error: "Student does not belong to this batch" },
          403
        );
      }
    }

    // --------------------------------------------------
    // 5c. VALIDATE SESSION SNAPSHOT FIELDS
    // --------------------------------------------------

    if (
      !matchedSession.semester_subject_id ||
      !matchedSession.subject_code ||
      !matchedSession.subject_name ||
      !matchedSession.semester
    ) {
      return json(
        { error: "Attendance session is missing required subject information" },
        400
      );
    }

    // --------------------------------------------------
    // 6. DETERMINE ATTENDANCE TABLE
    // --------------------------------------------------

    let attendanceTable = "";

    if (studentBatch) {
      // Batch-based table: {dept}_attendance_{batch}
      attendanceTable = `${studentDepartment.toLowerCase()}_attendance_${studentBatch}`;
    } else {
      // Legacy non-batch table: {dept}_attendance
      const legacyMap: Record<string, string> = {
        CSE: "cse_attendance",
        ECE: "ece_attendance",
        EEE: "eee_attendance",
      };
      attendanceTable =
        legacyMap[studentDepartment] || "";
    }

    if (!attendanceTable) {
      return json(
        { error: "Could not determine attendance table" },
        400
      );
    }

    // --------------------------------------------------
    // 7. CHECK DUPLICATE ATTENDANCE
    // --------------------------------------------------

    const today = new Date().toISOString().split("T")[0];

    const {
      data: existingAttendance,
      error: existingError,
    } = await supabase
      .from(attendanceTable)
      .select("attendance_id")
      .eq("register_no", student.register_no)
      .eq("attendance_date", today)
      .eq("period", matchedSession.period)
      .eq("subject_id", matchedSession.subject_id)
      .maybeSingle();

    if (existingError) {
      console.error(
        "Existing attendance lookup error:",
        existingError
      );
      return json(
        {
          error: "Failed to check existing attendance",
          details: existingError.message,
        },
        500
      );
    }

    if (existingAttendance) {
      return json(
        { error: "Attendance already marked" },
        409
      );
    }

    // --------------------------------------------------
    // 8. MARK PRESENT
    // --------------------------------------------------

    const {
      data: attendance,
      error: attendanceError,
    } = await supabase
      .from(attendanceTable)
      .insert({
        register_no: student.register_no,
        attendance_date: today,
        period: matchedSession.period,
        subject_id: matchedSession.subject_id,
        semester_subject_id: matchedSession.semester_subject_id,
        subject_code: matchedSession.subject_code,
        subject_name: matchedSession.subject_name,
        semester: matchedSession.semester,
        status: "PRESENT",
        marked_at: new Date().toISOString(),
        session_id: matchedSession.session_id,
      })
      .select()
      .single();

    if (attendanceError) {
      console.error(
        "Attendance insertion error:",
        attendanceError
      );
      return json(
        {
          error: "Failed to mark attendance",
          details: attendanceError.message,
        },
        500
      );
    }

    // --------------------------------------------------
    // 9. SUCCESS
    // --------------------------------------------------

    return json({
      success: true,
      message: "Attendance marked successfully",
      student: {
        student_id: student.student_id,
        register_no: student.register_no,
        student_name: student.student_name,
        department: studentDepartment,
        year: student.year,
        section: student.section,
        ...(studentBatch ? { batch: studentBatch } : {}),
      },
      attendance,
    });
  } catch (error) {
    console.error("Unexpected error:", error);
    return json(
      { error: "Internal server error" },
      500
    );
  }
});
