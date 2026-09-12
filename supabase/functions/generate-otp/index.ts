import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Only POST requests are allowed" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    const {
      subject_id,
      batch_code,
      department,
      year,
      section,
      period,
    } = await req.json();

    if (
      !subject_id ||
      !batch_code ||
      !department ||
      !year ||
      !section ||
      !period
    ) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // --------------------------------------------------
    // 1b. RESOLVE STAFF IDENTITY FROM THE AUTHENTICATED JWT
    //
    // The caller MUST present a valid staff session.
    // The staff member's identity (staff_id + department)
    // is resolved from public.staff via auth_user_id.
    // A browser-supplied staff_id/department is NEVER trusted.
    // --------------------------------------------------

    const authHeader = req.headers.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    const token = authHeader.slice(7);
    const { data: userData } = await supabase.auth.getUser(token);

    let resolvedStaffId = 0;
    let resolvedDepartment = "";

    if (userData?.user) {
      const { data: staff } = await supabase
        .from("staff")
        .select("staff_id, department")
        .eq("auth_user_id", userData.user.id)
        .maybeSingle();

      if (staff) {
        resolvedStaffId = Number(staff.staff_id);
        resolvedDepartment = String(staff.department);
      }
    }

    if (!Number.isInteger(resolvedStaffId) || resolvedStaffId <= 0 || !resolvedDepartment) {
      return new Response(
        JSON.stringify({ error: "Invalid staff identity" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Resolve the selected subject from the central semester master.
    // The batch semester is authoritative and is never inferred from year.
    const normalizedBatch = String(batch_code).trim();
    const { data: batch, error: batchError } = await supabase
      .from("academic_batches")
      .select("current_semester")
      .eq("department", resolvedDepartment.toUpperCase())
      .eq("batch_code", normalizedBatch)
      .maybeSingle();
    if (batchError || !batch?.current_semester) {
      return new Response(JSON.stringify({ error: "The selected batch has no current semester configured" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
    const { data: subject, error: subjectError } = await supabase
      .from("semester_subjects")
      .select("id, semester, subject_code, subject_name")
      .eq("id", Number(subject_id))
      .eq("semester", batch.current_semester)
      .maybeSingle();
    if (subjectError || !subject) {
      return new Response(JSON.stringify({ error: "Subject is not available for this batch's current semester" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Generate secure 6-digit OTP
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);

    const otp = (100000 + (random[0] % 900000)).toString();

    // OTP valid for 20 seconds
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 20 * 1000);

    // Create attendance session
    const { data, error } = await supabase
      .from("attendance_sessions")
      .insert({
        staff_id: resolvedStaffId,
        subject_id,
        batch_code: normalizedBatch,
        semester_subject_id: subject.id,
        subject_code: subject.subject_code,
        subject_name: subject.subject_name,
        semester: subject.semester,
        department: resolvedDepartment,
        year,
        section,
        period,
        otp,
        created_at: createdAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error("Database error:", error);

      return new Response(
        JSON.stringify({
          error: "Failed to create attendance session",
          details: error.message,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "OTP generated successfully",
        otp,
        session: data,
        expires_at: expiresAt.toISOString(),
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
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
});
