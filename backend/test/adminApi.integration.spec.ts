import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/utils/auth";
import {
	DEFAULT_INITIAL_PASSWORD,
	verifyDefaultPassword,
} from "../src/utils/accountProvisioning";
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
import migration0016 from "../migrations/0016_academic_batches.sql?raw";

/*
 * Admin provisioning, end to end against a real D1.
 *
 * The dashboard used to call `POST /api/functions/admin-students`, which has no
 * implementation on this Worker, so none of this was reachable. These tests drive
 * the replacement routes over HTTP and assert against the database rather than
 * against the JSON alone, because the interesting failures are schema-level: a
 * missing NOT NULL column, a missing unique index, a table name that resolved to
 * the wrong department, or an account that was created without its roster row.
 *
 * Two properties are load-bearing and are asserted explicitly rather than implied:
 *
 *   1. A batch created through the API must be usable by the attendance flow on
 *      the *next* request, without a migration and without a redeploy. That is the
 *      whole reason the registry exists, and it is the failure this suite is most
 *      likely to catch, because the module-level cache would hide it.
 *   2. A roster insert and its login accounts must be atomic. A half-provisioned
 *      student, one with a row but no account, cannot sign in and is invisible
 *      from the UI.
 *
 * Each test file gets isolated storage, so this file applies the migrations itself.
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
	migration0016,
];

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

const ADMIN_ID = "c5e5f000-0000-4000-8000-0000000000ad";
const ADMIN_TOKEN = "admin-api-session-token";
const STUDENT_ID = "c5e50001-0000-4000-8000-000000000001";
const STUDENT_TOKEN = "cse-student-session-token";

/** The cohort the admin creates through the API rather than a migration. */
const NEW_BATCH = "2024_2028";

function adminCookie(): string {
	return `campus-flow-session=${ADMIN_TOKEN}`;
}

function studentCookie(): string {
	return `campus-flow-session=${STUDENT_TOKEN}`;
}

async function createAuthSession(authUserId: string, token: string): Promise<void> {
	await env.DB
		.prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
		.bind(hashToken(token), authUserId, new Date(Date.now() + 60 * 60_000).toISOString())
		.run();
}

interface ApiResult {
	status: number;
	body: any;
}

async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
	const response = await SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { "Content-Type": "application/json", Cookie: adminCookie(), ...(init.headers ?? {}) },
	});
	return { status: response.status, body: await response.json() };
}

/** Two students in different sections, including the D section that was missing. */
const PILOT_STUDENTS = [
	{
		student_id: "2K24CS001",
		register_no: "24CS001",
		student_name: "Asha Raman",
		year: 3,
		section: "A",
		email: "asha.raman@kiot.ac.in",
	},
	{
		student_id: "2K24CS002",
		register_no: "24CS002",
		student_name: "Bilal Khan",
		year: 3,
		section: "D",
		email: "bilal.khan@kiot.ac.in",
	},
];

async function createBatch(): Promise<ApiResult> {
	return api("/api/admin/batches", {
		method: "POST",
		body: JSON.stringify({ department: "CSE", batch: NEW_BATCH }),
	});
}

async function importStudents(rows: unknown[] = PILOT_STUDENTS): Promise<ApiResult> {
	return api(`/api/admin/students?department=CSE&batch=${NEW_BATCH}`, {
		method: "POST",
		body: JSON.stringify({ rows }),
	});
}

describe("admin provisioning API", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}
		// The seed ships an advisor and a student but no admin, and every route here
		// is behind requireAdmin, so one has to exist to be tested at all.
		await env.DB
			.prepare(
				"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(ADMIN_ID, "api-admin", "not-a-real-hash", "admin", "api.admin@kiot.ac.in")
			.run();
		await createAuthSession(ADMIN_ID, ADMIN_TOKEN);
		await createAuthSession(STUDENT_ID, STUDENT_TOKEN);
	});

	describe("authorization", () => {
		it("refuses an unauthenticated request", async () => {
			const response = await SELF.fetch("https://example.com/api/admin/batches");
			expect(response.status).toBe(401);
		});

		it("refuses a non-admin session", async () => {
			const response = await SELF.fetch("https://example.com/api/admin/batches", {
				headers: { Cookie: studentCookie() },
			});
			expect(response.status).toBe(403);
		});
	});

	describe("GET /api/admin/batches", () => {
		it("reports departments and their provisioned batches", async () => {
			const { status, body } = await api("/api/admin/batches");
			expect(status).toBe(200);
			expect(body.departments).toContain("CSE");
			// Seeded by migration 0014, so this proves the registry merged the
			// pre-existing pair rather than only reporting what it just created.
			expect(body.batches.CSE.map((b: { key: string }) => b.key)).toContain("2026_2030");
			expect(body.batches.CSE).toHaveLength(1);
		});
	});

	describe("POST /api/admin/batches", () => {
		it("creates both tables and registers the batch", async () => {
			const { status, body } = await createBatch();
			expect(status).toBe(200);
			expect(body.created).toBe(true);
			expect(body.studentTable).toBe(`CSE_Students_${NEW_BATCH}`);
			expect(body.attendanceTable).toBe(`CSE_Attendance_${NEW_BATCH}`);

			const { results } = await env.DB
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
				)
				.bind(`CSE_Students_${NEW_BATCH}`, `CSE_Attendance_${NEW_BATCH}`)
				.all();
			expect(results.map((row: { name: string }) => row.name).sort()).toEqual([
				`CSE_Attendance_${NEW_BATCH}`,
				`CSE_Students_${NEW_BATCH}`,
			]);

			const registry = await env.DB
				.prepare("SELECT student_table, attendance_table FROM academic_batches WHERE department = ? AND batch = ?")
				.bind("CSE", NEW_BATCH)
				.first();
			expect(registry).toMatchObject({
				student_table: `CSE_Students_${NEW_BATCH}`,
				attendance_table: `CSE_Attendance_${NEW_BATCH}`,
			});
		});

		it("gives the new tables the same shape as the migrated ones", async () => {
			const columnNames = async (table: string) => {
				const { results } = await env.DB
					.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
					.bind(table)
					.all();
				return results.map((row: { name: string }) => row.name);
			};
			// Structural parity is what lets the shared attendance queries run
			// against a table that no migration ever mentioned.
			expect(await columnNames(`CSE_Students_${NEW_BATCH}`)).toEqual(
				await columnNames("CSE_Students_2026_2030"),
			);
			expect(await columnNames(`CSE_Attendance_${NEW_BATCH}`)).toEqual(
				await columnNames("CSE_Attendance_2026_2030"),
			);
		});

		it("is idempotent and never recreates an existing batch", async () => {
			// No import here on purpose: this asserts the create call is a no-op for a
			// batch that already exists, and importing first would make a later
			// roster test order-dependent.
			const before = await env.DB
				.prepare(`SELECT COUNT(*) AS n FROM CSE_Students_${NEW_BATCH}`)
				.first<{ n: number }>();
			const { status, body } = await createBatch();
			expect(status).toBe(200);
			expect(body.created).toBe(false);
			expect(body.tablesCreated).toBe(false);

			const after = await env.DB
				.prepare(`SELECT COUNT(*) AS n FROM CSE_Students_${NEW_BATCH}`)
				.first<{ n: number }>();
			expect(after?.n).toBe(before?.n);
		});

		it("rejects a batch that is not a real admission year range", async () => {
			// "2024-2028" is deliberately accepted and canonicalised to "2024_2028",
			// so a dash is not a rejection. These are the values that must be refused
			// because they would otherwise become a table name.
			for (const bad of [
				"2024_2029", // end year is not start + 4
				"24_28", // not four digits
				"2024_2028; DROP TABLE x", // statement separator
				"2024_2028 extra",
				"",
				"abcd_efgh",
				"CSE_Students_2024_2028",
			]) {
				const { status, body } = await api("/api/admin/batches", {
					method: "POST",
					body: JSON.stringify({ department: "CSE", batch: bad }),
				});
				expect(status, `batch "${bad}" should be rejected`).toBe(400);
				expect(body.success).toBe(false);
			}
		});

		it("accepts a dashed or spaced year range and stores the canonical form", async () => {
			const { status, body } = await api("/api/admin/batches", {
				method: "POST",
				body: JSON.stringify({ department: "ECE", batch: " 2030-2034 " }),
			});
			expect(status).toBe(200);
			expect(body.batch).toBe("2030_2034");
			expect(body.studentTable).toBe("ECE_Students_2030_2034");
		});

		it("rejects an unsupported department", async () => {
			const { status } = await api("/api/admin/batches", {
				method: "POST",
				body: JSON.stringify({ department: "CSE'; DROP TABLE students", batch: "2030_2034" }),
			});
			expect(status).toBe(400);
		});
	});

	describe("POST /api/admin/students", () => {
		it("inserts the roster and creates a matching login account per student", async () => {
			const { status, body } = await importStudents();
			expect(status).toBe(200);
			expect(body.created).toBe(2);
			expect(body.authAccountsCreated).toBe(2);

			const { results } = await env.DB
				.prepare(
					`SELECT student_id, register_no, student_name, year, section, email, auth_user_id
					 FROM CSE_Students_${NEW_BATCH} ORDER BY student_id`,
				)
				.all();
			expect(results).toHaveLength(2);
			expect((results[0] as any).section).toBe("A");
			// Section D was rejected by the previous A-C allow-list; storing it is the
			// regression this specific assertion exists for.
			expect((results[1] as any).section).toBe("D");

			for (const student of results as any[]) {
				expect(student.auth_user_id).toBeTruthy();
				const account = await env.DB
					.prepare("SELECT user_name, role, email, pwd_hash FROM auth_users WHERE auth_user_id = ?")
					.bind(student.auth_user_id)
					.first<any>();
				expect(account).toBeTruthy();
				expect(account.role).toBe("student");
				// The login handler matches on user_name OR email, so an account with
				// neither the ID nor the address could never be reached.
				expect([student.student_id, student.email.toUpperCase()]).toContain(account.user_name.toUpperCase());
				expect(account.pwd_hash).not.toBe("1234");
				expect(account.pwd_hash.startsWith("$2")).toBe(true);
			}
		});

		it("re-uploading the same rows is a no-op rather than a constraint failure", async () => {
			const { status, body } = await importStudents();
			expect(status).toBe(200);
			expect(body.created).toBe(0);
			expect(body.skipped).toBe(2);
			expect(body.authAccountsCreated).toBe(0);

			const roster = await env.DB
				.prepare(`SELECT COUNT(*) AS n FROM CSE_Students_${NEW_BATCH}`)
				.first<{ n: number }>();
			expect(roster?.n).toBe(2);

			// Counted by joining the roster to auth_users rather than by counting
			// every "student" account, because migration 0014 seeded ten CSE students
			// of its own and a global count would move for unrelated reasons.
			const linked = await env.DB
				.prepare(
					`SELECT COUNT(*) AS n
					 FROM auth_users a
					 JOIN CSE_Students_${NEW_BATCH} s ON s.auth_user_id = a.auth_user_id
					 WHERE a.role = 'student'`,
				)
				.first<{ n: number }>();
			expect(linked?.n).toBe(2);
		});

		it("rejects rows that fail validation without inserting any of them", async () => {
			const { status, body } = await importStudents([
				{ student_id: "2K24CS900", register_no: "24CS900", student_name: "Bad Row", year: 3, section: "Z", email: "bad@kiot.ac.in" },
				{ student_id: "2K24CS901", register_no: "24CS901", student_name: "No Email", year: 3, section: "A", email: "" },
			]);
			expect(status).toBe(400);
			expect(body.code).toBe("import-validation-failed");
			expect(body.details.invalid).toHaveLength(2);

			const { results } = await env.DB
				.prepare(`SELECT COUNT(*) AS n FROM CSE_Students_${NEW_BATCH}`)
				.all();
			expect((results[0] as { n: number }).n).toBe(2);
		});

		it("reports a duplicate in the same file and imports the first occurrence", async () => {
			const { status, body } = await importStudents([
				{ student_id: "2K24CS010", register_no: "24CS010", student_name: "First", year: 3, section: "A", email: "first@kiot.ac.in" },
				{ student_id: "2K24CS010", register_no: "24CS010", student_name: "Second", year: 3, section: "A", email: "first@kiot.ac.in" },
			]);
			expect(status).toBe(200);
			expect(body.created).toBe(1);
			expect(body.duplicates).toHaveLength(1);

			const { results } = await env.DB
				.prepare(`SELECT student_name FROM CSE_Students_${NEW_BATCH} WHERE student_id = ?`)
				.bind("2K24CS010")
				.all();
			expect(results).toEqual([{ student_name: "First" }]);
		});

		it("reports a new id whose email already belongs to a different student", async () => {
			const { status, body } = await importStudents([
				{ student_id: "2K24CS777", register_no: "24CS777", student_name: "Impostor", year: 3, section: "A", email: "asha.raman@kiot.ac.in" },
			]);
			expect(status).toBe(200);
			expect(body.created).toBe(0);
			// Without this check the insert would fail a UNIQUE constraint and take the
			// whole batch down with an opaque 500.
			expect(body.conflicts).toHaveLength(1);
			expect(body.conflicts[0].reason).toContain("already belongs to another student");
		});

		it("does not link a roster row to an account with a different role", async () => {
			await env.DB
				.prepare(
					"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(
					"c5e5f000-0000-4000-8000-0000000000cf",
					"2K24CS888",
					"not-a-real-hash",
					"staff",
					"advisor.elsewhere@kiot.ac.in",
				)
				.run();

			const { body } = await importStudents([
				{ student_id: "2K24CS888", register_no: "24CS888", student_name: "Wrong Role", year: 3, section: "A", email: "advisor.elsewhere@kiot.ac.in" },
			]);
			expect(body.created).toBe(0);
			expect(body.roleMismatches).toHaveLength(1);

			const { results } = await env.DB
				.prepare(`SELECT COUNT(*) AS n FROM CSE_Students_${NEW_BATCH} WHERE student_id = ?`)
				.bind("2K24CS888")
				.all();
			expect((results[0] as { n: number }).n).toBe(0);
		});

		it("refuses a body with no rows", async () => {
			const { status, body } = await api(`/api/admin/students?department=CSE&batch=${NEW_BATCH}`, {
				method: "POST",
				body: JSON.stringify({ rows: [] }),
			});
			expect(status).toBe(400);
			expect(body.code).toBe("empty-rows");
		});
	});

	describe("GET /api/admin/students", () => {
		it("lists the roster for the cohort", async () => {
			const { status, body } = await api(`/api/admin/students?department=CSE&batch=${NEW_BATCH}`);
			expect(status).toBe(200);
			expect(body.students.length).toBeGreaterThanOrEqual(2);
			expect(body.students[0]).toHaveProperty("register_no");
		});

		it("will not read a batch that was never provisioned", async () => {
			const { status, body } = await api("/api/admin/students?department=CSE&batch=2030_2034");
			expect(status).toBe(400);
			expect(body.code).toBe("batch-not-provisioned");
		});
	});

	describe("attendance against an admin-created batch", () => {
		it("lets an advisor generate a session and a rostered student verify the OTP", async () => {
			/*
			 * This is the assertion the whole registry exists for. The batch was
			 * created by an API call, not a migration, and the module-level allow-list
			 * cache was warmed before it existed. If hydration only happened inside
			 * the admin routes, this would fail with "batch not configured" while
			 * every admin test above still passed.
			 */
			const ADVISOR_ID = "c5e5f000-0000-4000-8000-0000000000d1";
			const ADVISOR_TOKEN_ADV = "new-batch-advisor-token";

			// The staff account needs the class_advisor role, not admin: /generate is
			// behind requireStaff, which authorizes on the account role.
			await env.DB
				.prepare(
					"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(ADVISOR_ID, "newbatch.advisor", "not-a-real-hash", "class_advisor", "newbatch.advisor@kiot.ac.in")
				.run();
			await env.DB
				.prepare(
					`INSERT INTO staff
					   (staff_id, staff_name, email, department, class_advisor, auth_user_id,
					    advisor_year, advisor_section, advisor_batch)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					"110",
					"API Advisor",
					"newbatch.advisor@kiot.ac.in",
					"CSE",
					"Y",
					ADVISOR_ID,
					3,
					"A",
					NEW_BATCH,
				)
				.run();
			await createAuthSession(ADVISOR_ID, ADVISOR_TOKEN_ADV);

			// /generate resolves the subject against the global catalog and 404s if it
			// is not there, so the subject is added first, through the same API.
			await api("/api/admin/subjects", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ subject_code: "CS24API1", subject_name: "API Provisioned Subject" }],
				}),
			});

			const generate = await SELF.fetch("https://example.com/api/attendance/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: `campus-flow-session=${ADVISOR_TOKEN_ADV}` },
				body: JSON.stringify({
					department: "CSE",
					batch: NEW_BATCH,
					year: 3,
					section: "A",
					period: 1,
					subject_code: "CS24API1",
					subject_name: "API Provisioned Subject",
				}),
			});
			expect(generate.status).toBe(200);
			const generated = (await generate.json()) as any;
			expect(generated.success).toBe(true);
			// The OTP is returned under `session`, not at the top level.
			expect(generated.session.otp).toMatch(/^\d{6}$/);
			expect(generated.session.batch).toBe(NEW_BATCH);

			/*
			 * The verify call identifies the student from its own session, not from
			 * the body, so this signs in as the student the roster import created.
			 * That closes the loop the dashboard exists for: an account created by
			 * the admin API is usable for attendance in the batch the admin API also
			 * created.
			 */
			const provisioned = await env.DB
				.prepare(
					`SELECT s.student_id, s.auth_user_id
					 FROM CSE_Students_${NEW_BATCH} s
					 WHERE s.student_id = '2K24CS001'`,
				)
				.first<{ student_id: string; auth_user_id: string }>();
			expect(provisioned?.auth_user_id).toBeTruthy();

			const STUDENT_TOKEN_NEW = "new-batch-student-token";
			await createAuthSession(provisioned!.auth_user_id, STUDENT_TOKEN_NEW);

			const verify = await SELF.fetch("https://example.com/api/attendance/verify", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: `campus-flow-session=${STUDENT_TOKEN_NEW}`,
				},
				body: JSON.stringify({ otp: generated.session.otp }),
			});
			expect(verify.status).toBe(200);
			const verified = (await verify.json()) as any;
			expect(verified.success).toBe(true);
			expect(verified.present).toBe(true);

			const mark = await env.DB
				.prepare(`SELECT status, register_no FROM CSE_Attendance_${NEW_BATCH} WHERE register_no = ?`)
				.bind("24CS001")
				.first<any>();
			expect(mark).toMatchObject({ status: "PRESENT", register_no: "24CS001" });
		});
	});

	describe("POST /api/admin/staff", () => {
		it("creates staff with a generated numeric staff_id and a login account", async () => {
			const { status, body } = await api(`/api/admin/staff?department=CSE&batch=${NEW_BATCH}`, {
				method: "POST",
				body: JSON.stringify({
					rows: [
						{ staff_name: "Nisha Iyer", email: "nisha.iyer@kiot.ac.in" },
						{
							staff_name: "Omar Farouk",
							email: "omar.farouk@kiot.ac.in",
							advisor_year: 3,
							advisor_section: "D",
							advisor_batch: NEW_BATCH,
						},
					],
				}),
			});
			expect(status).toBe(200);
			expect(body.created).toBe(2);

			const { results } = await env.DB
				.prepare("SELECT staff_id, staff_name, email, department, class_advisor, auth_user_id, advisor_batch FROM staff WHERE department = ? AND email IN (?, ?) ORDER BY email")
				.bind("CSE", "nisha.iyer@kiot.ac.in", "omar.farouk@kiot.ac.in")
				.all<any>();
			expect(results).toHaveLength(2);

			for (const member of results) {
				// staff_id has no default in the schema, and /api/auth/staff/login only
				// accepts an id that is a positive integer, so a non-numeric or missing
				// value here would create an account that cannot be signed into by ID.
				expect(Number.isInteger(Number(member.staff_id))).toBe(true);
				expect(Number(member.staff_id)).toBeGreaterThan(0);
				expect(member.department).toBe("CSE");
				expect(member.auth_user_id).toBeTruthy();
			}

			// The advisor row carries the cohort; the non-advisor row does not.
			const omar = results.find((row: any) => row.email === "omar.farouk@kiot.ac.in");
			expect(omar.class_advisor).toBe("Y");
			expect(omar.advisor_batch).toBe(NEW_BATCH);
			const nisha = results.find((row: any) => row.email === "nisha.iyer@kiot.ac.in");
			expect(nisha.advisor_batch).toBeNull();

			// An advisor gets the class-advisor role so the advisor routes authorize.
			const account = await env.DB
				.prepare("SELECT role FROM auth_users WHERE auth_user_id = ?")
				.bind((omar as any).auth_user_id)
				.first<any>();
			expect(account.role).toBe("class_advisor");
		});

		it("assigns distinct staff_id values to consecutive rows in one import", async () => {
			// ECE has no tables yet, so its batch is provisioned through the API in
			// the batch suite above; this import is about the id sequence, which is
			// derived in SQL and would collide if it were read once in the handler.
			const { body } = await api(`/api/admin/staff?department=ECE&batch=2030_2034`, {
				method: "POST",
				body: JSON.stringify({
					rows: [
						{ staff_name: "Batch Id One", email: "ece.one@kiot.ac.in" },
						{ staff_name: "Batch Id Two", email: "ece.two@kiot.ac.in" },
						{ staff_name: "Batch Id Three", email: "ece.three@kiot.ac.in" },
					],
				}),
			});
			expect(body.created).toBe(3);

			const { results } = await env.DB
				.prepare("SELECT staff_id FROM staff WHERE department = 'ECE' ORDER BY id")
				.all<any>();
			const ids = results.map((row: any) => row.staff_id);
			expect(ids).toHaveLength(3);
			expect(new Set(ids).size).toBe(3);
		});

		it("refuses a department and batch that do not go together", async () => {
			const { status, body } = await api("/api/admin/staff?department=EEE&batch=2030_2034", {
				method: "POST",
				body: JSON.stringify({ rows: [{ staff_name: "Nowhere", email: "nowhere@kiot.ac.in" }] }),
			});
			expect(status).toBe(400);
			expect(body.code).toBe("batch-not-provisioned");
		});

		it("skips an email that is already on the staff table", async () => {
			const { status, body } = await api(`/api/admin/staff?department=CSE&batch=${NEW_BATCH}`, {
				method: "POST",
				body: JSON.stringify({ rows: [{ staff_name: "Nisha Again", email: "nisha.iyer@kiot.ac.in" }] }),
			});
			expect(status).toBe(200);
			expect(body.created).toBe(0);
			expect(body.skipped).toBe(1);
		});
	});

	describe("GET /api/admin/staff", () => {
		it("lists the department's staff", async () => {
			const { status, body } = await api("/api/admin/staff?department=CSE");
			expect(status).toBe(200);
			expect(body.staff.every((member: any) => member.department === "CSE")).toBe(true);
		});
	});

	describe("subjects", () => {
		it("adds a subject and rejects a duplicate code", async () => {
			// A code the attendance test did not already create, so the first insert
			// here is genuinely new.
			const { status, body } = await api("/api/admin/subjects", {
				method: "POST",
				body: JSON.stringify({ rows: [{ subject_code: "CS24SUBJ", subject_name: "Catalog Subject" }] }),
			});
			expect(status).toBe(200);
			expect(body.created).toBe(1);

			const again = await api("/api/admin/subjects", {
				method: "POST",
				body: JSON.stringify({ rows: [{ subject_code: "CS24SUBJ", subject_name: "Duplicate" }] }),
			});
			expect(again.body.created).toBe(0);
			expect(again.body.skipped).toBe(1);
		});

		it("rejects a duplicate code inside one payload", async () => {
			const { body } = await api("/api/admin/subjects", {
				method: "POST",
				body: JSON.stringify({
					rows: [
						{ subject_code: "CS24DUP", subject_name: "One" },
						{ subject_code: "CS24DUP", subject_name: "Two" },
					],
				}),
			});
			expect(body.created).toBe(1);
			expect(body.duplicates).toHaveLength(1);
		});

		it("lists the catalog", async () => {
			const { status, body } = await api("/api/admin/subjects");
			expect(status).toBe(200);
			expect(body.subjects.some((subject: any) => subject.subject_code === "CS24SUBJ")).toBe(true);
		});
	});

	/*
	 * The confirmed product rule: students and staff both start on password 1234.
	 *
	 * These assertions exist to pin two things that are easy to break quietly. The
	 * stored value must be a bcrypt hash the existing login handler can verify, and
	 * the plaintext must never be persisted -- so the tests read the raw column
	 * rather than trusting the API response, and they verify the hash with the same
	 * bcrypt call `/api/auth/staff/login` and `/api/auth/login` use.
	 */
	describe("initial password", () => {
		it("is 1234 for a newly provisioned staff account, stored only as a hash", async () => {
			const { body } = await api(`/api/admin/staff?department=IT&batch=${NEW_BATCH}`, {
				method: "POST",
				body: JSON.stringify({ rows: [{ staff_name: "Password Check", email: "pw.check@kiot.ac.in" }] }),
			});
			expect(body.created).toBe(1);
			// Reported back so the dashboard can name it, in aggregate, once.
			expect(body.defaultPassword).toBe(DEFAULT_INITIAL_PASSWORD);
			expect(DEFAULT_INITIAL_PASSWORD).toBe("1234");

			const account = await env.DB
				.prepare("SELECT a.pwd_hash, a.user_name, a.role FROM auth_users a JOIN staff s ON s.auth_user_id = a.auth_user_id WHERE s.email = ?")
				.bind("pw.check@kiot.ac.in")
				.first<{ pwd_hash: string; user_name: string; role: string }>();

			// Not the plaintext, and recognisably a bcrypt hash.
			expect(account?.pwd_hash).not.toBe("1234");
			expect(account?.pwd_hash.startsWith("$2")).toBe(true);
			// And it actually verifies, which is what the login handler depends on.
			expect(await verifyDefaultPassword(account!.pwd_hash)).toBe(true);
		});

		it("is 1234 for a newly provisioned student account, stored only as a hash", async () => {
			const { body } = await importStudents([
				{ student_id: "2K24CS555", register_no: "24CS555", student_name: "Password Check", year: 3, section: "A", email: "pw.student@kiot.ac.in" },
			]);
			expect(body.defaultPassword).toBe("1234");

			const account = await env.DB
				.prepare(
					`SELECT a.pwd_hash FROM auth_users a JOIN CSE_Students_${NEW_BATCH} s ON s.auth_user_id = a.auth_user_id WHERE s.student_id = ?`,
				)
				.bind("2K24CS555")
				.first<{ pwd_hash: string }>();
			expect(account?.pwd_hash).not.toBe("1234");
			expect(account?.pwd_hash.startsWith("$2")).toBe(true);
			expect(await verifyDefaultPassword(account!.pwd_hash)).toBe(true);
		});

		it("never leaves plaintext in the auth_users table", async () => {
			// A blunt sweep rather than a targeted check: whatever else the import
			// wrote, no row anywhere may hold the literal.
			const { results } = await env.DB
				.prepare("SELECT auth_user_id, user_name FROM auth_users WHERE pwd_hash = ? OR pwd_hash = ?")
				.bind("1234", DEFAULT_INITIAL_PASSWORD)
				.all();
			expect(results).toEqual([]);
		});

		it("lets a newly provisioned staff account sign in with 1234", async () => {
			// End to end through the real login route, which is the only proof that
			// the hash written by provisioning is one the application accepts.
			await api(`/api/admin/staff?department=IT&batch=${NEW_BATCH}`, {
				method: "POST",
				body: JSON.stringify({ rows: [{ staff_name: "Login Check", email: "login.check@kiot.ac.in" }] }),
			});

			const response = await SELF.fetch("https://example.com/api/auth/staff/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "login.check@kiot.ac.in", password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as any;
			expect(body.success).toBe(true);
			expect(body.staff.email).toBe("login.check@kiot.ac.in");
			// The response must not echo the hash back to the browser.
			expect(JSON.stringify(body)).not.toContain("$2");
		});
	});
});
