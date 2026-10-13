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
 * An account is counted when it holds a login session that is both unexpired and was
 * created within the recent-session window. The second half is what separates "signed
 * in" from "here": a student who signed in during last week still holds a valid session
 * and is still signed in on every protected route, and this file asserts that they are,
 * while the dashboard does not claim they are in the room.
 *
 * That is a deliberate change from counting heartbeats, and the file is shaped around
 * the session rather than the browser: a count test sets **which accounts hold a
 * qualifying session** and nothing else. The `student_activity` table is never consulted
 * by either endpoint, and several tests below exist specifically to prove that -- an
 * account with a qualifying session and no heartbeat at all is counted, and an account
 * with a fresh heartbeat and no qualifying session is not.
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
 * ## The total and the missing list
 *
 * `GET /api/activity/class-active-students` also returns `total_students` and a
 * `missing` array of `{ register_no, student_name }`, so a staff member can act on the
 * count rather than only read it. Those two figures are the part of this file that can
 * contradict the count without looking wrong, so `readClassActivity` re-asserts
 * `active + missing === total` on every single read, and the suite checks the
 * properties that make the arithmetic hold: a roster row with no account is in the
 * total, a non-student account linked into a roster is in neither half, and the list
 * spans every cohort of the department rather than one table.
 *
 * ## Session age
 *
 * A session qualifies while it is unexpired *and* was created inside the recent-session
 * window. Almost every test in this file grants a session the ordinary way, which
 * stamps `created_at` with "now" and therefore lands inside the window -- so those tests
 * are unaffected by the rule and still read as before.
 *
 * The window itself is exercised by `grantSessionAged`, which writes `created_at`
 * directly, because the column has one-second resolution and the boundary cannot be
 * reached by waiting. Those tests state the whole rule rather than only its edges:
 * an old session still authenticates, a fresh login restores the count, several
 * sessions make one student, and the campus-wide count and the class count agree.
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
	/**
	 * The register number of the roster row behind this account, or `null` for an
	 * account that was created without one. Returned so a test can assert on the
	 * identity a response carries without re-deriving it from the same suffix.
	 */
	registerNo: string | null;
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
	let registerNo: string | null = null;

	const statements: D1PreparedStatement[] = [
		env.DB.prepare(
			`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
			 VALUES (?, ?, ?, ?, ?)`,
		).bind(authUserId, email, passwordHash, role, email),
	];

	if (linkedStudent) {
		const studentId = `ACT${suffix.toUpperCase()}`;
		registerNo = `REG${suffix.toUpperCase()}`;
		statements.push(
			env.DB.prepare(
				`INSERT INTO ${table}
				 (student_id, register_no, student_name, year, section, email, auth_user_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).bind(studentId, registerNo, `Class Test ${label}`, year, section, email, authUserId),
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
	return { authUserId, token, email, registerNo };
}

/**
 * The register number behind an account.
 *
 * A hard assertion that it exists, so a test that meant to describe a roster row cannot
 * silently pass by comparing against `null`.
 */
function registerOf(account: Account): string {
	expect(account.registerNo, "this fixture has no roster row").toBeTruthy();
	return account.registerNo as string;
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
 * A session whose *age* is what the test is about.
 *
 * The counting rule looks at `auth_sessions.created_at`, and that column is never
 * written by any code: every insert in `auth.ts` names only `(token_hash,
 * auth_user_id, expires_at)`, so the value is SQLite's `CURRENT_TIMESTAMP` default. A
 * test therefore cannot reach the boundary cases by waiting, and cannot reach them by
 * granting a session either -- that always stamps "now".
 *
 * So the column is written here, in the exact shape the default produces. Writing it as
 * an ISO string instead would quietly test a different comparison: `created_at` is
 * stored space-separated and without a zone, and the two forms do not order against each
 * other as text. See the note in `activity.ts`.
 *
 * `expiresAt` defaults to an hour out, which keeps every fixture session well inside its
 * seven-day life, so a test about session *age* is never accidentally a test about
 * session *expiry*.
 */
async function grantSessionAged(
	account: Account,
	options: { ageMs?: number; expiresAt?: string; token?: string } = {},
): Promise<void> {
	const { ageMs = 0, expiresAt, token = account.token } = options;

	// SQLite's CURRENT_TIMESTAMP format: UTC, space separated, second resolution.
	const createdAt = new Date(Date.now() - ageMs).toISOString().slice(0, 19).replace("T", " ");
	await env.DB.prepare(
		"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
	)
		.bind(
			hashToken(token),
			account.authUserId,
			expiresAt ?? new Date(Date.now() + HOUR_MS).toISOString(),
			createdAt,
		)
		.run();
}

/**
 * The recent-session window the endpoint applies, restated here as a number.
 *
 * Written out rather than imported from the module on purpose. The module's copy is
 * what the SQL binds, so importing it would mean a test that changes the rule silently
 * starts agreeing with the new rule instead of failing -- which is the opposite of what
 * these tests are for.
 */
const WINDOW_MS = 5 * 60 * 1000;

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

/** One missing-student row, as the endpoint is documented to shape it. */
interface MissingStudent {
	register_no: string;
	student_name: string;
}

/** The whole class-activity response, with the two numbers as numbers. */
interface ClassActivity {
	success: boolean;
	active_students: number;
	total_students: number;
	missing: MissingStudent[];
	missing_truncated: boolean;
	updated_at: string;
}

async function readClassCount(token: string, department: string, year: number, section: string) {
	const response = await classCount(token, { department, year: String(year), section });
	expect(response.status).toBe(200);
	const body = (await response.json()) as { active_students: number };
	return body.active_students;
}

async function readClassTotal(token: string, department: string, year: number, section: string) {
	const response = await classCount(token, { department, year: String(year), section });
	expect(response.status).toBe(200);
	const body = (await response.json()) as { total_students: number };
	return body.total_students;
}

/**
 * Reads the full payload and asserts the two invariants the card depends on.
 *
 * These are checked on every read rather than in one dedicated test because they are
 * the properties that make the three figures safe to put on one screen: the count, the
 * denominator and the list have to describe the same class at the same moment. A
 * regression in any one of the three would still produce three individually plausible
 * numbers, and only the arithmetic between them gives it away.
 */
async function readClassActivity(
	token: string,
	department: string,
	year: number,
	section: string,
): Promise<ClassActivity> {
	const response = await classCount(token, { department, year: String(year), section });
	expect(response.status).toBe(200);
	const body = (await response.json()) as ClassActivity;

	expect(body.success).toBe(true);
	expect(Number.isNaN(Date.parse(body.updated_at))).toBe(false);

	// Active plus missing accounts for every student in the class.
	expect(body.active_students + body.missing.length, "active + missing should equal total").toBe(
		body.total_students,
	);

	// No student appears twice, and every row is the two documented fields.
	const keys = body.missing.map((row) => row.register_no);
	expect(new Set(keys).size, "register numbers should be unique").toBe(keys.length);
	for (const row of body.missing) {
		expect(Object.keys(row).sort()).toEqual(["register_no", "student_name"]);
	}

	return body;
}

/** Register numbers in the missing list, for assertions that do not care about order. */
function missingRegisters(activity: ClassActivity): string[] {
	return activity.missing.map((row) => row.register_no).sort();
}

/**
 * Adds a roster row that has no account behind it.
 *
 * A student imported without an account is a real state -- the column is nullable -- and
 * it is the case that decides whether `total` can be defined as "rows in the class" or
 * as "rows with a session". Such a student can never be active and must still be in the
 * total, because they are still a student the staff member is waiting for.
 */
async function addUnlinkedStudent(table: string, year: number, section: string): Promise<string> {
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
	const registerNo = `REG${suffix}`;
	await env.DB.prepare(
		`INSERT INTO ${table} (student_id, register_no, student_name, year, section, email)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(`NOLINK${suffix}`, registerNo, `Unlinked ${suffix}`, year, section, `nolink.${suffix}@kiot.ac.in`)
		.run();
	return registerNo;
}

/** Removes a roster row, so a test can undo what `addUnlinkedStudent` did. */
async function removeStudent(table: string, registerNo: string): Promise<void> {
	await env.DB.prepare(`DELETE FROM ${table} WHERE register_no = ?`).bind(registerNo).run();
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

		/*
		 * The class route is the one place a student's name is returned to a staff
		 * session in bulk, so the exact key set is asserted rather than described: a
		 * field added here is a field crossing the roster boundary by accident.
		 */
		expect(Object.keys(body).sort()).toEqual([
			"active_students",
			"missing",
			"missing_truncated",
			"success",
			"total_students",
			"updated_at",
		]);
		expect(body.active_students).toBe(1);
		expect(Number.isNaN(Date.parse(body.updated_at))).toBe(false);
	});

	it("names only the missing students, and only the two fields that identify one", async () => {
		/*
		 * Everyone in IT 3 B except one is signed in, so the response legitimately
		 * carries exactly one student's name. What must never travel is everything else:
		 * the students who are present are not in the list at all, and no account,
		 * address or cohort identifier leaves with the one that is.
		 *
		 * IT 3 B holds only `it3b`, so it is signed in, and the response is about
		 * IT 3 A where exactly one of the four has no session.
		 */
		await signedIn([student, otherStudent, it3a]);

		const response = await classCount(staff.token, { department: "IT", year: "3", section: "A" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as ClassActivity;

		expect(body.total_students).toBe(4);
		expect(body.active_students).toBe(3);
		expect(body.missing).toEqual([
			{
				register_no: registerOf(it3aOtherCohort),
				student_name: "Class Test clsit3ab",
			},
		]);

		const serialised = JSON.stringify(body);
		for (const secret of [
			// The three students who are present must not appear at all.
			student.authUserId,
			student.token,
			student.email,
			otherStudent.authUserId,
			otherStudent.email,
			it3a.authUserId,
			it3a.token,
			it3a.email,
			// The missing student's account must not appear either, only their name.
			it3aOtherCohort.authUserId,
			it3aOtherCohort.token,
			it3aOtherCohort.email,
			// Columns that exist on the roster but are not needed to recognise someone.
			"email",
			"auth_user_id",
			"student_id",
			"mentor_email",
			"created_at",
			"@kiot.ac.in",
			// And no cohort or table name.
			IT_2024,
			IT_2025,
		]) {
			expect(serialised, `response must not contain ${secret}`).not.toContain(secret);
		}
	});
});

/*
 * What counts as active, stated as scenarios.
 *
 * The single-account case is here because it is the one a reader is most likely to
 * doubt: one student signing in on one device must move the number by exactly one, and
 * the ways it could move by more are all ways this query could be quietly wrong.
 *
 * Each case is a whole class rather than a single row, so `readClassActivity` checks
 * `active + missing === total` on the way through and a miscount cannot hide behind a
 * plausible looking number.
 */
describe("the five-minute session window", () => {
	/*
	 * The rule: a session qualifies while it is unexpired AND was created inside the
	 * window. These tests drive the *age* of the session directly rather than sleeping,
	 * because the boundaries are the whole point and a suite that waits for them would be
	 * both slow and timing-dependent.
	 */

	it("counts a session created well inside the window", async () => {
		await revokeStudentSessions();
		await grantSessionAged(it3b, { ageMs: 30 * 1000 });

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
	});

	it("counts a session sitting exactly on the boundary", async () => {
		/*
		 * Exactly five minutes old counts: "older than five minutes must not qualify"
		 * makes the boundary itself inclusive.
		 *
		 * Asserted against the stored timestamps with the cutoff frozen, rather than
		 * through the live endpoint. `created_at` has one-second resolution and the query
		 * compares against `datetime('now', ...)`, which is evaluated when the request is
		 * served -- so a session written five minutes before the request is already a few
		 * hundred milliseconds past the line by the time it is read. Driving it through
		 * HTTP would be a test that passes or fails depending on how fast the request
		 * arrived. These assertions are deterministic, and the two cases either side of
		 * the line are covered through the endpoint above and below.
		 */
		await revokeStudentSessions();
		await grantSessionAged(it3b, { ageMs: WINDOW_MS });

		const row = await env.DB.prepare(
			"SELECT created_at FROM auth_sessions WHERE auth_user_id = ? ORDER BY created_at DESC LIMIT 1",
		)
			.bind(it3b.authUserId)
			.first<{ created_at: string }>();
		const createdAt = row?.created_at ?? "";
		expect(createdAt).not.toBe("");

		const qualifies = async (threshold: string): Promise<number> => {
			const result = await env.DB.prepare("SELECT ? >= ? AS qualifies")
				.bind(createdAt, threshold)
				.first<{ qualifies: number }>();
			return Number(result?.qualifies ?? 0);
		};

		// `created_at` is UTC with no zone, so parsing it back as UTC is exact.
		const createdAtMs = Date.parse(`${createdAt.replace(" ", "T")}Z`);
		expect(Number.isNaN(createdAtMs)).toBe(false);
		const oneSecondEarlier = new Date(createdAtMs - 1000).toISOString().slice(0, 19).replace("T", " ");
		const oneSecondLater = new Date(createdAtMs + 1000).toISOString().slice(0, 19).replace("T", " ");

		// A cutoff exactly equal to the session's own timestamp includes it: the boundary
		// is inclusive, which is what makes "older than five minutes" mean strictly
		// more than five minutes.
		expect(await qualifies(createdAt)).toBe(1);
		// A cutoff one second earlier -- a session that is comfortably inside -- includes it.
		expect(await qualifies(oneSecondEarlier)).toBe(1);
		// A cutoff one second later -- the session has just aged out -- excludes it.
		expect(await qualifies(oneSecondLater)).toBe(0);
	});

	it("counts a session created just inside the boundary", async () => {
		/*
		 * Thirty seconds of margin rather than one. The window is measured against the
		 * instant the request is served, so anything written exactly on the line is
		 * already past it by the time it is read; this asserts the rule without
		 * depending on how long the request took.
		 */
		await revokeStudentSessions();
		await grantSessionAged(it3b, { ageMs: WINDOW_MS - 30 * 1000 });

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
	});

	it("stops counting a session just past the boundary", async () => {
		await revokeStudentSessions();
		await grantSessionAged(it3b, { ageMs: WINDOW_MS + 30 * 1000 });

		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);
	});

	it("does not count a valid seven-day session that is simply old", async () => {
		/*
		 * The distinction the whole change exists to draw. The session is still perfectly
		 * valid -- unexpired, and `resolveAuthUser` would still accept it on every
		 * protected route -- and the student is still signed in. They are just not in the
		 * room, so the dashboard does not claim they are.
		 *
		 * The expiry here is the full seven days, matching `SESSION_TTL_MS`, so nothing
		 * about this fixture is about expiry.
		 */
		await revokeStudentSessions();
		await grantSessionAged(it3b, {
			ageMs: 2 * 60 * 60 * 1000,
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
		});

		// The session still authenticates: it is neither rejected nor ended by the fact
		// that the dashboard does not count it. This is the assertion that proves the
		// window is reporting-only.
		expect((await ping(it3b.token)).status).toBe(200);
		expect(
			(await SELF.fetch("https://example.com/api/auth/session", {
				headers: { Cookie: cookie(it3b.token) },
			})).status,
		).toBe(200);

		// But it does not make the student active on the dashboard.
		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);
	});

	it("counts the student again once they log in afresh", async () => {
		await revokeStudentSessions();
		await grantSessionAged(it3b, { ageMs: 30 * 60 * 1000 });
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(0);

		// A new login mints a new row. Nothing had to expire for this to work.
		await grantSession(it3b);

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
	});

	it("keeps counting a student whose other session is old", async () => {
		/*
		 * One account, two sessions, one fresh and one ancient. The window filters
		 * sessions, not accounts: the account qualifies on the fresh one, and the old one
		 * is neither deleted nor counted twice.
		 */
		await revokeStudentSessions();
		await grantSessionAged(it3b, { ageMs: 4 * 60 * 60 * 1000, token: `${it3b.token}-old` });
		await grantSession(it3b);

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		// Both rows are still present: nothing here invalidates a session.
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS total FROM auth_sessions WHERE auth_user_id = ?",
		)
			.bind(it3b.authUserId)
			.first<{ total: number }>();
		expect(rows?.total).toBe(2);
	});

	it("counts one student however many sessions are inside the window", async () => {
		await revokeStudentSessions();
		await grantSessionAged(it3b, { ageMs: 10 * 1000 });
		await grantSessionAged(it3b, { ageMs: 60 * 1000, token: `${it3b.token}-device-2` });
		await grantSessionAged(it3b, { ageMs: 120 * 1000, token: `${it3b.token}-device-3` });
		await grantSessionAged(it3b, { ageMs: 4 * 60 * 60 * 1000, token: `${it3b.token}-device-4` });

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
		expect((await readCount(staff.token))).toBe(1);
	});

	it("does not count an expired session even when it was created just now", async () => {
		/*
		 * The two halves of the rule are independent, and neither substitutes for the
		 * other. A session minted a second ago and already expired is not a session at
		 * all, and must not be resurrected by being recent.
		 */
		await revokeStudentSessions();
		await grantSessionAged(it3b, {
			ageMs: 1000,
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});

		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);
	});

	it("does not count a logged-out session", async () => {
		await revokeStudentSessions();
		await grantSession(it3b);
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		expect((await logout(it3b.token)).status).toBe(200);

		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);
	});

	it("does not let logging out of one device end the account", async () => {
		/*
		 * Logout deletes the row it was given and nothing else, so an account with a
		 * second session inside the window stays active. Counting sessions instead of
		 * accounts would have got this backwards.
		 */
		await revokeStudentSessions();
		await grantSession(it3b);
		await grantSessionAged(it3b, { ageMs: 2000, token: `${it3b.token}-device-2` });

		expect((await logout(it3b.token)).status).toBe(200);

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
	});

	it("ignores the heartbeat entirely, in both directions", async () => {
		/*
		 * `student_activity` is not a fallback. A fresh beat with no qualifying session
		 * does not make a student active, and a qualifying session with no beat at all
		 * does not need one.
		 */
		await revokeStudentSessions();
		await grantSessionAged(it3b, { ageMs: 60 * 60 * 1000 });
		await grantSession(it3b);
		expect((await ping(it3b.token)).status).toBe(200);
		expect(await activityRows()).toEqual([it3b.authUserId]);

		// Beat present, session too old: still not active.
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		await revokeStudentSessions();
		await grantSession(it3b);

		// Session present, beat table emptied: still active.
		await clearActivity();
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
	});

	it("applies the same window to the campus-wide count", async () => {
		/*
		 * The global route and the class route answer the same question, so they have to
		 * agree. A dashboard showing 1 here and 0 there would leave a reader with no way
		 * to tell which number to believe.
		 */
		await revokeStudentSessions();
		await grantSession(it3b);
		expect(await readCount(staff.token)).toBe(1);
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		await grantSessionAged(it3b, { ageMs: 60 * 60 * 1000, token: `${it3b.token}-old` });
		await revokeStudentSessions();
		await grantSessionAged(it3b, { ageMs: 60 * 60 * 1000 });

		expect(await readCount(staff.token)).toBe(0);
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(0);
	});

	it("never counts a non-student session, however fresh", async () => {
		await signedIn([]);

		for (const account of [staff, advisor, admin]) {
			await grantSession(account);
			await grantSessionAged(account, { ageMs: 1000, token: `${account.token}-fresh` });
		}

		for (const [department, year, section] of [
			["IT", 3, "A"],
			["IT", 3, "B"],
			["IT", 2, "A"],
			["CSE", 3, "A"],
		] as [string, number, string][]) {
			expect(
				(await readClassActivity(staff.token, department, year, section)).active_students,
				`${department} ${year} ${section}`,
			).toBe(0);
		}

		// And the campus-wide count agrees.
		expect(await readCount(staff.token)).toBe(0);
	});

	it("keeps active, missing and total consistent at the boundary", async () => {
		/*
		 * The identity the card is built on, checked with sessions sitting either side of
		 * the window rather than comfortably inside it. Both fixtures are in IT year 3
		 * section A, so the one just inside and the one just outside are counted in the
		 * same class and the arithmetic can actually be checked.
		 */
		await revokeStudentSessions();
		await grantSessionAged(it3a, { ageMs: WINDOW_MS - 30 * 1000 });
		await grantSessionAged(it3aOtherCohort, { ageMs: WINDOW_MS + 30 * 1000 });

		const activity = await readClassActivity(staff.token, "IT", 3, "A");

		// `readClassActivity` already asserts active + missing === total.
		expect(activity.active_students).toBe(1);
		expect(activity.total_students).toBe(4);
		expect(activity.missing.length).toBe(activity.total_students - 1);
		// The one outside the window is the one listed.
		expect(missingRegisters(activity)).toContain(registerOf(it3aOtherCohort));
		expect(missingRegisters(activity)).not.toContain(registerOf(it3a));
	});
});

describe("what counts as an active student", () => {
	it("counts one student signing in as exactly one", async () => {
		await signedIn([]);

		const before = await readClassActivity(staff.token, "IT", 3, "B");
		expect(before.active_students).toBe(0);
		expect(before.total_students).toBe(1);

		await signedIn([it3b]);

		const after = await readClassActivity(staff.token, "IT", 3, "B");
		expect(after.active_students).toBe(1);
		expect(after.total_students).toBe(1);
		expect(after.missing).toEqual([]);
	});

	it("is not moved by a student in another class", async () => {
		/*
		 * The reported symptom, isolated. Signing in somebody who is on a different
		 * roster must leave this class's numbers exactly as they were -- a count that
		 * ignores the class filter is the most likely way for an extra account to appear
		 * on a card it does not belong to.
		 */
		await signedIn([it2a]);

		const it3a = await readClassActivity(staff.token, "IT", 3, "A");
		expect(it3a.active_students).toBe(0);
		expect(it3a.missing.length).toBe(it3a.total_students);

		const it3b = await readClassActivity(staff.token, "IT", 3, "B");
		expect(it3b.active_students).toBe(0);

		const cse3a = await readClassActivity(staff.token, "CSE", 3, "A");
		expect(cse3a.active_students).toBe(0);
	});

	it("is not moved by a student in another department", async () => {
		await signedIn([cse3a]);

		expect((await readClassActivity(staff.token, "IT", 3, "A")).active_students).toBe(0);
		expect((await readClassActivity(staff.token, "CSE", 3, "A")).active_students).toBe(1);
	});

	it("counts one student however many sessions they hold", async () => {
		await signedIn([it3b]);
		await addSession(it3b);
		await addSession(it3b);
		await addSession(it3b);

		const activity = await readClassActivity(staff.token, "IT", 3, "B");

		expect(activity.active_students).toBe(1);
		expect(activity.missing).toEqual([]);
	});

	it("counts a student who never logged out from an earlier login once", async () => {
		/*
		 * The production report, reproduced.
		 *
		 * An account that logs in repeatedly without logging out accumulates one
		 * session row per login, all of them unexpired. The count is of accounts, so
		 * that has to be one -- a staff member watching the card sees one student, not
		 * one student per device and per forgotten session.
		 */
		await signedIn([it3b]);
		await addSession(it3b);
		await addSession(it3b);

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		// And with a second account signed in, the class reads as two -- which is the
		// honest answer when two people are signed in.
		await signedIn([it3a, it3aOtherCohort]);
		expect((await readClassActivity(staff.token, "IT", 3, "A")).active_students).toBe(2);
	});

	it("never counts a staff, advisor or admin session", async () => {
		/*
		 * Every one of these holds a live session right now -- that is what authorises
		 * the requests in this file -- and none of them is a student.
		 */
		const staffSessions = await env.DB.prepare(
			"SELECT COUNT(*) AS total FROM auth_sessions WHERE auth_user_id IN (?, ?, ?)",
		)
			.bind(staff.authUserId, advisor.authUserId, admin.authUserId)
			.first<{ total: number }>();
		expect(staffSessions?.total ?? 0).toBeGreaterThan(0);

		await signedIn([]);

		for (const [department, year, section] of [
			["IT", 3, "A"],
			["IT", 3, "B"],
			["IT", 2, "A"],
			["CSE", 3, "A"],
		] as [string, number, string][]) {
			expect(
				(await readClassActivity(staff.token, department, year, section)).active_students,
				`${department} ${year} ${section}`,
			).toBe(0);
		}
	});

	it("keeps a student out of the count once the last session expires", async () => {
		await signedIn([it3b]);
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		await expireSessions(it3b);

		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(activity.total_students).toBe(1);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);
	});
});

/*
 * The total and the missing list.
 *
 * These are the half of the response that has to agree with the count rather than
 * merely resemble it: a staff member reading `42 / 68` and then opening a list has to
 * find 26 names there, or the card is lying in a way nothing else on screen can reveal.
 *
 * Every read below goes through `readClassActivity`, which asserts `active + missing`
 * equals `total` before returning, so the agreement is checked on every case rather
 * than only in the one that is meant to test it.
 */
describe("the class total", () => {
	it("counts every roster row in the class, signed in or not", async () => {
		/*
		 * A class spans cohorts, and no signed-in student means the total and the
		 * active count must both still be non-zero -- which they are only if `total` is
		 * counting roster rows rather than sessions.
		 *
		 * IT year 3 section A holds four students: `student` and `otherStudent` from
		 * the top-level fixtures, `it3a` from the 2024_2028 cohort and `it3aOtherCohort`
		 * from 2025_2029. Both of those cohorts really are the same class.
		 */
		const activity = await readClassActivity(staff.token, "IT", 3, "A");

		expect(activity.total_students).toBe(4);
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity).sort()).toEqual(
			[
				registerOf(student),
				registerOf(otherStudent),
				registerOf(it3a),
				registerOf(it3aOtherCohort),
			].sort(),
		);
	});

	it("is unaffected by who is signed in", async () => {
		const before = await readClassTotal(staff.token, "IT", 3, "A");
		await signedIn([it3a, it3aOtherCohort, it3b]);
		const after = await readClassTotal(staff.token, "IT", 3, "A");

		expect(before).toBe(4);
		expect(after).toBe(4);
	});

	it("includes a roster row that has no account behind it", async () => {
		/*
		 * `auth_user_id` is nullable, so a student can be on the roster with no way to
		 * sign in. They cannot ever be active, but they are still a student of this
		 * class and the staff member is still waiting for them -- counting them out of
		 * the total would quietly shrink the class.
		 */
		const registerNo = await addUnlinkedStudent(IT_2024, 3, "A");
		try {
			const activity = await readClassActivity(staff.token, "IT", 3, "A");

			expect(activity.total_students).toBe(5);
			expect(activity.active_students).toBe(0);
			expect(missingRegisters(activity)).toContain(registerNo);
		} finally {
			await removeStudent(IT_2024, registerNo);
		}
	});

	it("excludes other sections, other years and other departments", async () => {
		// IT 3 A holds four, two per IT cohort.
		expect(await readClassTotal(staff.token, "IT", 3, "A")).toBe(4);
		// IT 3 B holds one.
		expect(await readClassTotal(staff.token, "IT", 3, "B")).toBe(1);
		// IT 2 A holds one.
		expect(await readClassTotal(staff.token, "IT", 2, "A")).toBe(1);
		// CSE 3 A holds one, from the CSE cohort.
		expect(await readClassTotal(staff.token, "CSE", 3, "A")).toBe(1);
		// A class nobody is enrolled in is empty, not an error.
		expect(await readClassTotal(staff.token, "IT", 4, "A")).toBe(0);
	});

	it("reports zero for a department with no provisioned cohort", async () => {
		const response = await classCount(staff.token, { department: "ECE", year: "3", section: "A" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as ClassActivity;

		expect(body.active_students).toBe(0);
		expect(body.total_students).toBe(0);
		expect(body.missing).toEqual([]);
		expect(body.missing_truncated).toBe(false);
	});
});

describe("the missing student list", () => {
	it("is exactly the class minus the students holding a live session", async () => {
		await signedIn([it3a, it3aOtherCohort, student, otherStudent]);

		const activity = await readClassActivity(staff.token, "IT", 3, "A");

		expect(activity.total_students).toBe(4);
		expect(activity.active_students).toBe(4);
		expect(activity.missing).toEqual([]);
	});

	it("empties as students sign in, and refills as their last session ends", async () => {
		/*
		 * The behaviour the card is for. Nothing here is pushed to the client and there
		 * is no subscription: the same poll that reports the count reports the list, so
		 * the only thing that moves the list is a session appearing or going away.
		 *
		 * IT 3 A starts with four students and nobody signed in.
		 */
		const everyone = [student, otherStudent, it3a, it3aOtherCohort]
			.map((account) => registerOf(account))
			.sort();

		await signedIn([]);
		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "A"))).toEqual(everyone);

		// One signs in. Three names come off the list.
		await signedIn([it3a]);
		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "A"))).toEqual(
			everyone.filter((registerNo) => registerNo !== registerOf(it3a)),
		);

		// Signing in again with a second device does not re-add anybody.
		await addSession(it3a);
		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "A"))).toEqual(
			everyone.filter((registerNo) => registerNo !== registerOf(it3a)),
		);

		// Losing the first session while the second lives leaves them present.
		expect((await logout(it3a.token)).status).toBe(200);
		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "A"))).toEqual(
			everyone.filter((registerNo) => registerNo !== registerOf(it3a)),
		);

		// Only when the last one goes does the name come back.
		await revokeStudentSessions();
		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "A"))).toEqual(everyone);
	});

	it("puts an expired session's owner back on the list", async () => {
		await signedIn([it3b]);
		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "B"))).toEqual([]);

		await expireSessions(it3b);

		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "B"))).toEqual([
			registerOf(it3b),
		]);
	});

	it("spans every cohort of the department, not just one table", async () => {
		/*
		 * The failure this guards against is the quiet one: reading only the cohort that
		 * happened to be selected would report a full class while showing a missing list
		 * that is missing half the students.
		 *
		 * IT 3 A holds two students in IT_2024 and two in IT_2025. Signing in everyone
		 * from one cohort must leave the whole of the other cohort on the list.
		 */
		await signedIn([student, otherStudent, it3a]);

		const activity = await readClassActivity(staff.token, "IT", 3, "A");

		expect(activity.total_students).toBe(4);
		expect(activity.active_students).toBe(3);
		expect(missingRegisters(activity)).toEqual([registerOf(it3aOtherCohort)]);
	});

	it("is ordered by register number, so a stable key really is stable", async () => {
		await signedIn([]);

		const first = await readClassActivity(staff.token, "IT", 3, "A");
		const second = await readClassActivity(staff.token, "IT", 3, "A");

		const ordered = first.missing.map((row) => row.register_no);
		expect(ordered.length).toBeGreaterThan(1);
		expect(ordered).toEqual([...ordered].sort());
		// The card keys each row on this value, so it has to be the same list twice.
		expect(second.missing.map((row) => row.register_no)).toEqual(ordered);
	});

	it("never lists a student who is signed in", async () => {
		await signedIn([student, otherStudent, it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		for (const [department, year, section] of [
			["IT", 3, "A"],
			["IT", 3, "B"],
			["IT", 2, "A"],
			["CSE", 3, "A"],
		] as [string, number, string][]) {
			const activity = await readClassActivity(staff.token, department, year, section);
			expect(activity.missing, `${department} ${year} ${section}`).toEqual([]);
		}
	});

	it("ignores heartbeat activity entirely", async () => {
		/*
		 * The same regression guard the count has, applied to the list. A student who
		 * beat seconds ago but has no session is not signed in, and must not be
		 * presented as though they were.
		 */
		await signedIn([]);
		await grantSession(it3b);
		expect((await ping(it3b.token)).status).toBe(200);
		expect(await activityRows()).toEqual([it3b.authUserId]);

		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "B"))).toEqual([]);

		await revokeStudentSessions();

		// The beat is still there, seconds old, and is still worth nothing.
		expect(await activityRows()).toEqual([it3b.authUserId]);
		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "B"))).toEqual([
			registerOf(it3b),
		]);
	});

	it("never lists a non-student account, even one planted in the roster", async () => {
		/*
		 * The complement case. A staff account linked into a student roster is not
		 * counted as active, and if the missing list were simply "rows with no session"
		 * it would then be listed as a missing student -- false, and alarming to read.
		 *
		 * It is left out of the total too, which is what keeps the arithmetic honest:
		 * a row that is in the denominator but in neither half would make
		 * `active + missing` disagree with `total` on screen.
		 */
		await signedIn([student, otherStudent, it3a, it3aOtherCohort]);

		await env.DB.prepare(
			`INSERT INTO ${IT_2024} (student_id, register_no, student_name, year, section, email, auth_user_id)
			 VALUES ('CLSSTAFF02', 'REGSTAFF02', 'Class Test planted', 3, 'A', 'cls.staff.02@kiot.ac.in', ?)`,
		)
			.bind(staff.authUserId)
			.run();

		try {
			const activity = await readClassActivity(staff.token, "IT", 3, "A");

			expect(activity.active_students).toBe(4);
			// The planted row is in a cohort table but is not a student of the class.
			expect(activity.total_students).toBe(4);
			expect(activity.missing).toEqual([]);
		} finally {
			await env.DB.prepare(`DELETE FROM ${IT_2024} WHERE student_id = 'CLSSTAFF02'`).run();
		}
	});

	it("does not expose the list to a caller who cannot see the count", async () => {
		/*
		 * The names are the sensitive part, so the gate that protects the integer has to
		 * be the gate that protects them. A student asking about their own class is the
		 * sharpest version of this: they are one of the rows.
		 */
		await signedIn([student]);

		const response = await classCount(student.token, {
			department: "IT",
			year: "3",
			section: "A",
		});
		expect(response.status).toBe(403);
		expect(JSON.stringify(await response.json())).not.toContain("Class Test");

		const asAdmin = await classCount(admin.token, {
			department: "IT",
			year: "3",
			section: "A",
		});
		expect(asAdmin.status).toBe(403);
		expect(JSON.stringify(await asAdmin.json())).not.toContain("Class Test");

		const anonymous = await classCount(null, { department: "IT", year: "3", section: "A" });
		expect(anonymous.status).toBe(401);
		expect(JSON.stringify(await anonymous.json())).not.toContain("Class Test");
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

/*
 * A cohort provisioned after this build shipped.
 *
 * The class route reaches its tables through `listBatchesForDepartment`, so it has no
 * list of cohorts of its own to fall out of date -- but "it uses the registry" is a
 * claim, and a claim is only worth what a test that provisions a new cohort proves.
 *
 * The cohort here is created through the same admin endpoint the dashboard uses, so
 * the tables, the indexes and the registry row are all real. Nothing is planted by hand
 * and no batch label is written into this file's assertions: the test asks the
 * registry what exists, and checks the class route followed it.
 */
describe("a cohort provisioned after this build shipped", () => {
	const NEW_DEPARTMENT = "ECE";
	const NEW_BATCH = "2027_2031";

	it("is picked up by the total and the missing list with no code change", async () => {
		// ECE is a supported department with no cohort at all until this runs.
		expect(await readClassTotal(staff.token, NEW_DEPARTMENT, 2, "B")).toBe(0);

		const created = await SELF.fetch("https://example.com/api/admin/batches", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie(admin.token) },
			body: JSON.stringify({ department: NEW_DEPARTMENT, batch: NEW_BATCH }),
		});
		expect(created.status).toBe(200);
		const body = (await created.json()) as { studentTable: string };

		/*
		 * The table name comes back from the endpoint rather than being written here, so
		 * this suite cannot fall out of step with `buildTableNames` the way a hardcoded
		 * label would.
		 */
		const newTable = body.studentTable;
		expect(newTable).toBeTruthy();

		// Declared outside the try so the cleanup below can reach them either way.
		let present: Account | undefined;
		let absent: Account | undefined;
		let elsewhere: Account | undefined;

		try {
			// Two students in ECE year 2 section B, one of them signed in.
			present = await makeAccount("student", "ecenewe", {
				live: false,
				linkedStudent: true,
				table: newTable,
				year: 2,
				section: "B",
			});
			absent = await makeAccount("student", "ecenewa", {
				live: false,
				linkedStudent: true,
				table: newTable,
				year: 2,
				section: "B",
			});
			// One in a different section, who must never appear in this class.
			elsewhere = await makeAccount("student", "ecenewb", {
				live: false,
				linkedStudent: true,
				table: newTable,
				year: 2,
				section: "A",
			});

			await signedIn([present]);

			const activity = await readClassActivity(staff.token, NEW_DEPARTMENT, 2, "B");

			expect(activity.total_students).toBe(2);
			expect(activity.active_students).toBe(1);
			expect(missingRegisters(activity)).toEqual([registerOf(absent)]);
			expect(missingRegisters(activity)).not.toContain(registerOf(elsewhere));

			/*
			 * The global count spans every department, so it sees this student too --
			 * which is what shows the new cohort was really registered rather than only
			 * read from a table that happened to exist.
			 */
			expect(await readCount(staff.token)).toBe(1);
		} finally {
			for (const account of [present, absent, elsewhere]) {
				if (!account) continue;
				await env.DB.prepare(`DELETE FROM auth_sessions WHERE auth_user_id = ?`)
					.bind(account.authUserId)
					.run();
				await env.DB.prepare(`DELETE FROM auth_users WHERE auth_user_id = ?`)
					.bind(account.authUserId)
					.run();
			}
			await env.DB.prepare(`DELETE FROM ${newTable}`).run();
			await env.DB.prepare(`DELETE FROM academic_batches WHERE department = ? AND batch = ?`)
				.bind(NEW_DEPARTMENT, NEW_BATCH)
				.run();
			await env.DB.prepare(`DROP TABLE IF EXISTS ${newTable}`).run();
			await env.DB.prepare(
				`DROP TABLE IF EXISTS ${newTable.replace("_Students_", "_Attendance_")}`,
			).run();
		}

		/*
		 * And with the cohort gone, the department is empty again -- which is the other
		 * half of "dynamic": a cohort that is unregistered must stop counting, rather than
		 * going on resolving for the life of the Worker isolate.
		 *
		 * The batch registry is cached per isolate for 60s, and this test has just
		 * dropped the tables inside that window, so the refresh production code relies
		 * on is triggered here explicitly instead of by sleeping. `GET /api/admin/batches`
		 * is the route that already forces a rehydrate, and it is the same call the
		 * admin picker makes every time it opens.
		 */
		await SELF.fetch("https://example.com/api/admin/batches", {
			headers: { Cookie: cookie(admin.token) },
		});

		expect(await readClassTotal(staff.token, NEW_DEPARTMENT, 2, "B")).toBe(0);
	});
});

/*
 * Failure handling.
 *
 * The card's contract with the server is that a failed request produces *no* payload,
 * never a zeroed one. "0 / 0" and "0 of 68 present" are both answers a staff member
 * would act on, so the server must not be able to produce them by accident, and the
 * client must not be able to invent them either.
 */
describe("failure handling", () => {
	it("answers a rejected class with no figures at all", async () => {
		for (const query of [
			{ department: "IT", year: "9", section: "A" },
			{ department: "ZZ", year: "3", section: "A" },
			{ department: "IT", year: "3", section: "" },
		]) {
			const response = await classCount(staff.token, query);
			expect(response.status, JSON.stringify(query)).toBe(400);
			const body = (await response.json()) as Record<string, unknown>;

			expect(body.success).toBe(false);
			// No half-answer: a rejected request carries neither figures nor rows.
			for (const field of ["active_students", "total_students", "missing", "updated_at"]) {
				expect(body, `${field} must not be present on a rejection`).not.toHaveProperty(field);
			}
		}
	});

	it("keeps the roster untouched when a class is rejected", async () => {
		const before = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${IT_2024}`).first<{
			total: number;
		}>();

		await classCount(staff.token, { department: "IT", year: "3", section: "Z" });

		const after = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${IT_2024}`).first<{
			total: number;
		}>();
		expect(after?.total).toBe(before?.total);
	});

	it("still serves the count when the class is one with nobody in it", async () => {
		/*
		 * The distinction the card is built on. An empty class is a successful answer of
		 * zeroes; a broken request is an error with no answer. Conflating them is what
		 * would let a failure reach the screen as a number.
		 *
		 * The card renders this state as "There are no students in this class" rather
		 * than as `0 / 0`, so what matters here is that the response is a well-formed
		 * success and that every figure really is zero -- the client decides how to
		 * present it, and it can only do that correctly if it is told the truth.
		 */
		await signedIn([it3a, it3b, it2a, cse3a]);

		const activity = await readClassActivity(staff.token, "IT", 4, "D");

		expect(activity.success).toBe(true);
		expect(activity.active_students).toBe(0);
		expect(activity.total_students).toBe(0);
		expect(activity.missing).toEqual([]);
		// Not truncated, because there is nothing that could have been truncated.
		expect(activity.missing_truncated).toBe(false);
		expect(Number.isNaN(Date.parse(activity.updated_at))).toBe(false);

		/*
		 * The same for a department with no cohort at all, which reaches the route
		 * through the empty-registry branch rather than through an empty query result.
		 * Both must produce the identical shape, or the card would branch on one and
		 * not the other.
		 */
		const noCohort = await readClassActivity(staff.token, "ECE", 1, "A");
		expect(Object.keys(noCohort).sort()).toEqual(Object.keys(activity).sort());
		expect(noCohort.active_students).toBe(0);
		expect(noCohort.total_students).toBe(0);
		expect(noCohort.missing).toEqual([]);
		expect(noCohort.missing_truncated).toBe(false);
	});

	it("reports a class that stops being empty the moment a roster row appears", async () => {
		/*
		 * The card keeps polling while it shows an empty class, so this is the state that
		 * has to arrive on its own -- an administrator importing a roster under a
		 * watching staff member, with nobody pressing refresh.
		 */
		await signedIn([]);
		expect((await readClassActivity(staff.token, "IT", 4, "D")).total_students).toBe(0);

		const late = await makeAccount("student", "latejoin", {
			live: true,
			linkedStudent: true,
			table: IT_2024,
			year: 4,
			section: "D",
		});

		try {
			const activity = await readClassActivity(staff.token, "IT", 4, "D");

			expect(activity.total_students).toBe(1);
			expect(activity.active_students).toBe(1);
			expect(activity.missing).toEqual([]);
		} finally {
			await env.DB.prepare(`DELETE FROM auth_sessions WHERE auth_user_id = ?`)
				.bind(late.authUserId)
				.run();
			await env.DB.prepare(`DELETE FROM auth_users WHERE auth_user_id = ?`)
				.bind(late.authUserId)
				.run();
			await env.DB.prepare(`DELETE FROM ${IT_2024} WHERE auth_user_id = ?`)
				.bind(late.authUserId)
				.run();
		}

		// And back to empty once the account is gone, so nothing lingers.
		expect((await readClassActivity(staff.token, "IT", 4, "D")).total_students).toBe(0);
	});
});