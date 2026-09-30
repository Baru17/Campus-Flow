/**
 * Admin provisioning API.
 *
 * This replaces the Supabase-era `/api/functions/admin-*` surface the dashboard
 * used to call, which no longer exists on the Worker and would in any case have
 * reintroduced the old action-multiplexed contract. The routes are ordinary Hono
 * REST handlers mounted at `/api/admin`, and every one of them is behind
 * `requireAuth` + `requireAdmin`, so authorization is decided by the database and
 * not by whatever the browser happens to hold.
 *
 * The shape of every write is the same three phases, in this order:
 *
 *   1. resolve   - turn request values into a department, a batch and a pair of
 *                  table names the backend constructed itself
 *   2. validate  - reject the whole request if anything is malformed, or collect
 *                  per-row errors if only some rows are bad
 *   3. write     - create the tables if needed, then insert rows and accounts
 *
 * Nothing in phase 3 interpolates a client-supplied string into SQL. Department
 * comes from a fixed list, batch from a strict format check, and table names from
 * `buildTableNames`.
 */

import { Hono } from "hono";
import { requireAuth, requireAdmin, type AuthUser } from "../middleware/auth";
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";
import {
  ensureBatchRegistry,
  invalidateBatchRegistry,
  listBatchesForDepartment,
  normalizeDepartment,
  resolveTables,
  SUPPORTED_DEPARTMENTS,
  type Department,
} from "../utils/tableResolver";
import { provisionBatchTables } from "../utils/provisioning";
import { formatBatchLabel, validateBatchInput } from "../utils/batchValidation";
import {
  hashDefaultPassword,
  planAccounts,
  staffUserName,
  studentUserName,
  DEFAULT_INITIAL_PASSWORD,
  type ProvisionedRole,
  type ExistingAccount,
} from "../utils/accountProvisioning";
import {
  validateStaffRow,
  validateStudentRow,
  validateSubjectRow,
  type StaffInput,
  type StudentInput,
  type SubjectInput,
} from "../utils/adminValidation";

const app = new Hono<{ Bindings: { DB: D1Database } }>();

/** A bulk import larger than this is refused rather than attempted. */
const MAX_BULK_ROWS = 2000;
/** Guard on the raw request body before it is parsed. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function authUser(c: any): AuthUser {
  return (c as any).get("authUser") as AuthUser;
}

function fail(c: any, status: number, error: string, code: string, details?: unknown) {
  return c.json({ success: false, error, code, ...(details ? { details } : {}) }, status);
}

function serverError(c: any, error: unknown, message: string, code: string) {
  console.error(message, error);
  const transient = isTransientD1Error(error);
  return c.json(
    {
      success: false,
      error: transient ? "Admin service is temporarily busy. Please retry." : message,
      code: transient ? "database-busy" : code,
    },
    transient ? 503 : 500
  );
}

/**
 * Reads and size-checks a JSON body.
 *
 * The dashboard posts parsed rows rather than uploading a file, so the body is the
 * untrusted input. It is capped before parsing to avoid materialising an
 * arbitrarily large payload, and a body over the cap is refused as a distinct
 * error so the admin is told to split the file rather than shown a parse failure.
 */
async function readRows(c: any): Promise<unknown[] | Response> {
  const declared = Number(c.req.header("content-length") || "0");
  if (declared > MAX_BODY_BYTES) {
    return fail(
      c,
      413,
      `That file is too large. Split it into batches of ${MAX_BULK_ROWS} rows or fewer.`,
      "import-too-large"
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "Invalid JSON body", "invalid-json");
  }

  const rows = body?.rows;
  if (!Array.isArray(rows)) {
    return fail(c, 400, "Expected a 'rows' array", "invalid-rows");
  }
  if (rows.length === 0) {
    return fail(c, 400, "No rows to import", "empty-rows");
  }
  if (rows.length > MAX_BULK_ROWS) {
    return fail(
      c,
      400,
      `At most ${MAX_BULK_ROWS} rows can be imported at a time. ${rows.length} were provided.`,
      "too-many-rows"
    );
  }
  return rows;
}

/**
 * Resolves the department and batch a request is about, and ensures the pair is
 * resolvable.
 *
 * `requireProvisioned` is false when the request is the one that *creates* the
 * batch: at that point the pair is not in the registry yet, and demanding it be
 * resolvable first would make creating a batch impossible.
 */
function resolveTarget(
  c: any,
  { requireProvisioned }: { requireProvisioned: boolean }
):
  | { department: Department; batch: string; studentTable: string; attendanceTable: string }
  | Response {
  const department = normalizeDepartment((c.req.query("department") ?? "").trim());
  if (!department) {
    return fail(c, 400, "Choose a supported department", "invalid-department");
  }

  const batchCheck = validateBatchInput(c.req.query("batch"));
  if (!batchCheck.valid) {
    return fail(c, 400, batchCheck.message, batchCheck.code);
  }

  const tables = resolveTables(department, batchCheck.batch);
  if (requireProvisioned && !tables) {
    return fail(
      c,
      400,
      `That batch is not provisioned for ${department}. Create it first.`,
      "batch-not-provisioned"
    );
  }

  const names = tables ?? {
    studentTable: `${department}_Students_${batchCheck.batch}`,
    attendanceTable: `${department}_Attendance_${batchCheck.batch}`,
  };

  return { department, batch: batchCheck.batch, ...names };
}

/* ------------------------------------------------------------------ batches */

app.get("/batches", requireAuth, requireAdmin, async (c) => {
  try {
    await ensureBatchRegistry(c.env.DB);

    /*
     * `?department=CSE` narrows the response to one department's cohorts, which is
     * what the picker needs after the admin has chosen a department. Without it the
     * full map is returned, because the department step needs the list of
     * departments to choose from in the first place.
     *
     * `batches` is always keyed by every department rather than only the requested
     * one, so a client can cache one response and index into it.
     */
    const requested = c.req.query("department");
    if (requested !== undefined) {
      const department = normalizeDepartment(requested);
      if (!department) {
        return fail(c, 400, "Choose a supported department", "invalid-department");
      }
      return c.json({
        success: true,
        department,
        departments: [department],
        batches: {
          [department]: listBatchesForDepartment(department).map((key) => ({
            key,
            label: formatBatchLabel(key),
          })),
        },
      });
    }

    const batches: Record<string, { key: string; label: string }[]> = {};
    for (const department of SUPPORTED_DEPARTMENTS) {
      batches[department] = listBatchesForDepartment(department).map((key) => ({
        key,
        label: formatBatchLabel(key),
      }));
    }
    return c.json({ success: true, departments: [...SUPPORTED_DEPARTMENTS], batches });
  } catch (error) {
    return serverError(c, error, "Could not load batches", "batches-failed");
  }
});

/**
 * Registers a batch and creates its tables.
 *
 * Idempotent: creating a batch that already exists reports `created: false` and
 * leaves the existing tables and data alone. This is the endpoint that removes
 * the need for a migration per cohort, so it is also the one that must never
 * recreate or truncate an existing pair.
 */
app.post("/batches", requireAuth, requireAdmin, async (c) => {
  try {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, "Invalid JSON body", "invalid-json");
    }

    const department = normalizeDepartment(body?.department);
    if (!department) {
      return fail(c, 400, "Choose a supported department", "invalid-department");
    }

    const batchCheck = validateBatchInput(body?.batch);
    if (!batchCheck.valid) {
      return fail(c, 400, batchCheck.message, batchCheck.code);
    }

    await ensureBatchRegistry(c.env.DB);
    const alreadyResolved = resolveTables(department, batchCheck.batch) !== null;

    const provisioned = await provisionBatchTables(c.env.DB, department, batchCheck.batch);

    // The registry row is written after the tables exist, so a row can never
    // advertise a cohort whose tables are missing.
    await c.env.DB
      .prepare(
        `INSERT INTO academic_batches
           (department, batch, start_year, end_year, student_table, attendance_table, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (department, batch) DO UPDATE SET
           student_table = excluded.student_table,
           attendance_table = excluded.attendance_table`
      )
      .bind(
        department,
        batchCheck.batch,
        batchCheck.startYear,
        batchCheck.endYear,
        provisioned.studentTable,
        provisioned.attendanceTable,
        authUser(c).auth_user_id
      )
      .run();

    // Make the new pair resolvable in this isolate immediately, so the very next
    // request can import students into it.
    invalidateBatchRegistry();
    await ensureBatchRegistry(c.env.DB, { force: true });

    return c.json({
      success: true,
      created: !alreadyResolved,
      tablesCreated: provisioned.created,
      department,
      batch: batchCheck.batch,
      label: formatBatchLabel(batchCheck.batch),
      studentTable: provisioned.studentTable,
      attendanceTable: provisioned.attendanceTable,
    });
  } catch (error) {
    return serverError(c, error, "Could not create that batch", "batch-create-failed");
  }
});

/* ------------------------------------------------------------------ students */

app.get("/students", requireAuth, requireAdmin, async (c) => {
  try {
    await ensureBatchRegistry(c.env.DB);
    const target = resolveTarget(c, { requireProvisioned: true });
    if (target instanceof Response) return target;

    const rows = await c.env.DB
      .prepare(
        `SELECT student_id, register_no, student_name, year, section, email
         FROM ${target.studentTable}
         ORDER BY register_no`
      )
      .all();

    return c.json({
      success: true,
      department: target.department,
      batch: target.batch,
      students: rows?.results ?? [],
    });
  } catch (error) {
    return serverError(c, error, "Could not load students", "students-list-failed");
  }
});

/**
 * Creates a student roster and the matching login accounts.
 *
 * Re-importing the same file is safe. A student already present in the target
 * table is reported as skipped rather than inserted, and an account that already
 * exists is reused rather than recreated, so no UNIQUE constraint is ever hit on
 * `student_id`, `register_no`, `email` or `user_name`.
 */
app.post("/students", requireAuth, requireAdmin, async (c) => {
  try {
    const rawRows = await readRows(c);
    if (rawRows instanceof Response) return rawRows;

    await ensureBatchRegistry(c.env.DB);
    const target = resolveTarget(c, { requireProvisioned: false });

    // `readRows` returns either rows or a Response; narrow before use.
    if (target instanceof Response) return target;

    const validated: { row: number; value: StudentInput }[] = [];
    const invalid: { row: number; errors: { field: string; message: string }[] }[] = [];

    rawRows.forEach((raw, index) => {
      const result = validateStudentRow(raw);
      if (result.ok) {
        validated.push({ row: index + 1, value: result.value });
      } else {
        invalid.push({ row: index + 1, errors: result.errors });
      }
    });

    // In-file duplicates: the same id, register number or email twice is a data
    // error, not a second student. The first occurrence wins.
    const seenIds = new Set<string>();
    const seenRegisters = new Set<string>();
    const seenEmails = new Set<string>();
    const deduped: typeof validated = [];
    const inFileDuplicates: { row: number; reason: string }[] = [];
    for (const entry of validated) {
      const idKey = entry.value.student_id.toLowerCase();
      const regKey = entry.value.register_no.toLowerCase();
      const emailKey = entry.value.email.toLowerCase();
      if (seenIds.has(idKey)) {
        inFileDuplicates.push({ row: entry.row, reason: `Duplicate student_id ${entry.value.student_id}` });
        continue;
      }
      if (seenRegisters.has(regKey)) {
        inFileDuplicates.push({ row: entry.row, reason: `Duplicate register_no ${entry.value.register_no}` });
        continue;
      }
      // The student table has `email TEXT NOT NULL UNIQUE` and the login lookup
      // matches on email, so two rows sharing one address would both be
      // unidentifiable at sign-in even if the insert somehow succeeded.
      if (seenEmails.has(emailKey)) {
        inFileDuplicates.push({ row: entry.row, reason: `Duplicate email ${entry.value.email}` });
        continue;
      }
      seenIds.add(idKey);
      seenRegisters.add(regKey);
      seenEmails.add(emailKey);
      deduped.push(entry);
    }

    if (deduped.length === 0) {
      return fail(
        c,
        400,
        "No valid rows to import",
        "import-validation-failed",
        { invalid, duplicates: inFileDuplicates }
      );
    }

    // The pair may not be provisioned yet. Creating it here is what lets the very
    // first import of a new cohort work without a separate step.
    if (!resolveTables(target.department, target.batch)) {
      await provisionBatchTables(c.env.DB, target.department, target.batch);
      await c.env.DB
        .prepare(
          `INSERT INTO academic_batches
             (department, batch, start_year, end_year, student_table, attendance_table, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (department, batch) DO NOTHING`
        )
        .bind(
          target.department,
          target.batch,
          Number(target.batch.slice(0, 4)),
          Number(target.batch.slice(5)),
          target.studentTable,
          target.attendanceTable,
          authUser(c).auth_user_id
        )
        .run();
      invalidateBatchRegistry();
    }

    /*
     * Which of these rows can be inserted?
     *
     * `student_id` is the identity of a student, so a row already present by id is
     * simply skipped and re-uploading the same file is a no-op.
     *
     * A row whose id is new but whose `register_no` or `email` already belongs to a
     * *different* student is a conflict rather than a re-import. It is reported
     * per row and excluded, because inserting it would violate a UNIQUE constraint
     * and abort the whole batch, taking the valid rows down with it. Asking about
     * all three columns at once is what makes that visible to the admin instead of
     * surfacing as an opaque "UNIQUE constraint failed" 500.
     */
    const conflicts: { row: number; reason: string }[] = [];
    const existingRows = await c.env.DB
      .prepare(
        `SELECT student_id, register_no, email FROM ${target.studentTable}
         WHERE student_id IN (${deduped.map(() => "?").join(",")})
            OR LOWER(register_no) IN (${deduped.map(() => "?").join(",")})
            OR LOWER(email) IN (${deduped.map(() => "?").join(",")})`
      )
      .bind(
        ...deduped.map((entry) => entry.value.student_id),
        ...deduped.map((entry) => entry.value.register_no.toLowerCase()),
        ...deduped.map((entry) => entry.value.email)
      )
      .all<{ student_id: string; register_no: string; email: string }>();

    const existingById = new Map<string, string>();
    const existingRegisters = new Set<string>();
    const existingEmails = new Set<string>();
    for (const row of existingRows?.results ?? []) {
      existingById.set(row.student_id.toUpperCase(), row.student_id);
      if (row.register_no) existingRegisters.add(row.register_no.toLowerCase());
      if (row.email) existingEmails.add(row.email.toLowerCase());
    }

    const insertable: typeof deduped = [];
    let skipped = 0;
    for (const entry of deduped) {
      const id = entry.value.student_id;
      if (existingById.has(id.toUpperCase())) {
        skipped += 1;
        continue;
      }
      if (existingRegisters.has(entry.value.register_no.toLowerCase())) {
        conflicts.push({
          row: entry.row,
          reason: `Register number ${entry.value.register_no} already belongs to another student`,
        });
        continue;
      }
      if (existingEmails.has(entry.value.email.toLowerCase())) {
        conflicts.push({
          row: entry.row,
          reason: `Email ${entry.value.email} already belongs to another student`,
        });
        continue;
      }
      insertable.push(entry);
    }

    const toInsert = insertable;

    if (toInsert.length === 0) {
      // Every row was either already present or in conflict. Nothing is written,
      // and the reason is reported per row rather than as a failure, because
      // re-uploading an unchanged file is a legitimate thing to do.
      return c.json({
        success: true,
        department: target.department,
        batch: target.batch,
        created: 0,
        authAccountsCreated: 0,
        skipped,
        invalid,
        duplicates: inFileDuplicates,
        conflicts,
        defaultPassword: DEFAULT_INITIAL_PASSWORD,
      });
    }

    // Accounts: look up every identifier and email first so a reused account can
    // be linked rather than recreated.
    const wantedKeys = toInsert.map((entry) => studentUserName(entry.value.student_id));
    const wantedEmails = toInsert.map((entry) => entry.value.email);
    const accounts = await c.env.DB
      .prepare(
        `SELECT auth_user_id, user_name, role, email FROM auth_users
         WHERE user_name IN (${wantedKeys.map(() => "?").join(",")})
            OR email IN (${wantedEmails.map(() => "?").join(",")})`
      )
      .bind(...wantedKeys, ...wantedEmails)
      .all<ExistingAccount>();

    const byKey = new Map<string, ExistingAccount>();
    const byEmail = new Map<string, ExistingAccount>();
    for (const account of accounts?.results ?? []) {
      byKey.set(account.user_name.toLowerCase(), account);
      if (account.email) byEmail.set(account.email.toLowerCase(), account);
    }

    /*
     * An account is only reused when its role already matches.
     *
     * `planAccounts` links a found account by id regardless of role, which is right
     * for a genuine re-import but wrong when the match is coincidental: attaching
     * a roster row to a colleague's account would hand that colleague's
     * credentials to a different person, and in the other direction an existing
     * `admin` account matched on email would be silently demoted in the dashboard's
     * eyes. A mismatched row is reported instead of being linked.
     */
    const roleMismatches: { row: number; reason: string }[] = [];
    const linkable: (typeof deduped)[number][] = [];
    toInsert.forEach((entry, index) => {
      const wantedRole = "student" as ProvisionedRole;
      const key = studentUserName(entry.value.student_id);
      const found = byKey.get(key.toLowerCase()) ?? byEmail.get(entry.value.email);
      if (found && found.role !== wantedRole) {
        roleMismatches.push({
          row: entry.row,
          reason: `${entry.value.email} already has a "${found.role}" account, so it cannot also be a student login`,
        });
        return;
      }
      linkable.push(insertable[index]);
    });

    const insertRows = linkable;

    // One hash is shared by every new account: bcrypt is deliberately slow, so
    // hashing per row would make a 128-row import take minutes. It is only computed
    // when there is a new account to create, so an import that reuses every
    // account does not pay for a hash it discards.
    const pwdHash = await hashDefaultPassword();
    const { plans } = planAccounts(
      insertRows.map((entry) => ({
        key: studentUserName(entry.value.student_id),
        email: entry.value.email,
        role: "student" as ProvisionedRole,
      })),
      { byKey, byEmail },
      pwdHash
    );

    // Roster rows and accounts are written in one D1 batch, which is a
    // transaction: either both halves land or neither does, so a student is never
    // left without a usable account.
    const statements: D1PreparedStatement[] = [];
    insertRows.forEach((entry, index) => {
      const plan = plans[index];
      statements.push(
        c.env.DB
          .prepare(
            `INSERT INTO ${target.studentTable}
               (student_id, register_no, student_name, year, section, email, auth_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            entry.value.student_id,
            entry.value.register_no,
            entry.value.student_name,
            entry.value.year,
            entry.value.section,
            entry.value.email,
            plan.auth_user_id
          )
      );
    });

    let accountsCreated = 0;
    plans.forEach((plan) => {
      // An empty hash marks a reused account: nothing to insert for it.
      if (!plan.pwdHash) return;
      accountsCreated += 1;
      statements.push(
        c.env.DB
          .prepare(
            `INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(plan.auth_user_id, plan.user_name, plan.pwdHash, plan.role, plan.email)
      );
    });

    if (statements.length > 0) {
      await c.env.DB.batch(statements);
    }

    return c.json({
      success: true,
      department: target.department,
      batch: target.batch,
      studentTable: target.studentTable,
      attendanceTable: target.attendanceTable,
      created: insertRows.length,
      authAccountsCreated: accountsCreated,
      skipped,
      invalid,
      duplicates: inFileDuplicates,
      conflicts,
      roleMismatches,
      // Stated once, in aggregate. The per-row password is never returned.
      defaultPassword: DEFAULT_INITIAL_PASSWORD,
    });
  } catch (error) {
    return serverError(c, error, "Could not provision students", "students-import-failed");
  }
});

/* --------------------------------------------------------------------- staff */

app.get("/staff", requireAuth, requireAdmin, async (c) => {
  try {
    const department = normalizeDepartment(c.req.query("department"));
    if (!department) {
      return fail(c, 400, "Choose a supported department", "invalid-department");
    }
    const rows = await c.env.DB
      .prepare(
        `SELECT staff_id, staff_name, email, department, class_advisor,
                advisor_year, advisor_section, advisor_batch
         FROM staff
         WHERE department = ?
         ORDER BY staff_name`
      )
      .bind(department)
      .all();
    return c.json({ success: true, department, staff: rows?.results ?? [] });
  } catch (error) {
    return serverError(c, error, "Could not load staff", "staff-list-failed");
  }
});

/**
 * Creates staff records and their accounts.
 *
 * Staff live in one `staff` table, not in per-batch tables, so this endpoint takes
 * only a department. A batch appears here solely as an *advisor* attribute: the
 * cohort a class advisor is responsible for. It is therefore optional, and the
 * per-row `advisor_batch` is what decides whether one is needed, rather than a
 * request-wide query parameter that would force every staff import to name a
 * cohort.
 *
 * The department is the request's own, already validated, and is written to every
 * row. `advisor_year` / `advisor_section` / `advisor_batch` are preserved exactly
 * as the row supplied them, because those are what the class-advisor endpoints
 * authorise and resolve tables with; they are not re-derived here.
 */
app.post("/staff", requireAuth, requireAdmin, async (c) => {
  try {
    const rawRows = await readRows(c);
    if (rawRows instanceof Response) return rawRows;

    const department = normalizeDepartment(c.req.query("department"));
    if (!department) {
      return fail(c, 400, "Choose a supported department", "invalid-department");
    }

    await ensureBatchRegistry(c.env.DB);

    const validated: { row: number; value: StaffInput }[] = [];
    const invalid: { row: number; errors: { field: string; message: string }[] }[] = [];
    rawRows.forEach((raw, index) => {
      const result = validateStaffRow(raw);
      if (result.ok) {
        validated.push({ row: index + 1, value: result.value });
      } else {
        invalid.push({ row: index + 1, errors: result.errors });
      }
    });

    if (validated.length === 0) {
      return fail(c, 400, "No valid rows to import", "import-validation-failed", { invalid });
    }

    /*
     * An advisor batch must name a cohort that really exists in this department.
     *
     * It is checked here rather than by the row validator, which only knows the
     * format, because "is this batch provisioned" is a database question. Doing it
     * per row means a single file may contain advisors of different cohorts while
     * the non-advisor rows need no batch at all.
     */
    const advisorBatches = [
      ...new Set(
        validated
          .map((entry) => entry.value.advisor_batch)
          .filter((batch): batch is string => Boolean(batch))
      ),
    ];
    const unprovisioned = advisorBatches.filter((batch) => !resolveTables(department, batch));
    if (unprovisioned.length > 0) {
      return fail(
        c,
        400,
        unprovisioned.length === 1
          ? `Advisor batch ${unprovisioned[0]} is not provisioned for ${department}. Create it first.`
          : `These advisor batches are not provisioned for ${department}: ${unprovisioned.join(", ")}. Create them first.`,
        "batch-not-provisioned"
      );
    }

    const seenEmails = new Set<string>();
    const deduped: typeof validated = [];
    const inFileDuplicates: { row: number; reason: string }[] = [];
    for (const entry of validated) {
      const key = entry.value.email.toLowerCase();
      if (seenEmails.has(key)) {
        inFileDuplicates.push({ row: entry.row, reason: `Duplicate email ${entry.value.email}` });
        continue;
      }
      seenEmails.add(key);
      deduped.push(entry);
    }

    const existingRows = await c.env.DB
      .prepare(`SELECT email FROM staff WHERE email IN (${deduped.map(() => "?").join(",")})`)
      .bind(...deduped.map((entry) => entry.value.email))
      .all<{ email: string }>();
    const existingEmails = new Set((existingRows?.results ?? []).map((row) => row.email.toLowerCase()));

    const toInsert = deduped.filter((entry) => !existingEmails.has(entry.value.email));
    const skipped = deduped.length - toInsert.length;

    const wantedKeys = toInsert.map((entry) => staffUserName(entry.value.email));
    const wantedEmails = toInsert.map((entry) => entry.value.email);
    const accounts = await c.env.DB
      .prepare(
        `SELECT auth_user_id, user_name, role, email FROM auth_users
         WHERE user_name IN (${wantedKeys.map(() => "?").join(",")})
            OR email IN (${wantedEmails.map(() => "?").join(",")})`
      )
      .bind(...wantedKeys, ...wantedEmails)
      .all<ExistingAccount>();

    const byKey = new Map<string, ExistingAccount>();
    const byEmail = new Map<string, ExistingAccount>();
    for (const account of accounts?.results ?? []) {
      byKey.set(account.user_name.toLowerCase(), account);
      if (account.email) byEmail.set(account.email.toLowerCase(), account);
    }

    const pwdHash = await hashDefaultPassword();
    const { plans } = planAccounts(
      toInsert.map((entry) => ({
        key: staffUserName(entry.value.email),
        email: entry.value.email,
        // A staff member who is assigned a class is a class advisor, which is the
        // role the class-advisor endpoints authorise.
        role: (entry.value.class_advisor === "Y" ? "class_advisor" : "staff") as ProvisionedRole,
      })),
      { byKey, byEmail },
      pwdHash
    );

    const statements: D1PreparedStatement[] = [];
    toInsert.forEach((entry, index) => {
      const plan = plans[index];
      statements.push(
        c.env.DB
          .prepare(
            /*
             * `staff_id` is assigned here rather than accepted from the admin.
             *
             * It is `TEXT NOT NULL UNIQUE` with no default, so omitting it fails,
             * and the column is load-bearing: `/api/auth/staff/login` accepts a
             * staff ID as an alternative to an email, but only after `Number(id)`
             * checks it is a positive integer, so a random string here would create
             * a row that cannot be logged into by ID.
             *
             * The number is derived in SQL from the current maximum rather than
             * read in the handler, because a read-then-write would race two
             * concurrent imports onto the same id. D1 executes a `batch()`
             * sequentially inside one transaction, so each row in the batch sees
             * the rows before it and the sequence advances correctly; a duplicate
             * would abort the whole batch rather than half-provision the staff.
             *
             * The floor of 100 keeps the generated ids in the same range as the
             * seeded staff (101-104) instead of restarting from 1.
             */
            `INSERT INTO staff
               (staff_id, staff_name, email, department, class_advisor, auth_user_id,
                advisor_year, advisor_section, advisor_batch)
             VALUES (
               (SELECT COALESCE(MAX(CAST(NULLIF(staff_id, '') AS INTEGER)), 100) + 1 FROM staff),
               ?, ?, ?, ?, ?, ?, ?, ?
             )`
          )
          .bind(
            entry.value.staff_name,
            entry.value.email,
            department,
            entry.value.class_advisor,
            plan.auth_user_id,
            entry.value.advisor_year,
            entry.value.advisor_section || null,
            entry.value.advisor_batch || null
          )
      );
    });

    let accountsCreated = 0;
    for (const plan of plans) {
      if (!plan.pwdHash) continue;
      accountsCreated += 1;
      statements.push(
        c.env.DB
          .prepare(
            `INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(plan.auth_user_id, plan.user_name, plan.pwdHash, plan.role, plan.email)
      );
    }

    if (statements.length > 0) {
      await c.env.DB.batch(statements);
    }

    return c.json({
      success: true,
      department,
      created: toInsert.length,
      authAccountsCreated: accountsCreated,
      skipped,
      invalid,
      duplicates: inFileDuplicates,
      defaultPassword: DEFAULT_INITIAL_PASSWORD,
    });
  } catch (error) {
    return serverError(c, error, "Could not provision staff", "staff-import-failed");
  }
});

/* ----------------------------------------------------------------- subjects */

app.get("/subjects", requireAuth, requireAdmin, async (c) => {
  try {
    const rows = await c.env.DB
      .prepare("SELECT subject_id, subject_code, subject_name FROM subjects ORDER BY subject_code")
      .all();
    return c.json({ success: true, subjects: rows?.results ?? [] });
  } catch (error) {
    return serverError(c, error, "Could not load subjects", "subjects-list-failed");
  }
});

/**
 * Adds catalog subjects.
 *
 * The global `subjects` table keeps its three columns and gains none: it is a
 * catalog entry with a code and a name, and it must never decide which attendance
 * table a mark lands in. That is the batch's job, chosen by the staff member.
 */
app.post("/subjects", requireAuth, requireAdmin, async (c) => {
  try {
    const rawRows = await readRows(c);
    if (rawRows instanceof Response) return rawRows;

    const validated: { row: number; value: SubjectInput }[] = [];
    const invalid: { row: number; errors: { field: string; message: string }[] }[] = [];
    rawRows.forEach((raw, index) => {
      const result = validateSubjectRow(raw);
      if (result.ok) {
        validated.push({ row: index + 1, value: result.value });
      } else {
        invalid.push({ row: index + 1, errors: result.errors });
      }
    });

    if (validated.length === 0) {
      return fail(c, 400, "No valid rows to import", "import-validation-failed", { invalid });
    }

    const seenCodes = new Set<string>();
    const deduped: typeof validated = [];
    const inFileDuplicates: { row: number; reason: string }[] = [];
    for (const entry of validated) {
      const key = entry.value.subject_code.toUpperCase();
      if (seenCodes.has(key)) {
        inFileDuplicates.push({
          row: entry.row,
          reason: `Duplicate subject code ${entry.value.subject_code}`,
        });
        continue;
      }
      seenCodes.add(key);
      deduped.push(entry);
    }

    const existingRows = await c.env.DB
      .prepare(`SELECT subject_code FROM subjects WHERE subject_code IN (${deduped.map(() => "?").join(",")})`)
      .bind(...deduped.map((entry) => entry.value.subject_code))
      .all<{ subject_code: string }>();
    const existingCodes = new Set(
      (existingRows?.results ?? []).map((row) => row.subject_code.toUpperCase())
    );

    const toInsert = deduped.filter((entry) => !existingCodes.has(entry.value.subject_code));
    const skipped = deduped.length - toInsert.length;

    if (toInsert.length > 0) {
      // One batched insert: subjects is a single table, so this is atomic without
      // needing a transaction of its own.
      await c.env.DB.batch(
        toInsert.map((entry) =>
          c.env.DB
            .prepare("INSERT INTO subjects (subject_code, subject_name) VALUES (?, ?)")
            .bind(entry.value.subject_code, entry.value.subject_name)
        )
      );
    }

    return c.json({
      success: true,
      created: toInsert.length,
      skipped,
      invalid,
      duplicates: inFileDuplicates,
    });
  } catch (error) {
    return serverError(c, error, "Could not add subjects", "subjects-import-failed");
  }
});

export default app;
