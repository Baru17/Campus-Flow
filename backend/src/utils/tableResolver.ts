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
 * Provisioning a batch is two coordinated steps, and both are required before a
 * pair belongs in this list:
 *
 *   1. A migration creates `<DEPARTMENT>_Students_<BATCH>` and
 *      `<DEPARTMENT>_Attendance_<BATCH>`. Both halves are needed: the student
 *      table holds the roster and the attendance table holds the marks, so a
 *      batch with only one of them cannot take attendance. See
 *      migrations/0014_cse-2026-2030-test-seed.sql for the worked example.
 *   2. The pair is added here, which is the only place table names are
 *      introduced at runtime.
 *
 * Table names are never built from request values, so this list stays the single
 * place a name can enter the system. A batch is added by an administrator ahead
 * of time, never on demand from the UI.
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

const ALLOWED_BATCHES: Record<Department, BatchTables[]> = {
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

/* `department:batch` is the exact identity of a pair of tables. */
const BATCH_INDEX = new Map<string, BatchTables>();
const ALLOWED_STUDENT_TABLES = new Set<string>();
const ALLOWED_ATTENDANCE_TABLES = new Set<string>();

for (const department of SUPPORTED_DEPARTMENTS) {
  for (const tables of ALLOWED_BATCHES[department]) {
    BATCH_INDEX.set(`${department}:${tables.batch}`, tables);
    ALLOWED_STUDENT_TABLES.add(tables.studentTable);
    ALLOWED_ATTENDANCE_TABLES.add(tables.attendanceTable);
  }
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
  return ALLOWED_BATCHES[normalized].map((tables) => tables.batch);
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
