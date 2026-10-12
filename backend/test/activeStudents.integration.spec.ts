/**
 * The active-student counters, end to end against a real D1.
 *
 * Both endpoints report one number, so most of what matters is not the number itself
 * -- it is who is allowed to move it and who is allowed to read it. Both halves are
 * therefore driven over HTTP rather than by calling the handlers directly, because the
 * role gates live in the routes: a handler called directly is a handler whose
 * authorisation has never been run.
 *
 * ## What "active" means here
 *
 * An account is counted when it holds a valid, unexpired login session. It is counted
 * for as long as that session exists, whether or not the student has touched the
 * screen, and whether or not the app is in the foreground.
 *
 * That is a deliberate change from counting heartbeats, and the file is shaped around
 * it: a count test sets **which accounts hold a session** and nothing else. The
 * `student_activity` table is never consulted by either endpoint, and several tests
 * below exist specifically to prove that -- an account with a live session and no
 * heartbeat at all is counted, and an account with a fresh heartbeat and no live
 * session is not.
 *
 * ## On test "ignores an identity claimed in the body"
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
 * `0019_student_activity.sql` -- the reviewed artefact. Applying it here proves it
 * works without touching a real database.
 *
 * Session expiry is reached by writing `expires_at` directly, never by waiting: a test
 * that slept would be slow and would still be timing-dependent.
 */

import { env, SELF } from "cloudflare:test";
import bcrypt from "bcryptjs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
 * Creates the CSE cohort tables and seeds ten CSE students, so the department filter
 * has a second department to keep out. Needs 0013 first: it is that migration which
 * adds the advisor columns 0014 writes into `staff`.
 */
import migration0013 from "../migrations/0013_department-aware-attendance.sql?raw";
import migration0014 from "../migrations/0014_cse-2026-2030-test-seed.sql?raw";
import migration0015 from "../migrations/0015_simplify-subjects.sql?raw";
/*
 * Creates `academic_batches`. It is here for the tests that sign a student in
 * through `/api/auth/login` rather than planting a session: login resolves the
 * student's cohort through the registry, exactly as it does in production.
 */
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

const HOUR_MS = 60 * 60_000;

interface Account {
	authUserId: string;
	token: string;
	email: string;
}

async function makeAccount(
	role: string,
	label: string,
	options: { live?: boolean; linkedStudent?: boolean; table?: string; year?: number; section?: string } = {},
): Promise<Account> {
	const {
		live = true,
		linkedStudent = false,
		table = "IT_Students_2024_2028",
		year = 3,
		section = "A",
	} = options;
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
				`INSERT INTO ${table}
				 (student_id, register_no, student_name, year, section, email, auth_user_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).bind(studentId, `REG${suffix.toUpperCase()}`, `Class Test ${label}`, year, section, email, authUserId),
		);
	}

	if (live) {
		statements.push(
			env.DB.prepare(
				"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)",
			).bind(hashToken(token), authUserId, new Date(Date.now() + HOUR_MS).toISOString()),
		);
	}

	await env.DB.batch(statements);
	return { authUserId, token, email };
}

/* --------------------------------------------------- controlling the sessions */

/**
 * Removes every session belonging to a student-role account.
 *
 * Staff, class advisor and admin sessions are deliberately left alone: they are what
 * authorises the count request itself, and a test that threw those away could no
 * longer ask the question it is asking.
 */
async function revokeStudentSessions(): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM auth_sessions
		 WHERE auth_user_id IN (SELECT auth_user_id FROM auth_users WHERE LOWER(role) = 'student')`
	).run();
}

/** Gives an account one live session, or one that has already expired. */
async function grantSession(
	account: Account,
	options: { expiresAt?: string } = {},
): Promise<string> {
	const expiresAt = options.expiresAt ?? new Date(Date.now() + HOUR_MS).toISOString();
	await env.DB.prepare(
		"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)"
	)
		.bind(hashToken(account.token), account.authUserId, expiresAt)
		.run();
	return account.token;
}

/** A second live session for an account that already has one -- a second device. */
async function addSession(account: Account): Promise<string> {
	const token = `${account.token}-device-2`;
	await env.DB.prepare(
		"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)",
	)
		.bind(hashToken(token), account.authUserId, new Date(Date.now() + HOUR_MS).toISOString())
		.run();
	return token;
}

/**
 * The whole setup a count test needs: exactly these accounts are signed in.
 *
 * Every test starts from nobody being signed in, so a count of 2 means two of these
 * accounts and not two of the fourteen fixtures the file creates.
 */
async function signedIn(accounts: Account[]): Promise<void> {
	await revokeStudentSessions();
	for (const account of accounts) {
		await grantSession(account);
	}
}

async function expireSessions(account: Account): Promise<void> {
	await env.DB.prepare("UPDATE auth_sessions SET expires_at = ? WHERE auth_user_id = ?")
		.bind(new Date(Date.now() - 1000).toISOString(), account.authUserId)
		.run();
}

async function clearActivity(): Promise<void> {
	await env.DB.prepare("DELETE FROM student_activity").run();
}

async function activityRows(): Promise<string[]> {
	const rows = await env.DB.prepare("SELECT auth_user_id FROM student_activity").all<{
		auth_user_id: string;
	}>();
	return rows.results.map((row) => row.auth_user_id);
}

/* --------------------------------------------------------------- requests */

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

function classCount(token: string | null, query: Record<string, string>): Promise<Response> {
	const search = new URLSearchParams(query).toString();
	return SELF.fetch(`https://example.com/api/activity/class-active-students?${search}`, {
		headers: token ? { Cookie: cookie(token) } : {},
	});
}

async function readCount(token: string): Promise<number> {
	const response = await count(token);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { active_students: number };
	return body.active_students;
}

async function readClassCount(token: string, department: string, year: number, section: string) {
	const response = await classCount(token, { department, year: String(year), section });
	expect(response.status).toBe(200);
	const body = (await response.json()) as { active_students: number };
	return body.active_students;
}

async function logout(token: string): Promise<Response> {
	return SELF.fetch("https://example.com/api/auth/logout", {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie(token) },
		body: "{}",
	});
}

/* --------------------------------------------------------------- fixtures */

const IT_2024 = "IT_Students_2024_2028";
const IT_2025 = "IT_Students_2025_2029";
const CSE_2026 = "CSE_Students_2026_2030";

let student: Account;
let otherStudent: Account;
let staff: Account;
let advisor: Account;
let admin: Account;

let it3a: Account;
let it3aOtherCohort: Account;
let it3b: Account;
let it2a: Account;
let cse3a: Account;

beforeAll(async () => {
	for (const migration of APPLY_ORDER) {
		await applyMigration(migration);
	}

	student = await makeAccount("student", "actstudent", { live: false, linkedStudent: true });
	otherStudent = await makeAccount("student", "actother", { live: false, linkedStudent: true });

	it3a = await makeAccount("student", "clsit3a", { live: false, linkedStudent: true, table: IT_2024, year: 3, section: "A" });
	it3aOtherCohort = await makeAccount("student", "clsit3ab", { live: false, linkedStudent: true, table: IT_2025, year: 3, section: "A" });
	it3b = await makeAccount("student", "clsit3b", { live: false, linkedStudent: true, table: IT_2024, year: 3, section: "B" });
	it2a = await makeAccount("student", "clsit2a", { live: false, linkedStudent: true, table: IT_2024, year: 2, section: "A" });
	cse3a = await makeAccount("student", "clscse3a", { live: false, linkedStudent: true, table: CSE_2026, year: 3, section: "A" });

	/* Authorising sessions. Never revoked, so every test can ask the question. */
	staff = await makeAccount("staff", "actstaff");
	advisor = await makeAccount("class_advisor", "actadvisor");
	admin = await makeAccount("admin", "actadmin");

	await env.DB.prepare(
		`INSERT INTO staff (staff_id, staff_name, email, department, class_advisor, auth_user_id)
		 VALUES (?, ?, ?, 'IT', 0, ?)`,
	)
		.bind(`9${staff.authUserId.slice(-6)}`, "Active Count Staff", staff.email, staff.authUserId)
		.run();
});

/*
 * Nobody is signed in as a student before each test. Heartbeat rows are left alone:
 * they are written by whichever test needs them and are never part of the setup for a
 * count, which is the point the file keeps making.
 */
beforeEach(async () => {
	await revokeStudentSessions();
	await clearActivity();
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
		expect(await activityRows()).toEqual([]);
	});

	it("records a beat for a signed-in student", async () => {
		await grantSession(student);

		const response = await ping(student.token);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true });
		expect(await activityRows()).toEqual([student.authUserId]);
	});

	it("ignores an identity claimed in the body", async () => {
		await grantSession(student);

		const response = await ping(student.token, {
			auth_user_id: staff.authUserId,
			user_id: admin.authUserId,
			role: "staff",
		});
		expect(response.status).toBe(200);
		expect(await activityRows()).toEqual([student.authUserId]);
	});

	it("never creates, extends or revokes an authentication session", async () => {
		await grantSession(student);

		const snapshot = async () =>
			(
				await env.DB.prepare(
					"SELECT token_hash, auth_user_id, expires_at FROM auth_sessions WHERE auth_user_id = ?",
				)
					.bind(student.authUserId)
					.all<{ token_hash: string; auth_user_id: string; expires_at: string }>()
			).results;

		const before = await snapshot();
		for (let i = 0; i < 3; i += 1) {
			expect((await ping(student.token)).status).toBe(200);
		}

		expect(await snapshot()).toEqual(before);
	});
});

describe("GET /api/activity/active-students", () => {
	it("refuses an unauthenticated caller", async () => {
		const response = await count(null);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "auth-required" });
	});

	it("refuses a student session", async () => {
		await grantSession(student);
		const response = await count(student.token);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "forbidden" });
	});

	it("refuses an administrator", async () => {
		// `requireStaff` is the project's existing staff gate: staff and class advisor.
		// The admin dashboard is a separate surface and is deliberately not widened here.
		const response = await count(admin.token);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "forbidden" });
	});

	it("serves staff and class advisors", async () => {
		expect((await count(staff.token)).status).toBe(200);
		expect((await count(advisor.token)).status).toBe(200);
	});

	it("counts an idle student who has never sent a heartbeat", async () => {
		await signedIn([student]);

		expect(await readCount(staff.token)).toBe(1);
		expect(await activityRows()).toEqual([]);
	});

	it("ignores heartbeat activity entirely", async () => {
		/*
		 * The regression guard for the whole change. Three students sign in and beat;
		 * their sessions then go away. A heartbeat-driven counter would still be
		 * showing them, because their `last_active_at` is seconds old.
		 */
		await signedIn([student, otherStudent, it3a]);
		for (const account of [student, otherStudent, it3a]) {
			expect((await ping(account.token)).status).toBe(200);
		}
		expect(await activityRows()).toHaveLength(3);
		expect(await readCount(staff.token)).toBe(3);

		await revokeStudentSessions();

		expect(await readCount(staff.token)).toBe(0);
		expect(await activityRows()).toHaveLength(3);
	});

	it("counts each account once, however many sessions it holds", async () => {
		await signedIn([student, otherStudent]);
		await addSession(student);
		await addSession(student);

		expect(await readCount(staff.token)).toBe(2);
	});

	it("excludes every non-student role that holds a live session", async () => {
		await signedIn([student]);

		// staff, advisor and admin all have live sessions right now.
		const sessions = await env.DB.prepare("SELECT COUNT(*) AS total FROM auth_sessions").first<{
			total: number;
		}>();
		expect(sessions?.total ?? 0).toBeGreaterThan(1);

		expect(await readCount(staff.token)).toBe(1);
	});

	it("does not count a student whose session has expired", async () => {
		await grantSession(student, { expiresAt: new Date(Date.now() - 1000).toISOString() });

		expect(await readCount(staff.token)).toBe(0);
		expect((await ping(student.token)).status).toBe(401);
	});

	it("drops a student the moment they log out", async () => {
		await signedIn([student]);
		expect(await readCount(staff.token)).toBe(1);

		const response = await logout(student.token);
		expect(response.status).toBe(200);

		expect(await readCount(staff.token)).toBe(0);
		expect((await ping(student.token)).status).toBe(401);
	});

	it("returns a student to the count when they sign in again", async () => {
		await signedIn([student]);
		expect(await logout(student.token)).toHaveProperty("status", 200);
		expect(await readCount(staff.token)).toBe(0);

		const login = await SELF.fetch("https://example.com/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ user_name: student.email, password: PASSWORD }),
		});
		expect(login.status).toBe(200);

		expect(await readCount(staff.token)).toBe(1);
	});

	it("keeps counting an account that is still signed in on another device", async () => {
		await signedIn([student]);
		await addSession(student);

		/*
		 * Signing out deletes the current session only. An account with a second one
		 * is still signed in, so it is still counted -- once, because the count is a
		 * count of accounts.
		 */
		expect((await logout(student.token)).status).toBe(200);

		expect(await readCount(staff.token)).toBe(1);
		expect((await ping(student.token)).status).toBe(401);
	});

	it("returns a count and a timestamp, and nothing identifying", async () => {
		await signedIn([student]);

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
			"auth_user_id",
		]) {
			expect(serialised).not.toContain(secret);
		}
	});
});

describe("GET /api/activity/class-active-students", () => {
	it("counts the selected class across every cohort of that department", async () => {
		await signedIn([it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		/*
		 * Two students in IT year 3 section A, because that class spans two cohorts --
		 * 2024_2028 and 2025_2029 -- and a class is a department, a year and a
		 * section, not a cohort. Counting only the cohort that happened to be
		 * selected would silently under-report by a factor of the number of cohorts.
		 */
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(2);
	});

	it("excludes other sections and other years of the same cohort", async () => {
		await signedIn([it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(1);
		expect(await readClassCount(staff.token, "IT", 2, "A")).toBe(1);
		expect(await readClassCount(staff.token, "IT", 3, "C")).toBe(0);
		expect(await readClassCount(staff.token, "IT", 4, "A")).toBe(0);
	});

	it("excludes another department that shares the year and section", async () => {
		await signedIn([it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		expect(await readClassCount(staff.token, "CSE", 3, "A")).toBe(1);
		// And the ten CSE students migration 0014 seeded hold no session at all.
		expect(await readClassCount(staff.token, "CSE", 1, "A")).toBe(0);
		// ECE is a supported department with no provisioned cohort.
		expect(await readClassCount(staff.token, "ECE", 3, "A")).toBe(0);
	});

	it("counts a class of idle students who have never sent a heartbeat", async () => {
		await signedIn([it3a, it3aOtherCohort]);

		expect(await activityRows()).toEqual([]);
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(2);
	});

	it("counts an account once however many devices it is signed in on", async () => {
		await signedIn([it3a, it3aOtherCohort]);
		await addSession(it3a);
		await addSession(it3a);

		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(2);
	});

	it("does not count an account whose sessions are gone but whose beat is fresh", async () => {
		await signedIn([it3a, it3b]);
		expect((await ping(it3b.token)).status).toBe(200);
		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(1);

		await logout(it3b.token);

		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(0);
		// The beat row is still there, seconds old, and is still worth nothing.
		expect(await activityRows()).toEqual([it3b.authUserId]);
	});

	it("stops counting a class when an idle student logs out", async () => {
		await signedIn([it3a, it3aOtherCohort]);
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(2);

		expect((await logout(it3a.token)).status).toBe(200);

		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(1);
	});

	it("excludes a student whose session has expired", async () => {
		await signedIn([it3b]);
		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(1);

		await expireSessions(it3b);

		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(0);
	});

	it("excludes a non-student account even if one is linked into the roster", async () => {
		await signedIn([it3a]);
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(1);

		/*
		 * The staff account already holds a live session; all it lacks is a roster row
		 * in this class. With one planted it satisfies every condition except the one
		 * that matters, and must still not be counted.
		 */
		await env.DB.prepare(
			`INSERT INTO ${IT_2024} (student_id, register_no, student_name, year, section, email, auth_user_id)
			 VALUES ('CLSSTAFF01', 'REGSTAFF01', 'Class Test Staff', 3, 'A', 'cls.staff.01@kiot.ac.in', ?)`,
		)
			.bind(staff.authUserId)
			.run();

		try {
			expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(1);
		} finally {
			await env.DB.prepare(`DELETE FROM ${IT_2024} WHERE student_id = 'CLSSTAFF01'`).run();
		}
	});

	it("refuses an unauthenticated caller", async () => {
		const response = await classCount(null, { department: "IT", year: "3", section: "A" });
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "auth-required" });
	});

	it("refuses a student session", async () => {
		await grantSession(student);
		const response = await classCount(student.token, { department: "IT", year: "3", section: "A" });
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
		await signedIn([it3a]);

		expect(await readClassCount(staff.token, "  it ", 3, " a ")).toBe(1);
	});

	it("returns a count and a timestamp, and nothing identifying", async () => {
		await signedIn([it3a, it2a, cse3a]);

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
});

describe("the counters do not touch the workflows around them", () => {
	it("reads only, and leaves attendance and the other tables alone", async () => {
		await signedIn([it3a, it3b]);
		expect((await ping(it3a.token)).status).toBe(200);

		const tables = [
			"attendance_session",
			"IT_Attendance_2024_2028",
			"IT_Attendance_2025_2029",
			"CSE_Attendance_2026_2030",
			"auth_users",
			"auth_sessions",
			"staff",
			"subjects",
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
			expect((await count(staff.token)).status).toBe(200);
			expect(
				(await classCount(staff.token, { department: "IT", year: "3", section: "A" })).status
			).toBe(200);
		}

		for (const table of tables) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{
				total: number;
			}>();
			expect(row?.total ?? -1, table).toBe(before.get(table));
		}
	});

	it("does not let a count change any session", async () => {
		await signedIn([it3a, it3b]);

		const snapshot = async () =>
			(
				await env.DB.prepare(
					"SELECT token_hash, auth_user_id, expires_at FROM auth_sessions ORDER BY auth_user_id",
				).all<{ token_hash: string; auth_user_id: string; expires_at: string }>()
			).results;

		const before = await snapshot();
		await readCount(staff.token);
		await readClassCount(staff.token, "IT", 3, "A");
		expect(await snapshot()).toEqual(before);
	});
});