import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// CORS headers so the browser frontend can call this function.
// Only headers are added — attendance logic is unchanged.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  try {
    // Handle browser CORS preflight requests.
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
    // 1. FIND THE STUDENT AND THEIR DEPARTMENT
    // --------------------------------------------------

    let student: any = null;
    let studentDepartment = "";
    let attendanceTable = "";

    // IT
    const { data: itStudent } = await supabase
      .from("it_students")
      .select("student_id, register_no, student_name")
      .ilike("student_id", student_id)
      .maybeSingle();

    if (itStudent) {
      student = itStudent;
      studentDepartment = "IT";
      attendanceTable = "it_attendance";
    }

    // CSE
    if (!student) {
      const { data: cseStudent } = await supabase
        .from("cse_students")
        .select("student_id, register_no, student_name")
        .ilike("student_id", student_id)
        .maybeSingle();

      if (cseStudent) {
        student = cseStudent;
        studentDepartment = "CSE";
        attendanceTable = "cse_attendance";
      }
    }

    // ECE
    if (!student) {
      const { data: eceStudent } = await supabase
        .from("ece_students")
        .select("student_id, register_no, student_name")
        .ilike("student_id", student_id)
        .maybeSingle();

      if (eceStudent) {
        student = eceStudent;
        studentDepartment = "ECE";
        attendanceTable = "ece_attendance";
      }
    }

    // EEE
    if (!student) {
      const { data: eeeStudent } = await supabase
        .from("eee_students")
        .select("student_id, register_no, student_name")
        .ilike("student_id", student_id)
        .maybeSingle();

      if (eeeStudent) {
        student = eeeStudent;
        studentDepartment = "EEE";
        attendanceTable = "eee_attendance";
      }
    }

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
    // 1b. VERIFY AUTHENTICATED IDENTITY (IF A SESSION EXISTS)
    //
    // When the caller presents a valid user session, confirm the student
    // ID they submitted belongs to that same authenticated user. This
    // prevents a logged-in student from submitting another student's ID.
    // Legacy unauthenticated callers keep the previous behavior.
    // --------------------------------------------------

    const authHeader = req.headers.get("authorization");
    let authenticatedStudentId: string | null = null;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const { data: userData } = await supabase.auth.getUser(token);

      if (userData?.user) {
        const { data: linkedStudent } = await supabase
          .from("it_students")
          .select("student_id")
          .eq("auth_user_id", userData.user.id)
          .maybeSingle();

        if (linkedStudent) {
          authenticatedStudentId = linkedStudent.student_id;
        }
      }
    }

    if (
      authenticatedStudentId &&
      authenticatedStudentId.toLowerCase() !== student.student_id.toLowerCase()
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

    // --------------------------------------------------
    // 2. FIND ALL ACTIVE ATTENDANCE SESSIONS
    // --------------------------------------------------

    const { data: sessions, error: sessionError } = await supabase
      .from("attendance_sessions")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (sessionError) {
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
    // 3. CHECK ALL ACTIVE SESSIONS FOR OTP
    // --------------------------------------------------

    const now = new Date();
    let matchedSession: any = null;

    for (const currentSession of sessions) {
      const expiresAt = new Date(currentSession.expires_at);

      // If OTP/session has expired,
      // mark it inactive and continue checking others.
      if (now >= expiresAt) {
        await supabase
          .from("attendance_sessions")
          .update({
            is_active: false,
          })
          .eq("session_id", currentSession.session_id);

        continue;
      }

      // Check whether entered OTP matches this session
      if (
        otp.toString().trim() ===
        currentSession.otp.toString().trim()
      ) {
        matchedSession = currentSession;
        break;
      }
    }

    // --------------------------------------------------
    // 4. OTP NOT FOUND
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
    // 5. CHECK DUPLICATE ATTENDANCE
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
    // 6. MARK ATTENDANCE
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
    // 7. SUCCESS
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
    console.error(error);

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