import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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

const ADMIN_EMAIL = "admin@kiot.ac.in";
const CANONICAL_DEPARTMENTS = ["IT", "CSE", "ECE", "EEE"];
const STAFF_AUTH_EMAIL_DOMAIN = "kiot.ac.in";
const INITIAL_STAFF_PASSWORD =
  Deno.env.get("INITIAL_STAFF_PASSWORD") || "1234";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

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

async function handleMeta() {
  const departments = [...CANONICAL_DEPARTMENTS];
  const { data: staffDepts } = await supabase.from("staff").select("department");
  for (const row of staffDepts || []) {
    const dept = String(row.department || "").toUpperCase().trim();
    if (dept && !departments.includes(dept)) departments.push(dept);
  }
  return json({ success: true, departments });
}

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

async function mapAuthUserIdsByEmail(emails: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(emails.map((email) => email.toLowerCase()))];
  if (unique.length === 0) return new Map();
  const result = await runDb(async (sql) => {
    const rows = await sql.unsafe(
      `select lower(email::text) as email, id::text as id
         from auth.users
        where lower(email::text) = any($1::text[])`,
      [unique]
    );
    const map = new Map<string, string>();
    for (const row of rows || []) {
      map.set(String(row.email).toLowerCase(), String(row.id));
    }
    return map;
  });
  return result;
}

async function ensureStaffAuthAccount(
  email: string,
  staffId: number,
  department: string
): Promise<{ status: "created" | "existing" | null; userId: string | null; reason?: string }> {
  try {
    let userId = await mapAuthUserIdsByEmail([email]).then(m => m.get(email)) ?? null;
    let status: "created" | "existing" | null = userId ? "existing" : null;

    if (!userId) {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password: INITIAL_STAFF_PASSWORD,
        email_confirm: true,
        user_metadata: {
          staff_id: staffId,
          role: "staff",
          department,
        },
        app_metadata: {
          role: "staff",
        },
      });

      if (error) {
        const message = String(error.message || "").toLowerCase();
        if (message.includes("already") || message.includes("exists")) {
          const found = await mapAuthUserIdsByEmail([email]);
          userId = found.get(email) ?? null;
          if (!userId) {
            return { status: null, userId: null, reason: "Auth account already exists but could not be resolved" };
          }
          status = "existing";
        } else {
          return { status: null, userId: null, reason: error.message };
        }
      } else {
        userId = data.user.id;
        status = "created";
      }
    }

    return { status, userId };
  } catch (error) {
    return { status: null, userId: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

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

  const seenEmails = new Set<string>();
  const deduped: typeof validRows = [];
  for (const row of validRows) {
    const key = row.email.toLowerCase();
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    deduped.push(row);
  }

  const { data: existing } = await supabase
    .from("staff")
    .select("email")
    .in("email", deduped.map((r) => r.email));

  const existingEmails = new Set(
    (existing || []).map((r) => String(r.email).toLowerCase())
  );

  const toInsert = deduped.filter((r) => !existingEmails.has(r.email.toLowerCase()));
  const skippedExisting = deduped.filter((r) => existingEmails.has(r.email.toLowerCase()));

  if (toInsert.length > 0) {
    const { data: insertedData, error: insertError } = await supabase
      .from("staff")
      .insert(toInsert)
      .select("staff_id, email, department");
    if (insertError) {
      return json(
        { success: false, error: "Failed to insert staff", details: insertError.message },
        500
      );
    }
    if (!insertedData || insertedData.length === 0) {
      return json(
        { success: false, error: "Staff insertion returned no records" },
        500
      );
    }

    // Auth provisioning for newly inserted staff records.
    let authCreated = 0;
    let authLinkedExisting = 0;
    let authFailed = 0;
    const authFailures: { email: string; reason: string }[] = [];

    for (const record of insertedData) {
      const email = String(record.email).toLowerCase();
      const staffId = Number(record.staff_id);
      const dept = String(record.department || department);

      const result = await ensureStaffAuthAccount(email, staffId, dept);

      if (result.userId) {
        const { error: linkError } = await supabase
          .from("staff")
          .update({ auth_user_id: result.userId })
          .eq("staff_id", staffId);

        if (linkError) {
          console.error(`Failed to link auth_user_id for staff_id ${staffId}:`, linkError.message);
          authFailed++;
          authFailures.push({ email, reason: `Auth created but linking to staff table failed: ${linkError.message}` });
          continue;
        }

        if (result.status === "created") authCreated++;
        else authLinkedExisting++;
      } else {
        authFailed++;
        authFailures.push({ email, reason: result.reason || "Unknown Auth failure" });
      }
    }

    // Backfill auth linking for pre-existing staff records that lack auth_user_id.
    if (skippedExisting.length > 0) {
      const { data: backfillRows, error: backfillError } = await supabase
        .from("staff")
        .select("staff_id, email, auth_user_id")
        .in("email", skippedExisting.map((r) => r.email));

      if (!backfillError && backfillRows && backfillRows.length > 0) {
        for (const row of backfillRows) {
          if (!row.auth_user_id) {
            const result = await ensureStaffAuthAccount(
              String(row.email).toLowerCase(),
              Number(row.staff_id),
              department
            );
            if (result.userId) {
              const { error: linkError } = await supabase
                .from("staff")
                .update({ auth_user_id: result.userId })
                .eq("staff_id", Number(row.staff_id));
              if (!linkError) {
                if (result.status === "created") authCreated++;
                else authLinkedExisting++;
              }
            }
          }
        }
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
      auth_accounts_created: authCreated,
      auth_linked_existing: authLinkedExisting,
      auth_failed: authFailed,
      auth_failures: authFailures,
    });
  }

  // No new staff to insert, but still backfill auth for existing records.
  if (skippedExisting.length > 0) {
    const { data: backfillRows, error: backfillError } = await supabase
      .from("staff")
      .select("staff_id, email, auth_user_id")
      .in("email", skippedExisting.map((r) => r.email));

    let authCreated = 0;
    let authLinkedExisting = 0;
    const authFailures: { email: string; reason: string }[] = [];

    if (!backfillError && backfillRows && backfillRows.length > 0) {
      for (const row of backfillRows) {
        if (!row.auth_user_id) {
          const result = await ensureStaffAuthAccount(
            String(row.email).toLowerCase(),
            Number(row.staff_id),
            department
          );
          if (result.userId) {
            const { error: linkError } = await supabase
              .from("staff")
              .update({ auth_user_id: result.userId })
              .eq("staff_id", Number(row.staff_id));
            if (!linkError) {
              if (result.status === "created") authCreated++;
              else authLinkedExisting++;
            }
          }
        }
      }
    }

    return json({
      success: true,
      message: "Staff imported successfully",
      total: rows.length,
      inserted: 0,
      skippedInvalid: skippedInvalid.length,
      skippedExisting: skippedExisting.length,
      invalid_rows: skippedInvalid,
      auth_accounts_created: authCreated,
      auth_linked_existing: authLinkedExisting,
      auth_failed: authFailed,
      auth_failures: authFailures,
    });
  }

  return json({
    success: true,
    message: "Staff imported successfully",
    total: rows.length,
    inserted: 0,
    skippedInvalid: skippedInvalid.length,
    skippedExisting: skippedExisting.length,
    invalid_rows: skippedInvalid,
    auth_accounts_created: 0,
    auth_linked_existing: 0,
    auth_failed: 0,
    auth_failures: [],
  });
}

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
