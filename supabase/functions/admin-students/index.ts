import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const ADMIN_EMAIL = "admin@kiot.ac.in";

const STUDENT_AUTH_EMAIL_DOMAIN = "kiot.ac.in";
const INITIAL_STUDENT_PASSWORD =
  Deno.env.get("INITIAL_STUDENT_PASSWORD") || "1234";

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
// DEPARTMENTS & BATCH HELPERS (generic for all departments)
// ------------------------------------------------------------------

const CANONICAL_DEPARTMENTS = ["IT", "CSE", "ECE", "EEE"];

/**
 * Build a table name: {dept_lower}_{entity}_{batch}
 * e.g. getTableName("IT", "students", "2027_2031") => "it_students_2027_2031"
 */
function getTableName(
  department: string,
  entity: string,
  batchKey: string
): string {
  return `${department.toLowerCase()}_${entity}_${batchKey}`;
}

/**
 * A batch key must be "YYYY_YYYY" where end year = start year + 4.
 */
function isValidBatchKey(batchKey: string): boolean {
  const match = /^(\d{4})_(\d{4})$/.exec(batchKey);
  if (!match) return false;
  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  return endYear === startYear + 4;
}

function getBatchLabel(batchKey: string): string {
  const [start, end] = batchKey.split("_");
  return `${start} - ${end}`;
}

function getDepartmentBatchTables(
  department: string,
  batchKey: string
): { students: string; attendance: string; subjects: string } {
  return {
    students: getTableName(department, "students", batchKey),
    attendance: getTableName(department, "attendance", batchKey),
    subjects: getTableName(department, "subjects", batchKey),
  };
}

// Template tables used to clone the schema of a brand-new batch.
// All departments use the same schema (cloned from IT 2024_2028 templates).
const TEMPLATE_TABLES = {
  students: "it_students_2024_2028",
  attendance: "it_attendance_2024_2028",
  subjects: "it_subjects_2024_2028",
};

// Legacy non-batch tables for backward compatibility with CSE/ECE/EEE.
const LEGACY_DEPARTMENT_TABLES: Record<string, string> = {
  CSE: "cse_students",
  ECE: "ece_students",
  EEE: "eee_students",
};

// ------------------------------------------------------------------
// DIRECT DATABASE ACCESS (used to discover / create batch tables)
// ------------------------------------------------------------------

async function runDb<T>(
  fn: (sql: ReturnType<typeof postgres>) => Promise<T>
): Promise<T> {
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

/**
 * List every existing student batch table for a given department.
 * e.g. for IT: it_students_2023_2027, it_students_2024_2028, ...
 * e.g. for CSE: cse_students_2024_2028, ...
 */
async function listBatchTables(department: string): Promise<string[]> {
  const prefix = `${department.toLowerCase()}_students_`;
  return runDb(async (sql) => {
    const rows = await sql.unsafe(
      `select tablename from pg_catalog.pg_tables
       where schemaname = 'public'
         and tablename like '${prefix}%'`
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
      await sql.unsafe(
        `alter table public.${name} enable row level security`
      );
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
 * Ensure the subject_id column in a subject table has a sequence/identity
 * so that INSERT without subject_id works (auto-generates the ID).
 *
 * This fixes the ERROR: 23502 "null value in column subject_id" issue
 * that occurs when the template table was cloned without preserving the
 * sequence.
 */
async function ensureSubjectIdIdentity(
  subjectTable: string
): Promise<void> {
  try {
    await runDb(async (sql) => {
      // Check if the column already has a default (sequence).
      const rows = await sql.unsafe(
        `select pg_get_serial_sequence('public.${subjectTable}', 'subject_id') as seq`
      );
      const seq = rows?.[0]?.seq;
      if (seq) return; // Already has a sequence.

      // Create a sequence and set it as the column default.
      const seqName = `${subjectTable}_subject_id_seq`;
      await sql.unsafe(
        `create sequence if not exists public.${seqName}`
      );
      await sql.unsafe(
        `alter table public.${subjectTable}
           alter column subject_id
           set default nextval('public.${seqName}')`
      );
      // Set the sequence ownership so it drops with the table.
      await sql.unsafe(
        `alter sequence public.${seqName}
           owned by public.${subjectTable}.subject_id`
      );
    });
  } catch (error) {
    console.error(
      `Failed to ensure subject_id identity on ${subjectTable}:`,
      error
    );
  }
}

/**
 * Create the three tables for a brand-new batch by cloning the schema
 * of an existing batch, mirroring its security posture:
 *  - {dept}_students_{batch}  (RLS + select-own policy)
 *  - {dept}_attendance_{batch} (RLS enabled)
 *  - {dept}_subjects_{batch}   (RLS enabled + subject_id identity ensured)
 */
async function ensureBatchTables(
  department: string,
  batchKey: string
): Promise<{ students: string; attendance: string; subjects: string }> {
  const tables = getDepartmentBatchTables(department, batchKey);

  const defs = [
    { name: tables.students, template: TEMPLATE_TABLES.students },
    { name: tables.attendance, template: TEMPLATE_TABLES.attendance },
    { name: tables.subjects, template: TEMPLATE_TABLES.subjects },
  ];

  const created: Record<string, boolean> = {};

  for (const def of defs) {
    if (await ensureBatchTable(def.name, def.template, true)) {
      created[def.name] = true;
    } else if (await ensureBatchTable(def.name, def.template, false)) {
      created[def.name] = true;
    } else {
      created[def.name] = false;
    }
  }

  // Ensure subject_id has an identity/sequence in the new subjects table.
  if (created[tables.subjects]) {
    await ensureSubjectIdIdentity(tables.subjects);
  }

  // Ensure the students table has a select-own RLS policy.
  if (created[tables.students]) {
    const policyName = `${department.toLowerCase()}_students_select_own`;
    try {
      await runDb(async (sql) => {
        await sql.unsafe(
          `drop policy if exists "${policyName}" on public.${tables.students}`
        );
        await sql.unsafe(
          `create policy "${policyName}"
             on public.${tables.students}
             for select to authenticated
             using (auth_user_id = auth.uid())`
        );
      });
    } catch (error) {
      console.error(`Policy creation failed for ${tables.students}:`, error);
    }
  }

  if (!created[tables.students]) {
    throw new Error(
      `Failed to create batch tables for ${department} ${batchKey} (students table missing)`
    );
  }

  return tables;
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
 * Resolve the student table for a department + batch.
 * For any valid department, if the batch tables don't exist yet, they are
 * created on demand so the admin can import students into a new batch.
 * Returns null when the department/batch is invalid or cannot be created.
 */
async function resolveStudentTable(
  department: string,
  batch: string
): Promise<{ table: string; created: boolean } | null> {
  const dept = String(department || "").toUpperCase();
  if (!CANONICAL_DEPARTMENTS.includes(dept)) return null;

  const batchKey = String(batch || "").trim();
  if (!isValidBatchKey(batchKey)) return null;

  const tables = getDepartmentBatchTables(dept, batchKey);
  const studentTable = tables.students;

  if (await tableExists(studentTable)) {
    return { table: studentTable, created: false };
  }

  try {
    await ensureBatchTables(dept, batchKey);
    return { table: studentTable, created: true };
  } catch (error) {
    console.error(`Failed to create ${dept} batch tables:`, error);
    throw new Error(
      `Failed to create batch tables for ${dept} ${batchKey}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Resolve the subjects table for a department + batch.
 * Creates the table if it doesn't exist.
 */
async function resolveSubjectsTable(
  department: string,
  batch: string
): Promise<{ table: string; created: boolean } | null> {
  const dept = String(department || "").toUpperCase();
  if (!CANONICAL_DEPARTMENTS.includes(dept)) return null;

  const batchKey = String(batch || "").trim();
  if (!isValidBatchKey(batchKey)) return null;

  const tables = getDepartmentBatchTables(dept, batchKey);
  const subjectTable = tables.subjects;

  if (await tableExists(subjectTable)) {
    return { table: subjectTable, created: false };
  }

  try {
    await ensureBatchTables(dept, batchKey);
    return { table: subjectTable, created: true };
  } catch (error) {
    console.error(`Failed to create ${dept} batch tables:`, error);
    return null;
  }
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
// STUDENT AUTH PROVISIONING
// ------------------------------------------------------------------

function studentAuthEmail(studentId: string) {
  return `${studentId.toLowerCase()}@${STUDENT_AUTH_EMAIL_DOMAIN}`;
}

async function ensureSelectOwnPolicy(table: string) {
  try {
    await runDb(async (sql) => {
      // Derive a policy name from the table name.
      const policyName = `${table.replace(/[^a-z0-9]/g, "_")}_select_own`;
      await sql.unsafe(
        `drop policy if exists "${policyName}" on public.${table}`
      );
      await sql.unsafe(
        `create policy "${policyName}"
           on public.${table}
           for select to authenticated
           using (auth_user_id = auth.uid())`
      );
    });
  } catch (error) {
    console.error(`Failed to ensure select policy on ${table}:`, error);
  }
}

async function mapAuthUserIdsByEmail(
  emails: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(emails.map((email) => email.toLowerCase()))];
  if (unique.length === 0) return new Map();

  return runDb(async (sql) => {
    const result = await sql.unsafe(
      `select lower(email::text) as email, id::text as id
         from auth.users
        where lower(email::text) = any($1::text[])`,
      [unique]
    );
    const map = new Map<string, string>();
    for (const row of result || []) {
      map.set(String(row.email).toLowerCase(), String(row.id));
    }
    return map;
  });
}

async function provisionStudentAuthAccounts(
  table: string,
  department: string,
  rows: { student_id: string }[]
): Promise<{
  created: number;
  linked_existing: number;
  failed: number;
  failures: { student_id: string; reason: string }[];
}> {
  const stats = { created: 0, linked_existing: 0, failed: 0 };
  const failures: { student_id: string; reason: string }[] = [];

  let existingUsers = new Map<string, string>();
  try {
    existingUsers = await mapAuthUserIdsByEmail(
      rows.map((row) => studentAuthEmail(row.student_id))
    );
  } catch (error) {
    console.error("Auth pre-lookup failed:", error);
  }

  let index = 0;
  const CONCURRENCY = 8;

  async function worker() {
    while (index < rows.length) {
      const row = rows[index++];
      const email = studentAuthEmail(row.student_id);

      try {
        let userId = existingUsers.get(email) ?? null;
        let status: "created" | "existing" | null = userId
          ? "existing"
          : null;

        if (!userId) {
          const { data, error } = await supabase.auth.admin.createUser({
            email,
            password: INITIAL_STUDENT_PASSWORD,
            email_confirm: true,
            user_metadata: {
              student_id: row.student_id,
              role: "student",
              department,
            },
            app_metadata: {
              role: "student",
              student_table: table,
            },
          });

          if (error) {
            const message = String(error.message || "").toLowerCase();
            if (message.includes("already") || message.includes("exists")) {
              try {
                userId =
                  (await mapAuthUserIdsByEmail([email])).get(email) ?? null;
              } catch {
                userId = null;
              }
              if (!userId) {
                stats.failed++;
                failures.push({
                  student_id: row.student_id,
                  reason:
                    "Auth account already exists but could not be resolved",
                });
                continue;
              }
            } else {
              stats.failed++;
              failures.push({
                student_id: row.student_id,
                reason: error.message,
              });
              continue;
            }
          } else {
            userId = data.user.id;
            status = "created";
          }
        }

        const { error: linkError } = await supabase
          .from(table)
          .update({ auth_user_id: userId })
          .eq("student_id", row.student_id);

        if (linkError) {
          stats.failed++;
          failures.push({
            student_id: row.student_id,
            reason: `Auth created but linking to ${table} failed: ${linkError.message}`,
          });
          continue;
        }

        if (status === "created") stats.created++;
        else stats.linked_existing++;

        if (status === "existing" && userId) {
          try {
            await supabase.auth.admin.updateUserById(userId, {
              app_metadata: { role: "student", student_table: table },
            });
          } catch (error) {
            console.error("Failed to stamp routing metadata:", error);
          }
        }
      } catch (error) {
        stats.failed++;
        failures.push({
          student_id: row.student_id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker())
  );

  return { ...stats, failures };
}

// ------------------------------------------------------------------
// META — available departments + batch lists derived from the DB
// ------------------------------------------------------------------

async function handleMeta() {
  const departments: string[] = [];
  const batchesByDept: Record<
    string,
    { key: string; label: string; table: string }[]
  > = {};

  for (const dept of CANONICAL_DEPARTMENTS) {
    const seenBatchKeys = new Set<string>();
    const deptBatches: { key: string; label: string; table: string }[] = [];

    // 1. Discover batch tables from the database.
    let dbTables: string[] = [];
    try {
      dbTables = await listBatchTables(dept);
    } catch (error) {
      console.error(`Failed to list ${dept} batch tables from DB:`, error);
    }

    for (const table of dbTables) {
      const prefix = `${dept.toLowerCase()}_students_`;
      const key = table.replace(prefix, "");
      if (!isValidBatchKey(key)) continue;
      if (seenBatchKeys.has(key)) continue;
      seenBatchKeys.add(key);
      deptBatches.push({ key, label: getBatchLabel(key), table });
    }

    // 2. Check legacy non-batch table for CSE/ECE/EEE.
    const legacyTable = LEGACY_DEPARTMENT_TABLES[dept];
    if (legacyTable && (await tableExists(legacyTable))) {
      // Legacy tables don't have a batch key — represent as a special entry.
      // Only show if no batch tables exist for this department.
      if (deptBatches.length === 0) {
        departments.push(dept);
      }
    }

    deptBatches.sort((a, b) => a.key.localeCompare(b.key));

    if (deptBatches.length > 0 || legacyTable) {
      if (!departments.includes(dept)) departments.push(dept);
    }

    batchesByDept[dept] = deptBatches;
  }

  // Include departments that exist in the central staff table too.
  const { data: staffDepts } = await supabase
    .from("staff")
    .select("department");
  for (const row of staffDepts || []) {
    const dept = String(row.department || "").toUpperCase().trim();
    if (
      dept &&
      CANONICAL_DEPARTMENTS.includes(dept) &&
      !departments.includes(dept)
    ) {
      departments.push(dept);
    }
  }

  departments.sort(
    (a, b) => CANONICAL_DEPARTMENTS.indexOf(a) - CANONICAL_DEPARTMENTS.indexOf(b)
  );

  return json({
    success: true,
    departments,
    batches_by_dept: batchesByDept,
  });
}

// ------------------------------------------------------------------
// LIST — students of a department + batch
// ------------------------------------------------------------------

async function handleList(payload: Record<string, unknown>) {
  const department = String(payload.department || "").toUpperCase();
  const batch = String(payload.batch || "");
  const resolved = await resolveStudentTable(department, batch);

  if (!resolved) {
    return json(
      { success: false, error: "Invalid department or batch" },
      400
    );
  }

  const { table } = resolved;
  const { data, error } = await supabase
    .from(table)
    .select("student_id, register_no, student_name, year, section, email")
    .order("register_no", { ascending: true });

  if (error) {
    return json(
      { success: false, error: "Failed to load students" },
      500
    );
  }

  return json({ success: true, students: data || [] });
}

// ------------------------------------------------------------------
// ADD — validate, de-duplicate, insert students.
// A brand-new batch is created on the fly for any department.
// ------------------------------------------------------------------

async function handleAdd(payload: Record<string, unknown>) {
  const department = String(payload.department || "").toUpperCase();
  const batch = String(payload.batch || "");
  const resolved = await resolveStudentTable(department, batch);

  if (!resolved) {
    return json(
      { success: false, error: "Invalid department or batch" },
      400
    );
  }

  const { table, created: tableCreated } = resolved;
  await ensureSelectOwnPolicy(table);
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  if (rows.length === 0) {
    return json(
      { success: false, error: "No student records to import" },
      400
    );
  }

  if (rows.length > 1000) {
    return json(
      {
        success: false,
        error: "Too many records. Split the file into batches of 1000 or fewer.",
      },
      400
    );
  }

  // 1. Validate rows server-side.
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
      skippedInvalid.push({
        student_id: studentId,
        reason: "Missing register_no",
      });
      continue;
    }
    if (!studentName) {
      skippedInvalid.push({
        student_id: studentId,
        reason: "Missing student_name",
      });
      continue;
    }
    if (!Number.isInteger(year) || year < 1 || year > 4) {
      skippedInvalid.push({
        student_id: studentId,
        reason: `Invalid year: ${String(raw?.year)}`,
      });
      continue;
    }
    if (!section) {
      skippedInvalid.push({
        student_id: studentId,
        reason: "Missing section",
      });
      continue;
    }

    const email =
      String(raw?.email ?? "").trim() || undefined;
    validRows.push({
      student_id: studentId,
      register_no: registerNo,
      student_name: studentName,
      year,
      section,
      email,
    });
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
  const skippedExisting: {
    student_id: string;
    register_no: string;
  }[] = [];

  for (const row of deduped) {
    if (
      existingStudentIds.has(row.student_id.toLowerCase()) ||
      existingRegisterNos.has(row.register_no.toLowerCase())
    ) {
      skippedExisting.push({
        student_id: row.student_id,
        register_no: row.register_no,
      });
    } else {
      toInsert.push(row);
    }
  }

  // 5. Insert.
  if (toInsert.length > 0) {
    const { error: insertError } = await supabase
      .from(table)
      .insert(toInsert);
    if (insertError) {
      return json(
        {
          success: false,
          error: "Failed to insert students",
          details: insertError.message,
        },
        500
      );
    }
  }

  // 6. Provision auth accounts.
  const auth = {
    created: 0,
    linked_existing: 0,
    backfilled: 0,
    failed: 0,
    failures: [] as { student_id: string; reason: string }[],
  };

  const groups: {
    kind: "new" | "backfill";
    rows: { student_id: string; auth_user_id?: string | null }[];
  }[] = [{ kind: "new", rows: toInsert }];

  if (skippedExisting.length > 0) {
    const existingIds = skippedExisting.map((row) => row.student_id);
    const { data: backfillRows, error: backfillError } = await supabase
      .from(table)
      .select("student_id, auth_user_id")
      .in("student_id", existingIds);
    if (!backfillError && backfillRows && backfillRows.length > 0) {
      groups.push({ kind: "backfill", rows: backfillRows });
    }
  }

  for (const group of groups) {
    if (group.rows.length === 0) continue;
    try {
      const result = await provisionStudentAuthAccounts(
        table,
        department,
        group.rows
      );
      auth.created += result.created;
      auth.linked_existing += result.linked_existing;
      auth.failed += result.failed;
      auth.failures.push(...result.failures);
      if (group.kind === "backfill") {
        auth.backfilled += result.created + result.linked_existing;
      }
    } catch (error) {
      console.error("Student auth provisioning failed:", error);
      auth.failed += group.rows.length;
      auth.failures.push({
        student_id: "",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return json({
    success: true,
    message: "Students imported successfully",
    total: rows.length,
    inserted: toInsert.length,
    skippedInvalid: skippedInvalid.length,
    skippedExisting: skippedExisting.length,
    skipped_existing_rows: skippedExisting,
    invalid_rows: skippedInvalid,
    auth_accounts_created: auth.created,
    auth_linked_existing: auth.linked_existing,
    auth_backfilled: auth.backfilled,
    auth_failed: auth.failed,
    auth_failures: auth.failures,
    department,
    batch,
    table_created: tableCreated,
  });
}

// ------------------------------------------------------------------
// LIST-SUBJECTS — list subjects for a department + batch
// ------------------------------------------------------------------

async function handleListSubjects(payload: Record<string, unknown>) {
  const department = String(payload.department || "").toUpperCase();
  const batch = String(payload.batch || "").trim();
  const year = payload.year != null ? Number(payload.year) : null;
  const section = payload.section
    ? String(payload.section).toUpperCase().trim()
    : null;

  if (!CANONICAL_DEPARTMENTS.includes(department)) {
    return json({ success: false, error: "Invalid department" }, 400);
  }
  if (!isValidBatchKey(batch)) {
    return json({ success: false, error: "Invalid batch key" }, 400);
  }

  const resolved = await resolveSubjectsTable(department, batch);
  if (!resolved) {
    return json(
      { success: false, error: "Could not resolve subjects table" },
      500
    );
  }

  let query = supabase
    .from(resolved.table)
    .select("subject_id, subject_code, subject_name, year, section")
    .order("subject_code", { ascending: true });

  if (year != null && Number.isInteger(year)) {
    query = query.eq("year", year);
  }
  if (section) {
    query = query.eq("section", section);
  }

  const { data, error } = await query;

  if (error) {
    return json(
      { success: false, error: "Failed to load subjects", details: error.message },
      500
    );
  }

  return json({ success: true, subjects: data || [] });
}

// ------------------------------------------------------------------
// ADD-SUBJECTS — insert subjects into a batch subject table
// ------------------------------------------------------------------

async function handleAddSubjects(payload: Record<string, unknown>) {
  const department = String(payload.department || "").toUpperCase();
  const batch = String(payload.batch || "").trim();

  if (!CANONICAL_DEPARTMENTS.includes(department)) {
    return json({ success: false, error: "Invalid department" }, 400);
  }
  if (!isValidBatchKey(batch)) {
    return json({ success: false, error: "Invalid batch key" }, 400);
  }

  const rawSubjects = Array.isArray(payload.subjects) ? payload.subjects : [];
  if (rawSubjects.length === 0) {
    return json(
      { success: false, error: "No subjects to add" },
      400
    );
  }

  if (rawSubjects.length > 50) {
    return json(
      { success: false, error: "Too many subjects. Maximum 50 per batch." },
      400
    );
  }

  // Resolve/create the subjects table.
  const resolved = await resolveSubjectsTable(department, batch);
  if (!resolved) {
    return json(
      { success: false, error: "Could not resolve subjects table" },
      500
    );
  }

  // Validate and normalize subjects.
  const validSubjects: {
    subject_code: string;
    subject_name: string;
    year: number;
    section: string;
  }[] = [];
  const skippedInvalid: { subject_code: string; reason: string }[] = [];

  for (const raw of rawSubjects) {
    const code = String(raw?.subject_code || "")
      .trim()
      .toUpperCase();
    const name = String(raw?.subject_name || "").trim();
    const year = Number(raw?.year);
    const section = String(raw?.section || "")
      .trim()
      .toUpperCase();

    if (!code) {
      skippedInvalid.push({
        subject_code: "",
        reason: "Missing subject_code",
      });
      continue;
    }
    if (!name) {
      skippedInvalid.push({
        subject_code: code,
        reason: "Missing subject_name",
      });
      continue;
    }
    if (!Number.isInteger(year) || year < 1 || year > 4) {
      skippedInvalid.push({
        subject_code: code,
        reason: `Invalid year: ${String(raw?.year)}`,
      });
      continue;
    }
    if (!section) {
      skippedInvalid.push({
        subject_code: code,
        reason: "Missing section",
      });
      continue;
    }

    validSubjects.push({
      subject_code: code,
      subject_name: name,
      year,
      section,
    });
  }

  if (validSubjects.length === 0) {
    return json(
      {
        success: false,
        error: "All subjects were invalid",
        invalid_rows: skippedInvalid,
      },
      400
    );
  }

  // Check for duplicates within the upload (subject_code + year + section).
  const seenKeys = new Set<string>();
  const deduped: typeof validSubjects = [];
  const duplicateKeys: string[] = [];

  for (const sub of validSubjects) {
    const key = `${sub.subject_code}_${sub.year}_${sub.section}`;
    if (seenKeys.has(key)) {
      duplicateKeys.push(key);
      continue;
    }
    seenKeys.add(key);
    deduped.push(sub);
  }

  // Check for existing subjects in the table.
  const existingSubjectCodes = new Set<string>();
  const codesToCheck = deduped.map((s) => s.subject_code);
  const { data: existingSubjects } = await supabase
    .from(resolved.table)
    .select("subject_code")
    .in("subject_code", codesToCheck);

  for (const row of existingSubjects || []) {
    existingSubjectCodes.add(String(row.subject_code).toUpperCase());
  }

  // Keep only subjects not already in the table.
  const toInsert: typeof deduped = [];
  const skippedExisting: string[] = [];

  for (const sub of deduped) {
    if (existingSubjectCodes.has(sub.subject_code)) {
      skippedExisting.push(sub.subject_code);
    } else {
      toInsert.push(sub);
    }
  }

  // Insert subjects.
  let inserted = 0;
  if (toInsert.length > 0) {
    // NOTE: subject_id is excluded — it auto-generates via the sequence
    // ensured by ensureSubjectIdIdentity().
    const { error: insertError } = await supabase
      .from(resolved.table)
      .insert(
        toInsert.map((s) => ({
          subject_code: s.subject_code,
          subject_name: s.subject_name,
          year: s.year,
          section: s.section,
        }))
      );

    if (insertError) {
      return json(
        {
          success: false,
          error: "Failed to insert subjects",
          details: insertError.message,
        },
        500
      );
    }
    inserted = toInsert.length;
  }

  return json({
    success: true,
    message: "Subjects processed successfully",
    inserted,
    skippedExisting: skippedExisting.length,
    skipped_existing_codes: skippedExisting,
    skippedInvalid: skippedInvalid.length,
    invalid_rows: skippedInvalid,
    skipped_duplicates: duplicateKeys.length,
    department,
    batch,
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
      case "list-subjects":
        return await handleListSubjects(payload);
      case "add-subjects":
        return await handleAddSubjects(payload);
      default:
        return json(
          { success: false, error: "Unknown action" },
          400
        );
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
