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
 * CSE 2026-2030 provisioning, migration 0014+0015.
 *
 * The point of this suite is the second department. Everything here is written to
 * fail if CSE traffic is ever routed to an IT table, which is the specific
 * failure mode that a single-department test suite cannot catch: with only IT
 * configured, a resolver that ignored department entirely would still pass.
 *
 * Each file gets isolated storage, so this file applies the migrations itself
 * rather than sharing the IT attendance suite's schema.
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

/* Wrangler-style: strip comment lines, then run each statement. */
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

const ADVISOR_STAFF_ID = "104";
const ADVISOR_TOKEN = "cse-advisor-session-token";
const STUDENT_TOKEN = "cse-student-session-token";
const SUBJECT_CODE = "CSETST101";

/** Signs a session in the way the real login does: a hashed token row. */
async function createAuthSession(authUserId: string, token: string): Promise<void> {
	await env.DB
		.prepare(
			"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)",
		)
		.bind(hashToken(token), authUserId, new Date(Date.now() + 60 * 60_000).toISOString())
		.run();
}

function advisorCookie(): string {
	return `campus-flow-session=${ADVISOR_TOKEN}`;
}

function studentCookie(): string {
	return `campus-flow-session=${STUDENT_TOKEN}`;
}

async function generateForCse(): Promise<Response> {
	return SELF.fetch("https://example.com/api/attendance/generate", {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: advisorCookie() },
		body: JSON.stringify({
			department: "CSE",
			batch: "2026_2030",
			year: 1,
			section: "A",
			period: 1,
			subject_code: SUBJECT_CODE,
			subject_name: "CSE Year 1 Test Subject",
		}),
	});
}

describe("migration 0014 CSE 2026-2030 provisioning", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}

		await createAuthSession("c5e5f004-0000-4000-8000-000000000004", ADVISOR_TOKEN);
		await createAuthSession("c5e50001-0000-4000-8000-000000000001", STUDENT_TOKEN);
	});

	describe("tables", () => {
		it("creates both halves of the batch", async () => {
			// A batch with only a student table cannot take attendance, so both
			// are asserted rather than just the cohort.
			const { results } = await env.DB
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
				)
				.bind("CSE_Students_2026_2030", "CSE_Attendance_2026_2030")
				.all();
			expect(results.map((row: { name: string }) => row.name).sort()).toEqual([
				"CSE_Attendance_2026_2030",
				"CSE_Students_2026_2030",
			]);
		});

		it("gives the CSE attendance table the same columns as the IT ones", async () => {
			const columnNames = async (table: string) => {
				const { results } = await env.DB
					.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
					.bind(table)
					.all();
				return results.map((row: { name: string }) => row.name);
			};
			// Structural parity is what makes the shared code path work: the
			// finalize and report queries are written against these columns.
			expect(await columnNames("CSE_Attendance_2026_2030")).toEqual(
				await columnNames("IT_Attendance_2024_2028"),
			);
			expect(await columnNames("CSE_Students_2026_2030")).toEqual(
				await columnNames("IT_Students_2024_2028"),
			);
		});

		it("carries the duplicate-protection index", async () => {
			const { results } = await env.DB
				.prepare(
					`SELECT sql FROM sqlite_master WHERE type = 'index'
					 AND tbl_name = 'CSE_Attendance_2026_2030'
					   AND name = 'idx_cse_attendance_session_register'`,
				)
				.all();
			expect(results).toHaveLength(1);
			expect(String(results[0].sql)).toContain("UNIQUE");
		});
	});

	describe("seeded students", () => {
		it("seeds exactly ten", async () => {
			const row = await env.DB
				.prepare("SELECT COUNT(*) AS total FROM CSE_Students_2026_2030")
				.first<{ total: number }>();
			expect(row?.total).toBe(10);
		});

		it("seeds the required identifiers", async () => {
			const { results } = await env.DB
				.prepare(
					`SELECT student_id, register_no, email, year, section
					 FROM CSE_Students_2026_2030 ORDER BY student_id`,
				)
				.all();
			expect(results).toHaveLength(10);
			for (const [index, row] of results.entries()) {
				const suffix = String(index + 1).padStart(3, "0");
				expect(row.student_id).toBe(`2k26cse${suffix}`);
				expect(row.email).toBe(`2k26cse${suffix}@kiot.ac.in`);
				expect(row.register_no).toBe(`611226104${suffix}`);
				expect(row.year).toBe(1);
				expect(row.section).toBe("A");
			}
		});

		it("rejects a duplicate student rather than adding a second row", async () => {
			await expect(
				env.DB
					.prepare(
						`INSERT INTO CSE_Students_2026_2030
						 (student_id, register_no, student_name, year, section, email, auth_user_id)
						 VALUES ('2k26cse001', '611226104999', 'Duplicate', 1, 'A', 'dup@kiot.ac.in', 'dup')`,
					)
					.run(),
			).rejects.toThrow();
		});

		it("is re-runnable without duplicating the seed", async () => {
			// Idempotency: re-applying must be a no-op, not a second set of rows.
			await applyMigration(migration0014);
			const row = await env.DB
				.prepare("SELECT COUNT(*) AS total FROM CSE_Students_2026_2030")
				.first<{ total: number }>();
			expect(row?.total).toBe(10);
		});
	});

	describe("seeded staff", () => {
		it("seeds exactly four CSE staff", async () => {
			const row = await env.DB
				.prepare("SELECT COUNT(*) AS total FROM staff WHERE department = 'CSE'")
				.first<{ total: number }>();
			expect(row?.total).toBe(4);
		});

		it("adds no staff in any other department", async () => {
			// Migrations are schema-only and never seed staff, so the only rows
			// that can exist here are the four this migration inserted. This is
			// the non-interference check: 0014 created CSE staff and nothing else.
			const { results } = await env.DB
				.prepare("SELECT department, COUNT(*) AS total FROM staff GROUP BY department")
				.all();
			expect(results).toHaveLength(1);
			expect(results[0].department).toBe("CSE");
			expect(results[0].total).toBe(4);
		});

		it("marks exactly one class advisor, assigned to CSE 2026-2030 year 1 section A", async () => {
			const row = await env.DB
				.prepare(
					`SELECT staff_id, department, class_advisor, advisor_batch, advisor_year, advisor_section
					 FROM staff
					 WHERE department = 'CSE' AND class_advisor = '1'`,
				)
				.all();
			expect(row.results).toHaveLength(1);
			expect(row.results[0].staff_id).toBe(ADVISOR_STAFF_ID);
			expect(row.results[0].advisor_batch).toBe("2026_2030");
			expect(row.results[0].advisor_year).toBe(1);
			expect(row.results[0].advisor_section).toBe("A");
		});

		it("gives the other three no advisor assignment", async () => {
			const { results } = await env.DB
				.prepare(
					`SELECT COUNT(*) AS total FROM staff
					 WHERE department = 'CSE' AND class_advisor IS NULL
					   AND advisor_batch IS NULL
					   AND advisor_year IS NULL
					   AND advisor_section IS NULL`,
				)
				.all();
			expect(results[0].total).toBe(3);
		});
	});

	describe("authentication compatibility", () => {
		it("gives every seeded account a login row", async () => {
			const students = await env.DB
				.prepare(
					`SELECT COUNT(*) AS total FROM auth_users
					 WHERE role = 'student' AND auth_user_id IN (SELECT auth_user_id FROM CSE_Students_2026_2030)`,
				)
				.first<{ total: number }>();
			expect(students?.total).toBe(10);

			const staff = await env.DB
				.prepare("SELECT COUNT(*) AS total FROM auth_users WHERE role = 'staff'")
				.first<{ total: number }>();
			expect(staff?.total).toBe(3);

			const advisors = await env.DB
				.prepare("SELECT COUNT(*) AS total FROM auth_users WHERE role = 'class_advisor'")
				.first<{ total: number }>();
			expect(advisors?.total).toBe(1);
		});

		it("stores passwords as bcrypt hashes, never plaintext", async () => {
			const { results } = await env.DB
				.prepare(
					`SELECT pwd_hash FROM auth_users
					 WHERE auth_user_id IN (
					   SELECT auth_user_id FROM CSE_Students_2026_2030
					   UNION SELECT auth_user_id FROM staff WHERE department = 'CSE'
					 )`,
				)
				.all();
			expect(results.length).toBe(14);
			for (const row of results) {
				expect(String(row.pwd_hash)).toMatch(/^\$2[aby]\$\d{2}\$/);
				expect(String(row.pwd_hash)).toHaveLength(60);
			}
		});

		it("does not collide with the existing IT staff user names", async () => {
			// auth_users.user_name is UNIQUE and holds the staff_id. Reusing 1-4
			// would have broken authentication for real accounts.
			const { results } = await env.DB
				.prepare("SELECT user_name FROM auth_users WHERE role = 'class_advisor'")
				.all();
			expect(results.map((row: { user_name: string }) => row.user_name)).toContain(ADVISOR_STAFF_ID);
		});

		it("logs a CSE student in by ID and resolves CSE identity", async () => {
			const response = await SELF.fetch("https://example.com/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				// Lowercase, exactly as seeded. The route uppercases a non-email
				// identifier before lookup, so this only works because the login
				// key was stored uppercase while the student_id stayed lowercase.
				body: JSON.stringify({ user_name: "2k26cse001", password: "1234" }),
			});
			const body = (await response.json()) as {
				success: boolean;
				student?: { student_id: string; department: string; batch: string; year: number; section: string };
			};
			expect(response.status).toBe(200);
			expect(body.success).toBe(true);
			// The required lowercase identifier is preserved on the student record.
			expect(body.student?.student_id).toBe("2k26cse001");
			// The batch is recovered from the table the student was found in.
			expect(body.student?.department).toBe("CSE");
			expect(body.student?.batch).toBe("2026_2030");
			expect(body.student?.year).toBe(1);
			expect(body.student?.section).toBe("A");
		});

		it("logs a CSE student in by email", async () => {
			const response = await SELF.fetch("https://example.com/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ user_name: "2k26cse001@kiot.ac.in", password: "1234" }),
			});
			expect(response.status).toBe(200);
		});

		it("logs a CSE staff member in by staff id and resolves CSE department", async () => {
			const response = await SELF.fetch("https://example.com/api/auth/staff/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				// The staff route takes staff_id or email, not user_name.
				body: JSON.stringify({ staff_id: ADVISOR_STAFF_ID, password: "1234" }),
			});
			const body = (await response.json()) as {
				success?: boolean;
				staff?: { department: string };
			};
			expect(response.status).toBe(200);
			expect(body.success).toBe(true);
			expect(body.staff?.department).toBe("CSE");
		});

		it("logs a CSE staff member in by email", async () => {
			const response = await SELF.fetch("https://example.com/api/auth/staff/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "cse.advisor@kiot.ac.in", password: "1234" }),
			});
			expect(response.status).toBe(200);
		});

		it("rejects a wrong password", async () => {
			const response = await SELF.fetch("https://example.com/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ user_name: "2k26cse001", password: "not-the-password" }),
			});
			expect(response.status).toBe(401);
		});
	});

	describe("attendance routing", () => {
		it("generates a CSE session against the CSE tables", async () => {
			const response = await generateForCse();
			const body = (await response.json()) as {
				success: boolean;
				session?: { department: string; batch: string; otp: string };
			};
			expect(response.status).toBe(200);
			expect(body.success).toBe(true);
			expect(body.session?.department).toBe("CSE");
			expect(body.session?.batch).toBe("2026_2030");
		});

		it("rejects a CSE batch that was never provisioned", async () => {
			const response = await SELF.fetch("https://example.com/api/attendance/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: advisorCookie() },
				body: JSON.stringify({
					department: "CSE",
					batch: "2027_2031",
					year: 1,
					section: "A",
					period: 1,
					subject_code: SUBJECT_CODE,
					subject_name: "CSE Year 1 Test Subject",
				}),
			});
			const body = (await response.json()) as { code?: string };
			expect(response.status).toBe(400);
			expect(body.code).toBe("batch-not-configured");
		});

		it("rejects an IT batch asked for as CSE", async () => {
			const response = await SELF.fetch("https://example.com/api/attendance/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: advisorCookie() },
				body: JSON.stringify({
					department: "CSE",
					batch: "2024_2028",
					year: 1,
					section: "A",
					period: 1,
					subject_code: SUBJECT_CODE,
					subject_name: "CSE Year 1 Test Subject",
				}),
			});
			const body = (await response.json()) as { code?: string };
			expect(response.status).toBe(400);
			expect(body.code).toBe("batch-not-configured");
		});

		it("rejects a missing batch instead of defaulting one", async () => {
			const response = await SELF.fetch("https://example.com/api/attendance/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: advisorCookie() },
				body: JSON.stringify({
					department: "CSE",
					year: 1,
					section: "A",
					period: 1,
					subject_code: SUBJECT_CODE,
					subject_name: "CSE Year 1 Test Subject",
				}),
			});
			expect(response.status).toBe(400);
		});
	});

	describe("cross-table safety", () => {
		it("writes CSE attendance only to the CSE table", async () => {
			const generated = await generateForCse();
			const { session } = (await generated.json()) as { session: { otp: string; session_id: string } };

			const verify = await SELF.fetch("https://example.com/api/attendance/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: studentCookie() },
				body: JSON.stringify({ otp: session.otp }),
			});
			expect(verify.status).toBe(200);

			const cse = await env.DB
				.prepare("SELECT COUNT(*) AS total FROM CSE_Attendance_2026_2030 WHERE session_id = ?")
				.bind(session.session_id)
				.first<{ total: number }>();
			expect(cse?.total).toBe(1);

			// The assertion that matters most: nothing reached IT.
			for (const table of ["IT_Attendance_2024_2028", "IT_Attendance_2025_2029"]) {
				const leaked = await env.DB
					.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE session_id = ?`)
					.bind(session.session_id)
					.first<{ total: number }>();
				expect(leaked?.total).toBe(0);
			}
		});

		it("rejects a second mark for the same student in the same session", async () => {
			const generated = await generateForCse();
			const { session } = (await generated.json()) as { session: { otp: string; session_id: string } };

			const first = await SELF.fetch("https://example.com/api/attendance/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: studentCookie() },
				body: JSON.stringify({ otp: session.otp }),
			});
			expect(first.status).toBe(200);

			// Direct insert, bypassing the route, to prove the index is real and
			// not merely the application checking first.
			await expect(
				env.DB
					.prepare(
						`INSERT INTO CSE_Attendance_2026_2030
						 (attendance_id, register_no, section, attendance_date, period,
						  subject_code, subject_name, session_id, status)
						 VALUES ('dup', '611226104001', 'A', '2026-01-01', 1, ?, ?, ?, 'PRESENT')`,
					)
					.bind(SUBJECT_CODE, "CSE Year 1 Test Subject", session.session_id)
					.run(),
			).rejects.toThrow();
		});

		it("leaves the IT tables empty overall", async () => {
			for (const table of ["IT_Attendance_2024_2028", "IT_Attendance_2025_2029"]) {
				const row = await env.DB
					.prepare(`SELECT COUNT(*) AS total FROM ${table}`)
					.first<{ total: number }>();
				expect(row?.total).toBe(0);
			}
		});
	});

	describe("class advisor compatibility", () => {
		it("serves the advisor roster from the CSE student table", async () => {
			const response = await SELF.fetch(
				"https://example.com/api/class-advisors/students",
				{ headers: { Cookie: advisorCookie() } },
			);
			const body = (await response.json()) as {
				data: { student_id: string }[] | null;
				error: { code: string } | null;
			};
			expect(response.status).toBe(200);
			expect(body.error).toBeNull();
			// Ten students, and not one row from an IT table.
			expect(body.data).toHaveLength(10);
			expect(body.data?.[0]?.student_id).toBe("2k26cse001");
		});

		it("reports the advisor assignment with the CSE batch", async () => {
			const response = await SELF.fetch(
				`https://example.com/api/class-advisors?staff_id=${ADVISOR_STAFF_ID}`,
				{ headers: { Cookie: advisorCookie() } },
			);
			const body = (await response.json()) as {
				data: { department: string; batch: string; year: number; section: string } | null;
			};
			expect(response.status).toBe(200);
			expect(body.data?.department).toBe("CSE");
			expect(body.data?.batch).toBe("2026_2030");
			expect(body.data?.year).toBe(1);
			expect(body.data?.section).toBe("A");
		});

		it("serves the CSE year 1 subject to the advisor", async () => {
			const response = await SELF.fetch("https://example.com/api/class-advisors/subjects", {
				headers: { Cookie: advisorCookie() },
			});
			const body = (await response.json()) as { data: { subject_code: string }[] };
			expect(response.status).toBe(200);
			expect(body.data.map((row) => row.subject_code)).toContain(SUBJECT_CODE);
		});
	});

	describe("cross-department attendance follows the requested department", () => {
		it("lets a CSE class advisor generate for a configured IT batch", async () => {
			// The department in the body is the class being marked, not a claim about
			// who may mark it. A CSE advisor reaching an IT batch is now expected
			// behaviour, and the request must route to the IT tables.
			const response = await SELF.fetch("https://example.com/api/attendance/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: advisorCookie() },
				body: JSON.stringify({
					department: "IT",
					batch: "2024_2028",
					year: 3,
					section: "A",
					period: 1,
					// Subjects are global, so the CSE test subject is a valid choice
					// for an IT class too.
					subject_code: SUBJECT_CODE,
					subject_name: "CSE Year 1 Test Subject",
				}),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				success: boolean;
				session: Record<string, unknown>;
			};
			expect(body.success).toBe(true);
			expect(body.session.department).toBe("IT");
			expect(body.session.batch).toBe("2024_2028");
		});

		it("still refuses a department+batch pair that is not configured", async () => {
			// IT has no 2026_2030 batch. Removing the department comparison must not
			// turn that into a permissions error or, worse, let it through.
			const response = await SELF.fetch("https://example.com/api/attendance/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: advisorCookie() },
				body: JSON.stringify({
					department: "IT",
					batch: "2026_2030",
					year: 3,
					section: "A",
					period: 1,
					subject_code: SUBJECT_CODE,
					subject_name: "CSE Year 1 Test Subject",
				}),
			});
			expect(response.status).toBe(400);
			expect(((await response.json()) as { code: string }).code).toBe("batch-not-configured");
		});
	});
});
