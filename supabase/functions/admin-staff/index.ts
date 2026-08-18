import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// The single administrator identity (matches admin-students).
const ADMIN_EMAIL = "admin@kiot.ac.in";

const CANONICAL_DEPARTMENTS = ["IT", "CSE", "ECE", "EEE"];

// ------------------------------------------------------------------
// CORS
// ------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/**
 * Resolve the caller as the administrator.
 * The JWT is validated by Supabase Auth and both the email and the
 * app_metadata role must match.
 */
async function resolveAdmin(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const { data: userData } = await supabase.auth.getUser(token);
  const user = userData?.user;
  if (!user) return null;
  if (String(user.email || "").toLowerCase() !== ADMIN_EMAIL) return null;
  if (user.app_metadata?.role !== "admin") return null;
  return user;
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeName(value: unknown) {
  return String(value ?? "").trim();
}

// ------------------------------------------------------------------
// META — departments available for staff management
// ------------------------------------------------------------------

async function handleMeta() {
  const departments = [...CANONICAL_DEPARTMENTS];

  // Also include any department present in the central staff table so
  // existing records are always reachable.
  const { data: staffDepts } = await supabase.from("staff").select("department");
  for (const row of staffDepts || []) {
    const dept = String(row.department || "").toUpperCase().trim();
    if (dept && !departments.includes(dept)) departments.push(dept);
  }

  return json({ success: true, departments });
}

// ------------------------------------------------------------------
// LIST — staff records for a department
// ------------------------------------------------------------------

async function handleList(payload: Record<string, unknown>) {
  const department = String(payload.department || "").toUpperCase();

  const { data, error } = await supabase
    .from("staff")
    .select("staff_id, staff_name, email, department, auth_user_id")
    .eq("department", department)
    .order("staff_id", { ascending: true });

  if (error) {
    return json({ success: false, error: "Failed to load staff" }, 500);
  }

  return json({ success: true, staff: data || [] });
}

// ------------------------------------------------------------------
// ADD — validate, de-duplicate, insert into the central staff table.
// The department is always forced from the selected department so an
// admin can never accidentally insert staff into the wrong department.
// ------------------------------------------------------------------

async function handleAdd(payload: Record<string, unknown>) {
  const department = String(payload.department || "").toUpperCase();
  if (!CANONICAL_DEPARTMENTS.includes(department)) {
    return json({ success: false, error: "Invalid department" }, 400);
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length === 0) {
    return json({ success: false, error: "No staff records to import" }, 400);
  }
  if (rows.length > 1000) {
    return json({ success: false, error: "Too many records. Split the file into batches of 1000 or fewer." }, 400);
  }

  // 1. Validate.
  const validRows: { staff_name: string; email: string; department: string }[] = [];
  const skippedInvalid: { email: string; reason: string }[] = [];

  for (const raw of rows) {
    const staffName = normalizeName(raw?.staff_name);
    const email = normalizeEmail(raw?.email);

    if (!staffName) {
      skippedInvalid.push({ email, reason: "Missing staff_name" });
      continue;
    }
    if (!email || !email.includes("@")) {
      skippedInvalid.push({ email, reason: "Missing or invalid email" });
      continue;
    }

    validRows.push({ staff_name: staffName, email, department });
  }

  // 2. De-duplicate within the upload.
  const seenEmails = new Set<string>();
  const deduped: typeof validRows = [];
  for (const row of validRows) {
    const key = row.email.toLowerCase();
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    deduped.push(row);
  }

  // 3. Skip records whose email already exists in the staff table.
  const { data: existing } = await supabase
    .from("staff")
    .select("email")
    .in("email", deduped.map((r) => r.email));

  const existingEmails = new Set(
    (existing || []).map((r) => String(r.email).toLowerCase())
  );

  const toInsert = deduped.filter((r) => !existingEmails.has(r.email.toLowerCase()));
  const skippedExisting = deduped.filter((r) => existingEmails.has(r.email.toLowerCase()));

  // 4. Insert. staff_id is an identity column — the database generates it.
  if (toInsert.length > 0) {
    const { error: insertError } = await supabase.from("staff").insert(toInsert);
    if (insertError) {
      return json(
        { success: false, error: "Failed to insert staff", details: insertError.message },
        500
      );
    }
  }

  return json({
    success: true,
    message: "Staff imported successfully",
    total: rows.length,
    inserted: toInsert.length,
    skippedInvalid: skippedInvalid.length,
    skippedExisting: skippedExisting.length,
    invalid_rows: skippedInvalid,
  });
}

// ------------------------------------------------------------------
// MAIN
// ------------------------------------------------------------------

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return json({ error: "Only POST requests are allowed" }, 405);
    }

    const admin = await resolveAdmin(req);
    if (!admin) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }

    const payload = await req.json().catch(() => ({}));
    const action = String(payload.action || "");

    switch (action) {
      case "meta":
        return await handleMeta();
      case "list":
        return await handleList(payload);
      case "add":
        return await handleAdd(payload);
      default:
        return json({ success: false, error: "Unknown action" }, 400);
    }
  } catch (error) {
    console.error("admin-staff unexpected error:", error);
    return json({ success: false, error: "Internal server error" }, 500);
  }
});
