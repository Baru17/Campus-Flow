import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  try {
    // --------------------------------------------------
    // 0. CHECK REQUEST METHOD
    // --------------------------------------------------

    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: "Only POST requests are allowed",
        }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // --------------------------------------------------
    // 1. GET SESSION ID
    // --------------------------------------------------

    const { session_id } = await req.json();

    if (!session_id) {
      return new Response(
        JSON.stringify({
          error: "session_id is required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // --------------------------------------------------
    // 2. FIND ATTENDANCE SESSION
    // --------------------------------------------------

    const { data: session, error: sessionError } = await supabase
      .from("attendance_sessions")
      .select("*")
      .eq("session_id", session_id)
      .maybeSingle();

    if (sessionError) {
      console.error("Session error:", sessionError);

      return new Response(
        JSON.stringify({
          error: "Failed to find attendance session",
          details: sessionError.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    if (!session) {
      return new Response(
        JSON.stringify({
          error: "Attendance session not found",
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // --------------------------------------------------
    // 3. CHECK SESSION STATUS
    // --------------------------------------------------

    if (!session.is_active) {
      return new Response(
        JSON.stringify({
          error: "Attendance session is already finalized",
        }),
        {
          status: 409,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // --------------------------------------------------
    // 4. CHECK OTP EXPIRY
    // --------------------------------------------------

    const now = new Date();
    const expiresAt = new Date(session.expires_at);

    if (now < expiresAt) {
      return new Response(
        JSON.stringify({
          error: "Attendance session has not expired yet",
          expires_at: session.expires_at,
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // --------------------------------------------------
    // 5. DETERMINE TABLES USING SESSION DEPARTMENT
    // --------------------------------------------------

    let studentTable = "";
    let attendanceTable = "";

    switch (session.department.toUpperCase()) {
      case "IT":
        studentTable = "it_students";
        attendanceTable = "it_attendance";
        break;

      case "CSE":
        studentTable = "cse_students";
        attendanceTable = "cse_attendance";
        break;

      case "ECE":
        studentTable = "ece_students";
        attendanceTable = "ece_attendance";
        break;

      case "EEE":
        studentTable = "eee_students";
        attendanceTable = "eee_attendance";
        break;

      default:
        return new Response(
          JSON.stringify({
            error: "Invalid department in attendance session",
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
    }

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

      return new Response(
        JSON.stringify({
          error: "Failed to find students",
          details: studentsError.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    if (!students || students.length === 0) {
      await supabase
        .from("attendance_sessions")
        .update({
          is_active: false,
        })
        .eq("session_id", session.session_id);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Session finalized. No students found.",
          session_id: session.session_id,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // --------------------------------------------------
    // 7. TODAY'S DATE
    // --------------------------------------------------

    const today = new Date().toISOString().split("T")[0];

    // --------------------------------------------------
    // 8. FIND EXISTING ATTENDANCE
    //
    // IMPORTANT:
    // We DO NOT filter by session_id here.
    //
    // Your unique constraint is:
    //
    // register_no + attendance_date + period + subject_id
    //
    // So we must check using those same fields.
    // --------------------------------------------------

    const { data: existingAttendance, error: existingError } =
      await supabase
        .from(attendanceTable)
        .select("register_no, status")
        .eq("attendance_date", today)
        .eq("period", session.period)
        .eq("subject_id", session.subject_id);

    if (existingError) {
      console.error("Attendance lookup error:", existingError);

      return new Response(
        JSON.stringify({
          error: "Failed to check existing attendance",
          details: existingError.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // --------------------------------------------------
    // 9. CREATE SET OF STUDENTS WHO ALREADY HAVE
    // ATTENDANCE RECORDS
    // --------------------------------------------------

    const attendanceRegisters = new Set(
      (existingAttendance || []).map(
        (attendance) => attendance.register_no
      )
    );

    // --------------------------------------------------
    // 10. FIND STUDENTS WITHOUT ATTENDANCE
    // --------------------------------------------------

    const absentStudents = students.filter(
      (student) =>
        !attendanceRegisters.has(student.register_no)
    );

    // --------------------------------------------------
    // 11. MARK ABSENT STUDENTS
    // --------------------------------------------------

    if (absentStudents.length > 0) {
      const absentRecords = absentStudents.map((student) => ({
        register_no: student.register_no,
        attendance_date: today,
        period: session.period,
        subject_id: session.subject_id,
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

        return new Response(
          JSON.stringify({
            error: "Failed to mark absent students",
            details: absentInsertError.message,
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    // --------------------------------------------------
    // 12. DEACTIVATE SESSION
    // --------------------------------------------------

    const { error: deactivateError } = await supabase
      .from("attendance_sessions")
      .update({
        is_active: false,
      })
      .eq("session_id", session.session_id);

    if (deactivateError) {
      console.error(
        "Session deactivate error:",
        deactivateError
      );

      return new Response(
        JSON.stringify({
          error: "Failed to deactivate attendance session",
          details: deactivateError.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // --------------------------------------------------
    // 13. CALCULATE SUMMARY
    // --------------------------------------------------

    const totalStudents = students.length;
    const absentCount = absentStudents.length;
    const presentCount = totalStudents - absentCount;

    // --------------------------------------------------
    // 14. SUCCESS RESPONSE
    // --------------------------------------------------

    return new Response(
      JSON.stringify({
        success: true,
        message: "Attendance session finalized successfully",

        session: {
          session_id: session.session_id,
          department: session.department,
          year: session.year,
          section: session.section,
          period: session.period,
          subject_id: session.subject_id,
        },

        attendance_summary: {
          total_students: totalStudents,
          present_students: presentCount,
          absent_students: absentCount,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
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
        },
      }
    );
  }
});