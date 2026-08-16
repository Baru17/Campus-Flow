import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  try {
    // --------------------------------------------------
    // 0. HANDLE CORS
    // --------------------------------------------------

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: "Only POST requests are allowed",
        }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // --------------------------------------------------
    // 1. GET REQUEST DATA
    // --------------------------------------------------

    const { student_id, otp } = await req.json();

    if (!student_id || !otp) {
      return new Response(
        JSON.stringify({
          error: "Student ID and OTP are required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // --------------------------------------------------
    // 2. FIND STUDENT AND DEPARTMENT
    // --------------------------------------------------

    let student: any = null;
    let studentDepartment = "";

    // --------------------------------------------------
    // IT
    // --------------------------------------------------

    const { data: itStudent, error: itStudentError } = await supabase
      .from("it_students")
      .select(
        "student_id, register_no, student_name, year, section, auth_user_id"
      )
      .ilike("student_id", student_id)
      .maybeSingle();

    if (itStudentError) {
      console.error("IT student lookup error:", itStudentError);
    }

    if (itStudent) {
      student = itStudent;
      studentDepartment = "IT";
    }

    // --------------------------------------------------
    // CSE
    // --------------------------------------------------

    if (!student) {
      const { data: cseStudent, error: cseStudentError } = await supabase
        .from("cse_students")
        .select("student_id, register_no, student_name, year, section")
        .ilike("student_id", student_id)
        .maybeSingle();

      if (cseStudentError) {
        console.error("CSE student lookup error:", cseStudentError);
      }

      if (cseStudent) {
        student = cseStudent;
        studentDepartment = "CSE";
      }
    }

    // --------------------------------------------------
    // ECE
    // --------------------------------------------------

    if (!student) {
      const { data: eceStudent, error: eceStudentError } = await supabase
        .from("ece_students")
        .select("student_id, register_no, student_name, year, section")
        .ilike("student_id", student_id)
        .maybeSingle();

      if (eceStudentError) {
        console.error("ECE student lookup error:", eceStudentError);
      }

      if (eceStudent) {
        student = eceStudent;
        studentDepartment = "ECE";
      }
    }

    // --------------------------------------------------
    // EEE
    // --------------------------------------------------

    if (!student) {
      const { data: eeeStudent, error: eeeStudentError } = await supabase
        .from("eee_students")
        .select("student_id, register_no, student_name, year, section")
        .ilike("student_id", student_id)
        .maybeSingle();

      if (eeeStudentError) {
        console.error("EEE student lookup error:", eeeStudentError);
      }

      if (eeeStudent) {
        student = eeeStudent;
        studentDepartment = "EEE";
      }
    }

    // --------------------------------------------------
    // STUDENT NOT FOUND
    // --------------------------------------------------

    if (!student) {
      return new Response(
        JSON.stringify({
          error: "Student not found",
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // --------------------------------------------------
    // 3. VERIFY AUTHENTICATED STUDENT ID
    // --------------------------------------------------

    const authHeader = req.headers.get("authorization");

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      const { data: userData } = await supabase.auth.getUser(token);

      if (userData?.user) {
        // Currently student authentication is linked through IT students.
        if (studentDepartment === "IT") {
          const { data: linkedStudent } = await supabase
            .from("it_students")
            .select("student_id")
            .eq("auth_user_id", userData.user.id)
            .maybeSingle();

          if (
            linkedStudent &&
            linkedStudent.student_id.toLowerCase() !==
              student.student_id.toLowerCase()
          ) {
            return new Response(
              JSON.stringify({
                error: "Student identity does not match",
              }),
              {
                status: 403,
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
        }
      }
    }

    // --------------------------------------------------
    // 4. FIND ALL ACTIVE ATTENDANCE SESSIONS
    // --------------------------------------------------

    // Subjects are common across sections for a department + year, so the
    // section is intentionally not filtered here.
    const { data: sessions, error: sessionError } = await supabase
      .from("attendance_sessions")
      .select("*")
      .eq("is_active", true)
      .eq("department", studentDepartment)
      .eq("year", student.year)
      .order("created_at", { ascending: false });

    if (sessionError) {
      console.error("Session lookup error:", sessionError);

      return new Response(
        JSON.stringify({
          error: "Failed to find attendance sessions",
          details: sessionError.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    if (!sessions || sessions.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No active attendance session",
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // --------------------------------------------------
    // 5. CHECK OTP
    // --------------------------------------------------

    const now = new Date();
    let matchedSession: any = null;

    for (const currentSession of sessions) {
      const expiresAt = new Date(currentSession.expires_at);

      // Expired session
      if (now >= expiresAt) {
        await supabase
          .from("attendance_sessions")
          .update({
            is_active: false,
          })
          .eq("session_id", currentSession.session_id);

        continue;
      }

      // OTP matches
      if (
        otp.toString().trim() ===
        currentSession.otp.toString().trim()
      ) {
        matchedSession = currentSession;
        break;
      }
    }

    // --------------------------------------------------
    // 6. OTP NOT FOUND
    // --------------------------------------------------

    if (!matchedSession) {
      return new Response(
        JSON.stringify({
          error: "Invalid or expired OTP",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // --------------------------------------------------
    // 7. VERIFY SESSION BELONGS TO STUDENT
    // --------------------------------------------------

    if (
      matchedSession.department.toUpperCase() !==
      studentDepartment.toUpperCase()
    ) {
      return new Response(
        JSON.stringify({
          error: "Student does not belong to this department",
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    if (Number(matchedSession.year) !== Number(student.year)) {
      return new Response(
        JSON.stringify({
          error: "Student does not belong to this year",
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // NOTE: No section check is performed here. Since subjects are common
    // across all sections of a department + year, a student from any section
    // can mark attendance against a session for the same department and year.

    // --------------------------------------------------
    // 8. DETERMINE ATTENDANCE TABLE
    // --------------------------------------------------

    let attendanceTable = "";

    if (studentDepartment === "IT") {
      const year = Number(matchedSession.year);

      if (![1, 2, 3, 4].includes(year)) {
        return new Response(
          JSON.stringify({
            error: "Invalid attendance year",
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          }
        );
      }

      attendanceTable = `it_attendance_${year}`;
    } else if (studentDepartment === "CSE") {
      attendanceTable = "cse_attendance";
    } else if (studentDepartment === "ECE") {
      attendanceTable = "ece_attendance";
    } else if (studentDepartment === "EEE") {
      attendanceTable = "eee_attendance";
    } else {
      return new Response(
        JSON.stringify({
          error: "Invalid student department",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // --------------------------------------------------
    // 9. CHECK DUPLICATE ATTENDANCE
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

      return new Response(
        JSON.stringify({
          error: "Failed to check existing attendance",
          details: existingError.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    if (existingAttendance) {
      return new Response(
        JSON.stringify({
          error: "Attendance already marked",
        }),
        {
          status: 409,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // --------------------------------------------------
    // 10. MARK PRESENT
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

      return new Response(
        JSON.stringify({
          error: "Failed to mark attendance",
          details: attendanceError.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // --------------------------------------------------
    // 11. SUCCESS
    // --------------------------------------------------

    return new Response(
      JSON.stringify({
        success: true,
        message: "Attendance marked successfully",
        student: {
          student_id: student.student_id,
          register_no: student.register_no,
          student_name: student.student_name,
          department: studentDepartment,
          year: student.year,
          section: student.section,
        },
        attendance,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    console.error("Unexpected error:", error);

    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  }
});