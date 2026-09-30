/**
 * Single source of truth for department + batch -> table resolution.
 *
 * Students and attendance rows live in physically separate tables per
 * department and batch, and those table names cannot be bound as SQL
 * parameters. Every call site therefore resolves its identifiers here, against a
 * validated department and a strictly formatted batch, instead of building them
 * from request values.
 *
 * The batch the staff member selects identifies the tables directly. Year of
 * study is deliberately NOT part of the lookup: it is client-supplied, it
 * changes as a batch advances (2025_2029 is second year now and fourth year in
 * 2027), and a mapping baked into this file would go stale. Year is stored on
 * the session and used only to pick which students of that batch are in the
 * class being taken.
 *
 * ## The registry is the only source of batches
 *
 * There is no built-in batch list in this file. That list used to exist, as a
 * hardcoded floor, and it caused a real bug: a cohort was removed from the
 * database and its tables were dropped, but because the floor was merged into
 * the in-process index and only ever added to, the batch stayed resolvable and
 * kept being offered in the staff batch selector indefinitely. A batch in this
 * application exists if and only if it is registered in `academic_batches`.
 *
 * A pair is treated as available only when three things all hold:
 *
 *   1. `academic_batches` has a row for it, which is what provisioning writes
 *      and what makes the cohort real to the application.
 *   2. Its department is in `SUPPORTED_DEPARTMENTS`. This is a format gate, not
 *      a batch list: it is what makes the department half of an interpolated
 *      table name safe, and it holds no admission cohort information.
 *   3. Both `<DEPARTMENT>_Students_<BATCH>` and `<DEPARTMENT>_Attendance_<BATCH>`
 *      physically exist. A row whose tables were dropped is not a cohort anyone
 *      can take attendance for, so it must not be offered, and offering it would
 *      put a selection in the UI that the API then refuses.
 *
 * Requiring both tables is deliberate: the student table holds the roster and
 * the attendance table holds the marks, so a batch with only one of them cannot
 * take attendance and is not a usable cohort.
 *
 * ## Names are derived, never read
 *
 * The table name is always *computed* from a validated department and a
 * strictly formatted batch by `buildTableNames`, never read from the row, so a
 * tampered or malformed `academic_batches` row cannot introduce a table name.
 * The stored `student_table` / `attendance_table` columns are kept for operator
 * visibility and for the provisioning tests, but resolution does not trust them.
 *
 * Because the index is rebuilt from the table on every hydration, a cohort that
 * is unregistered or whose tables are dropped disappears on the next hydration
 * rather than lingering for the life of the Worker isolate.
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

/**
 * The name a pair resolves to is always *computed* from a validated department
 * and batch, never read from the database.
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

/**
 * Replaces the whole index.
 *
 * A rebuild rather than a merge is the point: merging is what allowed a deleted
 * cohort to keep resolving, because the in-process index is per-isolate and
 * outlives the request that deleted the row.
 */
function replaceBatchRegistry(entries: BatchTables[]): void {
  BATCH_INDEX.clear();
  ALLOWED_STUDENT_TABLES.clear();
  ALLOWED_ATTENDANCE_TABLES.clear();
  for (const tables of entries) {
    const key = `${tables.department}:${tables.batch}`;
    BATCH_INDEX.set(key, tables);
    ALLOWED_STUDENT_TABLES.add(tables.studentTable);
    ALLOWED_ATTENDANCE_TABLES.add(tables.attendanceTable);
  }
}

const REGISTRY_TABLE = "academic_batches";

/**
 * Rebuilds the in-process registry from D1.
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
 *   3. Both physical tables must exist. A registered pair whose tables are gone
 *      is not servable, so it is left out rather than offered and then rejected.
 *   4. A failed read leaves the previous registry in place instead of emptying
 *      it. A transient D1 error must not make every existing cohort disappear,
 *      which would break student login and attendance wholesale. The cost of
 *      keeping it is that the list is briefly stale, which is the safer error.
 */
export async function hydrateBatchRegistry(db: D1Database): Promise<void> {
  let rows: { results?: { department: string; batch: string }[] };
  try {
    rows = await db
      .prepare(`SELECT department, batch FROM ${REGISTRY_TABLE}`)
      .all<{ department: string; batch: string }>();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "batch_registry_unavailable",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return;
  }

  /*
   * Validate every row before touching the database again, so a malformed or
   * hostile row cannot influence the existence query below.
   */
  const candidates: BatchTables[] = [];
  const seen = new Set<string>();
  for (const row of rows?.results ?? []) {
    const department = normalizeDepartment(row?.department);
    const batch = normalizeBatch(row?.batch);
    if (!department || !batch) continue;
    const key = `${department}:${batch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ department, batch, ...buildTableNames(department, batch) });
  }

  if (candidates.length === 0) {
    replaceBatchRegistry([]);
    return;
  }

  const present = await provisionedTables(db, candidates);

  replaceBatchRegistry(
    candidates.filter(
      (tables) => present.has(tables.studentTable) && present.has(tables.attendanceTable)
    )
  );
}

/**
 * The subset of the derived table names that exist as real tables.
 *
 * The names are bound as parameters rather than interpolated, and each was built
 * by `buildTableNames` from an already-validated department and batch, so this
 * query cannot be steered toward a name the resolver would not have produced.
 */
async function provisionedTables(
  db: D1Database,
  candidates: BatchTables[]
): Promise<Set<string>> {
  const names = candidates.flatMap((tables) => [tables.studentTable, tables.attendanceTable]);
  const placeholders = names.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
    )
    .bind(...names)
    .all<{ name: string }>();
  return new Set((results ?? []).map((row) => row.name));
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
  session: { department?: unknown; batch?: unknown } | null | undefined
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
