/**
 * Writes to `academic_batches`, the registry that makes a cohort exist.
 *
 * This is separated from `tableResolver` because it is the other half of the same
 * contract. `tableResolver` reads the registry to decide which tables a
 * (department, batch) pair resolves to; this module writes the row that the reader
 * then trusts. Keeping the two apart is deliberate: the resolver is read on every
 * authenticated request and its inputs are assumed normalised, whereas this runs
 * only when an administrator creates or imports into a cohort.
 *
 * ## Why the column list is discovered rather than written out
 *
 * `POST /api/admin/batches` answered 500 in production, on every attempt, with
 * `table academic_batches has no column named created_by`.
 *
 * The cause is schema drift rather than a bad query. Migration 0016 was applied to
 * the production database on 2026-09-30 from a working-tree draft of the file, and
 * that draft created `academic_batches` with six columns and a
 * `UNIQUE (department, batch)` -- no `created_at`, no `created_by`, and no
 * `idx_academic_batches_department`. The migration file was then edited to add all
 * three and committed. D1 records a migration by id and name, so the edited file has
 * never been applied and never will be: the column the code writes has never
 * existed in production.
 *
 * The damage was worse than the status code. Provisioning runs before this write,
 * and D1 auto-commits DDL outside a transaction, so each failed attempt left a
 * `<DEPARTMENT>_Students_<BATCH>` and `<DEPARTMENT>_Attendance_<BATCH>` pair
 * behind with nothing registered. The retry then reported the tables as pre-existing
 * and failed at the same statement, so a cohort could not be created at all.
 *
 * So the write states the columns it needs, and asks which of them this database
 * actually has. The optional ones are dropped when they are absent, which is what
 * lets the same statement work on the deployed schema and on a database freshly
 * built from the migration files. `created_by` is the only such column: it is an
 * audit note that nothing in this application reads, and it was never writable in
 * production, so losing it costs a fact nobody was being told. It is still written
 * wherever the column exists, so a fresh install keeps the audit trail.
 *
 * ## Why the required ones are not optional
 *
 * `department`, `batch`, `start_year`, `end_year`, `student_table` and
 * `attendance_table` are the row. A registry missing any of them is not a registry,
 * and silently inserting a partial row would register a cohort the resolver then
 * reads with holes in it. Those six are therefore checked, and their absence is a
 * loud failure naming the table and the column rather than an `INSERT` error from
 * SQLite or, worse, a row written anyway.
 *
 * Column names come from a fixed table below and are compared against the names
 * `pragma_table_info` reports; nothing a caller supplies is ever concatenated into
 * the statement. The department and batch are bound parameters, and they have
 * already been through `normalizeDepartment` and `validateBatchInput` at the call
 * site, so this module cannot widen what a table name may become.
 */

import type { Department } from "./tableResolver";

const REGISTRY_TABLE = "academic_batches";

/** The row every cohort needs, and the only columns the upsert keys on. */
type RequiredColumn = "department" | "batch" | "start_year" | "end_year" | "student_table" | "attendance_table";

/** Audit columns a given database may not have. Dropped when absent. */
type OptionalColumn = "created_by";

/**
 * The statement, as a fixed list of (column, value) pairs.
 *
 * The order is the insert order, and it is declared here rather than assembled per
 * call so that the column list and the value list cannot fall out of step.
 */
const REQUIRED_FIELDS: readonly (readonly [RequiredColumn, (input: RegisterBatchInput) => unknown])[] = [
	["department", (input) => input.department],
	["batch", (input) => input.batch],
	["start_year", (input) => input.startYear],
	["end_year", (input) => input.endYear],
	["student_table", (input) => input.studentTable],
	["attendance_table", (input) => input.attendanceTable],
];

const OPTIONAL_FIELDS: readonly (readonly [OptionalColumn, (input: RegisterBatchInput) => unknown])[] = [
	["created_by", (input) => input.createdBy],
];

export interface RegisterBatchInput {
	department: Department;
	/** Already normalised and already validated, e.g. "2027_2031". */
	batch: string;
	startYear: number;
	endYear: number;
	studentTable: string;
	attendanceTable: string;
	/** The admin's `auth_user_id`, or null when there is no session to attribute it to. */
	createdBy: string | null;
}

/**
 * The upsert target.
 *
 * A pair is written at most once. A second call for the same (department, batch)
 * refreshes the stored table names and leaves `created_at` and `created_by` alone,
 * because the row records when a cohort was first registered and who registered it.
 * Changing either on a re-create would make "when was this cohort added" depend on
 * how many times somebody retried.
 */
const UPSERT_CLAUSE = `ON CONFLICT (department, batch) DO UPDATE SET
       student_table = excluded.student_table,
       attendance_table = excluded.attendance_table`;

/** The columns this database has, or a thrown error explaining what is wrong with it. */
async function registryColumns(db: D1Database): Promise<Set<string>> {
	let present: Set<string>;
	try {
		const { results } = await db
			.prepare("SELECT name FROM pragma_table_info(?)")
			.bind(REGISTRY_TABLE)
			.all<{ name: string }>();
		present = new Set((results ?? []).map((row) => row.name));
	} catch (error) {
		throw new Error(
			`Cannot read the columns of ${REGISTRY_TABLE}, so a batch cannot be registered: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}

	/*
	 * An absent table and an empty one are indistinguishable here, because
	 * `pragma_table_info` on a missing table returns no rows rather than failing. That
	 * is the case worth naming: the registry is created by migration 0016, and its
	 * absence is a deployment that skipped it rather than a cohort that cannot be
	 * written.
	 */
	if (present.size === 0) {
		throw new Error(
			`${REGISTRY_TABLE} does not exist. Apply migration 0016_academic_batches.sql before creating a batch.`
		);
	}

	const missing = REQUIRED_FIELDS.map(([column]) => column).filter((column) => !present.has(column));
	if (missing.length > 0) {
		throw new Error(
			`${REGISTRY_TABLE} is missing the required column(s) ${missing.join(", ")}, so a batch cannot be registered.`
		);
	}
	return present;
}

/**
 * Registers a cohort, creating its registry row or refreshing the one it already has.
 *
 * Call this only *after* `provisionBatchTables` has reported both tables present.
 * The order is the whole point: the reader requires both tables to exist before it
 * will resolve a pair, so a row written first would advertise a cohort the
 * application cannot serve, whereas a table created first without a row is merely
 * invisible and is picked up by the retry that this function makes possible.
 *
 * The tables are read fresh on every call rather than cached per isolate. Batch
 * creation is a rare administrative act, so the query costs nothing that matters,
 * and not caching means a database that has just been migrated, or that a test has
 * just rebuilt, is never written through a stale idea of its own schema. The
 * alternative is a second cache with its own invalidation rules and its own way of
 * being wrong.
 */
export async function registerBatch(db: D1Database, input: RegisterBatchInput): Promise<void> {
	const present = await registryColumns(db);

	// The accessor is applied here, not at the bind call, so the bound list is
	// values only -- D1 rejects anything else, and a function that slipped through
	// would surface as an opaque `D1_TYPE_ERROR` from deep inside the driver.
	const fields: readonly (readonly [string, unknown])[] = [
		...REQUIRED_FIELDS.map(([column, value]) => [column, value(input)] as const),
		...OPTIONAL_FIELDS.filter(([column]) => present.has(column)).map(
			([column, value]) => [column, value(input)] as const
		),
	];

	const columns = fields.map(([column]) => column).join(", ");
	const placeholders = fields.map(() => "?").join(", ");

	await db
		.prepare(
			`INSERT INTO ${REGISTRY_TABLE} (${columns}) VALUES (${placeholders}) ${UPSERT_CLAUSE}`
		)
		.bind(...fields.map(([, value]) => value))
		.run();
}
