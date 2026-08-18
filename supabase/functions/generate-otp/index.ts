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
        JSON.stringify({ error: "Only POST requests are allowed" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    const {
      staff_id,
      subject_id,
      department,
      year,
      section,
      period,
    } = await req.json();

    // Validate required fields
    if (
      !staff_id ||
      !subject_id ||
      !department ||
      !year ||
      !section ||
      !period
    ) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // --------------------------------------------------
    // 1b. RESOLVE STAFF IDENTITY FROM THE AUTHENTICATED JWT
    //
    // When the caller presents a valid staff session, the staff member's
    // identity (staff_id + department) is taken from public.staff via
    // auth_user_id — a browser-supplied staff_id/department is never
    // trusted for authenticated callers. Unauthenticated callers keep the
    // legacy behavior of using the body values.
    // --------------------------------------------------

    let resolvedStaffId = Number(staff_id);
    let resolvedDepartment = String(department);

    const authHeader = req.headers.get("authorization");

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const { data: userData } = await supabase.auth.getUser(token);

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
    }

    if (!Number.isInteger(resolvedStaffId) || resolvedStaffId <= 0 || !resolvedDepartment) {
      return new Response(
        JSON.stringify({
          error: "Invalid staff identity",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Generate secure 6-digit OTP
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);

    const otp = (100000 + (random[0] % 900000)).toString();

    // OTP valid for 15 seconds
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 20 * 1000);

    // Create attendance session
    const { data, error } = await supabase
      .from("attendance_sessions")
      .insert({
        staff_id: resolvedStaffId,
        subject_id,
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
