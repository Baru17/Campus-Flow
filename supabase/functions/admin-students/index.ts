import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// The single administrator identity. Only this Supabase Auth user may use
// these admin operations. The role is stored in app_metadata (set via the
// service role — regular users cannot change it).
const ADMIN_EMAIL = "admin@kiot.ac.in";

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
// IT BATCH TABLES (known batches — the DB is also probed at runtime so
// batches created through the admin UI are always discovered)
// ------------------------------------------------------------------

const IT_STUDENT_TABLES = [
  "it_students_2026_2030",
  "it_students_2025_2029",
  "it_students_2024_2028",
  "it_students_2023_2027",
];

// Template tables used to clone the schema of a brand-new batch.
const TEMPLATE_TABLES = {
  students: "it_students_2024_2028",
  attendance: "it_attendance_2024_2028",
  subjects: "it_subjects_2024_2028",
};

const DEPARTMENT_STUDENT_TABLES: Record<string, string> = {
  CSE: "cse_students",
  ECE: "ece_students",
  EEE: "eee_students",
};

const CANONICAL_DEPARTMENTS = ["IT", "CSE", "ECE", "EEE"];

function getITBatchKey(table: string) {
  return table.replace("it_students_", ""); // e.g. 2024_2028
}

function getITBatchLabel(batchKey: string) {
  const [start, end] = batchKey.split("_");
  return `${start} - ${end}`;
}

/**
 * A batch key must be "YYYY_YYYY" where the end year is the start year + 4.
 * Examples: 2024_2028, 2027_2031.
 */
function isValidITBatchKey(batchKey: string) {
  const match = /^(\d{4})_(\d{4})$/.exec(batchKey);
  if (!match) return false;
  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  return endYear === startYear + 4;
}

// ------------------------------------------------------------------
// DIRECT DATABASE ACCESS (used to discover / create batch tables)
// ------------------------------------------------------------------

async function runDb<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) {
    throw new Error("SUPABASE_DB_URL is not configured");
  }
  const sql = postgres(dbUrl, { prepare: false });
  try {
    return await fn(sql);
  } finally {
    await sql.end().catch(() => {});
  }
}

/** List every existing IT student batch table in the database. */
async function listItBatchTables(): Promise<string[]> {
  return runDb(async (sql) => {
    const rows = await sql.unsafe(
      `select tablename from pg_catalog.pg_tables
       where schemaname = 'public'
         and tablename like 'it\\_students\\_%'`
    );
    return (rows || []).map((row) => String(row.tablename));
  });
}

/** Clone a single batch table from its template. Returns true on success. */
async function ensureBatchTable(
  name: string,
  template: string,
  fullClone: boolean
): Promise<boolean> {
  try {
    await runDb(async (sql) => {
      const withClause = fullClone ? "including all" : "";
      await sql.unsafe(
        `create table if not exists public.${name}
           (like public.${template} ${withClause})`
      );
      await sql.unsafe(`alter table public.${name} enable row level security`);
    });
    return true;
  } catch (error) {
    console.error(
      `${fullClone ? "Full" : "Bare"} clone failed for ${name}:`,
      error
    );
    return false;
  }
}

/**
 * Create the three tables for a brand-new IT batch by cloning the schema
 * of an existing batch, mirroring its security posture:
 *  - it_students_<batch>  (RLS + select-own policy, like all batch tables)
 *  - it_attendance_<batch> (RLS enabled)
 *  - it_subjects_<batch>   (RLS enabled)
 *
 * A full `INCLUDING ALL` clone is attempted first. If that fails (e.g. a
 * constraint/index name collision with the template), the table falls back
 * to a bare schema clone (columns + types + NOT NULL) so the new batch can
 * still be used for student management. Idempotent — safe to call when some
 * tables already exist.
 */
async function ensureItBatchTables(batchKey: string): Promise<{
  students: string;
  attendance: string;
  subjects: string;
}> {
  const defs = [
    { name: `it_students_${batchKey}`, template: TEMPLATE_TABLES.students },
    { name: `it_attendance_${batchKey}`, template: TEMPLATE_TABLES.attendance },
    { name: `it_subjects_${batchKey}`, template: TEMPLATE_TABLES.subjects },
  ];

  const created: Record<string, boolean> = {};
  let anyFailed = false;

  for (const def of defs) {
    if (await ensureBatchTable(def.name, def.template, true)) {
      created[def.name] = true;
    } else if (await ensureBatchTable(def.name, def.template, false)) {
      created[def.name] = true;
      anyFailed = true;
    } else {
      created[def.name] = false;
      anyFailed = true;
    }
  }

  if (created[defs[0].name]) {
    try {
      await runDb(async (sql) => {
        await sql.unsafe(
          `create policy if not exists "it_students_select_own"
             on public.${defs[0].name}
             for select to authenticated
             using (auth_user_id = auth.uid())`
        );
      });
    } catch (error) {
      console.error(`Policy creation failed for ${defs[0].name}:`, error);
    }
  }

  if (!created[defs[0].name]) {
    throw new Error(
      `Failed to create any batch tables for ${batchKey} (students table missing)`
    );
  }

  return {
    students: defs[0].name,
    attendance: defs[1].name,
    subjects: defs[2].name,
  };
}

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
 * app_metadata role must match. Regular students/staff can never pass.
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

async function tableExists(table: string) {
  const { error } = await supabase.from(table).select("year").limit(1);
  return !error;
}

/**
 * Resolve the student table for a department (and batch for IT).
 * For a valid IT batch that does not exist yet, the batch tables are
 * created on demand so the admin can import students into a new batch.
 * Returns null when the department/batch is invalid or cannot be created,
 * otherwise { table, created } where `created` indicates the batch table
 * was just created.
 */
async function resolveStudentTable(department: string, batch: string) {
  const dept = String(department || "").toUpperCase();

  if (dept === "IT") {
    const batchKey = String(batch || "").trim();
    if (!isValidITBatchKey(batchKey)) return null;

    const table = `it_students_${batchKey}`;
    if (IT_STUDENT_TABLES.includes(table) || (await tableExists(table))) {
      return { table, created: false };
    }

    try {
      await ensureItBatchTables(batchKey);
      return { table, created: true };
    } catch (error) {
      console.error("Failed to create IT batch tables:", error);
      throw new Error(
        `Failed to create batch tables for ${batchKey}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const table = DEPARTMENT_STUDENT_TABLES[dept];
  return table ? { table, created: false } : null;
}

function normalizeStudentId(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeSection(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeRegisterNo(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeName(value: unknown) {
  return String(value ?? "").trim();
}

// ------------------------------------------------------------------
// META — available departments + IT batches derived from the DB
// ------------------------------------------------------------------

async function handleMeta() {
  const departments: string[] = [];
  const itBatches: { key: string; label: string; table: string }[] = [];
  const seenBatchKeys = new Set<string>();

  // 1. Discover batch tables directly from the database so batches created
  //    through the admin UI (or elsewhere) always show up.
  let dbTables: string[] = [];
  try {
    dbTables = await listItBatchTables();
  } catch (error) {
    console.error("Failed to list IT batch tables from DB:", error);
  }

  for (const table of dbTables) {
    const key = getITBatchKey(table);
    if (!isValidITBatchKey(key)) continue;
    if (seenBatchKeys.has(key)) continue;
    seenBatchKeys.add(key);
    itBatches.push({ key, label: getITBatchLabel(key), table });
  }

  // 2. Fall back to / merge in the known batch list.
  for (const table of IT_STUDENT_TABLES) {
    const key = getITBatchKey(table);
    if (seenBatchKeys.has(key)) continue;
    if (await tableExists(table)) {
      seenBatchKeys.add(key);
      itBatches.push({ key, label: getITBatchLabel(key), table });
    }
  }

  itBatches.sort((a, b) => a.key.localeCompare(b.key));

  if (itBatches.length > 0) departments.push("IT");
  for (const dept of ["CSE", "ECE", "EEE"]) {
    if (await tableExists(DEPARTMENT_STUDENT_TABLES[dept])) departments.push(dept);
  }

  // Include departments that exist in the central staff table too.
  const { data: staffDepts } = await supabase.from("staff").select("department");
  for (const row of staffDepts || []) {
    const dept = String(row.department || "").toUpperCase().trim();
    if (dept && CANONICAL_DEPARTMENTS.includes(dept) && !departments.includes(dept)) {
      departments.push(dept);
    }
  }

  departments.sort((a, b) => CANONICAL_DEPARTMENTS.indexOf(a) - CANONICAL_DEPARTMENTS.indexOf(b));

  return json({
    success: true,
    departments,
    it_batches: itBatches,
  });
}

// ------------------------------------------------------------------
// LIST — students of a department (and batch for IT)
// ------------------------------------------------------------------

async function handleList(payload: Record<string, unknown>) {
  const department = String(payload.department || "").toUpperCase();
  const batch = String(payload.batch || "");
  const resolved = await resolveStudentTable(department, batch);

  if (!resolved) {
    return json({ success: false, error: "Invalid department or batch" }, 400);
  }

  const { table } = resolved;
  const { data, error } = await supabase
    .from(table)
    .select("student_id, register_no, student_name, year, section, email")
    .order("register_no", { ascending: true });

  if (error) {
    return json({ success: false, error: "Failed to load students" }, 500);
  }

  return json({ success: true, students: data || [] });
}

// ------------------------------------------------------------------
// ADD — validate, de-duplicate against the target table, insert.
// A brand-new IT batch is created on the fly.
// ------------------------------------------------------------------

async function handleAdd(payload: Record<string, unknown>) {
  const department = String(payload.department || "").toUpperCase();
  const batch = String(payload.batch || "");
  const resolved = await resolveStudentTable(department, batch);

  if (!resolved) {
    return json({ success: false, error: "Invalid department or batch" }, 400);
  }

  const { table, created: tableCreated } = resolved;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  if (rows.length === 0) {
    return json({ success: false, error: "No student records to import" }, 400);
  }

  if (rows.length > 1000) {
    return json({ success: false, error: "Too many records. Split the file into batches of 1000 or fewer." }, 400);
  }

  // 1. Validate rows client-side equivalent (server is authoritative).
  const validRows: {
    student_id: string;
    register_no: string;
    student_name: string;
    year: number;
    section: string;
    email?: string;
  }[] = [];
  const skippedInvalid: { student_id: string; reason: string }[] = [];

  for (const raw of rows) {
    const studentId = normalizeStudentId(raw?.student_id);
    const registerNo = normalizeRegisterNo(raw?.register_no);
    const studentName = normalizeName(raw?.student_name);
    const section = normalizeSection(raw?.section);
    const year = Number(raw?.year);

    if (!studentId) {
      skippedInvalid.push({ student_id: "", reason: "Missing student_id" });
      continue;
    }
    if (!registerNo) {
      skippedInvalid.push({ student_id: studentId, reason: "Missing register_no" });
      continue;
    }
    if (!studentName) {
      skippedInvalid.push({ student_id: studentId, reason: "Missing student_name" });
      continue;
    }
    if (!Number.isInteger(year) || year < 1 || year > 4) {
      skippedInvalid.push({ student_id: studentId, reason: `Invalid year: ${String(raw?.year)}` });
      continue;
    }
    if (!section) {
      skippedInvalid.push({ student_id: studentId, reason: "Missing section" });
      continue;
    }

    const email = String(raw?.email ?? "").trim() || undefined;
    validRows.push({ student_id: studentId, register_no: registerNo, student_name: studentName, year, section, email });
  }

  // 2. De-duplicate within the upload.
  const seenStudentIds = new Set<string>();
  const seenRegisterNos = new Set<string>();
  const deduped: typeof validRows = [];

  for (const row of validRows) {
    const sidKey = row.student_id.toLowerCase();
    const regKey = row.register_no.toLowerCase();
    if (seenStudentIds.has(sidKey) || seenRegisterNos.has(regKey)) continue;
    seenStudentIds.add(sidKey);
    seenRegisterNos.add(regKey);
    deduped.push(row);
  }

  // 3. Check the target table for records that already exist.
  const existingStudentIds = new Set<string>();
  const existingRegisterNos = new Set<string>();

  const sidValues = deduped.map((r) => r.student_id);
  const regValues = deduped.map((r) => r.register_no);

  const { data: existingBySid } = await supabase
    .from(table)
    .select("student_id")
    .in("student_id", sidValues);

  for (const row of existingBySid || []) {
    existingStudentIds.add(String(row.student_id).toLowerCase());
  }

  const { data: existingByReg } = await supabase
    .from(table)
    .select("register_no")
    .in("register_no", regValues);

  for (const row of existingByReg || []) {
    existingRegisterNos.add(String(row.register_no).toLowerCase());
  }

  // 4. Keep only brand-new records.
  const toInsert: typeof deduped = [];
  const skippedExisting: { student_id: string; register_no: string }[] = [];

  for (const row of deduped) {
    if (
      existingStudentIds.has(row.student_id.toLowerCase()) ||
      existingRegisterNos.has(row.register_no.toLowerCase())
    ) {
      skippedExisting.push({ student_id: row.student_id, register_no: row.register_no });
    } else {
      toInsert.push(row);
    }
  }

  // 5. Insert.
  if (toInsert.length > 0) {
    const { error: insertError } = await supabase.from(table).insert(toInsert);
    if (insertError) {
      return json(
        { success: false, error: "Failed to insert students", details: insertError.message },
        500
      );
    }
  }

  // Report whether this was a brand-new batch table.
  const batchKey = department === "IT" ? String(batch || "").trim() : null;

  return json({
    success: true,
    message: "Students imported successfully",
    total: rows.length,
    inserted: toInsert.length,
    skippedInvalid: skippedInvalid.length,
    skippedExisting: skippedExisting.length,
    skipped_existing_rows: skippedExisting,
    invalid_rows: skippedInvalid,
    department,
    batch: batchKey,
    table_created: tableCreated,
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

    // Administrator-only.
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
    console.error("admin-students unexpected error:", error);
    return json(
      {
        success: false,
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});