import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// --------------------------------------------------
// CORS HEADERS
// --------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// --------------------------------------------------
// IT BATCH TABLES
// --------------------------------------------------

const IT_STUDENT_TABLES = [
  "it_students_2026_2030",
  "it_students_2025_2029",
  "it_students_2024_2028",
  "it_students_2023_2027",
];

// --------------------------------------------------
// GET IT BATCH FROM STUDENT ID
// Example:
// 2k24it001 -> 2024_2028
// 2k25it001 -> 2025_2029
// --------------------------------------------------

function getITBatchFromStudentId(studentId: string) {
  const normalizedId = String(studentId || "").trim().toLowerCase();

  const match = normalizedId.match(/^2k(\d{2})it\d+$/i);

  if (!match) {
    return null;
  }

  const startYear = 2000 + Number(match[1]);
  const endYear = startYear + 4;

  const allowedBatches = [
    "2026_2030",
    "2025_2029",
    "2024_2028",
    "2023_2027",
  ];

  const batch = `${startYear}_${endYear}`;

  if (!allowedBatches.includes(batch)) {
    return null;
  }

  return batch;
}

// --------------------------------------------------
// GET IT STUDENT TABLE FROM BATCH
// --------------------------------------------------

function getITStudentTable(batch: string) {
  const allowedBatches = [
    "2026_2030",
    "2025_2029",
    "2024_2028",
    "2023_2027",
  ];

  if (!allowedBatches.includes(batch)) {
    return null;
  }

  return `it_students_${batch}`;
}

// --------------------------------------------------
// GET IT ATTENDANCE TABLE FROM BATCH
// --------------------------------------------------

function getITAttendanceTable(batch: string) {
  const allowedBatches = [
    "2026_2030",
    "2025_2029",
    "2024_2028",
    "2023_2027",
  ];

  if (!allowedBatches.includes(batch)) {
    return null;
  }

  return `it_attendance_${batch}`;
}

// --------------------------------------------------
// MAIN FUNCTION
// --------------------------------------------------

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
    let studentBatch = "";

    // --------------------------------------------------
    // IT
    // --------------------------------------------------

    for (const table of IT_STUDENT_TABLES) {
      const { data: itStudent, error: itStudentError } =
        await supabase
          .from(table)
          .select(
            "student_id, register_no, student_name, year, section, auth_user_id"
          )
          .ilike("student_id", student_id)
          .maybeSingle();

      if (itStudentError) {
        console.error(
          `IT student lookup error in ${table}:`,
          itStudentError
        );
        continue;
      }

      if (itStudent) {
        student = itStudent;
        studentDepartment = "IT";

        const batch = getITBatchFromStudentId(
          itStudent.student_id
        );

        if (!batch) {
          return new Response(
            JSON.stringify({
              error: "Invalid IT student batch",
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

        studentBatch = batch;

        // Make sure the student was found in the correct
        // permanent batch table.
        const expectedStudentTable =
          getITStudentTable(batch);

        if (expectedStudentTable !== table) {
          console.error(
            `Student ${itStudent.student_id} found in ${table}, expected ${expectedStudentTable}`
          );

          return new Response(
            JSON.stringify({
              error: "Student is stored in an incorrect batch table",
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

        break;
      }
    }

    // --------------------------------------------------
    // CSE
    // --------------------------------------------------

    if (!student) {
      const {
        data: cseStudent,
        error: cseStudentError,
      } = await supabase
        .from("cse_students")
        .select(
          "student_id, register_no, student_name, year, section"
        )
        .ilike("student_id", student_id)
        .maybeSingle();

      if (cseStudentError) {
        console.error(
          "CSE student lookup error:",
          cseStudentError
        );
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
      const {
        data: eceStudent,
        error: eceStudentError,
      } = await supabase
        .from("ece_students")
        .select(
          "student_id, register_no, student_name, year, section"
        )
        .ilike("student_id", student_id)
        .maybeSingle();

      if (eceStudentError) {
        console.error(
          "ECE student lookup error:",
          eceStudentError
        );
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
      const {
        data: eeeStudent,
        error: eeeStudentError,
      } = await supabase
        .from("eee_students")
        .select(
          "student_id, register_no, student_name, year, section"
        )
        .ilike("student_id", student_id)
        .maybeSingle();

      if (eeeStudentError) {
        console.error(
          "EEE student lookup error:",
          eeeStudentError
        );
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

    if (
      authHeader &&
      authHeader.startsWith("Bearer ")
    ) {
      const token = authHeader.slice(7);

      const { data: userData } =
        await supabase.auth.getUser(token);

      if (userData?.user) {
        // --------------------------------------------------
        // IT AUTHENTICATION
        // --------------------------------------------------

        if (studentDepartment === "IT") {
          let linkedStudent: {
            student_id: string;
          } | null = null;

          for (const table of IT_STUDENT_TABLES) {
            const { data } = await supabase
              .from(table)
              .select("student_id")
              .eq(
                "auth_user_id",
                userData.user.id
              )
              .maybeSingle();

            if (data) {
              linkedStudent = data;
              break;
            }
          }

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

    // Subjects are common across sections for a
    // department + year, so section is intentionally
    // not filtered here.

    const {
      data: sessions,
      error: sessionError,
    } = await supabase
      .from("attendance_sessions")
      .select("*")
      .eq("is_active", true)
      .eq("department", studentDepartment)
      .eq("year", student.year)
      .order("created_at", {
        ascending: false,
      });

    if (sessionError) {
      console.error(
        "Session lookup error:",
        sessionError
      );

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
      const expiresAt = new Date(
        currentSession.expires_at
      );

      // Expired session
      if (now >= expiresAt) {
        await supabase
          .from("attendance_sessions")
          .update({
            is_active: false,
          })
          .eq(
            "session_id",
            currentSession.session_id
          );

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
          error:
            "Student does not belong to this department",
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

    if (
      Number(matchedSession.year) !==
      Number(student.year)
    ) {
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

    // NOTE:
    // No section check is performed here.
    // Subjects are common across all sections
    // of a department + year.

    // --------------------------------------------------
    // 8. DETERMINE ATTENDANCE TABLE
    // --------------------------------------------------

    let attendanceTable = "";

    if (studentDepartment === "IT") {
      // IMPORTANT:
      // IT attendance is selected using the student's
      // permanent batch, NOT the current year.
      //
      // Example:
      // 2k24IT001 -> 2024_2028
      // -> it_attendance_2024_2028

      attendanceTable =
        getITAttendanceTable(studentBatch) || "";

      if (!attendanceTable) {
        return new Response(
          JSON.stringify({
            error: "Invalid IT attendance batch",
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

    const today = new Date()
      .toISOString()
      .split("T")[0];

    const {
      data: existingAttendance,
      error: existingError,
    } = await supabase
      .from(attendanceTable)
      .select("attendance_id")
      .eq(
        "register_no",
        student.register_no
      )
      .eq(
        "attendance_date",
        today
      )
      .eq(
        "period",
        matchedSession.period
      )
      .eq(
        "subject_id",
        matchedSession.subject_id
      )
      .maybeSingle();

    if (existingError) {
      console.error(
        "Existing attendance lookup error:",
        existingError
      );

      return new Response(
        JSON.stringify({
          error:
            "Failed to check existing attendance",
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
          ...(studentDepartment === "IT"
            ? { batch: studentBatch }
            : {}),
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
    console.error(
      "Unexpected error:",
      error
    );

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

