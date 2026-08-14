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

    // Generate secure 6-digit OTP
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);

    const otp = (100000 + (random[0] % 900000)).toString();

    // OTP valid for 10 seconds
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 1000);

    // Create attendance session
    const { data, error } = await supabase
      .from("attendance_sessions")
      .insert({
        staff_id,
        subject_id,
        department,
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
