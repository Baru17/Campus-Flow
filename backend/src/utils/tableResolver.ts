/**
 * Single source of truth for department + batch -> table resolution.
 *
 * Students and attendance rows live in physically separate tables per
 * department and batch, and those table names cannot be bound as SQL
 * parameters. Every call site therefore resolves its identifiers here, against a
 * static allow-list, instead of building them from request values.
 *
 * The batch the staff member selects identifies the tables directly. Year of
 * study is deliberately NOT part of the lookup: it is client-supplied, it
 * changes as a batch advances (2025_2029 is second year now and fourth year in
 * 2027), and a mapping baked into this file would go stale. Year is stored on
 * the session and used only to pick which students of that batch are in the
 * class being taken.
 *
 * The allow-list only contains (department, batch) pairs whose tables actually
 * exist in D1. ECE and EEE are recognised as valid departments but have no
 * tables yet, so they resolve to `null` and callers return a clean "batch not
 * configured" error rather than letting D1 fail with an opaque "no such table".
 * Add a pair here once an administrator has created the tables for it.
 *
 * A batch becomes resolvable in two coordinated steps, and both are required
 * before a pair can be served:
 *
 *   1. An administrator provisions `<DEPARTMENT>_Students_<BATCH>` and
 *      `<DEPARTMENT>_Attendance_<BATCH>`. Both halves are needed: the student
 *      table holds the roster and the attendance table holds the marks, so a
 *      batch with only one of them cannot take attendance.
 *   2. The pair is recorded in the `academic_batches` registry, from which
 *      `hydrateBatchRegistry` merges it into the allow-list on the next request.
 *
 * `POST /api/admin/batches` performs both steps, and `POST /api/admin/students`
 * will do so for a batch that does not exist yet, so adding a cohort no longer
 * needs a hand-written migration or a code change. The registry rows are merged
 * into a per-isolate allow-list, and a table name is only ever produced by
 * `buildTableNames` from an allow-listed department and a strictly formatted
 * batch — the stored names are never interpolated, so a malformed or tampered
 * registry row cannot introduce a table name.
 */

export const SUPPORTED_DEPARTMENTS = ["IT", "CSE", "ECE", "EEE"] as const;

export type Department = (typeof SUPPORTED_DEPARTMENTS)[number];

export interface BatchTables {
  department: Department;
  /** Admission batch, e.g. "2024_2028". Identifies the tables together with the department. */
  batch: string;
  studentTable: string;
  attendanceTable: string;
}

/*
 * The batches that existed before the registry, kept in code so the resolver still
 * works before migration 0016 has been applied, and so a database read can never
 * leave the Worker unable to serve attendance for the tables that are already in
 * production. `hydrateBatchRegistry` merges the `academic_batches` rows on top of
 * these, and provisioning writes new pairs into that table, so this list is a
 * floor rather than the set of known batches.
 */
const BUILTIN_BATCHES: Record<Department, BatchTables[]> = {
  IT: [
    {
      department: "IT",
      batch: "2024_2028",
      studentTable: "IT_Students_2024_2028",
      attendanceTable: "IT_Attendance_2024_2028",
    },
    {
      department: "IT",
      batch: "2025_2029",
      studentTable: "IT_Students_2025_2029",
      attendanceTable: "IT_Attendance_2025_2029",
    },
  ],
  // Departments are selectable in the UI but have no tables yet. Populate these
  // when the student tables are created; every caller then starts working with
  // no further change.
  CSE: [
    {
      department: "CSE",
      batch: "2026_2030",
      studentTable: "CSE_Students_2026_2030",
      attendanceTable: "CSE_Attendance_2026_2030",
    },
  ],
  ECE: [],
  EEE: [],
};

/*
 * The name a pair resolves to is always *computed* from a validated department
 * and batch, never read from the database. `academic_batches` records which pairs
 * have been provisioned, but the identifiers themselves are derived here, so a
 * tampered or malformed row cannot introduce a table name.
 */
export function buildTableNames(
  department: Department,
  batch: string
): { studentTable: string; attendanceTable: string } {
  return {
    studentTable: `${department}_Students_${batch}`,
    attendanceTable: `${department}_Attendance_${batch}`,
  };
}

/* `department:batch` is the exact identity of a pair of tables. */
const BATCH_INDEX = new Map<string, BatchTables>();
const ALLOWED_STUDENT_TABLES = new Set<string>();
const ALLOWED_ATTENDANCE_TABLES = new Set<string>();

function registerBatchTables(tables: BatchTables): void {
  BATCH_INDEX.set(`${tables.department}:${tables.batch}`, tables);
  ALLOWED_STUDENT_TABLES.add(tables.studentTable);
  ALLOWED_ATTENDANCE_TABLES.add(tables.attendanceTable);
}

for (const department of SUPPORTED_DEPARTMENTS) {
  for (const tables of BUILTIN_BATCHES[department]) {
    registerBatchTables(tables);
  }
}

const REGISTRY_TABLE = "academic_batches";

/*
 * Merges the provisioned batches from D1 into the in-process registry.
 *
 * Every call site of this module is synchronous, because a table name cannot be
 * bound as a SQL parameter and the identifiers are interpolated at the call site.
 * Rather than push an async lookup through thirty call sites, the registry is
 * hydrated once per request by `ensureBatchRegistry` and read synchronously
 * afterwards.
 *
 * Robustness rules, in order:
 *   1. A row is only honoured when its department is in the fixed allow-list and
 *      its batch matches the strict format, so the pair is safe to resolve.
 *   2. The table names are recomputed from that pair rather than read from the
 *      row, so a stored name is never trusted.
 *   3. A missing table (migration not yet applied) is not an error. The built-in
 *      list already covers production, so attendance keeps working.
 */
export async function hydrateBatchRegistry(db: D1Database): Promise<void> {
  let rows: { results?: { department: string; batch: string }[] };
  try {
    rows = await db
      .prepare(`SELECT department, batch FROM ${REGISTRY_TABLE}`)
      .all<{ department: string; batch: string }>();
  } catch (error) {
    // Before migration 0016 there is no registry table. The built-in batches
    // stay authoritative and every existing flow keeps resolving.
    console.warn(
      JSON.stringify({
        event: "batch_registry_unavailable",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return;
  }

  for (const row of rows?.results ?? []) {
    const department = normalizeDepartment(row?.department);
    const batch = normalizeBatch(row?.batch);
    if (!department || !batch) continue;
    const key = `${department}:${batch}`;
    if (BATCH_INDEX.has(key)) continue;
    registerBatchTables({ department, batch, ...buildTableNames(department, batch) });
  }
}

/*
 * Hydrates the registry for the current request, at most once per Worker isolate
 * per `ttlMs`. Administrative provisioning invalidates the cache immediately, so a
 * batch created through the dashboard is usable on the very next request without
 * waiting out a TTL.
 */
let registryLoadedAt = 0;
let registryLoading: Promise<void> | null = null;

export function invalidateBatchRegistry(): void {
  registryLoadedAt = 0;
}

export async function ensureBatchRegistry(
  db: D1Database,
  options: { ttlMs?: number; force?: boolean } = {}
): Promise<void> {
  const ttlMs = options.ttlMs ?? 60_000;
  if (!options.force && registryLoading === null && Date.now() - registryLoadedAt < ttlMs) {
    return;
  }
  // Share one in-flight read across concurrent requests on the same isolate.
  if (!options.force && registryLoading) {
    return registryLoading;
  }
  const load = hydrateBatchRegistry(db)
    .then(() => {
      registryLoadedAt = Date.now();
    })
    .finally(() => {
      registryLoading = null;
    });
  registryLoading = load;
  return load;
}

/** Every student table that exists, for the authenticated-student lookups that scan batches. */
export function listAllowedStudentTables(): BatchTables[] {
  return [...BATCH_INDEX.values()].map((tables) => ({ ...tables }));
}

export function isSupportedDepartment(value: unknown): value is Department {
  return typeof value === "string" && (SUPPORTED_DEPARTMENTS as readonly string[]).includes(value);
}

/** Normalises loose input ("it", " IT ") to a supported department, or `null`. */
export function normalizeDepartment(value: unknown): Department | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return isSupportedDepartment(trimmed) ? trimmed : null;
}

/** Normalises loose input (" 2024_2028 ") to a batch key, or `null` if malformed. */
export function normalizeBatch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}_\d{4}$/.test(trimmed) ? trimmed : null;
}

/** Batches that have tables for a department, for populating a batch picker. */
export function listBatchesForDepartment(department: unknown): string[] {
  const normalized = normalizeDepartment(department);
  if (!normalized) return [];
  const batches: string[] = [];
  for (const [key, tables] of BATCH_INDEX) {
    if (key.startsWith(`${normalized}:`)) batches.push(tables.batch);
  }
  return batches.sort();
}

/**
 * Resolves the tables for a (department, batch) pair, or `null` when the pair is
 * unknown or has no tables provisioned yet.
 */
export function resolveTables(department: unknown, batch: unknown): BatchTables | null {
  const normalizedDepartment = normalizeDepartment(department);
  if (!normalizedDepartment) return null;
  const normalizedBatch = normalizeBatch(batch);
  if (!normalizedBatch) return null;
  return BATCH_INDEX.get(`${normalizedDepartment}:${normalizedBatch}`) ?? null;
}

/**
 * Resolves the tables a stored session belongs to, from the department and batch
 * recorded on it.
 *
 * There is deliberately no year fallback: the batch is stored on the session, so
 * a session missing one cannot be resolved and callers must surface that rather
 * than guessing which tables it meant.
 */
export function resolveSessionTables(
  session: { department?: unknown; batch?: unknown } | null | undefined,
): BatchTables | null {
  if (!session) return null;
  return resolveTables(session.department, session.batch);
}

/**
 * Last line of defence before a table name reaches SQL as an identifier.
 *
 * Resolution above already returns literals from the allow-list, so this should
 * never reject anything; it exists so that a future edit which builds a name
 * dynamically fails loudly instead of interpolating attacker-controlled input.
 */
export function assertAllowedStudentTable(table: string): string {
  if (!ALLOWED_STUDENT_TABLES.has(table)) {
    throw new Error(`Refusing to query unlisted student table: ${table}`);
  }
  return table;
}

export function assertAllowedAttendanceTable(table: string): string {
  if (!ALLOWED_ATTENDANCE_TABLES.has(table)) {
    throw new Error(`Refusing to query unlisted attendance table: ${table}`);
  }
  return table;
}
