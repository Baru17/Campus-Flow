/**
 * The live active-student counter, end to end against a real D1.
 *
 * The feature is a number on a staff dashboard, so most of what matters is not the
 * number itself -- it is who is allowed to move it and who is allowed to read it.
 * Both halves are therefore driven over HTTP rather than by calling the handlers
 * directly, because the role gates live in the routes: a handler called directly is
 * a handler whose authorisation has never been run.
 *
 * What is pinned here:
 *
 *   1. who may write activity (a signed-in student, and only a student),
 *   2. who may read the count (staff and class advisors, and nobody else),
 *   3. that the identity comes from the session rather than from the request,
 *   4. that the count is of *accounts* -- one account is one entry however many tabs,
 *      devices or sessions it has,
 *   5. that a heartbeat expires, and that a heartbeat cannot outlive, revive or
 *      otherwise qualify a session that has expired or been revoked,
 *   6. that the response carries the count and nothing else.
 *
 * ## On test 9 ("a body claiming to be somebody else changes nothing")
 *
 * `POST /api/activity/ping` has no identity parameter at all, so the honest way to
 * assert that is to send one and show it is ignored. Sending a staff account's id in
 * the body while authenticated as a student must not move the staff account, and must
 * not create a second row for anybody.
 *
 * ## The class-scoped endpoint and its fixtures
 *
 * `GET /api/activity/class-active-students` filters on the one link that exists
 * between an account and a roster row -- `auth_user_id` -- and filters department by
 * reading only that department's physical tables, because department is implied by
 * the table and is not a column on the roster.
 *
 * To prove that, the fixtures below deliberately span four different places a student
 * could be and shows each one landing in exactly one class:
 *
 *   - a second *cohort* of the same department (IT 2025_2029 rather than 2024_2028),
 *     which is the same class and must be counted;
 *   - a different *year* and a different *section* of the same cohort;
 *   - a different *department* (CSE), which shares year and section with an IT class
 *     and must still be excluded.
 *
 * Migration 0014 is applied for its CSE tables and its ten seeded year-1 CSE students,
 * which double as the check that an untouched roster contributes nothing.
 *
 * ## Storage
 *
 * Each test file gets isolated storage and applies the migrations itself, including
 * `0019_student_activity.sql` -- the reviewed artefact, not yet applied to production.
 * Applying it here proves it works without touching a real database.
 *
 * Session expiry and the 60s activity window are reached by writing the timestamps
 * directly, never by waiting: a test that slept for a minute would be slow and would
 * still be timing-dependent.
 */

import { env, SELF } from "cloudflare:test";
import bcrypt from "bcryptjs";
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
/*
 * Creates `academic_batches`. It is here for the one test that signs a student in
 * through `/api/auth/login` rather than planting a session: login resolves the
 * student's cohort through the registry, exactly as it does in production, so the
 * cohort has to be registered for the login to find the row.
 */
/*
 * Creates the CSE cohort tables and seeds ten CSE students, so the department filter
 * has a second department to keep out. Needs 0013 first: it is that migration which
 * adds the advisor columns 0014 writes into `staff`.
 */
import migration0013 from "../migrations/0013_department-aware-attendance.sql?raw";
import migration0014 from "../migrations/0014_cse-2026-2030-test-seed.sql?raw";
import migration0015 from "../migrations/0015_simplify-subjects.sql?raw";
import migration0016 from "../migrations/0016_academic_batches.sql?raw";
import migration0019 from "../migrations/0019_student_activity.sql?raw";

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
	migration0019,
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

/* --------------------------------------------------------------- fixtures */

const PASSWORD = "correct-horse-battery-staple";

/** Well inside the 60s window and well outside it, without any test sleeping. */
const RECENT_MS = 30_000;
const STALE_MS = 61_000;

const HOUR_MS = 60 * 60_000;

interface Account {
	authUserId: string;
	token: string;
	email: string;
}

async function makeAccount(
	role: string,
	label: string,
	options: { live?: boolean; linkedStudent?: boolean } = {},
): Promise<Account> {
	const { live = true, linkedStudent = false } = options;
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
	const authUserId = `c9e9f000-0000-4000-8000-${label}${suffix}`;
	const email = `${label}.${suffix}@kiot.ac.in`;
	const token = `${label}-token-${suffix}`;
	const passwordHash = await bcrypt.hash(PASSWORD, 4);

	const statements: D1PreparedStatement[] = [
		env.DB.prepare(
			`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
			 VALUES (?, ?, ?, ?, ?)`,
		).bind(authUserId, email, passwordHash, role, email),
	];

	if (linkedStudent) {
		const studentId = `ACT${suffix.toUpperCase()}`;
		statements.push(
			env.DB.prepare(
				`INSERT INTO IT_Students_2024_2028
				 (student_id, register_no, student_name, year, section, email, auth_user_id)
				 VALUES (?, ?, ?, 3, 'A', ?, ?)`,
			).bind(studentId, studentId, studentId, email, authUserId),
		);
	}

	if (live) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)`,
			).bind(hashToken(token), authUserId, new Date(Date.now() + HOUR_MS).toISOString()),
		);
	}

	await env.DB.batch(statements);
	return { authUserId, token, email };
}

/** A second live session for an account that already has one -- a second device. */
async function addSession(account: Account): Promise<string> {
	const token = `${account.token}-device-2`;
	await env.DB.prepare(
		`INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)`,
	)
		.bind(hashToken(token), account.authUserId, new Date(Date.now() + HOUR_MS).toISOString())
		.run();
	return token;
}

function cookie(token: string): string {
	return `campus-flow-session=${token}`;
}

function ping(token: string | null, body: unknown = {}): Promise<Response> {
	return SELF.fetch("https://example.com/api/activity/ping", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Cookie: cookie(token) } : {}),
		},
		body: JSON.stringify(body),
	});
}

function count(token: string | null): Promise<Response> {
	return SELF.fetch("https://example.com/api/activity/active-students", {
		headers: token ? { Cookie: cookie(token) } : {},
	});
}

async function readCount(token: string): Promise<number> {
	const response = await count(token);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { active_students: number };
	return body.active_students;
}

async function clearActivity(): Promise<void> {
	await env.DB.prepare("DELETE FROM student_activity").run();
}

async function ageActivity(authUserId: string, ageMs: number): Promise<void> {
	await env.DB.prepare("UPDATE student_activity SET last_active_at = ? WHERE auth_user_id = ?")
		.bind(new Date(Date.now() - ageMs).toISOString(), authUserId)
		.run();
}

/* --------------------------------------------------------------- fixtures */

let student: Account;
let otherStudent: Account;
let revokedStudent: Account;
let logoutStudent: Account;
let staff: Account;
let advisor: Account;
let admin: Account;

beforeAll(async () => {
	for (const migration of APPLY_ORDER) {
		await applyMigration(migration);
	}

	student = await makeAccount("student", "actstudent", { linkedStudent: true });
	otherStudent = await makeAccount("student", "actother", { linkedStudent: true });
	revokedStudent = await makeAccount("student", "actrevoked", { linkedStudent: true });
	/*
	 * Its own account, because signing out deletes the *current* session only. The
	 * shared `student` account has a second device session by then, which is exactly
	 * the case where remaining counted is correct -- so the logout test needs an
	 * account with nothing else signed in.
	 */
	logoutStudent = await makeAccount("student", "actlogout", { linkedStudent: true });
	staff = await makeAccount("staff", "actstaff", { linkedStudent: false });
	advisor = await makeAccount("class_advisor", "actadvisor", { linkedStudent: false });
	admin = await makeAccount("admin", "actadmin", { linkedStudent: false });

	await env.DB.prepare(
		`INSERT INTO staff (staff_id, staff_name, email, department, class_advisor, auth_user_id)
		 VALUES (?, ?, ?, 'IT', 0, ?)`,
	)
		.bind(`9${staff.authUserId.slice(-6)}`, "Active Count Staff", staff.email, staff.authUserId)
		.run();
});

/* ------------------------------------------------------------------ tests */

describe("POST /api/activity/ping", () => {
	it("refuses an unauthenticated caller", async () => {
		const response = await ping(null);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "auth-required" });
	});

	it("refuses a session that is not a student", async () => {
		for (const account of [staff, advisor, admin]) {
			const response = await ping(account.token);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "forbidden" });
		}

		await clearActivity();
		expect(await readCount(staff.token)).toBe(0);
	});

	it("records a beat for a signed-in student", async () => {
		await clearActivity();

		const response = await ping(student.token);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true });

		expect(await readCount(staff.token)).toBe(1);
	});

	it("ignores an identity claimed in the body", async () => {
		await clearActivity();

		const response = await ping(student.token, {
			auth_user_id: staff.authUserId,
			user_id: admin.authUserId,
			role: "staff",
		});
		expect(response.status).toBe(200);

		const rows = await env.DB.prepare("SELECT auth_user_id FROM student_activity").all<{
			auth_user_id: string;
		}>();
		expect(rows.results.map((row) => row.auth_user_id)).toEqual([student.authUserId]);
	});

	it("never creates, extends or revokes an authentication session", async () => {
		const before = await env.DB.prepare(
			"SELECT token_hash, auth_user_id, expires_at FROM auth_sessions WHERE auth_user_id = ?",
		)
			.bind(student.authUserId)
			.all<{ token_hash: string; auth_user_id: string; expires_at: string }>();

		for (let i = 0; i < 3; i += 1) {
			expect((await ping(student.token)).status).toBe(200);
		}

		const after = await env.DB.prepare(
			"SELECT token_hash, auth_user_id, expires_at FROM auth_sessions WHERE auth_user_id = ?",
		)
			.bind(student.authUserId)
			.all<{ token_hash: string; auth_user_id: string; expires_at: string }>();

		expect(after.results).toEqual(before.results);
	});
});

describe("GET /api/activity/active-students", () => {
	it("refuses an unauthenticated caller", async () => {
		const response = await count(null);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "auth-required" });
	});

	it("refuses a student session", async () => {
		const response = await count(student.token);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "forbidden" });
	});

	it("serves staff and class advisors", async () => {
		expect((await count(staff.token)).status).toBe(200);
		expect((await count(advisor.token)).status).toBe(200);
	});

	it("refuses an administrator", async () => {
		// `requireStaff` is the project's existing staff gate: staff and class advisor.
		// The admin dashboard is a separate surface and is deliberately not widened here.
		const response = await count(admin.token);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "forbidden" });
	});

	it("returns a count and a timestamp, and nothing identifying", async () => {
		await clearActivity();
		await ping(student.token);

		const response = await count(staff.token);
		expect(response.status).toBe(200);
		const body = await response.json();

		expect(Object.keys(body).sort()).toEqual(["active_students", "success", "updated_at"]);
		expect(body.success).toBe(true);
		expect(body.active_students).toBe(1);
		expect(Number.isNaN(Date.parse(body.updated_at))).toBe(false);

		// No name, register number, email, internal id, token or per-student row.
		const serialised = JSON.stringify(body);
		for (const secret of [
			student.email,
			student.authUserId,
			student.token,
			"ACT",
			"student_name",
			"register_no",
		]) {
			expect(serialised).not.toContain(secret);
		}
	});
});

describe("counting unique accounts", () => {
	it("counts each distinct student once, however many beats it sends", async () => {
		await clearActivity();

		for (let i = 0; i < 5; i += 1) {
			expect((await ping(student.token)).status).toBe(200);
		}
		expect((await ping(otherStudent.token)).status).toBe(200);

		const rows = await env.DB.prepare("SELECT auth_user_id FROM student_activity").all<{
			auth_user_id: string;
		}>();
		expect(rows.results).toHaveLength(2);
		expect(await readCount(staff.token)).toBe(2);
	});

	it("counts one account once across tabs and devices", async () => {
		await clearActivity();

		// A second tab of the same session, then a second device on a new session.
		await ping(student.token);
		await ping(student.token);
		await ping(await addSession(student));

		const rows = await env.DB.prepare("SELECT auth_user_id FROM student_activity").all<{
			auth_user_id: string;
		}>();
		expect(rows.results).toHaveLength(1);
		expect(await readCount(staff.token)).toBe(1);
	});

	it("excludes every non-student role even if a row reaches the table", async () => {
		await clearActivity();

		await ping(student.token);

		// The ping route already refuses these roles, so these rows are planted
		// directly: the count must not depend on the writer having been correct.
		const planted = await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO student_activity (auth_user_id, last_active_at) VALUES (?, ?)",
			).bind(staff.authUserId, new Date().toISOString()),
			env.DB.prepare(
				"INSERT INTO student_activity (auth_user_id, last_active_at) VALUES (?, ?)",
			).bind(advisor.authUserId, new Date().toISOString()),
			env.DB.prepare(
				"INSERT INTO student_activity (auth_user_id, last_active_at) VALUES (?, ?)",
			).bind(admin.authUserId, new Date().toISOString()),
		]);
		expect(planted.every((result) => result.success)).toBe(true);

		expect(await readCount(staff.token)).toBe(1);
	});
});

describe("expiry, revocation and the 60s window", () => {
	it("stops counting a student once their activity ages out", async () => {
		await clearActivity();
		await ping(student.token);
		expect(await readCount(staff.token)).toBe(1);

		await ageActivity(student.authUserId, RECENT_MS);
		expect(await readCount(staff.token)).toBe(1);

		await ageActivity(student.authUserId, STALE_MS);
		expect(await readCount(staff.token)).toBe(0);
	});

	it("does not count a student whose session has expired", async () => {
		await clearActivity();

		// A beat, then the session lapses. The row is still recent, which is the case
		// a heartbeat-driven counter gets wrong: recent activity must not be enough.
		await ping(revokedStudent.token);
		expect(await readCount(staff.token)).toBe(1);

		await env.DB.prepare("UPDATE auth_sessions SET expires_at = ? WHERE auth_user_id = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), revokedStudent.authUserId)
			.run();

		expect(await readCount(staff.token)).toBe(0);
		expect((await ping(revokedStudent.token)).status).toBe(401);
	});

	it("drops a student from the count when they log out", async () => {
		await clearActivity();
		await ping(logoutStudent.token);
		expect(await readCount(staff.token)).toBe(1);

		const response = await SELF.fetch("https://example.com/api/auth/logout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie(logoutStudent.token) },
			body: "{}",
		});
		expect(response.status).toBe(200);

		expect(await readCount(staff.token)).toBe(0);
		expect((await ping(logoutStudent.token)).status).toBe(401);

		// Sign back in the way the student page does, and the account returns.
		const login = await SELF.fetch("https://example.com/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ user_name: logoutStudent.email, password: PASSWORD }),
		});
		expect(login.status).toBe(200);
		const nextCookie = login.headers.get("Set-Cookie") ?? "";
		const nextToken = new URLSearchParams(nextCookie.split(";")[0]).get("campus-flow-session");
		expect(nextToken).toBeTruthy();

		expect((await ping(nextToken as string)).status).toBe(200);
		expect(await readCount(staff.token)).toBe(1);
	});

	it("keeps counting an account that is still signed in on another device", async () => {
		await clearActivity();

		/*
		 * The honest limit of a counter keyed on accounts rather than sessions:
		 * signing out removes one session, so an account with a second one is still
		 * genuinely using CampusFlow and is still counted once.
		 */
		await ping(student.token);
		const secondDevice = await addSession(student);
		await ping(secondDevice);

		const response = await SELF.fetch("https://example.com/api/auth/logout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie(student.token) },
			body: "{}",
		});
		expect(response.status).toBe(200);

		expect(await readCount(staff.token)).toBe(1);
		expect((await ping(student.token)).status).toBe(401);
	});
});

describe("the counter does not touch the workflows around it", () => {
	it("leaves every other table alone", async () => {
		await clearActivity();

		const tables = [
			"attendance_session",
			"IT_Attendance_2024_2028",
			"IT_Attendance_2025_2029",
			"auth_users",
			"auth_sessions",
			"staff",
			"subjects",
		];

		const before = new Map<string, number>();
		for (const table of tables) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{
				total: number;
			}>();
			before.set(table, row?.total ?? 0);
		}

		await ping(student.token);
		await ping(student.token);
		expect((await count(staff.token)).status).toBe(200);

		for (const table of tables) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{
				total: number;
			}>();
			expect(row?.total ?? -1).toBe(before.get(table));
		}
	});
});

/* ------------------------------------------------- class-specific counting */

const IT_2024 = "IT_Students_2024_2028";
const IT_2025 = "IT_Students_2025_2029";
const CSE_2026 = "CSE_Students_2026_2030";

/*
 * A roster row and a login row for one student, in a specific cohort.
 *
 * `table` is a literal from this file, never a request value, because the test is the
 * place where the physical-table-per-cohort fact is being set up rather than derived.
 * The two columns the endpoint joins on -- `auth_user_id`, `year`, `section` -- are
 * written exactly as `provisioning.ts` writes them.
 */
async function makeRosterStudent(label: string, table: string, year: number, section: string) {
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
	const authUserId = `c9e9f000-0000-4000-8001-${label}${suffix}`;
	const email = `${label}.${suffix}@kiot.ac.in`;
	const token = `${label}-token-${suffix}`;
	const studentId = `CLS${suffix.toUpperCase()}`;

	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
			 VALUES (?, ?, 'test-hash-not-used', 'student', ?)`,
		).bind(authUserId, studentId, email),
		env.DB.prepare(
			`INSERT INTO ${table} (student_id, register_no, student_name, year, section, email, auth_user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(studentId, `REG${suffix.toUpperCase()}`, `Class Test ${label}`, year, section, email, authUserId),
		env.DB.prepare(
			"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)",
		).bind(hashToken(token), authUserId, new Date(Date.now() + HOUR_MS).toISOString()),
	]);

	return { authUserId, token, email, studentId, table, year, section };
}

function classCount(token: string | null, query: Record<string, string>): Promise<Response> {
	const search = new URLSearchParams(query).toString();
	return SELF.fetch(`https://example.com/api/activity/class-active-students?${search}`, {
		headers: token ? { Cookie: cookie(token) } : {},
	});
}

async function readClassCount(token: string, department: string, year: number, section: string) {
	const response = await classCount(token, { department, year: String(year), section });
	expect(response.status).toBe(200);
	const body = (await response.json()) as { active_students: number };
	return body.active_students;
}

/** Beats once with every class fixture, so each lands in exactly one class. */
async function seedClassActivity(accounts: Account[]) {
	await clearActivity();
	for (const account of accounts) {
		const response = await ping(account.token);
		expect(response.status).toBe(200);
	}
}

let it3a: Account;
let it3aOtherCohort: Account;
let it3b: Account;
let it2a: Account;
let cse3a: Account;
/** Never logged out and never expired, so the role gates have a live student to refuse. */
let probeStudent: Account;

describe("GET /api/activity/class-active-students", () => {
	beforeAll(async () => {
		it3a = await makeRosterStudent("clsit3a", IT_2024, 3, "A");
		it3aOtherCohort = await makeRosterStudent("clsit3ab", IT_2025, 3, "A");
		it3b = await makeRosterStudent("clsit3b", IT_2024, 3, "B");
		it2a = await makeRosterStudent("clsit2a", IT_2024, 2, "A");
		cse3a = await makeRosterStudent("clscse3a", CSE_2026, 3, "A");
		probeStudent = await makeRosterStudent("clsprobe", IT_2024, 1, "D");
	});

	it("counts the selected class across every cohort of that department", async () => {
		await seedClassActivity([it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		/*
		 * Two students in IT year 3 section A, because that class spans two cohorts --
		 * 2024_2028 and 2025_2029 -- and a class is a department, a year and a
		 * section, not a cohort. Counting only the cohort that happened to be
		 * selected would silently under-report by a factor of the number of cohorts.
		 */
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(2);
	});

	it("excludes other sections and other years of the same cohort", async () => {
		await seedClassActivity([it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(1);
		expect(await readClassCount(staff.token, "IT", 2, "A")).toBe(1);
		expect(await readClassCount(staff.token, "IT", 3, "C")).toBe(0);
		expect(await readClassCount(staff.token, "IT", 4, "A")).toBe(0);
	});

	it("excludes another department that shares the year and section", async () => {
		await seedClassActivity([it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		expect(await readClassCount(staff.token, "CSE", 3, "A")).toBe(1);
		// And the ten CSE students migration 0014 seeded are active in no sense at all.
		expect(await readClassCount(staff.token, "CSE", 1, "A")).toBe(0);
		// ECE is a supported department with no provisioned cohort.
		expect(await readClassCount(staff.token, "ECE", 3, "A")).toBe(0);
	});

	it("counts an account once however many devices it is signed in on", async () => {
		await clearActivity();
		expect((await ping(it3a.token)).status).toBe(200);

		const secondDevice = await addSession(it3a);
		expect((await ping(secondDevice)).status).toBe(200);
		expect((await ping(it3a.token)).status).toBe(200);

		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(0);
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(1);
	});

	it("excludes a student whose session has expired", async () => {
		/*
		 * Its own account. Expiring a session is destructive to that account for the
		 * rest of the file, so the fixture that other tests count on is left alone.
		 */
		const lapsed = await makeRosterStudent("clslapsed", IT_2024, 3, "C");
		await seedClassActivity([lapsed]);
		expect(await readClassCount(staff.token, "IT", 3, "C")).toBe(1);

		await env.DB.prepare("UPDATE auth_sessions SET expires_at = ? WHERE auth_user_id = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), lapsed.authUserId)
			.run();

		expect(await readClassCount(staff.token, "IT", 3, "C")).toBe(0);
	});

	it("excludes a student whose activity has aged past the window", async () => {
		const ageing = await makeRosterStudent("clsageing", IT_2024, 4, "D");
		await seedClassActivity([ageing]);
		expect(await readClassCount(staff.token, "IT", 4, "D")).toBe(1);

		await ageActivity(ageing.authUserId, RECENT_MS);
		expect(await readClassCount(staff.token, "IT", 4, "D")).toBe(1);

		await ageActivity(ageing.authUserId, STALE_MS);
		expect(await readClassCount(staff.token, "IT", 4, "D")).toBe(0);
	});

	it("excludes a non-student account even if one is linked into the roster", async () => {
		await seedClassActivity([it3a]);
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(1);

		/*
		 * A staff account is given a heartbeat and a roster row, which is the shape an
		 * account would have if the ping gate or the import were ever wrong. It must
		 * still not be counted: the class count is a count of students.
		 */
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO ${IT_2024} (student_id, register_no, student_name, year, section, email, auth_user_id)
				 VALUES (?, ?, ?, 3, 'A', ?, ?)`,
			).bind("CLSSTAFF01", "REGSTAFF01", "Class Test Staff", `${staff.email}.roster`, staff.authUserId),
			env.DB.prepare("INSERT INTO student_activity (auth_user_id, last_active_at) VALUES (?, ?)").bind(
				staff.authUserId,
				new Date().toISOString(),
			),
		]);

		try {
			expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(1);
		} finally {
			await env.DB.batch([
				env.DB.prepare(`DELETE FROM ${IT_2024} WHERE student_id = ?`).bind("CLSSTAFF01"),
				env.DB.prepare("DELETE FROM student_activity WHERE auth_user_id = ?").bind(staff.authUserId),
			]);
		}
	});

	it("refuses an unauthenticated caller", async () => {
		const response = await classCount(null, { department: "IT", year: "3", section: "A" });
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "auth-required" });
	});

	it("refuses a student session", async () => {
		const response = await classCount(probeStudent.token, { department: "IT", year: "3", section: "A" });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "forbidden" });
	});

	it("refuses an administrator", async () => {
		const response = await classCount(admin.token, { department: "IT", year: "3", section: "A" });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "forbidden" });
	});

	it("serves staff and class advisors", async () => {
		expect((await classCount(staff.token, { department: "IT", year: "3", section: "A" })).status).toBe(200);
		expect((await classCount(advisor.token, { department: "IT", year: "3", section: "A" })).status).toBe(200);
	});

	it("rejects an incomplete or malformed class selection", async () => {
		const rejected: Record<string, string>[] = [
			{},
			{ department: "IT" },
			{ department: "IT", year: "3" },
			{ year: "3", section: "A" },
			{ department: "IT", year: "3", section: "" },
			{ department: "", year: "3", section: "A" },
			// Not a department the application supports.
			{ department: "XX", year: "3", section: "A" },
			{ department: "IT; DROP TABLE students", year: "3", section: "A" },
			{ department: "IT_Students_2024_2028", year: "3", section: "A" },
			// Year is a whole number from 1 to 4.
			{ department: "IT", year: "0", section: "A" },
			{ department: "IT", year: "5", section: "A" },
			{ department: "IT", year: "abc", section: "A" },
			{ department: "IT", year: "3.5", section: "A" },
			// Sections are A-D.
			{ department: "IT", year: "3", section: "Z" },
			{ department: "IT", year: "3", section: "A' OR 1=1" },
		];

		for (const query of rejected) {
			const response = await classCount(staff.token, query);
			expect(response.status, JSON.stringify(query)).toBe(400);
			expect(await response.json(), JSON.stringify(query)).toMatchObject({ code: "invalid-class" });
		}
	});

	it("accepts loose casing and spacing the same way the rest of the app does", async () => {
		await seedClassActivity([it3a]);

		expect(await readClassCount(staff.token, "  it ", 3, " a ")).toBe(1);
	});

	it("returns a count and a timestamp, and nothing identifying", async () => {
		await seedClassActivity([it3a, it2a, cse3a]);

		const response = await classCount(staff.token, { department: "IT", year: "3", section: "A" });
		expect(response.status).toBe(200);
		const body = await response.json();

		expect(Object.keys(body).sort()).toEqual(["active_students", "success", "updated_at"]);
		expect(body.active_students).toBe(1);
		expect(Number.isNaN(Date.parse(body.updated_at))).toBe(false);

		const serialised = JSON.stringify(body);
		for (const secret of [
			it3a.authUserId,
			it3a.token,
			it3a.email,
			it3a.studentId,
			it2a.authUserId,
			cse3a.authUserId,
			"Class Test",
			"REG",
			"student_name",
			"register_no",
			"auth_user_id",
			IT_2024,
		]) {
			expect(serialised).not.toContain(secret);
		}
	});

	it("reads only, and leaves attendance and the other tables untouched", async () => {
		await seedClassActivity([it3a, it3b]);

		const tables = [
			"attendance_session",
			"IT_Attendance_2024_2028",
			"IT_Attendance_2025_2029",
			"CSE_Attendance_2026_2030",
			"auth_users",
			"auth_sessions",
			IT_2024,
			IT_2025,
			CSE_2026,
		];

		const before = new Map<string, number>();
		for (const table of tables) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{
				total: number;
			}>();
			before.set(table, row?.total ?? 0);
		}

		for (let i = 0; i < 3; i += 1) {
			expect((await classCount(staff.token, { department: "IT", year: "3", section: "A" })).status).toBe(200);
		}

		for (const table of tables) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{
				total: number;
			}>();
			expect(row?.total ?? -1, table).toBe(before.get(table));
		}
	});
});
