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
 *
 * ## Updates
 *
 * The `PATCH` routes are the edit half of the same contract, and they are held to
 * one extra rule: the primary key of a row is never something the client gets to
 * change. A student is addressed by `student_id`, staff by `staff_id` and a
 * subject by `subject_id` in the path, and a body that names a *different* one is
 * refused rather than quietly ignored, so a caller is never told an edit succeeded
 * when it moved some other row.
 *
 * Identity also decides which table a student lives in, and the department and
 * batch on such a request are a hint, not an authority: the table name still comes
 * from the registry and the row still has to be found in it, so a wrong cohort
 * answers 404 rather than editing a different student.
 *
 * ## Deletions
 *
 * The `DELETE` routes are the third half of the same contract, and they are held to
 * one rule that the reads and writes above never had to think about: a directory
 * record and the history that mentions it are not the same thing.
 *
 * Nothing in this schema declares a single `FOREIGN KEY`. Attendance rows record a
 * `register_no`, `attendance_session` records a `created_by` staff id and a
 * subject code, and `od_requests` records a `student_table`/`student_id` pair and
 * four approver addresses -- all of them plain text, copied at the moment the event
 * happened. So there is no cascade to suppress and no constraint to trip: deleting a
 * roster row leaves every attendance mark, OD request and approval exactly where it
 * was, which is the behaviour this application wants and the reason the delete is a
 * single `DELETE FROM` rather than a fan-out.
 *
 * What does need care is the login account. Every directory row links to
 * `auth_users` through `auth_user_id`, and an account left behind by a deleted row is
 * a real problem for an appointment role: `/api/auth/od-approver/login` resolves the
 * caller through that column, so a coordinator whose row is gone can no longer sign
 * in even though their `auth_users` row still verifies. Deleting the account is not
 * automatically right either -- a contest coordinator's account is usually a reused
 * *staff* account that the `staff` roster also points at, and removing it would sign
 * a colleague out of the very roster that still lists them. `planAccountRemoval`
 * resolves that: it removes the account only when the role is one this directory
 * issues and nothing else still references it, and otherwise leaves it untouched and
 * says so in the response.
 *
 * Where a deletion would genuinely destroy the meaning of existing data, it is
 * refused rather than performed. A subject that attendance already names is a 409,
 * because the marks are filed under its code and a catalog entry is what makes them
 * readable. A staff member who is currently a department's contest coordinator is a
 * 409, because that appointment is a directory record in its own right and the
 * coordinator roster is chosen from the staff roster.
 */

import { Hono } from "hono";
import { requireAuth, requireAdmin, type AuthUser } from "../middleware/auth";
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";
import {
  assertAllowedAttendanceTable,
  assertAllowedStudentTable,
  buildTableNames,
  ensureBatchRegistry,
  invalidateBatchRegistry,
  listAllowedStudentTables,
  listBatchesForDepartment,
  normalizeDepartment,
  resolveTables,
  SUPPORTED_DEPARTMENTS,
  type Department,
} from "../utils/tableResolver";
import { provisionBatchTables } from "../utils/provisioning";
import { formatBatchLabel, validateBatchInput } from "../utils/batchValidation";
import { selectInChunks } from "../utils/sqlChunking";
import {
  hashDefaultPassword,
  planAccounts,
  emailUserName,
  staffUserName,
  studentUserName,
  DEFAULT_INITIAL_PASSWORD,
  type ProvisionedRole,
  type ExistingAccount,
} from "../utils/accountProvisioning";
import {
  validateContestCoordinatorRow,
  validateHodRow,
  validateStaffId,
  validateStaffRow,
  validateStudentId,
  validateStudentRow,
  validateSubjectRow,
  type StaffInput,
  type StudentInput,
  type SubjectInput,
  type RowResult,
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
 * Reads a single JSON object body, for the edit routes.
 *
 * Separate from `readRows` because an update is one record rather than a batch:
 * it is not size-capped the way a 2000-row import is, and a body that is an array
 * or a scalar is refused here rather than read as a record with no fields.
 */
async function readObjectBody(c: any): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "Invalid JSON body", "invalid-json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(c, 400, "Expected a JSON object", "invalid-body");
  }
  return body as Record<string, unknown>;
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

/** The columns an edit of a student may touch. Everything else is the identity. */
const STUDENT_COLUMNS =
  "student_id, register_no, student_name, year, section, email, auth_user_id";

type StudentRow = {
  student_id: string;
  register_no: string;
  student_name: string;
  year: number;
  section: string;
  email: string;
  auth_user_id: string | null;
};

type StudentCohort = {
  department: Department;
  batch: string;
  studentTable: string;
  student: StudentRow;
};

/**
 * Finds the cohort a student row lives in, and reads the row.
 *
 * Students are stored in a separate table per (department, batch), so a student is
 * only addressable once the table is known. Two properties make this safe:
 *
 *   1. The table name is never taken from the request. A caller that names a
 *      cohort gets it through `resolveTables`, which only vouches for a pair the
 *      registry knows and whose tables exist; a caller that names none gets the
 *      registry's own list. Either way `assertAllowedStudentTable` is the last
 *      gate before the name reaches SQL.
 *   2. The row still has to be found *in* that table. A department and batch that
 *      point at the wrong cohort therefore answer "not found" instead of editing a
 *      different student.
 *
 * The three ways it can come back empty are kept apart, because the admin needs a
 * different message for each: a cohort that was never provisioned is a setup
 * problem, a cohort that is fine but holds no such student is not, and an id that
 * exists in two cohorts at once has to be disambiguated rather than resolved by
 * taking the first hit.
 */
type CohortLookup =
  | { ok: true; cohort: StudentCohort }
  | { ok: false; reason: "ambiguous" | "not-provisioned" | "not-found" };

async function findStudentCohort(
  db: D1Database,
  studentId: string,
  hint: { department?: string; batch?: string } | null
): Promise<CohortLookup> {
  let candidates: { department: Department; batch: string; studentTable: string }[];

  if (hint) {
    const tables = resolveTables(hint.department, hint.batch);
    if (!tables) return { ok: false, reason: "not-provisioned" };
    candidates = [
      { department: tables.department, batch: tables.batch, studentTable: tables.studentTable },
    ];
  } else {
    candidates = listAllowedStudentTables().map((tables) => ({
      department: tables.department,
      batch: tables.batch,
      studentTable: tables.studentTable,
    }));
  }

  const matches: StudentCohort[] = [];
  for (const candidate of candidates) {
    const row = await db
      .prepare(
        `SELECT ${STUDENT_COLUMNS} FROM ${assertAllowedStudentTable(candidate.studentTable)}
         WHERE UPPER(student_id) = ? LIMIT 1`
      )
      .bind(studentId)
      .first<StudentRow>();
    if (row) {
      matches.push({ ...candidate, student: row as StudentRow });
      if (hint) break;
    }
  }

  if (matches.length === 0) return { ok: false, reason: "not-found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, cohort: matches[0] };
}

/* ---------------------------------------------------------------- deletions */

/**
 * Every table that carries an `auth_user_id`, apart from the per-cohort student
 * tables.
 *
 * Literals, all of them: `staff` and the two directory tables are named by the
 * schema, not by a request. The student tables are absent because their names come
 * from the registry, and they are read separately in `findCompetingAuthLink`.
 */
const AUTH_LINKED_TABLES = ["staff", "hods", "contest_coordinators"] as const;

/** Identifies the row being removed, so it is not mistaken for a competing reference. */
interface RemovedRow {
  /** Literal table name. Never anything a request supplied. */
  table: string;
  /** Literal id column of that table. */
  idColumn: string;
  /** The id of the row the delete is removing. */
  id: string | number;
}

/**
 * The table that still points `authUserId` somewhere else, or `null`.
 *
 * An account is shared whenever two live records carry the same `auth_user_id`, and
 * deleting a shared one signs the other record's owner out of a system they are
 * still listed in. The two ways that happens in this schema are both checked:
 *
 *   - one person holding two roles. A contest coordinator is appointed out of a
 *     department's staff roster, so their `coordinator_id` row and their `staff_id`
 *     row point at the *same* account. Deleting the appointment must not take the
 *     staff login with it.
 *   - one record duplicated across cohorts, which the student tables are scanned
 *     for the same reason.
 *
 * The row being deleted is excluded, because it is about to stop existing and would
 * otherwise always be reported as its own competitor.
 *
 * Requires the batch registry to be hydrated, which every caller does through
 * `ensureBatchRegistry` before reaching here.
 */
async function findCompetingAuthLink(
  db: D1Database,
  authUserId: string,
  self: RemovedRow
): Promise<string | null> {
  for (const table of AUTH_LINKED_TABLES) {
    if (table === self.table) {
      const other = await db
        .prepare(
          `SELECT 1 AS hit FROM ${table} WHERE auth_user_id = ? AND ${self.idColumn} <> ? LIMIT 1`
        )
        .bind(authUserId, self.id)
        .first<{ hit: number }>();
      if (other) return table;
      continue;
    }
    const holder = await db
      .prepare(`SELECT 1 AS hit FROM ${table} WHERE auth_user_id = ? LIMIT 1`)
      .bind(authUserId)
      .first<{ hit: number }>();
    if (holder) return table;
  }

  for (const tables of listAllowedStudentTables()) {
    const studentTable = assertAllowedStudentTable(tables.studentTable);
    // The student tables have no single id column in common, so the row being
    // removed is excluded by the table it lives in rather than by a shared name.
    const holder =
      studentTable === self.table
        ? await db
            .prepare(
              `SELECT 1 AS hit FROM ${studentTable}
               WHERE auth_user_id = ? AND UPPER(student_id) <> UPPER(?) LIMIT 1`
            )
            .bind(authUserId, String(self.id))
            .first<{ hit: number }>()
        : await db
            .prepare(`SELECT 1 AS hit FROM ${studentTable} WHERE auth_user_id = ? LIMIT 1`)
            .bind(authUserId)
            .first<{ hit: number }>();
    if (holder) return studentTable;
  }

  return null;
}

type AccountRemoval = {
  /** Statements to run in the same `DB.batch()` as the row's own delete. */
  statements: D1PreparedStatement[];
  /** Whether the account was removed. */
  removed: boolean;
  /** Why it was left alone, for the response and for the tests to assert on. */
  keptReason: "shared" | "foreign-role" | "missing-link" | null;
  /** The role the kept account has, so the dashboard can say what it left behind. */
  keptRole: string | null;
};

/**
 * Decides whether the account behind a deleted row goes with it, and returns the
 * statements that would close it.
 *
 * An account is removed only when all three of these hold, and each one exists
 * because the alternative is a real failure:
 *
 *   1. The row carries an `auth_user_id` at all. A row that predates the column, or
 *      one whose account could not be matched when it was written, has nothing to
 *      remove -- and nothing is invented to remove.
 *   2. The account's role is one *this* directory issues. A coordinator's account is
 *      usually the reused `staff` account, which belongs to the staff roster and
 *      would sign a colleague out of it. An `admin` account behind any of these rows
 *      belongs to the application, not to the person being removed.
 *   3. Nothing else references it. See `findCompetingAuthLink`.
 *
 * The statements are returned rather than run so the caller can put them in one
 * `DB.batch()` alongside the row's own delete. D1's batch is a transaction, which is
 * what makes "the record and its login are gone together, or neither happened" true
 * rather than aspirational.
 *
 * The session rows go with the account. `auth_sessions` has no foreign key either, so
 * leaving them would not keep anybody signed in -- `requireAuth` joins `auth_users` --
 * but it would leave rows nothing can ever match, which is what
 * `/api/auth/reset-password` already avoids by deleting an account's sessions first.
 */
async function planAccountRemoval(
  db: D1Database,
  authUserId: string | null,
  ownedRoles: readonly string[],
  self: RemovedRow
): Promise<AccountRemoval> {
  if (!authUserId) {
    return { statements: [], removed: false, keptReason: "missing-link", keptRole: null };
  }

  const account = await db
    .prepare("SELECT auth_user_id, role FROM auth_users WHERE auth_user_id = ? LIMIT 1")
    .bind(authUserId)
    .first<{ auth_user_id: string; role: string }>();
  if (!account) {
    return { statements: [], removed: false, keptReason: "missing-link", keptRole: null };
  }

  if (!ownedRoles.includes(account.role)) {
    return { statements: [], removed: false, keptReason: "foreign-role", keptRole: account.role };
  }

  const holder = await findCompetingAuthLink(db, authUserId, self);
  if (holder) {
    return { statements: [], removed: false, keptReason: "shared", keptRole: account.role };
  }

  return {
    statements: [
      db.prepare("DELETE FROM auth_sessions WHERE auth_user_id = ?").bind(authUserId),
      db.prepare("DELETE FROM auth_users WHERE auth_user_id = ?").bind(authUserId),
    ],
    removed: true,
    keptReason: null,
    keptRole: null,
  };
}

/**
 * Whether an optional table exists.
 *
 * Only used for `od_requests`, which `migrations/0017_od_requests.sql` records as
 * reviewed but *not applied to production*. A delete that reported how much history
 * it preserved would therefore be a 500 on the deployed database for the want of one
 * `SELECT`. The count is reported, never depended on for the deletion itself, so
 * treating the table as absent is the safe way to be wrong: the row is still deleted
 * and still reports the history it knows about.
 */
async function tableExists(db: D1Database, table: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .bind(table)
    .first<{ hit: number }>();
  return Boolean(row);
}

/**
 * How many OD requests mention this address in any decision column, and whether
 * `od_requests` is deployed at all.
 *
 * Reported rather than acted on. `od_requests` records approvers as the addresses
 * they signed in with, on purpose: an approval has to stay attached to the person who
 * gave it, so removing a directory row must not remove what they decided. Zero is
 * returned when the table is absent rather than pretending the history is empty.
 */
async function countOdDecisionsBy(
  db: D1Database,
  email: string,
  columns: readonly string[]
): Promise<number> {
  if (columns.length === 0) return 0;
  if (!(await tableExists(db, "od_requests"))) return 0;
  const predicate = columns.map((column) => `LOWER(${column}) = ?`).join(" OR ");
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM od_requests WHERE ${predicate}`)
    .bind(...columns.map(() => email.toLowerCase()))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ batches */

app.get("/batches", requireAuth, requireAdmin, async (c) => {
  try {
    // Forced for the same reason as the staff route: an admin picker must not
    // show a cohort that has been unregistered or whose tables were dropped.
    await ensureBatchRegistry(c.env.DB, { force: true });

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
     *
     * The lookup is chunked because it binds three parameters per row. At 66
     * students that is 198 bound parameters against D1's limit of 100, which the
     * database rejects outright with "too many SQL variables" before a single row
     * is written.
     */
    const conflicts: { row: number; reason: string }[] = [];
    const existingRows = await selectInChunks<{ student_id: string; register_no: string; email: string }>(
      c.env.DB,
      {
        parametersPerRow: 3,
        buildSql: (part) => {
          const placeholders = part.map(() => "?").join(",");
          return `SELECT student_id, register_no, email FROM ${target.studentTable}
            WHERE student_id IN (${placeholders})
               OR LOWER(register_no) IN (${placeholders})
               OR LOWER(email) IN (${placeholders})`;
        },
        bindValues: (part) => [
          ...part.map((row) => row.student_id),
          ...part.map((row) => row.register_no.toLowerCase()),
          ...part.map((row) => row.email),
        ],
      },
      deduped.map((entry) => ({
        student_id: entry.value.student_id,
        register_no: entry.value.register_no,
        email: entry.value.email,
      }))
    );

    const existingById = new Map<string, string>();
    const existingRegisters = new Set<string>();
    const existingEmails = new Set<string>();
    for (const row of existingRows) {
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
    // be linked rather than recreated. Two parameters per row, so this also needs
    // chunking to stay under D1's bound-parameter cap on a real cohort.
    const accountLookups = toInsert.map((entry) => ({
      key: studentUserName(entry.value.student_id),
      email: entry.value.email,
    }));
    const accounts = await selectInChunks<
      { key: string; email: string },
      ExistingAccount
    >(
      c.env.DB,
      {
        parametersPerRow: 2,
        buildSql: (part) => {
          const placeholders = part.map(() => "?").join(",");
          return `SELECT auth_user_id, user_name, role, email FROM auth_users
            WHERE user_name IN (${placeholders}) OR email IN (${placeholders})`;
        },
        bindValues: (part) => [
          ...part.map((row) => row.key),
          ...part.map((row) => row.email),
        ],
      },
      accountLookups
    );

    const byKey = new Map<string, ExistingAccount>();
    const byEmail = new Map<string, ExistingAccount>();
    for (const account of accounts) {
      byKey.set(account.user_name.toLowerCase(), account);
      if (account.email) byEmail.set(account.email.toLowerCase(), account);
    }

    /*
     * One hash is shared by every new account: bcrypt is deliberately slow, so
     * hashing per row would make a 128-row import take minutes. It is only computed
     * when there is a new account to create, so an import that reuses every
     * account does not pay for a hash it discards.
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

/**
 * Edits one student.
 *
 * Exactly four fields are editable: `student_name`, `year`, `section` and `email`.
 * Everything else on the row is fixed, and each exclusion has a reason:
 *
 *   - `student_id` is the identity the path addresses, and it is also the login
 *     name the account was created under, so a new one would need a new account.
 *   - `register_no` is the key attendance is recorded against. Every mark in the
 *     cohort's attendance table, and every class-advisor report built from it, is
 *     filed under it, so a number that moved would strand that history under a
 *     value the roster no longer has. Changing a register number is therefore a
 *     deliberate re-enrolment, not a correction, and it is not something this
 *     route will do -- which also means this route can never orphan a mark.
 *   - department and batch are not columns on the row at all. They decide which
 *     table the row is in, and the table is resolved here from the registry.
 *     `body.department` and `body.batch` are therefore read as nothing more than
 *     the hint described on `findStudentCohort`, and never as a destination.
 *
 * The email is the one editable field with a consequence outside the roster, so it
 * is worth stating: `/api/auth/login` looks an account up by `user_name` *or*
 * `email`, and a student's `user_name` is their student ID. A student signing in
 * with the new address would therefore find nothing unless the linked account's
 * `email` moved with the roster. That is the only auth column written here. The
 * password hash and the account's identifier are untouched, so the student keeps
 * the password they already had, and no second account is created for the address
 * that is being freed.
 */
app.patch("/students/:studentId", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await readObjectBody(c);
    if (body instanceof Response) return body;

    const idCheck = validateStudentId(c.req.param("studentId"));
    if (!idCheck.ok) {
      return fail(c, 400, idCheck.errors[0].message, "invalid-student-id");
    }
    const studentId = idCheck.value;

    /*
     * A body may repeat the id it is editing, but it may not name a different one.
     * Refusing beats ignoring: a client that believed it renamed a student would
     * otherwise get a success for a record it did not change.
     */
    if (body.student_id !== undefined && body.student_id !== null) {
      const submitted = validateStudentId(body.student_id);
      if (!submitted.ok) {
        return fail(c, 400, submitted.errors[0].message, "invalid-student-id");
      }
      if (submitted.value !== studentId) {
        return fail(c, 400, "Student ID cannot be changed", "student-id-immutable");
      }
    }

    await ensureBatchRegistry(c.env.DB);

    // The cohort is a hint, so an unusable one is the admin's mistake to see.
    const hintDepartment = c.req.query("department");
    const hintBatch = c.req.query("batch");
    let hint: { department?: string; batch?: string } | null = null;
    if (hintDepartment !== undefined || hintBatch !== undefined) {
      const department = normalizeDepartment(hintDepartment ?? "");
      if (!department) {
        return fail(c, 400, "Choose a supported department", "invalid-department");
      }
      const batchCheck = validateBatchInput(hintBatch);
      if (!batchCheck.valid) {
        return fail(c, 400, batchCheck.message, batchCheck.code);
      }
      hint = { department, batch: batchCheck.batch };
    }

    const lookup = await findStudentCohort(c.env.DB, studentId, hint);
    if (!lookup.ok) {
      if (lookup.reason === "ambiguous") {
        return fail(
          c,
          409,
          "That student ID exists in more than one cohort. Name the department and batch to edit.",
          "student-ambiguous"
        );
      }
      if (lookup.reason === "not-provisioned") {
        // Reported as a setup problem rather than a missing student, because it is
        // one: the cohort is well-formed but the registry does not vouch for it, so
        // there is no table to edit. The same wording the list and import routes use.
        return fail(
          c,
          400,
          `That batch is not provisioned for ${hint?.department}. Create it first.`,
          "batch-not-provisioned"
        );
      }
      return fail(c, 404, "Student not found", "student-not-found");
    }
    const cohort = lookup.cohort;

    /*
     * A field that was not sent keeps its stored value, so the whole submitted
     * record is validated as one unit through the same validator the import uses.
     * That is what makes the edit form and the import form hold a student to one
     * standard: a missing name here is as fatal as a missing name in a spreadsheet.
     *
     * `register_no` is the one field whose value is taken from the row rather than
     * from the request, because it is not writable here at all. Echoing it back is
     * allowed, because a form that submits the whole record should not be punished
     * for including it; anything else is refused, so a client is never told it
     * re-registered a student whose attendance is filed under the old number. The
     * comparison is case-insensitive, matching how the roster treats a register
     * number elsewhere, so a differently-cased echo is recognised as the same value
     * and the stored one is kept.
     */
    if (body.register_no !== undefined && body.register_no !== null) {
      const echoed = String(body.register_no).trim().toLowerCase();
      if (echoed !== cohort.student.register_no.toLowerCase()) {
        return fail(c, 400, "Register number cannot be changed", "register-no-immutable");
      }
    }

    const merged = {
      student_id: studentId,
      register_no: cohort.student.register_no,
      student_name: body.student_name ?? cohort.student.student_name,
      year: body.year ?? cohort.student.year,
      section: body.section ?? cohort.student.section,
      email: body.email ?? cohort.student.email,
    };
    const validated = validateStudentRow(merged);
    if (!validated.ok) {
      return fail(c, 400, validated.errors[0].message, "student-validation-failed", {
        errors: validated.errors,
      });
    }
    const value = validated.value;

    const studentTable = assertAllowedStudentTable(cohort.studentTable);

    /*
     * The email is the only column an edit can newly collide on, since the register
     * number cannot move. It is UNIQUE, so checking it here is the difference
     * between a specific message and a 500 from a failed UPDATE, and the student
     * being edited is excluded so re-saving their own address is not a conflict
     * with themselves.
     */
    const emailClash = await c.env.DB
      .prepare(
        `SELECT student_id FROM ${studentTable}
         WHERE LOWER(email) = ? AND UPPER(student_id) <> ? LIMIT 1`
      )
      .bind(value.email, studentId)
      .first<{ student_id: string }>();
    if (emailClash) {
      return fail(
        c,
        409,
        `Email ${value.email} already belongs to another student`,
        "duplicate-email"
      );
    }

    const emailChanged = value.email !== (cohort.student.email ?? "").toLowerCase();
    const authUserId = cohort.student.auth_user_id;

    if (emailChanged && authUserId) {
      /*
       * Login matches on `user_name OR email`, and a student account's `user_name`
       * is the student ID, so the address is the only handle that moves. If some
       * other account already holds it, writing it would make that address
       * ambiguous at sign-in, so the edit is refused instead.
       */
      const accountClash = await c.env.DB
        .prepare(
          "SELECT auth_user_id FROM auth_users WHERE LOWER(email) = ? AND auth_user_id <> ? LIMIT 1"
        )
        .bind(value.email, authUserId)
        .first<{ auth_user_id: string }>();
      if (accountClash) {
        return fail(
          c,
          409,
          `Email ${value.email} already belongs to another login account`,
          "auth-email-conflict"
        );
      }
    }

    /*
     * Roster and account in one batch, so the student's sign-in address can never
     * disagree with the address on their record.
     *
     * `register_no` is absent from the SET list, and not merely equal to its old
     * value: leaving the column out is what makes it unwritable, so a future edit
     * to this statement cannot reintroduce the change by accident.
     */
    const statements: D1PreparedStatement[] = [
      c.env.DB
        .prepare(
          `UPDATE ${studentTable}
             SET student_name = ?, year = ?, section = ?, email = ?
           WHERE student_id = ?`
        )
        .bind(
          value.student_name,
          value.year,
          value.section,
          value.email,
          cohort.student.student_id
        ),
    ];

    if (emailChanged && authUserId) {
      statements.push(
        c.env.DB
          .prepare("UPDATE auth_users SET email = ? WHERE auth_user_id = ?")
          .bind(value.email, authUserId)
      );
    }

    await c.env.DB.batch(statements);

    // Read back rather than echoing the request, so the response is what D1 holds.
    const updated = await c.env.DB
      .prepare(`SELECT ${STUDENT_COLUMNS} FROM ${studentTable} WHERE student_id = ?`)
      .bind(cohort.student.student_id)
      .first<StudentRow>();

    return c.json({
      success: true,
      department: cohort.department,
      batch: cohort.batch,
      student: {
        student_id: updated?.student_id,
        register_no: updated?.register_no,
        student_name: updated?.student_name,
        year: updated?.year,
        section: updated?.section,
        email: updated?.email,
      },
      // Stated so the dashboard can say whether sign-in details moved with it.
      authEmailUpdated: Boolean(emailChanged && authUserId),
    });
  } catch (error) {
    return serverError(c, error, "Could not update that student", "student-update-failed");
  }
});

/**
 * Removes one student from its cohort's roster.
 *
 * The cohort is found exactly as the edit route finds it, from the registry rather
 * than from the request, so `?department=` and `?batch=` stay a hint that is checked
 * rather than an authority: a cohort that does not hold this student answers 404, and
 * an id that exists in two cohorts answers 409 asking the admin to disambiguate
 * instead of taking the first hit.
 *
 * ## What is preserved, and why nothing cascades
 *
 * No migration in this schema declares a `FOREIGN KEY`, and the two things that
 * would otherwise have to be cleaned up are both stored as text:
 *
 *   - attendance marks record `register_no`, not `student_id`, and no index or
 *     constraint ties the two together;
 *   - `od_requests` records `student_table` + `student_id` as a snapshot, plus
 *     `student_name`, `department`, `batch`, `year`, `section` and
 *     `mentor_email`, all copied at submission and never re-read.
 *
 * So one `DELETE FROM` against the roster table leaves every mark and every OD
 * request -- approved, rejected or still pending -- exactly as it was, which is the
 * point: an academic record outlives the enrolment that produced it. The counts are
 * returned under `preservedHistory` so the dashboard can say what was kept rather
 * than the admin having to trust that it was.
 *
 * ## The login
 *
 * A student account is created for one student and used by nobody else:
 * `auth_users.user_name` is the student id, and the import refuses an address that
 * already holds an account of another role. So when the roster row carries a link,
 * the account is removed with it, in the same `DB.batch()`, together with its
 * sessions -- otherwise the person keeps a working password for a login that now
 * resolves to no roster at all. `planAccountRemoval` still applies its role and
 * sharing checks, so a row whose link points somewhere unexpected leaves that
 * account alone rather than taking it out from under its real owner.
 */
app.delete("/students/:studentId", requireAuth, requireAdmin, async (c) => {
  try {
    const idCheck = validateStudentId(c.req.param("studentId"));
    if (!idCheck.ok) {
      return fail(c, 400, idCheck.errors[0].message, "invalid-student-id");
    }
    const studentId = idCheck.value;

    await ensureBatchRegistry(c.env.DB);

    // Read as a hint, and validated as one, for the same reason the edit route does.
    const hintDepartment = c.req.query("department");
    const hintBatch = c.req.query("batch");
    let hint: { department?: string; batch?: string } | null = null;
    if (hintDepartment !== undefined || hintBatch !== undefined) {
      const department = normalizeDepartment(hintDepartment ?? "");
      if (!department) {
        return fail(c, 400, "Choose a supported department", "invalid-department");
      }
      const batchCheck = validateBatchInput(hintBatch);
      if (!batchCheck.valid) {
        return fail(c, 400, batchCheck.message, batchCheck.code);
      }
      hint = { department, batch: batchCheck.batch };
    }

    const lookup = await findStudentCohort(c.env.DB, studentId, hint);
    if (!lookup.ok) {
      if (lookup.reason === "ambiguous") {
        return fail(
          c,
          409,
          "That student ID exists in more than one cohort. Name the department and batch to delete.",
          "student-ambiguous"
        );
      }
      if (lookup.reason === "not-provisioned") {
        return fail(
          c,
          400,
          `That batch is not provisioned for ${hint?.department}. Create it first.`,
          "batch-not-provisioned"
        );
      }
      return fail(c, 404, "Student not found", "student-not-found");
    }
    const cohort = lookup.cohort;
    const studentTable = assertAllowedStudentTable(cohort.studentTable);

    const account = await planAccountRemoval(c.env.DB, cohort.student.auth_user_id, ["student"], {
      table: studentTable,
      idColumn: "student_id",
      id: cohort.student.student_id,
    });

    // Roster row, sessions and account in one batch, which D1 runs as a
    // transaction: a student is never left with a login and no roster, or the
    // reverse.
    await c.env.DB.batch([
      c.env.DB
        .prepare(`DELETE FROM ${studentTable} WHERE student_id = ?`)
        .bind(cohort.student.student_id),
      ...account.statements,
    ]);

    // Derived rather than read, exactly as everywhere else a table name reaches
    // SQL here: the department came out of the fixed allow-list and the batch out
    // of the registry, so this cannot name a table the resolver would not produce.
    const attendanceTable = assertAllowedAttendanceTable(
      buildTableNames(cohort.department, cohort.batch).attendanceTable
    );
    const attendance = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM ${attendanceTable} WHERE LOWER(register_no) = ?`)
      .bind((cohort.student.register_no ?? "").toLowerCase())
      .first<{ n: number }>();
    const odRequests = (await tableExists(c.env.DB, "od_requests"))
      ? await c.env.DB
          .prepare(
            `SELECT COUNT(*) AS n FROM od_requests
             WHERE student_table = ? AND UPPER(student_id) = UPPER(?)`
          )
          .bind(studentTable, cohort.student.student_id)
          .first<{ n: number }>()
      : null;

    return c.json({
      success: true,
      department: cohort.department,
      batch: cohort.batch,
      student: {
        student_id: cohort.student.student_id,
        register_no: cohort.student.register_no,
        student_name: cohort.student.student_name,
      },
      authAccountRemoved: account.removed,
      // Said plainly so the dashboard is not left implying a login was revoked when
      // the account was somebody else's to begin with.
      authAccountKept: account.keptReason,
      preservedHistory: {
        attendanceMarks: attendance?.n ?? 0,
        odRequests: odRequests?.n ?? 0,
      },
    });
  } catch (error) {
    return serverError(c, error, "Could not delete that student", "student-delete-failed");
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

    // One parameter per row, chunked so a large staff file stays under D1's cap.
    const existingRows = await selectInChunks<{ email: string }>(
      c.env.DB,
      {
        parametersPerRow: 1,
        buildSql: (part) =>
          `SELECT email FROM staff WHERE email IN (${part.map(() => "?").join(",")})`,
        bindValues: (part) => part.map((row) => row.email),
      },
      deduped.map((entry) => ({ email: entry.value.email }))
    );
    const existingEmails = new Set(existingRows.map((row) => row.email.toLowerCase()));

    const toInsert = deduped.filter((entry) => !existingEmails.has(entry.value.email));
    const skipped = deduped.length - toInsert.length;

    const accountLookups = toInsert.map((entry) => ({
      key: staffUserName(entry.value.email),
      email: entry.value.email,
    }));
    const accounts = await selectInChunks<
      { key: string; email: string },
      ExistingAccount
    >(
      c.env.DB,
      {
        parametersPerRow: 2,
        buildSql: (part) => {
          const placeholders = part.map(() => "?").join(",");
          return `SELECT auth_user_id, user_name, role, email FROM auth_users
            WHERE user_name IN (${placeholders}) OR email IN (${placeholders})`;
        },
        bindValues: (part) => [
          ...part.map((row) => row.key),
          ...part.map((row) => row.email),
        ],
      },
      accountLookups
    );

    const byKey = new Map<string, ExistingAccount>();
    const byEmail = new Map<string, ExistingAccount>();
    for (const account of accounts) {
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

/**
 * Edits one staff member.
 *
 * `staff_id` is fixed: it is the key the path addresses, it is UNIQUE with no
 * default, and `/api/auth/staff/login` accepts it as an alternative to an email.
 * A body naming a different one is refused rather than ignored.
 *
 * Department *is* editable, unlike a student's, because `staff` is one table keyed
 * by a department column rather than a table per cohort -- so moving someone is a
 * single column write rather than a move between files. The advisor columns follow
 * the same rules as the import, applied by `validateStaffRow`: a non-advisor has no
 * advisor values at all (they are cleared, not left behind), and an advisor needs a
 * cohort, a year and a section together, with the cohort resolved against the
 * *new* department so a move cannot leave an advisor pointing at another
 * department's tables.
 */
app.patch("/staff/:staffId", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await readObjectBody(c);
    if (body instanceof Response) return body;

    const idCheck = validateStaffId(c.req.param("staffId"));
    if (!idCheck.ok) {
      return fail(c, 400, idCheck.errors[0].message, "invalid-staff-id");
    }
    const staffId = idCheck.value;

    if (body.staff_id !== undefined && body.staff_id !== null) {
      const submitted = validateStaffId(body.staff_id);
      if (!submitted.ok) {
        return fail(c, 400, submitted.errors[0].message, "invalid-staff-id");
      }
      if (submitted.value !== staffId) {
        return fail(c, 400, "Staff ID cannot be changed", "staff-id-immutable");
      }
    }

    const existing = await c.env.DB
      .prepare(
        `SELECT staff_id, staff_name, email, department, class_advisor,
                advisor_year, advisor_section, advisor_batch, auth_user_id
         FROM staff
         WHERE staff_id = ?
         LIMIT 1`
      )
      .bind(staffId)
      .first<{
        staff_id: string;
        staff_name: string;
        email: string;
        department: string;
        class_advisor: string | null;
        advisor_year: number | null;
        advisor_section: string | null;
        advisor_batch: string | null;
        auth_user_id: string | null;
      }>();
    if (!existing) {
      return fail(c, 404, "Staff member not found", "staff-not-found");
    }

    const department = normalizeDepartment(body.department ?? existing.department);
    if (!department) {
      return fail(c, 400, "Choose a supported department", "invalid-department");
    }

    /*
     * A field that was not sent keeps its stored value, then the whole record is
     * validated through the same validator the import uses.
     *
     * An explicit `null` counts as "not sent" for the advisor columns, which is
     * harmless: `validateStaffRow` derives what is stored from the flag rather than
     * from what arrived, so a non-advisor's three columns are cleared whether the
     * request omitted them, nulled them or sent their old values. Sending a cohort
     * for someone who does not advise one cannot survive this line.
     */
    const validated = validateStaffRow({
      staff_name: body.staff_name ?? existing.staff_name,
      email: body.email ?? existing.email,
      class_advisor: body.class_advisor ?? existing.class_advisor,
      advisor_year: body.advisor_year ?? existing.advisor_year,
      advisor_section: body.advisor_section ?? existing.advisor_section ?? "",
      advisor_batch: body.advisor_batch ?? existing.advisor_batch ?? "",
    });
    if (!validated.ok) {
      return fail(c, 400, validated.errors[0].message, "staff-validation-failed", {
        errors: validated.errors,
      });
    }
    const value = validated.value;

    /*
     * The advisor cohort has to be one this department can actually serve.
     *
     * Checked after validation and against the department being written, so a
     * move from IT to CSE cannot carry a CSE-only cohort across with it, and so a
     * non-advisor is never subjected to the check at all -- `validateStaffRow` has
     * already cleared its cohort, so there is nothing left to resolve.
     */
    if (value.class_advisor === "Y" && value.advisor_batch) {
      await ensureBatchRegistry(c.env.DB, { force: true });
      if (!resolveTables(department, value.advisor_batch)) {
        return fail(
          c,
          400,
          `Advisor batch ${value.advisor_batch} is not provisioned for ${department}. Create it first.`,
          "batch-not-provisioned"
        );
      }
    }

    const emailClash = await c.env.DB
      .prepare("SELECT staff_id FROM staff WHERE LOWER(email) = ? AND staff_id <> ? LIMIT 1")
      .bind(value.email, existing.staff_id)
      .first<{ staff_id: string }>();
    if (emailClash) {
      return fail(
        c,
        409,
        `Email ${value.email} already belongs to another staff member`,
        "duplicate-email"
      );
    }

    const authUserId = existing.auth_user_id;
    const emailChanged = value.email !== (existing.email ?? "").toLowerCase();
    const account = authUserId
      ? await c.env.DB
          .prepare("SELECT auth_user_id, user_name, role, email FROM auth_users WHERE auth_user_id = ?")
          .bind(authUserId)
          .first<{ auth_user_id: string; user_name: string; role: string; email: string | null }>()
      : null;

    /*
     * A staff account signs in by address: `/api/auth/staff/login` looks up
     * `user_name` or `email` with the address typed in, and provisioning creates
     * `user_name` as the lower-cased address. So when the address moves, the
     * account has to move with it or the person is locked out.
     *
     * The account is *updated*, never re-created: the same `auth_user_id` and the
     * same `pwd_hash` are kept, so the password the person already had still
     * works and no second row is left claiming their old address. `user_name` is
     * only rewritten when it currently *is* the old address, because a staff
     * account whose `user_name` is something else (an employee number, say) is
     * deliberately signed into with that, and clobbering it would break the other
     * way round. The `email` column is corrected either way.
     */
    if (emailChanged && account) {
      const clash = await c.env.DB
        .prepare(
          `SELECT auth_user_id FROM auth_users
            WHERE auth_user_id <> ? AND (LOWER(user_name) = ? OR LOWER(email) = ?)
            LIMIT 1`
        )
        .bind(account.auth_user_id, value.email, value.email)
        .first<{ auth_user_id: string }>();
      if (clash) {
        return fail(
          c,
          409,
          `Email ${value.email} already belongs to another login account`,
          "auth-email-conflict"
        );
      }
    }

    /*
     * The class-advisor routes authorise on the *account* role, not on
     * `staff.class_advisor`, so the two have to agree. Toggling the flag without
     * moving the role would either lock a new advisor out of the routes they now
     * need, or leave a demoted one with access they no longer have. Only a role
     * this application issues for staff is rewritten, so an account that is
     * something else entirely is left alone.
     */
    const desiredRole = value.class_advisor === "Y" ? "class_advisor" : "staff";
    const nextRole =
      account && (account.role === "staff" || account.role === "class_advisor")
        ? desiredRole
        : account?.role;

    const statements: D1PreparedStatement[] = [
      c.env.DB
        .prepare(
          `UPDATE staff
              SET staff_name = ?, email = ?, department = ?, class_advisor = ?,
                  advisor_year = ?, advisor_section = ?, advisor_batch = ?
            WHERE staff_id = ?`
        )
        .bind(
          value.staff_name,
          value.email,
          department,
          value.class_advisor,
          value.advisor_year,
          value.advisor_section || null,
          value.advisor_batch || null,
          existing.staff_id
        ),
    ];

    if (account) {
      const nextUserName =
        emailChanged && account.user_name.toLowerCase() === (existing.email ?? "").toLowerCase()
          ? staffUserName(value.email)
          : account.user_name;
      const nextEmail = value.email;
      if (
        nextUserName !== account.user_name ||
        nextEmail !== (account.email ?? "") ||
        nextRole !== account.role
      ) {
        statements.push(
          c.env.DB
            .prepare("UPDATE auth_users SET user_name = ?, email = ?, role = ? WHERE auth_user_id = ?")
            .bind(nextUserName, nextEmail, nextRole, account.auth_user_id)
        );
      }
    }

    await c.env.DB.batch(statements);

    // Read back rather than echoing the request, so the response is what D1 holds.
    // The projection matches the list route exactly, which also means it cannot
    // grow a password hash by accident.
    const updated = await c.env.DB
      .prepare(
        `SELECT staff_id, staff_name, email, department, class_advisor,
                advisor_year, advisor_section, advisor_batch
         FROM staff
         WHERE staff_id = ?`
      )
      .bind(existing.staff_id)
      .first();

    return c.json({
      success: true,
      staff: updated ?? null,
      authAccountUpdated: statements.length > 1,
    });
  } catch (error) {
    return serverError(c, error, "Could not update that staff member", "staff-update-failed");
  }
});

/**
 * Removes one staff member from the roster.
 *
 * ## What is preserved
 *
 * Everything that mentions a member of staff does so as text, so nothing cascades and
 * nothing has to be cascaded deliberately:
 *
 *   - `attendance_session.created_by` holds the `staff_id` of whoever generated the
 *     session, and `created_by_name` holds their name. A finalized session keeps both,
 *     and the per-cohort marks tables are keyed by `attendance_id`, not by staff.
 *   - `od_requests` records the mentor by `mentor_email` and the advisor by
 *     `advisor_decided_by`, both copied at the moment of the decision.
 *
 * So a person who marked a term of attendance and approved a fortnight of OD can be
 * removed from the roster, and the record of what they did stays readable. The
 * counts come back under `preservedHistory`.
 *
 * ## The one dependency that blocks
 *
 * A contest coordinator is appointed out of a department's staff roster, so
 * `contest_coordinators` rows share the address and often the account with a `staff`
 * row. Removing the staff member first would leave an appointment whose subject is no
 * longer on the roster -- and the coordinator picker only offers people who are, so
 * the appointment could no longer be edited or renewed from the UI. That is a 409
 * naming the appointment, rather than a deletion that quietly orphans it. Removing
 * the appointment first is not a workaround the data loses anything by: nothing in
 * `contest_coordinators` refers back to `staff`, and the freed department can be
 * filled the moment the coordinator route has deleted the row.
 *
 * A class-advisor assignment is *not* a blocker, because it is a set of columns on
 * this row rather than a separate record: it goes with the row, and the students it
 * advised keep their attendance.
 *
 * ## The login
 *
 * A staff account is created for one member of staff and used by nobody else --
 * `/api/auth/staff/login` matches `user_name` or `email` and both are theirs. So the
 * account is removed with the row, in the same `DB.batch()`, along with its sessions.
 * `planAccountRemoval` applies its role and sharing checks first, so an account whose
 * role is not one the staff import issues is left alone rather than being taken away
 * from whoever really holds it.
 */
app.delete("/staff/:staffId", requireAuth, requireAdmin, async (c) => {
  try {
    const idCheck = validateStaffId(c.req.param("staffId"));
    if (!idCheck.ok) {
      return fail(c, 400, idCheck.errors[0].message, "invalid-staff-id");
    }
    const staffId = idCheck.value;

    const existing = await c.env.DB
      .prepare(
        `SELECT staff_id, staff_name, email, department, class_advisor,
                advisor_year, advisor_section, advisor_batch, auth_user_id
         FROM staff
         WHERE staff_id = ?
         LIMIT 1`
      )
      .bind(staffId)
      .first<{
        staff_id: string;
        staff_name: string;
        email: string;
        department: string;
        class_advisor: string | null;
        auth_user_id: string | null;
      }>();
    if (!existing) {
      return fail(c, 404, "Staff member not found", "staff-not-found");
    }

    // Matched on either handle, because the appointment may predate `0018` and carry
    // no `auth_user_id` of its own -- in which case the address is the only thing the
    // two records are known to share.
    const appointment = await c.env.DB
      .prepare(
        `SELECT coordinator_id, department FROM contest_coordinators
         WHERE LOWER(email) = ? OR (auth_user_id IS NOT NULL AND auth_user_id = ?)
         LIMIT 1`
      )
      .bind(existing.email.toLowerCase(), existing.auth_user_id ?? "")
      .first<{ coordinator_id: number; department: string }>();
    if (appointment) {
      return fail(
        c,
        409,
        `${existing.staff_name} is currently the ${appointment.department} contest coordinator. Remove that appointment first.`,
        "staff-appointment-conflict",
        { coordinatorId: appointment.coordinator_id, department: appointment.department }
      );
    }

    await ensureBatchRegistry(c.env.DB);

    const account = await planAccountRemoval(
      c.env.DB,
      existing.auth_user_id,
      ["staff", "class_advisor"],
      { table: "staff", idColumn: "staff_id", id: existing.staff_id }
    );

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM staff WHERE staff_id = ?").bind(existing.staff_id),
      ...account.statements,
    ]);

    const sessions = await c.env.DB
      .prepare("SELECT COUNT(*) AS n FROM attendance_session WHERE created_by = ?")
      .bind(existing.staff_id)
      .first<{ n: number }>();

    return c.json({
      success: true,
      staff: {
        staff_id: existing.staff_id,
        staff_name: existing.staff_name,
        email: existing.email,
        department: existing.department,
      },
      authAccountRemoved: account.removed,
      authAccountKept: account.keptReason,
      authAccountKeptRole: account.keptRole,
      preservedHistory: {
        attendanceSessions: sessions?.n ?? 0,
        odRequests: await countOdDecisionsBy(c.env.DB, existing.email, [
          "mentor_email",
          "advisor_decided_by",
        ]),
      },
    });
  } catch (error) {
    return serverError(c, error, "Could not delete that staff member", "staff-delete-failed");
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

    // Chunked: this binds one parameter per row and the request cap allows up to
    // 2000 rows, so a large subject file would otherwise exceed D1's limit.
    const existingRows = await selectInChunks<{ subject_code: string }>(
      c.env.DB,
      {
        parametersPerRow: 1,
        buildSql: (part) =>
          `SELECT subject_code FROM subjects WHERE subject_code IN (${part.map(() => "?").join(",")})`,
        bindValues: (part) => part.map((row) => row.subject_code),
      },
      deduped.map((entry) => ({ subject_code: entry.value.subject_code }))
    );
    const existingCodes = new Set(existingRows.map((row) => row.subject_code.toUpperCase()));

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

/**
 * Edits one catalog subject.
 *
 * Two columns, `subject_code` and `subject_name`, and no others. This is the
 * global catalog: a subject carries no department, no year and no section, because
 * it must never decide which attendance table a mark lands in. Reintroducing any of
 * those here would couple one subject row to a cohort, which is the thing migration
 * 0015 removed.
 *
 * `subject_id` is fixed. It is the key the path addresses, it is the primary key,
 * and historical attendance rows record the code and name rather than the id, so
 * nothing points at it -- but reissuing it would still break any client that
 * cached one, which is why a body naming a different id is refused.
 *
 * Note what is *not* written: `attendance_session` snapshots the code and name at
 * the moment a session is generated, so renaming a subject leaves past sessions
 * readable as they were taken. Rewriting history would be a data change, not an
 * edit, and the task is not to do one.
 */
app.patch("/subjects/:subjectId", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await readObjectBody(c);
    if (body instanceof Response) return body;

    // `subject_id` is an INTEGER PRIMARY KEY, so it is validated as a positive
    // integer rather than as free text: a non-numeric id is a client mistake, and
    // saying so is more useful than an empty result.
    const subjectId = Number(c.req.param("subjectId"));
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      return fail(c, 400, "Invalid subject ID", "invalid-subject-id");
    }

    if (body.subject_id !== undefined && body.subject_id !== null) {
      if (Number(body.subject_id) !== subjectId) {
        return fail(c, 400, "Subject ID cannot be changed", "subject-id-immutable");
      }
    }

    const existing = await c.env.DB
      .prepare("SELECT subject_id, subject_code, subject_name FROM subjects WHERE subject_id = ?")
      .bind(subjectId)
      .first<{ subject_id: number; subject_code: string; subject_name: string }>();
    if (!existing) {
      return fail(c, 404, "Subject not found", "subject-not-found");
    }

    // Same rule as the students: an unsent field keeps its stored value, and the
    // merged record goes through the import's own validator.
    const validated = validateSubjectRow({
      subject_code: body.subject_code ?? existing.subject_code,
      subject_name: body.subject_name ?? existing.subject_name,
    });
    if (!validated.ok) {
      return fail(c, 400, validated.errors[0].message, "subject-validation-failed", {
        errors: validated.errors,
      });
    }
    const value = validated.value;

    // UNIQUE on the code, checked against the current subject excluded so that
    // re-saving unchanged values is not a conflict with itself.
    const clash = await c.env.DB
      .prepare("SELECT subject_id FROM subjects WHERE UPPER(subject_code) = ? AND subject_id <> ? LIMIT 1")
      .bind(value.subject_code, subjectId)
      .first<{ subject_id: number }>();
    if (clash) {
      return fail(
        c,
        409,
        `Subject code ${value.subject_code} already belongs to another subject`,
        "duplicate-subject-code"
      );
    }

    await c.env.DB
      .prepare("UPDATE subjects SET subject_code = ?, subject_name = ? WHERE subject_id = ?")
      .bind(value.subject_code, value.subject_name, subjectId)
      .run();

    // Read back rather than echoing the request, so the response is what D1 holds.
    const updated = await c.env.DB
      .prepare("SELECT subject_id, subject_code, subject_name FROM subjects WHERE subject_id = ?")
      .bind(subjectId)
      .first();

    return c.json({ success: true, subject: updated ?? null });
  } catch (error) {
    return serverError(c, error, "Could not update that subject", "subject-update-failed");
  }
});

/**
 * Removes one catalog subject.
 *
 * ## This is the one deletion that can be refused, and it is refused on purpose
 *
 * `subjects` is a catalog: a code and a name, referenced by nothing at all -- no
 * migration declares a foreign key onto it. Marks are stored under the subject's
 * *code*, in `attendance_session` and in every `{DEPARTMENT}_Attendance_{BATCH}`
 * table, and a class advisor can file a mark against a subject with no session at all
 * (`POST /api/attendance/:table` resolves `subject_code` from `subject_id` on its
 * own). So a subject that has been taught is named in rows that will outlive it.
 *
 * Deleting the catalog entry would not corrupt those rows -- they hold the code and
 * the name as text, exactly as `attendance_session` was designed to snapshot them --
 * but it would leave a code filed under in the marks of every student who sat it,
 * with no catalog entry to explain what it was. That is a worse state than the one
 * the admin is trying to reach, and it is not the admin's call to make by accident,
 * so a subject anything references is a 409 that says so in those terms. A subject
 * that has never been used deletes cleanly, which is the case an admin is actually
 * in when they reach for this.
 *
 * The scan covers both places a code can appear: the session table, and the marks
 * table of every cohort the registry knows about. Cohort tables are named through
 * `assertAllowedAttendanceTable`, so the loop can only ever query a table the
 * resolver already vouched for.
 *
 * There is no login to think about here. A subject has no `auth_user_id` and no
 * account, so the delete is one statement against one table.
 */
app.delete("/subjects/:subjectId", requireAuth, requireAdmin, async (c) => {
  try {
    // Validated exactly as the edit route validates it: an INTEGER PRIMARY KEY in the
    // path, so a non-numeric value is a client mistake rather than a missing record.
    const subjectId = Number(c.req.param("subjectId"));
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      return fail(c, 400, "Invalid subject ID", "invalid-subject-id");
    }

    const existing = await c.env.DB
      .prepare("SELECT subject_id, subject_code, subject_name FROM subjects WHERE subject_id = ?")
      .bind(subjectId)
      .first<{ subject_id: number; subject_code: string; subject_name: string }>();
    if (!existing) {
      return fail(c, 404, "Subject not found", "subject-not-found");
    }

    await ensureBatchRegistry(c.env.DB);

    const sessions = await c.env.DB
      .prepare("SELECT COUNT(*) AS n FROM attendance_session WHERE subject_code = ?")
      .bind(existing.subject_code)
      .first<{ n: number }>();

    let marks = 0;
    for (const tables of listAllowedStudentTables()) {
      const attendanceTable = assertAllowedAttendanceTable(tables.attendanceTable);
      const row = await c.env.DB
        .prepare(`SELECT COUNT(*) AS n FROM ${attendanceTable} WHERE subject_code = ?`)
        .bind(existing.subject_code)
        .first<{ n: number }>();
      marks += row?.n ?? 0;
    }

    const referenced = (sessions?.n ?? 0) + marks;
    if (referenced > 0) {
      return fail(
        c,
        409,
        `Cannot delete ${existing.subject_code} because ${referenced} attendance record${
          referenced === 1 ? "" : "s"
        } reference it.`,
        "subject-in-use",
        { attendanceSessions: sessions?.n ?? 0, attendanceMarks: marks }
      );
    }

    await c.env.DB.prepare("DELETE FROM subjects WHERE subject_id = ?").bind(subjectId).run();

    return c.json({
      success: true,
      subject: {
        subject_id: existing.subject_id,
        subject_code: existing.subject_code,
        subject_name: existing.subject_name,
      },
      preservedHistory: { attendanceSessions: 0, attendanceMarks: 0 },
    });
  } catch (error) {
    return serverError(c, error, "Could not delete that subject", "subject-delete-failed");
  }
});

/* ------------------------------------------ hods and contest coordinators */

/**
 * A directory entry: a person, an address, and the department they belong to.
 *
 * `hods` and `contest_coordinators` are the same record under two names, so they
 * share one validator, one import contract and one set of responses. Only the
 * column names differ, and those live in the spec rather than in the request.
 */
interface DirectoryInput {
  name: string;
  email: string;
  department: string;
}

interface DirectorySpec {
  /** Route prefix under `/api/admin`. */
  path: string;
  /** Literal table name. Never derived from anything the client sent. */
  table: string;
  /** Literal primary key column. Assigned by the database, never by the client. */
  idColumn: string;
  /** Literal name column, and the id echoed by the list and read-back responses. */
  nameColumn: string;
  /** Name of the path parameter, so the route and the read agree. */
  idParam: string;
  /** The role this directory's accounts are created with. */
  role: ProvisionedRole;
  /** Singular noun for messages, e.g. "HOD". */
  label: string;
  /** Key the list is returned under, and the id-validation error code. */
  listKey: string;
  /** Error-code stem, e.g. `hod` in `hod-not-found`. */
  codeStem: string;
  /**
   * Set for a directory whose members are *already on the staff roster*, which is
   * contest coordinators and nothing else. A coordinator is appointed out of a
   * department's staff, so two things follow that are false for a head of department:
   *
   *   1. The address being added already holds an account -- with the role `staff`,
   *      created by the staff import. `auth_users.user_name` is UNIQUE, so the only
   *      options are "refuse" or "reuse", and refusal meant a coordinator could never
   *      be anybody who is actually on staff. So the account is reused: same
   *      `auth_user_id`, same role, same password, no second `auth_users` row, and no
   *      `roleMismatches`. Approval authority never came from the role --
   *      `verifyApprover` matches the caller's own address against this directory --
   *      so keeping the `staff` role is what lets them action their own OD queue.
   *
*   2. The row records `auth_user_id`, the account this appointment belongs to. Both roles
   *      are permanent users of the existing authentication architecture, and both
   *      approver routes resolve a signed-in session through that column rather than
   *      through the address -- `/api/auth/od-approver/login` and `/api/approver/me` --
   *      so a row without it cannot be signed in as. For a coordinator it is the reused
   *      staff account's own id, so the two roles share one login and one password.
   *
   * Head of department leaves this unset and is unaffected by the first point: an HOD is
   * appointed *to* a department, is not expected to already be staff, and an address
   * holding another kind of account really is a different person. Its rows are written
   * exactly as before.
   */
  provisionFromStaff?: boolean;
  /**
   * Set for a directory that holds exactly one person per department, which is contest
   * coordinators and nothing else.
   *
   * The workflow treats the coordinator for a department as a single addressee: the
   * approval mail is sent to one coordinator, their dashboard is one queue, and the
   * coordinator stage is one step in a fixed chain. Two rows for one department make all
   * three untrue at once, and no ordering of the rows makes it true again -- somebody is
   * always the coordinator and somebody is never told about it.
   *
   * So the second appointment is refused rather than resolved:
   *
   *   - on create, a row whose department is already held joins the `invalid` list, with
   *     the error on the `department` field, so a bulk import still imports the rows that
   *     are fine and reports this one instead of dropping it;
   *   - on edit, moving an entry into an occupied department is a 409, exactly as moving
   *     it onto a taken email is. Re-saving it in the department it already holds is not
   *     a conflict, because the entry being edited is excluded from the check.
   *
   * The check is deliberately the row's own uniqueness, not a database constraint. There
   * is no `UNIQUE` on `department` in any migration, and adding one to a deployed table
   * is a change to production data rather than to this feature; if duplicates already
   * exist, a constraint would refuse to be created and this rule would keep the directory
   * from growing any more. Nothing here deletes or rewrites an existing row: cleaning up
   * a department that already holds two is an administrative decision, not a side effect
   * of saving a form.
   *
   * Head of department leaves this unset. Nothing in the workflow or the dashboard
   * depends on there being only one HOD, so the rule is not extended to it here.
   */
  onePerDepartment?: boolean;
  /**
   * The account roles this directory is allowed to delete along with a row, and so the
   * only roles `planAccountRemoval` will act on for it.
   *
   * The distinction is the whole reason this field exists, and it follows
   * `provisionFromStaff` directly:
   *
   *   - a head of department is appointed to a department, so its account was created
   *     for the appointment and belongs to nobody else. `["hod"]` -- when the row goes,
   *     the login goes, or a person who is no longer a head of department keeps a
   *     working password.
   *   - a contest coordinator is appointed out of a department's staff roster, so the
   *     account behind the address is the *reused staff account*, whose role is
   *     `staff`. `["contest_coordinator"]` covers the case where one does exist -- an
   *     address that already held a coordinator account -- and never touches the staff
   *     one. Removing a coordinator must not sign a colleague off the staff roster.
   *
   * `planAccountRemoval` additionally refuses to remove an account that some other
   * live row still references, so this is the first of two gates rather than the only
   * one.
   */
  ownedAccountRoles?: readonly string[];
  /**
   * The `od_requests` columns this directory's members appear in, as *approvers*.
   *
   * `od_requests` records each of the four stages in its own column group rather than
   * in a shared decisions table, so the answer differs per role and cannot be derived
   * from `codeStem` without the next field in the spec quietly having to keep matching
   * this one's naming. Stated here instead: `hod_decided_by` for a head of department,
   * `coordinator_decided_by` for a coordinator.
   *
   * Read only to report what the delete preserved. Nothing in the workflow is touched
   * by a directory row going away, which is the point of stating it.
   */
  odApproverColumns: readonly string[];
  /**
   * The row validator, in its own column vocabulary.
   *
   * Typed against only the two fields both directories share, so each concrete
   * validator's richer result -- `HodInput`, `ContestCoordinatorInput` -- is
   * assignable to it, and `directoryValidator` does the narrowing to the three
   * fields the routes actually use.
   */
  validateRow: (row: unknown) => RowResult<{ email: string; department: string }>;
}

/**
 * Adapts a row validator that speaks in column names into one that speaks in the
 * three directory fields.
 *
 * The column names are read back out of the validated value using the spec's own
 * `nameColumn`, so `hod_name` and `coordinator_name` survive validation and the
 * error objects the caller sees still name the field the dashboard has an input
 * for.
 */
function directoryValidator<T extends { email: string; department: string }>(
  spec: DirectorySpec,
  validate: (row: unknown) => RowResult<T>
): (row: unknown) => RowResult<DirectoryInput> {
  return (row: unknown) => {
    const result = validate(row);
    if (!result.ok) return { ok: false, errors: result.errors };
    // `nameColumn` is a literal from the spec and the validator it is paired with
    // is written against that same spec, so the lookup is guaranteed to exist. The
    // assertion is here only because TypeScript cannot see that pairing.
    const value = result.value as T & Record<string, string>;
    return {
      ok: true,
      value: {
        name: value[spec.nameColumn],
        email: value.email,
        department: value.department,
      },
    };
  };
}

/**
 * An `INTEGER PRIMARY KEY` addressed by the path.
 *
 * Validated as a positive integer for the same reason `subject_id` is: the
 * column is a database-generated autoincrement, so a non-numeric value in the
 * path is a client mistake rather than a record that does not exist, and saying
 * so is more useful than an empty result.
 *
 * The parameter is optional because Hono types `req.param()` from the route
 * pattern, and these routes are registered from a template literal so the name is
 * not statically known. A missing parameter reaches `Number(undefined)`, which is
 * `NaN`, and is therefore refused by the same check.
 */
function validateDirectoryId(value: string | undefined): number | null {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/**
 * The departments in `departments` that `table` already holds somebody for.
 *
 * Used only by the one-per-department rule, and it answers a question about existing data
 * rather than about the submitted rows -- so the check has to be against the table, not
 * against the validated input, or re-uploading a file that is already there would report
 * its own rows as conflicts.
 *
 * `table` is a literal from the `DirectorySpec` above and never anything a request
 * supplied, which is why it is interpolated; the department values come from the request
 * and are bound, so the statement cannot be steered by them. The `IN` list is built from
 * request data, so it goes through `selectInChunks` like every other such lookup -- a
 * file can name far more rows than D1 will bind.
 */
async function occupiedDepartments(
  db: D1Database,
  table: string,
  departments: readonly string[]
): Promise<Set<string>> {
  const rows = await selectInChunks<{ department: string }>(
    db,
    {
      parametersPerRow: 1,
      buildSql: (part) =>
        `SELECT DISTINCT department FROM ${table} WHERE department IN (${part.map(() => "?").join(",")})`,
      bindValues: (part) => part.map((row) => row.department),
    },
    Array.from(new Set(departments), (department) => ({ department }))
  );
  return new Set(rows.map((row) => row.department));
}

/**
 * The rows of `rows` whose department is still free, with the rest reported as errors.
 *
 * "Free" means no row on the table holds it -- and, because a single request can claim the
 * same department twice, no earlier row in this request took it either. The first row to
 * claim a department wins and the rest are refused, which is the same rule the in-file
 * duplicate check above applies to an address.
 *
 * Errors are appended to `invalid` rather than returned, so a row rejected for a
 * department the directory already fills is reported in the same shape, on the same list
 * and with the same 1-based row number, as a row rejected for a malformed address.
 */
async function withoutOccupiedDepartments(
  c: any,
  spec: DirectorySpec,
  table: string,
  rows: readonly { row: number; value: DirectoryInput }[],
  invalid: { row: number; errors: { field: string; message: string }[] }[]
): Promise<{ row: number; value: DirectoryInput }[]> {
  const taken = await occupiedDepartments(
    c.env.DB,
    table,
    rows.map((entry) => entry.value.department)
  );

  const free: { row: number; value: DirectoryInput }[] = [];
  for (const entry of rows) {
    if (taken.has(entry.value.department)) {
      invalid.push({
        row: entry.row,
        errors: [
          {
            field: "department",
            message: `${entry.value.department} already has a ${spec.label.toLowerCase()}, and there is exactly one per department.`,
          },
        ],
      });
      continue;
    }
    taken.add(entry.value.department);
    free.push(entry);
  }
  return free;
}

/**
 * Registers the list, create and edit routes for one directory.
 *
 * The three routes are generated from a literal spec rather than written out per
 * table, and every SQL identifier in them comes from that spec. Nothing here is
 * interpolated from the request body or the URL: the table name, the id column and
 * the name column are compile-time strings in this file, and the one value that
 * does come from the client -- the id -- is bound as a parameter.
 */
function registerDirectoryRoutes(spec: DirectorySpec): void {
  const validateDirectoryRow = directoryValidator(spec, spec.validateRow);
  const {
    table,
    idColumn,
    nameColumn,
    provisionFromStaff = false,
    onePerDepartment = false,
    ownedAccountRoles = [],
  } = spec;
  const odApproverColumns = spec.odApproverColumns;

  /* ------------------------------------------------------------------- list */

  /*
   * Every entry, with no department filter.
   *
   * `staff` is department-scoped only because the staff page asks for one
   * department before showing a list. A head of department or a contest
   * coordinator is one person per department, so the whole directory fits on one
   * screen and filtering it would mean an admin could not see that a department
   * already has one. `?department=` is still accepted as an optional narrowing
   * for a caller that wants it, and is refused when the value is not one of the
   * supported departments, so the filter can never silently match nothing.
   *
   * The projection names four columns. That is also the reason this response
   * cannot grow a password hash: the list is built from an explicit column list,
   * not `SELECT *`.
   */
  app.get(spec.path, requireAuth, requireAdmin, async (c) => {
    try {
      const requested = c.req.query("department");
      const department = requested === undefined ? null : normalizeDepartment(requested);
      if (requested !== undefined && !department) {
        return fail(c, 400, "Choose a supported department", "invalid-department");
      }

      const rows = department
        ? await c.env.DB
            .prepare(
              `SELECT ${idColumn}, ${nameColumn}, email, department, created_at
               FROM ${table}
               WHERE department = ?
               ORDER BY ${nameColumn}`
            )
            .bind(department)
            .all()
        : await c.env.DB
            .prepare(
              `SELECT ${idColumn}, ${nameColumn}, email, department, created_at
               FROM ${table}
               ORDER BY ${nameColumn}`
            )
            .all();

      return c.json({
        success: true,
        ...(department ? { department } : {}),
        [spec.listKey]: rows?.results ?? [],
      });
    } catch (error) {
      return serverError(c, error, `Could not load ${spec.label.toLowerCase()}s`, `${spec.codeStem}s-list-failed`);
    }
  });

  /* ----------------------------------------------------------------- create */

  /*
   * Creates directory entries and their login accounts.
   *
   * Shaped exactly like the staff import, because it solves the same problem in the
   * same table shape:
   *
   *   - `email` is UNIQUE in the directory table, so an address already present is
   *     reported as skipped rather than inserted. Re-uploading the same file is
   *     therefore a no-op instead of a UNIQUE-constraint failure.
   *   - an account that already exists for the address is reused, so no second
   *     `auth_users` row is created and no existing password is reset.
   *   - an account that exists with a *different* role is a conflict, not a reuse:
   *     `user_name` is UNIQUE and both accounts would be the address, so the row is
   *     excluded and reported rather than leaving an entry nobody can sign in as.
   *     `spec.provisionFromStaff` is the one exception, and it is what makes a member
   *     of staff appointable as a contest coordinator: see that field for why reuse is
   *     the right answer there and refusal the right answer everywhere else.
   *   - the directory rows and the accounts are written in one `DB.batch()`, which
   *     is a transaction, so an entry is never created without its account.
   *
   * The id is absent from every INSERT. `hod_id` and `coordinator_id` are
   * `INTEGER PRIMARY KEY AUTOINCREMENT`, so the database assigns them; a client
   * that supplies one is not trusted with it because the value would have to be
   * interpolated into the column list to be honoured at all.
   */
  app.post(spec.path, requireAuth, requireAdmin, async (c) => {
    try {
      const rawRows = await readRows(c);
      if (rawRows instanceof Response) return rawRows;

      const validated: { row: number; value: DirectoryInput }[] = [];
      const invalid: { row: number; errors: { field: string; message: string }[] }[] = [];
      rawRows.forEach((raw, index) => {
        const result = validateDirectoryRow(raw);
        if (result.ok) {
          validated.push({ row: index + 1, value: result.value });
        } else {
          invalid.push({ row: index + 1, errors: result.errors });
        }
      });

      if (validated.length === 0) {
        return fail(c, 400, "No valid rows to import", "import-validation-failed", { invalid });
      }

      // In-file duplicates: the same address twice is a data error, not a second
      // person. The first occurrence wins.
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

      // One parameter per row, chunked so a large file stays under D1's cap.
      const existingRows = await selectInChunks<{ email: string }>(
        c.env.DB,
        {
          parametersPerRow: 1,
          buildSql: (part) =>
            `SELECT email FROM ${table} WHERE LOWER(email) IN (${part.map(() => "?").join(",")})`,
          bindValues: (part) => part.map((row) => row.email.toLowerCase()),
        },
        deduped.map((entry) => ({ email: entry.value.email }))
      );
      const existingEmails = new Set(existingRows.map((row) => row.email.toLowerCase()));

      const toInsert = deduped.filter((entry) => !existingEmails.has(entry.value.email));
      const skipped = deduped.length - toInsert.length;

      if (toInsert.length === 0) {
        // Every row was already present or duplicated. Nothing is written, and the
        // reason is reported per row rather than as a failure, because re-uploading an
        // unchanged file is a legitimate thing to do.
        return c.json({
          success: true,
          created: 0,
          authAccountsCreated: 0,
          skipped,
          invalid,
          duplicates: inFileDuplicates,
          roleMismatches: [],
          defaultPassword: DEFAULT_INITIAL_PASSWORD,
        });
      }

      /*
       * One appointment per department, for the directory that has one.
       *
       * This runs *after* the email check on purpose. A row that is already on the table
       * is a no-op whoever its department is -- re-uploading the same file has to stay a
       * no-op -- so only rows that would actually be written are held to the rule. Running
       * it earlier would report every already-saved coordinator as a conflict with
       * themselves, which is both wrong and enough to make an admin stop trusting the
       * report.
       *
       * The rejected rows are reported the same way validation failures are: on the
       * `invalid` list, with the error on `department`, keeping the row number the
       * dashboard highlights. A file whose other rows are fine still imports them.
       */
      const insertable = onePerDepartment
        ? await withoutOccupiedDepartments(c, spec, table, toInsert, invalid)
        : toInsert;

      if (insertable.length === 0) {
        // Nothing survived, and the reason is the row's department rather than its shape.
        // The same 400 the all-invalid file gets, so the dashboard reads one refusal.
        return fail(c, 400, "No valid rows to import", "import-validation-failed", { invalid });
      }

      const accountLookups = insertable.map((entry) => ({
        key: emailUserName(entry.value.email),
        email: entry.value.email,
      }));
      const accounts = await selectInChunks<
        { key: string; email: string },
        ExistingAccount
      >(
        c.env.DB,
        {
          parametersPerRow: 2,
          buildSql: (part) => {
            const placeholders = part.map(() => "?").join(",");
            return `SELECT auth_user_id, user_name, role, email FROM auth_users
              WHERE LOWER(user_name) IN (${placeholders}) OR LOWER(email) IN (${placeholders})`;
          },
          bindValues: (part) => [
            ...part.map((row) => row.key),
            ...part.map((row) => row.email),
          ],
        },
        accountLookups
      );

      const byKey = new Map<string, ExistingAccount>();
      const byEmail = new Map<string, ExistingAccount>();
      for (const account of accounts) {
        byKey.set(account.user_name.toLowerCase(), account);
        if (account.email) byEmail.set(account.email.toLowerCase(), account);
      }

      /*
       * One hash is shared by every new account: bcrypt is deliberately slow, so
       * hashing per row would make a 128-row import take minutes. It is only
       * computed when there is a new account to create, so an import that reuses
       * every account does not pay for a hash it discards.
       */
      const roleMismatches: { row: number; reason: string }[] = [];
      const linkable: typeof insertable = [];
      insertable.forEach((entry) => {
        const found =
          byKey.get(emailUserName(entry.value.email).toLowerCase()) ??
          byEmail.get(entry.value.email.toLowerCase());

        if (found && found.role !== spec.role) {
          if (provisionFromStaff) {
            // Same account, same role, same password: this address already has one and
            // it belongs to the very person being appointed. `planAccounts` resolves the
            // plan to that existing account -- same `auth_user_id`, no new hash -- so the
            // row below links to it and no second `auth_users` row is ever inserted.
            linkable.push(entry);
            return;
          }
          roleMismatches.push({
            row: entry.row,
            reason: `${entry.value.email} already has a "${found.role}" account, so it cannot also be a ${spec.label.toLowerCase()} login`,
          });
          return;
        }
        linkable.push(entry);
      });

/*
       * `auth_user_id` is written on every directory row, for both directories.
       *
       * Both roles are permanent users of the existing authentication architecture, so a
       * row has to be linked to the account that was provisioned alongside it -- the same
       * link `staff` and the student tables carry, and the one the approver routes
       * resolve by:
       *
       *   - `/api/auth/od-approver/login` looks the department up with
       *     `WHERE auth_user_id = ?`, so a row without it is refused at sign-in with
       *     `unlinked-approver`.
       *   - `/api/od/approver/me` reads the same column for the name and department the
       *     dashboard header renders.
       *
       * It is always safe to write, because `planAccounts` has already resolved this row's
       * account by the time the INSERT is built. For a head of department that account was
       * just created here; for a contest coordinator it is the staff account being reused,
       * which is the appointment itself.
       *
       * The column itself arrives with `migrations/0018_directory-auth-user-id.sql`, which
       * also backfills rows that predate it. It was previously written here without being
       * migrated, which made every appointment a 500.
       */
      const linkColumn = true;
      const pwdHash = await hashDefaultPassword();
      const { plans } = planAccounts(
        linkable.map((entry) => ({
          key: emailUserName(entry.value.email),
          email: entry.value.email,
          role: spec.role,
        })),
        { byKey, byEmail },
        pwdHash
      );

      const statements: D1PreparedStatement[] = [];
      linkable.forEach((entry, index) => {
        const plan = plans[index];
        statements.push(
          c.env.DB
            .prepare(
              `INSERT INTO ${table} (${nameColumn}, email, department, auth_user_id)
               VALUES (?, ?, ?, ?)`
            )
            .bind(
              entry.value.name,
              entry.value.email,
              entry.value.department,
              plan.auth_user_id
            )
        );
      });

      let accountsCreated = 0;
      for (const plan of plans) {
        // An empty hash marks a reused account: nothing to insert for it, so no
        // duplicate `auth_users` row is created and no password is reset.
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
        created: linkable.length,
        authAccountsCreated: accountsCreated,
        /*
         * How many of the rows that were written linked to an account that already
         * existed rather than getting a new one. A caller that has just told an admin
         * "here is the password" needs to know not to: the person already had a login,
         * it still works, and it was not reset. Zero for a directory that creates
         * every account afresh.
         */
        authAccountsReused: plans.filter((plan) => !plan.pwdHash).length,
        skipped,
        invalid,
        duplicates: inFileDuplicates,
        roleMismatches,
        // Stated once, in aggregate. The per-row password is never returned.
        defaultPassword: DEFAULT_INITIAL_PASSWORD,
      });
    } catch (error) {
      return serverError(
        c,
        error,
        `Could not provision ${spec.label.toLowerCase()}s`,
        `${spec.codeStem}s-import-failed`
      );
    }
  });

  /* ------------------------------------------------------------------- edit */

  /*
   * Edits one directory entry.
   *
   * Three fields are editable -- the name, the email and the department -- and the
   * id is not, for the same reason `subject_id` is not: it is the key the path
   * addresses and it is the table's autoincrement primary key. A body naming a
   * *different* id is refused rather than ignored, so a caller is never told an
   * edit succeeded when it moved another row.
   *
   * Unlike a student or a staff member, these rows carry no `auth_user_id` in the
   * projection below, so the linked account is found by address instead. That is the same
   * handle the login route uses, which makes it the right one: an account whose
   * `user_name` is the address can be found by nothing else.
   *
   * When the address moves, the account moves with it and the password is not
   * touched. The same `auth_user_id` and the same `pwd_hash` are kept, so the
   * person still signs in with the password they already had and no second row is
   * left claiming the old address. `user_name` is only rewritten when it currently
   * *is* the old address; an account signed into by some other handle keeps that
   * handle, exactly as the staff edit does.
   *
   * The row's own `auth_user_id` is repaired here when it is missing. A directory row
   * that predates `0018_directory-auth-user-id.sql`, or one whose account could not be
   * matched at the time, carries NULL and cannot be signed in as. Re-saving it is the
   * point at which the link is known, so it is written then rather than leaving the
   * administrator to create a second entry.
   */
  app.patch(`${spec.path}/:${spec.idParam}`, requireAuth, requireAdmin, async (c) => {
    try {
      const body = await readObjectBody(c);
      if (body instanceof Response) return body;

      const id = validateDirectoryId(c.req.param(spec.idParam));
      if (id === null) {
        return fail(c, 400, `Invalid ${spec.label} ID`, `invalid-${spec.codeStem}-id`);
      }

      if (body[idColumn] !== undefined && body[idColumn] !== null) {
        if (Number(body[idColumn]) !== id) {
          return fail(
            c,
            400,
            `${spec.label} ID cannot be changed`,
            `${spec.codeStem}-id-immutable`
          );
        }
      }

      const existing = await c.env.DB
        .prepare(
          `SELECT ${idColumn}, ${nameColumn}, email, department, auth_user_id FROM ${table} WHERE ${idColumn} = ?`
        )
        .bind(id)
        .first<Record<string, string>>();
      if (!existing) {
        return fail(c, 404, `${spec.label} not found`, `${spec.codeStem}-not-found`);
      }

      // A field that was not sent keeps its stored value, then the whole record is
      // validated through the same validator the import uses, so the edit form and
      // the import form hold an entry to one standard.
      const validated = validateDirectoryRow({
        [nameColumn]: body[nameColumn] ?? existing[nameColumn],
        email: body.email ?? existing.email,
        department: body.department ?? existing.department,
      });
      if (!validated.ok) {
        return fail(c, 400, validated.errors[0].message, `${spec.codeStem}-validation-failed`, {
          errors: validated.errors,
        });
      }
      const value = validated.value;

      // UNIQUE on the email, checked against the current entry excluded so that
      // re-saving unchanged values is not a conflict with itself.
      const emailClash = await c.env.DB
        .prepare(`SELECT ${idColumn} FROM ${table} WHERE LOWER(email) = ? AND ${idColumn} <> ? LIMIT 1`)
        .bind(value.email, id)
        .first<Record<string, number>>();
      if (emailClash) {
        return fail(
          c,
          409,
          `Email ${value.email} already belongs to another ${spec.label.toLowerCase()}`,
          "duplicate-email"
        );
      }

      /*
       * One appointment per department, for the directory that has one.
       *
       * The same rule the create route applies, and it is checked against the table rather
       * than against the stored value because the department being saved is the one under
       * test. This entry is excluded from the lookup, which is what makes re-saving a
       * coordinator without touching its department -- the ordinary edit, and the one that
       * repairs a missing `auth_user_id` -- not a conflict with itself.
       *
       * 409 with `duplicate-department`, beside the email conflict above, because it is the
       * same kind of failure: the row the admin asked for cannot exist next to the one that
       * is already there.
       */
      if (onePerDepartment) {
        const departmentClash = await c.env.DB
          .prepare(`SELECT ${idColumn} FROM ${table} WHERE department = ? AND ${idColumn} <> ? LIMIT 1`)
          .bind(value.department, id)
          .first<Record<string, number>>();
        if (departmentClash) {
          return fail(
            c,
            409,
            `${value.department} already has a ${spec.label.toLowerCase()}`,
            "duplicate-department"
          );
        }
      }

      const previousEmail = (existing.email ?? "").toLowerCase();
      const emailChanged = value.email.toLowerCase() !== previousEmail;

      /*
       * The account that holds this row's current address.
       *
       * Read on every edit, not only when the address moves, because it is also what
       * repairs the row's `auth_user_id`. A directory row that predates the migration, or
       * one whose account could not be matched when it was created, carries NULL and
       * cannot be signed in as; re-saving the entry is when the link becomes knowable.
       */
      const account = await c.env.DB
        .prepare(
          `SELECT auth_user_id, user_name, role, email FROM auth_users
           WHERE LOWER(user_name) = ? OR LOWER(email) = ? LIMIT 1`
        )
        .bind(previousEmail, previousEmail)
        .first<{ auth_user_id: string; user_name: string; role: string; email: string | null }>();

      /*
       * Sign-in is by address, so an address that moves must not already belong to
       * some other account or the same address would match two rows at login.
       */
      if (account && emailChanged) {
        const clash = await c.env.DB
          .prepare(
            `SELECT auth_user_id FROM auth_users
             WHERE auth_user_id <> ? AND (LOWER(user_name) = ? OR LOWER(email) = ?)
             LIMIT 1`
          )
          .bind(account.auth_user_id, value.email.toLowerCase(), value.email.toLowerCase())
          .first<{ auth_user_id: string }>();
        if (clash) {
          return fail(
            c,
            409,
            `Email ${value.email} already belongs to another login account`,
            "auth-email-conflict"
          );
        }
      }

      const nameChanged = value.name !== existing[nameColumn];
      const departmentChanged = value.department !== existing.department;

      /*
       * The row is re-linked to the account that holds its address whenever the stored
       * link is missing or names a different account. A missing link is a row nobody can
       * act as; a link that has drifted would point one person's directory entry at
       * another person's authority, and the address is the only thing that decides which
       * account that is. Nothing is written when it already agrees.
       */
      const nextAuthUserId = account?.auth_user_id ?? null;
      const linkChanged = nextAuthUserId !== null && nextAuthUserId !== (existing.auth_user_id ?? null);

      const statements: D1PreparedStatement[] = [];

      /*
       * Neither the row nor the account is written when nothing changed. An edit
       * that saves the values it was given is a no-op rather than a write, so it
       * cannot churn `updated_at`-style bookkeeping or race another admin's edit.
       */
      if (nameChanged || departmentChanged || emailChanged || linkChanged) {
        statements.push(
          c.env.DB
            .prepare(
              `UPDATE ${table} SET ${nameColumn} = ?, email = ?, department = ?${
                linkChanged ? ", auth_user_id = ?" : ""
              } WHERE ${idColumn} = ?`
            )
            .bind(
              value.name,
              value.email,
              value.department,
              ...(linkChanged ? [nextAuthUserId] : []),
              id
            )
        );
      }

      if (account && emailChanged) {
        const nextUserName =
          account.user_name.toLowerCase() === previousEmail
            ? emailUserName(value.email)
            : account.user_name;
        const nextEmail = value.email;
        if (nextUserName !== account.user_name || nextEmail !== (account.email ?? "")) {
          // `pwd_hash` is absent from the SET list on purpose: importing or editing
          // a directory never resets an existing account's password.
          statements.push(
            c.env.DB
              .prepare("UPDATE auth_users SET user_name = ?, email = ? WHERE auth_user_id = ?")
              .bind(nextUserName, nextEmail, account.auth_user_id)
          );
        }
      }

      if (statements.length > 0) {
        await c.env.DB.batch(statements);
      }

      // Read back rather than echoing the request, so the response is what D1 holds.
      // The projection matches the list route exactly.
      const updated = await c.env.DB
        .prepare(`SELECT ${idColumn}, ${nameColumn}, email, department, created_at FROM ${table} WHERE ${idColumn} = ?`)
        .bind(id)
        .first();

      return c.json({
        success: true,
        [spec.listKey.slice(0, -1)]: updated ?? null,
        authAccountUpdated: statements.length > 1,
      });
    } catch (error) {
      return serverError(
        c,
        error,
        `Could not update that ${spec.label.toLowerCase()}`,
        `${spec.codeStem}-update-failed`
      );
    }
  });

  /* ----------------------------------------------------------------- delete */

  /*
   * Removes one directory entry, and its login only when the login is its own.
   *
   * ## What is preserved
   *
   * The OD workflow snapshots every approver by the address they signed in with --
   * `mentor_email`, `coordinator_decided_by`, `advisor_decided_by`,
   * `hod_decided_by` -- and copies no approver id anywhere. There is no foreign key
   * from `od_requests` onto either directory table, so every approval either of these
   * roles ever gave stays exactly as it was recorded. Removing a head of department
   * does not remove a term of decisions they made; the count comes back under
   * `preservedHistory` so the dashboard can say so rather than assert it.
   *
   * ## The login, which is the whole difficulty
   *
   * Deleting the row is not enough on its own. `/api/auth/od-approver/login` resolves
   * the caller's role, name and department through this directory's `auth_user_id`, so
   * a person whose row is gone is refused at sign-in with `unlinked-approver` while
   * their `auth_users` row goes on verifying their password -- an account that exists,
   * authenticates against the shared login route, and grants nothing.
   *
   * Removing that account is not automatically the fix either. A coordinator's account
   * is normally the *reused staff account*, which `staff` also points at, and deleting
   * it would sign a colleague off a roster that still lists them. So the account goes
   * only when `spec.ownedAccountRoles` says this directory issues it *and* nothing
   * else still references it; otherwise it is left in place and the response says
   * which of those two reasons applied, in `authAccountKept`.
   *
   * For a coordinator the leaving-behind case is the expected one, not a fault: their
   * `staff` login keeps working, which is what an appointed member of staff expects,
   * and losing the appointment is what stops them approving contest requests.
   *
   * ## One per department
   *
   * Nothing here has to do anything about `spec.onePerDepartment` for the rule to hold
   * afterwards. It is enforced by the create and edit routes, both of which ask the
   * table rather than a constraint, so a department with no row is a department
   * available for a new appointment. The delete frees the slot by removing the row
   * that occupied it, and touches no other department's row.
   */
  app.delete(`${spec.path}/:${spec.idParam}`, requireAuth, requireAdmin, async (c) => {
    try {
      const id = validateDirectoryId(c.req.param(spec.idParam));
      if (id === null) {
        return fail(c, 400, `Invalid ${spec.label} ID`, `invalid-${spec.codeStem}-id`);
      }

      /*
       * Read the row before deleting anything, for the two things the delete needs to
       * say: which person it was, and which account (if any) came with them. A second
       * DELETE of an id that is already gone therefore answers 404 with a message about
       * this row rather than reporting a successful delete of nothing.
       */
      const existing = await c.env.DB
        .prepare(
          `SELECT ${idColumn}, ${nameColumn}, email, department, auth_user_id FROM ${table} WHERE ${idColumn} = ?`
        )
        .bind(id)
        .first<Record<string, string>>();
      if (!existing) {
        return fail(c, 404, `${spec.label} not found`, `${spec.codeStem}-not-found`);
      }

      await ensureBatchRegistry(c.env.DB);

      const account = await planAccountRemoval(c.env.DB, existing.auth_user_id ?? null, ownedAccountRoles, {
        table,
        idColumn,
        id,
      });

      // Row, sessions and account in one batch, which D1 runs as a transaction: the
      // appointment and its login are never left disagreeing with each other.
      await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).bind(id),
        ...account.statements,
      ]);

      return c.json({
        success: true,
        [spec.listKey.slice(0, -1)]: {
          [idColumn]: existing[idColumn],
          [nameColumn]: existing[nameColumn],
          email: existing.email,
          department: existing.department,
        },
        authAccountRemoved: account.removed,
        authAccountKept: account.keptReason,
        authAccountKeptRole: account.keptRole,
        // Reported, never acted on: these decisions are the historical record and
        // outlive the appointment that made them.
        preservedHistory: {
          odRequests: await countOdDecisionsBy(c.env.DB, existing.email, odApproverColumns),
        },
      });
    } catch (error) {
      return serverError(
        c,
        error,
        `Could not delete that ${spec.label.toLowerCase()}`,
        `${spec.codeStem}-delete-failed`
      );
    }
  });
}

/*
 * Both directories are registered from the same implementation, because they are
 * the same feature: a person, an address and a department, in a single
 * department-keyed table, with an account created alongside. Everything that
 * differs between them -- the table name, the primary key column, the name column
 * and the account role -- is a literal in the spec below, never anything a request
 * supplied.
 *
 * The one difference that is not cosmetic is `provisionFromStaff`, and it is stated
 * here because the two registrations look otherwise interchangeable. A head of
 * department is appointed *to* a department and already has no account, so an address
 * that already holds one of another role is refused. A contest coordinator is
 * appointed *out of* a department's staff roster, so that address always holds a
 * `staff` account belonging to the very person being appointed, and refusing it would
 * mean a coordinator could never be anyone who is on staff -- which is everybody the
 * dashboard offers them.
 *
 * `spec.listKey.slice(0, -1)` turns the plural list key into the singular response
 * key for an edit, so `hods` -> `hod` and `contest-coordinators` ->
 * `contest-coordinator`, matching how the dashboard reads a saved record.
 */
registerDirectoryRoutes(
  {
    path: "/hods",
    table: "hods",
    idColumn: "hod_id",
    nameColumn: "hod_name",
    idParam: "hodId",
    role: "hod",
    label: "HOD",
    listKey: "hods",
    codeStem: "hod",
    /*
     * An HOD's account was created for the appointment -- `provisionFromStaff` is unset
     * here, so the create route creates the account rather than reusing a staff one.
     * Removing the row therefore removes the login with it, in one transaction, so a
     * former head of department is not left holding a working password for authority
     * they no longer have.
     */
    ownedAccountRoles: ["hod"],
    odApproverColumns: ["hod_decided_by"],
    validateRow: validateHodRow,
  }
);

registerDirectoryRoutes(
  {
    path: "/contest-coordinators",
    table: "contest_coordinators",
    idColumn: "coordinator_id",
    nameColumn: "coordinator_name",
    idParam: "coordinatorId",
    role: "contest_coordinator",
    label: "Coordinator",
    listKey: "contest_coordinators",
    codeStem: "coordinator",
    // A coordinator is appointed out of a department's staff roster, so the address
    // being added belongs to somebody who already has a `staff` account. Reuse it.
    provisionFromStaff: true,
    /*
     * Only a `contest_coordinator` account is this directory's to remove, and it is
     * rare -- almost every coordinator holds the reused `staff` account instead. That
     * account stays, because `staff` points at it too and removing it would sign a
     * colleague off the roster that still lists them. Losing the appointment is enough:
     * `/api/auth/od-approver/login` resolves through this row, so with it gone they can
     * no longer reach a coordinator queue at all.
     */
    ownedAccountRoles: ["contest_coordinator"],
    odApproverColumns: ["coordinator_decided_by"],
    validateRow: validateContestCoordinatorRow,
    /*
     * A department has exactly one contest coordinator. It is the single addressee the OD
     * workflow hands a request to, so a second one cannot be resolved to anybody in
     * particular; see `spec.onePerDepartment` for why it is refused rather than ordered.
     *
     * Deleting the row is what makes a department available again, because both the create
     * and the edit route ask this table rather than a constraint. Nothing else has to
     * change for the rule to hold afterwards, and no other department's row is read or
     * written.
     */
    onePerDepartment: true,
  }
);

export default app;
