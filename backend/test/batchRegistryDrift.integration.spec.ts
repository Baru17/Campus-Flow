/**
 * Batch creation against the `academic_batches` table that is really in production.
 *
 * Migration 0016 was applied to the production database on 2026-09-30 from a
 * working-tree draft of the file. That draft created the table with six columns
 * and a `UNIQUE (department, batch)`, and nothing else: no `created_at`, no
 * `created_by`, and no `idx_academic_batches_department`. The file was then edited
 * to add all three before it was committed, and D1 records a migration by id and
 * name, so the edited file has never been applied and never will be.
 *
 * `POST /api/admin/batches` named `created_by` in its column list, which is a
 * column production does not have, so the registry write failed with
 * `table academic_batches has no column named created_by` and the route answered
 * 500. Every other batch-creation path through this Worker fails identically,
 * because they all write the same row.
 *
 * The interesting part is the damage the failure did on the way out: the tables
 * are created *before* the registry row, and D1 auto-commits DDL outside a
 * transaction, so each failed attempt left a pair of `<DEPARTMENT>_Students_<BATCH>`
 * and `<DEPARTMENT>_Attendance_<BATCH>` tables behind with nothing pointing at them.
 * Retrying then reported `tablesCreated: false` and failed again, so the cohort
 * could never be registered at all.
 *
 * These tests pin the deployed schema rather than the schema in the repository,
 * because the repository's copy is the thing that drifted. They deliberately do
 * not apply migration 0016.
 */

import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/utils/auth";
import migration0001 from "../migrations/0001_initial-schema.sql?raw";
import migration0002 from "../migrations/0002_auth_sessions.sql?raw";
import migration0003 from "../migrations/0003_add-attendance-session-status.sql?raw";
import migration0004 from "../migrations/0004_add-email-to-auth-users.sql?raw";
import migration0005 from "../migrations/0005_add-staff-advisor-class.sql?raw";
import migration0006 from "../migrations/0006_attendance-session-details.sql?raw";
import migration0007 from "../migrations/0007_add-od-column.sql?raw";
import migration0008 from "../migrations/0008_add-hot-path-indexes.sql?raw";
import migration0009 from "../migrations/0009_attendance-integrity-and-class-indexes.sql?raw";
import migration0010 from "../migrations/0010_auth-staff-subject-indexes.sql?raw";
import migration0011 from "../migrations/0011_attendance-session-otp-lookup-index.sql?raw";
import migration0013 from "../migrations/0013_department-aware-attendance.sql?raw";
import migration0014 from "../migrations/0014_cse-2026-2030-test-seed.sql?raw";
import migration0015 from "../migrations/0015_simplify-subjects.sql?raw";

/*
 * 0016 is intentionally absent from this list. `PRODUCTION_REGISTRY_DDL` below
 * stands in for it, because applying the file in `migrations/` would rebuild the
 * drifted schema into the one it drifted away from, and then assert nothing.
 */
const APPLY_ORDER = [
	migration0001,
	migration0002,
	migration0003,
	migration0004,
	migration0005,
	migration0006,
	migration0007,
	migration0008,
	migration0009,
	migration0010,
	migration0011,
	migration0013,
	migration0014,
	migration0015,
];

/**
 * The registry table as production has it.
 *
 * Copied from the `academic_batches` entry in `backup-pre0018.sql`, which is a
 * dump of the production database taken immediately before migration 0018. The
 * indentation and the `UNIQUE` on the closing line are the dump's own.
 */
const PRODUCTION_REGISTRY_DDL = `CREATE TABLE academic_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department TEXT NOT NULL,
      batch TEXT NOT NULL,
      start_year INTEGER NOT NULL,
      end_year INTEGER NOT NULL,
      student_table TEXT NOT NULL,
      attendance_table TEXT NOT NULL,
      UNIQUE (department, batch))`;

const ADMIN_ID = "c5e5f000-0000-4000-8000-0000000000ad";
const ADMIN_TOKEN = "registry-drift-admin-token";
const STUDENT_ID = "c5e5ffff-0000-4000-8000-0000000000ff";
const STUDENT_TOKEN = "registry-drift-student-token";

async function applyMigration(sql: string): Promise<void> {
	const statements = sql
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("--"))
		.join("\n")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
	for (const statement of statements) {
		await env.DB.prepare(statement).run();
	}
}

interface ApiResult {
	status: number;
	body: any;
}

async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
	const response = await SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { "Content-Type": "application/json", Cookie: `campus-flow-session=${ADMIN_TOKEN}` },
	});
	return { status: response.status, body: await response.json() };
}

function createBatch(department: string, batch: string): Promise<ApiResult> {
	return api("/api/admin/batches", {
		method: "POST",
		body: JSON.stringify({ department, batch }),
	});
}

async function tableExists(name: string): Promise<boolean> {
	const row = await env.DB
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.bind(name)
		.first<{ name: string }>();
	return row !== null;
}

describe("batch creation on the deployed academic_batches schema", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}
		await env.DB.prepare(PRODUCTION_REGISTRY_DDL).run();
		await env.DB
			.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
			.bind(ADMIN_ID, "drift-admin", "not-a-real-hash", "admin", "drift.admin@kiot.ac.in")
			.run();
		await env.DB
			.prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
			.bind(hashToken(ADMIN_TOKEN), ADMIN_ID, new Date(Date.now() + 60 * 60_000).toISOString())
			.run();
		/*
		 * A non-admin session, so the gate in front of the registry write is proved
		 * rather than assumed. The role alone decides it: `requireAdmin` reads the
		 * database, not the request.
		 */
		await env.DB
			.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
			.bind(STUDENT_ID, "drift-student", "not-a-real-hash", "student", "drift.student@kiot.ac.in")
			.run();
		await env.DB
			.prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
			.bind(hashToken(STUDENT_TOKEN), STUDENT_ID, new Date(Date.now() + 60 * 60_000).toISOString())
			.run();
	});

	describe("the fixture itself", () => {
		it("really is missing created_by, or the rest of this file proves nothing", async () => {
			const { results } = await env.DB
				.prepare("SELECT name FROM pragma_table_info(?)")
				.bind("academic_batches")
				.all<{ name: string }>();
			const columns = results.map((row) => row.name);
			expect(columns).not.toContain("created_by");
			expect(columns).not.toContain("created_at");
			// The six the deployed table does have are the contract the write relies on.
			expect(columns).toEqual(
				expect.arrayContaining([
					"department",
					"batch",
					"start_year",
					"end_year",
					"student_table",
					"attendance_table",
				])
			);
		});

		it("cannot upsert on created_by, which is what the route used to do", async () => {
			// The failing statement, verbatim. Asserted directly so that if the route
			// ever stops failing this way, the reason is visible rather than implied.
			await expect(
				env.DB
					.prepare(
						`INSERT INTO academic_batches
						   (department, batch, start_year, end_year, student_table, attendance_table, created_by)
						 VALUES (?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (department, batch) DO UPDATE SET
						   student_table = excluded.student_table,
						   attendance_table = excluded.attendance_table`,
					)
					.bind("IT", "2029_2033", 2029, 2033, "IT_Students_2029_2033", "IT_Attendance_2029_2033", ADMIN_ID)
					.run()
			).rejects.toThrow(/no column named created_by/);
		});
	});

	describe("authorization", () => {
		it("refuses an unauthenticated creation attempt", async () => {
			// The registry write sits behind the same gates as every other admin write;
			// a fix must not have moved it in front of them.
			const response = await SELF.fetch("https://example.com/api/admin/batches", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ department: "IT", batch: "2031_2035" }),
			});
			expect(response.status).toBe(401);
			expect(await tableExists("IT_Students_2031_2035")).toBe(false);
		});

		it("refuses a student session attempting a creation", async () => {
			const response = await SELF.fetch("https://example.com/api/admin/batches", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: `campus-flow-session=${STUDENT_TOKEN}`,
				},
				body: JSON.stringify({ department: "IT", batch: "2031_2035" }),
			});
			expect(response.status).toBe(403);
			expect(await tableExists("IT_Students_2031_2035")).toBe(false);
		});
	});

	describe("POST /api/admin/batches", () => {
		it("creates the cohort and registers it", async () => {
			const { status, body } = await createBatch("ECE", "2027_2031");
			expect(status).toBe(200);
			expect(body).toMatchObject({
				success: true,
				created: true,
				department: "ECE",
				batch: "2027_2031",
				studentTable: "ECE_Students_2027_2031",
				attendanceTable: "ECE_Attendance_2027_2031",
			});

			const row = await env.DB
				.prepare(
					"SELECT department, batch, start_year, end_year, student_table, attendance_table FROM academic_batches WHERE department = ? AND batch = ?"
				)
				.bind("ECE", "2027_2031")
				.first<Record<string, unknown>>();
			expect(row).toEqual({
				department: "ECE",
				batch: "2027_2031",
				start_year: 2027,
				end_year: 2031,
				student_table: "ECE_Students_2027_2031",
				attendance_table: "ECE_Attendance_2027_2031",
			});
		});

		it("makes the new cohort discoverable and usable without a migration", async () => {
			// Registry hydration is what every other route reads, so a cohort that was
			// written but not listed is created as far as the table is concerned and
			// invisible to the application.
			const { status, body } = await api("/api/admin/batches?department=ECE");
			expect(status).toBe(200);
			expect(body.batches.ECE.map((b: { key: string }) => b.key)).toContain("2027_2031");

			// The student-management read is the next thing an admin does, and it
			// resolves the same registry.
			const roster = await api("/api/admin/students?department=ECE&batch=2027_2031");
			expect(roster.status).toBe(200);
			expect(roster.body.students).toEqual([]);
		});

		it("is idempotent for a cohort that already exists", async () => {
			const before = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM academic_batches WHERE department = ? AND batch = ?")
				.bind("ECE", "2027_2031")
				.first<{ n: number }>();
			const { status, body } = await createBatch("ECE", "2027_2031");
			expect(status).toBe(200);
			expect(body.created).toBe(false);
			expect(body.tablesCreated).toBe(false);

			const after = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM academic_batches WHERE department = ? AND batch = ?")
				.bind("ECE", "2027_2031")
				.first<{ n: number }>();
			// Still one row: the upsert updated it in place rather than adding another.
			expect(after?.n).toBe(before?.n);
			expect(after?.n).toBe(1);
		});

		it("heals the orphan tables a failed attempt leaves behind", async () => {
			/*
			 * The state every failed production attempt produced: the tables exist,
			 * nothing registered them. Provisioning is `CREATE TABLE IF NOT EXISTS`, so
			 * this must finish the job rather than fail on the existing pair or, worse,
			 * report success over a cohort the registry still cannot resolve.
			 */
			await env.DB
				.prepare(
					`CREATE TABLE EEE_Students_2028_2032 (
					   id INTEGER PRIMARY KEY AUTOINCREMENT,
					   student_id TEXT NOT NULL UNIQUE,
					   register_no TEXT NOT NULL UNIQUE,
					   student_name TEXT NOT NULL,
					   year INTEGER NOT NULL,
					   section TEXT NOT NULL,
					   email TEXT NOT NULL UNIQUE,
					   created_at TEXT DEFAULT CURRENT_TIMESTAMP,
					   auth_user_id TEXT,
					   mentor_email TEXT
					 )`
				)
				.run();
			expect(await tableExists("EEE_Attendance_2028_2032")).toBe(false);

			const { status, body } = await createBatch("EEE", "2028_2032");
			expect(status).toBe(200);
			// The missing table is created; the existing one is left exactly as it is.
			expect(body.tablesCreated).toBe(true);
			expect(await tableExists("EEE_Attendance_2028_2032")).toBe(true);

			const listed = await api("/api/admin/batches?department=EEE");
			expect(listed.body.batches.EEE.map((b: { key: string }) => b.key)).toContain("2028_2032");
		});

		it("still validates the department and the year range", async () => {
			// The fix must not have opened the endpoint up: an unvalidated label is what
			// would become a table name.
			for (const payload of [
				{ department: "ME", batch: "2027_2031" },
				{ department: "ECE'; DROP TABLE academic_batches", batch: "2027_2031" },
				{ department: "ECE", batch: "2027_2030" },
				{ department: "ECE", batch: "27_31" },
				{ department: "ECE", batch: "2027_2031; DROP TABLE academic_batches" },
				{ department: "ECE", batch: "" },
				{ department: "ECE" },
			]) {
				const { status, body } = await api("/api/admin/batches", {
					method: "POST",
					body: JSON.stringify(payload),
				});
				expect(status, `${JSON.stringify(payload)} should be refused`).toBe(400);
				expect(body.success).toBe(false);
			}

			// And the table is still there afterwards.
			expect(await tableExists("academic_batches")).toBe(true);
		});
	});

	describe("import into a cohort created on this schema", () => {
		it("provisions on first import and records the cohort once", async () => {
			// The import path is the other writer of this row, and it used the same
			// broken column list, so a first-of-a-cohort import failed identically.
			const imported = await api("/api/admin/students?department=IT&batch=2029_2033", {
				method: "POST",
				body: JSON.stringify({
					rows: [
						{
							student_id: "2K29IT001",
							register_no: "29IT001",
							student_name: "Drift Case",
							year: 1,
							section: "C",
							email: "drift.case@kiot.ac.in",
						},
					],
				}),
			});
			expect(imported.status).toBe(200);
			expect(imported.body.created).toBe(1);

			const row = await env.DB
				.prepare("SELECT student_table, attendance_table FROM academic_batches WHERE department = ? AND batch = ?")
				.bind("IT", "2029_2033")
				.first<Record<string, unknown>>();
			expect(row).toEqual({
				student_table: "IT_Students_2029_2033",
				attendance_table: "IT_Attendance_2029_2033",
			});

			const listed = await api("/api/admin/batches?department=IT");
			expect(listed.body.batches.IT.map((b: { key: string }) => b.key)).toContain("2029_2033");
		});
	});

	describe("a registry write that cannot succeed", () => {
		it("answers with JSON rather than crashing, and does not claim success", async () => {
			// The registry is gone entirely, which is a different misconfiguration from
			// the drift above but reaches the same statement. What matters either way is
			// that the route degrades into a reported failure with its tables already
			// created, not into a cohort the application believes in.
			await env.DB.prepare("DROP TABLE academic_batches").run();

			const { status, body } = await createBatch("ECE", "2033_2037");
			expect(status).toBeGreaterThanOrEqual(500);
			expect(body.success).toBe(false);
			// No row, so nothing can resolve the pair it left behind.
			expect(await tableExists("academic_batches")).toBe(false);
			// The tables are there, which is what makes a retry, once the registry is
			// back, a complete operation rather than a half-finished one.
			expect(await tableExists("ECE_Students_2033_2037")).toBe(true);
			expect(await tableExists("ECE_Attendance_2033_2037")).toBe(true);

			const after = await env.DB
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ECE_Students_%'")
				.all<{ name: string }>();
			expect(after.results.map((row) => row.name).sort()).toEqual([
				"ECE_Students_2027_2031",
				"ECE_Students_2033_2037",
			]);
		});

		it("does not serve a cohort whose registry row could not be written", async () => {
			// The tables exist and the registry does not, so the resolver must not offer
			// them. This is the property that stops a failed attempt from becoming a
			// selectable-but-broken cohort in the picker.
			const { status } = await api("/api/admin/students?department=ECE&batch=2033_2037");
			expect(status).toBe(400);

			const listed = await api("/api/admin/batches?department=ECE");
			expect(listed.status).toBe(200);
			expect(listed.body.batches.ECE.map((b: { key: string }) => b.key)).not.toContain("2033_2037");
		});
	});
});
