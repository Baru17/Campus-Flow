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
 * An account is counted when it holds a valid, unexpired login session **and** has a
 * heartbeat within the last sixty seconds. Both halves are required.
 *
 * That is what the file is shaped around, and the shape matters: almost every test
 * establishes both at once through `signedInAndActive`, and the ones that establish only
 * one are named for the half they are isolating. A helper that quietly supplied the beat
 * would let the session tests pass without ever proving that a session alone is not
 * enough, which is one of the two things this rule says.
 *
 * `auth_sessions.created_at` is not consulted. How long an account has been signed in is
 * a different question from whether it is being used now, and reading the session's age
 * reported students who had left days ago as present.
 *
 * The heartbeat is written by `POST /ping` with the server's own clock, and the cutoff is
 * computed by SQLite, so neither a student nor their device clock decides who the staff
 * dashboard counts.
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
 * ## Activity age
 *
 * A session qualifies while it is unexpired *and* the account has beaten within the
 * window. Almost every test establishes both through `signedInAndActive`, so those read
 * as they always did.
 *
 * The window itself is exercised by `setActivity`, which writes `last_active_at`
 * directly, because `POST /ping` always stamps "now" and a suite cannot reach a boundary
 * by waiting. Those tests state the whole rule rather than only its edges: a stale beat
 * on a valid seven-day session does not count but the student stays signed in, a fresh
 * beat restores the count, several sessions and beats make one student, another tab
 * keeps an account counted, and the campus-wide and class counts agree.
 *
 * There are no sleep-based boundary tests anywhere in this file. Every edge is either
 * pinned against a frozen timestamp or driven with a margin wider than the few hundred
 * milliseconds between writing a value and the request that reads it.
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
 * Stamps an account's activity, at a chosen age.
 *
 * The counting rule reads `student_activity.last_active_at`, and `POST /ping` always
 * writes "now" from the server clock. That is exactly what a test needs for the ordinary
 * cases and useless for the boundary ones, so this writes the column directly and lets a
 * test put the timestamp wherever it wants it.
 *
 * Age rather than an absolute time, so the tests stay deterministic no matter how long
 * the file takes to run: `-2 minutes` is two minutes ago whenever it is evaluated, while
 * an absolute timestamp would drift against the database clock as the suite progresses.
 *
 * `ping()` is the counterpart that proves the server stamps its own time, and is what
 * most tests use instead.
 */
async function setActivity(
	account: Account,
	options: { ageMs?: number; at?: string } = {},
): Promise<void> {
	const { ageMs = 0, at } = options;
	const lastActiveAt = at ?? new Date(Date.now() - ageMs).toISOString();

	await env.DB.prepare(
		`INSERT INTO student_activity (auth_user_id, last_active_at) VALUES (?, ?)
		 ON CONFLICT(auth_user_id) DO UPDATE SET last_active_at = excluded.last_active_at`,
	)
		.bind(account.authUserId, lastActiveAt)
		.run();
}

/**
 * The whole setup a countable student needs: exactly these accounts are signed in *and*
 * beating.
 *
 * Every test starts from nobody being signed in, so a count of 2 means two of these
 * accounts and not two of the fourteen fixtures the file creates.
 *
 * It does both halves on purpose. A count needs a session and a recent beat, and a
 * helper that only did the first would let a test pass or fail on whether its author
 * remembered the second -- with a count of zero, which reads as a query bug rather than
 * as a missing beat. The tests that care about one half without the other set it up
 * themselves.
 */
async function signedInAndActive(accounts: Account[]): Promise<void> {
	await revokeStudentSessions();
	await clearActivity();
	for (const account of accounts) {
		await grantSession(account);
		await setActivity(account);
	}
}

/**
 * Grants a live session but records **no** activity.
 *
 * The counterpart, for the tests whose whole point is that a session on its own is not
 * enough. Used to set up the negative cases without having to undo anything afterwards.
 */
async function signedInOnly(accounts: Account[]): Promise<void> {
	await revokeStudentSessions();
	await clearActivity();
	for (const account of accounts) {
		await grantSession(account);
	}
}

/**
 * The recent-activity window the endpoint applies, restated here as a number.
 *
 * Written out rather than imported from the module on purpose. The module's copy is what
 * the SQL binds, so importing it would mean a test that changes the rule silently starts
 * agreeing with the new rule instead of failing -- the opposite of what these tests are
 * for.
 */
const ACTIVITY_WINDOW_MS = 60 * 1000;

async function expireSessions(account: Account): Promise<void> {
	await env.DB.prepare("UPDATE auth_sessions SET expires_at = ? WHERE auth_user_id = ?")
		.bind(new Date(Date.now() - 1000).toISOString(), account.authUserId)
		.run();
}

async function clearActivity(): Promise<void> {
	await env.DB.prepare("DELETE FROM student_activity").run();
}

async function activityRows(): Promise<string[]> {
	/*
	 * Ordered, so a test that expects more than one account compares against a fixed
	 * sequence. Without this the row order is whatever the scan happens to produce, and a
	 * test would pass or fail depending on the plan rather than on the behaviour.
	 */
	const rows = await env.DB.prepare(
		"SELECT auth_user_id FROM student_activity ORDER BY auth_user_id",
	).all<{ auth_user_id: string }>();
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

	it("does not count a student who has never sent a heartbeat", async () => {
		/*
		 * The other half of the rule from the one above. A valid session is necessary and
		 * not sufficient: with no beat on file, nothing has said this account was being
		 * used, so it is not on the board.
		 */
		await signedInOnly([student]);

		expect(await readCount(staff.token)).toBe(0);
		expect(await activityRows()).toEqual([]);
	});

	it("counts a student the moment they send their first heartbeat", async () => {
		/*
		 * The pair of the test above, and the behaviour a student actually sees: signing
		 * in does not by itself put them on the dashboard, and the first interaction does.
		 * The client tracker sends a beat as soon as the session exists, so the gap
		 * between the two is a single request.
		 */
		await signedInOnly([student]);
		expect(await readCount(staff.token)).toBe(0);

		expect((await ping(student.token)).status).toBe(200);

		expect(await readCount(staff.token)).toBe(1);
		expect(await activityRows()).toEqual([student.authUserId]);
	});

	it("does not count a student whose session is gone, whatever the beat says", async () => {
		/*
		 * The regression guard for the join. Three students sign in and beat; their
		 * sessions then go away. The beats are seconds old and the accounts have every
		 * right to still be beating -- and they must still not count, because there is no
		 * session left to pair the activity with.
		 */
		await signedInAndActive([student, otherStudent, it3a]);
		for (const account of [student, otherStudent, it3a]) {
			expect((await ping(account.token)).status).toBe(200);
		}
		expect(await activityRows()).toHaveLength(3);
		expect(await readCount(staff.token)).toBe(3);

		await revokeStudentSessions();

		expect(await readCount(staff.token)).toBe(0);
		// The beats are still on file, seconds old, and still worth nothing.
		expect(await activityRows()).toHaveLength(3);
	});

	it("counts each account once, however many sessions it holds", async () => {
		await signedInAndActive([student, otherStudent]);
		await addSession(student);
		await addSession(student);

		expect(await readCount(staff.token)).toBe(2);
	});

	it("excludes every non-student role that holds a live session", async () => {
		await signedInAndActive([student]);

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
		await signedInAndActive([student]);
		expect(await readCount(staff.token)).toBe(1);

		const response = await logout(student.token);
		expect(response.status).toBe(200);

		expect(await readCount(staff.token)).toBe(0);
		expect((await ping(student.token)).status).toBe(401);
	});

	it("returns a student to the count when they sign in again", async () => {
		await signedInAndActive([student]);
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
		await signedInAndActive([student]);
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
		await signedInAndActive([student]);

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
		await signedInAndActive([it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		/*
		 * Two students in IT year 3 section A, because that class spans two cohorts --
		 * 2024_2028 and 2025_2029 -- and a class is a department, a year and a
		 * section, not a cohort. Counting only the cohort that happened to be
		 * selected would silently under-report by a factor of the number of cohorts.
		 */
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(2);
	});

	it("excludes other sections and other years of the same cohort", async () => {
		await signedInAndActive([it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(1);
		expect(await readClassCount(staff.token, "IT", 2, "A")).toBe(1);
		expect(await readClassCount(staff.token, "IT", 3, "C")).toBe(0);
		expect(await readClassCount(staff.token, "IT", 4, "A")).toBe(0);
	});

	it("excludes another department that shares the year and section", async () => {
		await signedInAndActive([it3a, it3aOtherCohort, it3b, it2a, cse3a]);

		expect(await readClassCount(staff.token, "CSE", 3, "A")).toBe(1);
		// And the ten CSE students migration 0014 seeded hold no session at all.
		expect(await readClassCount(staff.token, "CSE", 1, "A")).toBe(0);
		// ECE is a supported department with no provisioned cohort.
		expect(await readClassCount(staff.token, "ECE", 3, "A")).toBe(0);
	});

	it("does not count a class whose students have never sent a heartbeat", async () => {
		/*
		 * The class-level version of the same rule. Two students across two cohorts, both
		 * holding valid sessions and neither beating: the class reads as empty, and the
		 * two of them are on the missing list rather than nowhere.
		 */
		await signedInOnly([it3a, it3aOtherCohort]);

		expect(await activityRows()).toEqual([]);
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(0);

		const activity = await readClassActivity(staff.token, "IT", 3, "A");
		expect(activity.missing.length).toBe(activity.total_students);
	});

	it("counts an account once however many devices it is signed in on", async () => {
		await signedInAndActive([it3a, it3aOtherCohort]);
		await addSession(it3a);
		await addSession(it3a);

		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(2);
	});

	it("does not count an account whose sessions are gone but whose beat is fresh", async () => {
		await signedInAndActive([it3a, it3b]);
		expect((await ping(it3b.token)).status).toBe(200);
		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(1);

		await logout(it3b.token);

		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(0);
		// Both beat rows are still there, seconds old, and the one for the account that
		// just logged out is still worth nothing.
		expect(await activityRows()).toEqual([it3a.authUserId, it3b.authUserId].sort());
	});

	it("stops counting a class when an idle student logs out", async () => {
		await signedInAndActive([it3a, it3aOtherCohort]);
		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(2);

		expect((await logout(it3a.token)).status).toBe(200);

		expect(await readClassCount(staff.token, "IT", 3, "A")).toBe(1);
	});

	it("excludes a student whose session has expired", async () => {
		await signedInAndActive([it3b]);
		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(1);

		await expireSessions(it3b);

		expect(await readClassCount(staff.token, "IT", 3, "B")).toBe(0);
	});

	it("excludes a non-student account even if one is linked into the roster", async () => {
		await signedInAndActive([it3a]);
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
		await signedInAndActive([it3a]);

		expect(await readClassCount(staff.token, "  it ", 3, " a ")).toBe(1);
	});

	it("returns a count and a timestamp, and nothing identifying", async () => {
		await signedInAndActive([it3a, it2a, cse3a]);

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
		await signedInAndActive([student, otherStudent, it3a]);

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
 * The sixty-second activity window.
 *
 * An account counts while it holds an unexpired session *and* has a beat inside the
 * recent-activity window. Almost every test elsewhere in this file grants a session and
 * beats at the same time, so those read unchanged; this suite is where the window itself
 * is driven, with the activity timestamp placed deliberately.
 */
describe("the sixty-second activity window", () => {
	/*
	 * The rule: an account counts while it holds an unexpired session *and* has a beat
	 * inside the recent-activity window.
	 *
	 * Activity is stamped with a chosen age rather than by waiting. A suite that slept
	 * for a boundary would be both slow and flaky, and a sleep long enough to cross
	 * sixty seconds is not a test suite anyone runs.
	 */

	it("counts a student who has just signed in", async () => {
		/*
		 * Login on its own. `POST /ping` is what the tracker sends the moment the student
		 * session exists, so this is the state a student is in seconds after logging in.
		 */
		await revokeStudentSessions();
		await clearActivity();
		await grantSession(it3b);
		expect((await ping(it3b.token)).status).toBe(200);

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
		expect(await readCount(staff.token)).toBe(1);
	});

	it("counts a beat well inside the window", async () => {
		await signedInAndActive([it3b]);
		await setActivity(it3b, { ageMs: 20 * 1000 });

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
	});

	it("counts a beat sitting just inside the boundary", async () => {
		/*
		 * Ten seconds of margin. The window is compared against the moment the request is
		 * served, so anything written exactly on the line is already past it by the time
		 * it is read; this asserts the rule without depending on request latency.
		 */
		await signedInAndActive([it3b]);
		await setActivity(it3b, { ageMs: ACTIVITY_WINDOW_MS - 10 * 1000 });

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
	});

	it("stops counting a beat just past the boundary", async () => {
		await signedInAndActive([it3b]);
		await setActivity(it3b, { ageMs: ACTIVITY_WINDOW_MS + 10 * 1000 });

		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);
	});

	it("counts a beat sitting exactly on the boundary", async () => {
		/*
		 * "Older than sixty seconds must not count" makes the boundary inclusive, and the
		 * boundary itself is asserted against frozen timestamps rather than through the
		 * live endpoint -- for the same reason the neighbouring tests carry a margin: the
		 * cutoff is evaluated when the request arrives, so a value written exactly on the
		 * line is a few hundred milliseconds past it by the time it is read.
		 */
		const qualifies = async (stored: string, threshold: string): Promise<number> => {
			const row = await env.DB.prepare("SELECT datetime(?) >= datetime(?) AS qualifies")
				.bind(stored, threshold)
				.first<{ qualifies: number }>();
			return Number(row?.qualifies ?? 0);
		};

		const stamp = "2026-10-13 16:40:00";
		const earlier = "2026-10-13 16:39:59";
		const later = "2026-10-13 16:40:01";

		// Equal timestamps qualify: the window closes only after the next second.
		expect(await qualifies(stamp, stamp)).toBe(1);
		expect(await qualifies(stamp, earlier)).toBe(1);
		expect(await qualifies(stamp, later)).toBe(0);
	});

	it("drops an idle student once the activity goes stale", async () => {
		/*
		 * The headline behaviour: a student who stops touching CampusFlow is no longer on
		 * the staff dashboard, while their session keeps working exactly as before.
		 */
		await signedInAndActive([it3b]);
		await setActivity(it3b);
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		// They stop interacting. No logout, no expiry, nothing ends their session.
		await setActivity(it3b, { ageMs: ACTIVITY_WINDOW_MS + 5 * 1000 });

		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);

		// And they are still signed in, in every way that matters. Again not `ping()`:
		// beating here would make them active again and the point is that they are not.
		expect(
			(await SELF.fetch("https://example.com/api/auth/session", {
				headers: { Cookie: cookie(it3b.token) },
			})).status,
		).toBe(200);
	});

	it("counts the student again as soon as they interact", async () => {
		await signedInAndActive([it3b]);
		await setActivity(it3b, { ageMs: ACTIVITY_WINDOW_MS + 5 * 1000 });
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(0);

		// A fresh beat, exactly what the tracker sends on the next interaction.
		await setActivity(it3b);

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "B"))).toEqual([]);
	});

	it("does not count a valid seven-day session with stale activity", async () => {
		/*
		 * The distinction the whole feature is built on: a session that is still perfectly
		 * valid and still authenticates, belonging to a student who has not touched the
		 * app in four hours. They are signed in. They are not here.
		 */
		await revokeStudentSessions();
		await clearActivity();
		await grantSession(it3b, {
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
		});
		await setActivity(it3b, { ageMs: 4 * 60 * 60 * 1000 });

		// Signed in, everywhere the application cares about. Deliberately *not* `ping()`:
		// a ping writes a fresh beat, which is exactly what this test needs to stay false.
		expect(
			(await SELF.fetch("https://example.com/api/auth/session", {
				headers: { Cookie: cookie(it3b.token) },
			})).status,
		).toBe(200);
		expect(
			(await SELF.fetch("https://example.com/api/auth/user", {
				headers: { Cookie: cookie(it3b.token) },
			})).status,
		).toBe(200);

		// Not counted here, on either surface.
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(0);
		expect(await readCount(staff.token)).toBe(0);
	});

	it("does not count an expired session even with a fresh beat", async () => {
		/*
		 * The two halves are independent. Activity cannot resurrect a session that has
		 * ended, which is what stops a student appearing on a dashboard for a class they
		 * are not actually signed in to.
		 */
		await revokeStudentSessions();
		await clearActivity();
		await grantSession(it3b, { expiresAt: new Date(Date.now() - 1000).toISOString() });
		await setActivity(it3b);

		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);
	});

	it("stops counting immediately on logout", async () => {
		await signedInAndActive([it3b]);
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		expect((await logout(it3b.token)).status).toBe(200);

		/*
		 * Immediately, not after sixty seconds. The session row is gone, so there is
		 * nothing left for the activity row to pair with -- which is why logout does not
		 * need to touch `student_activity` at all.
		 */
		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);

		// The stale beat is still on file, and is still worth nothing.
		expect(await activityRows()).toEqual([it3b.authUserId]);
	});

	it("does not let logging out of one device end the account", async () => {
		await signedInAndActive([it3b]);
		await setActivity(it3b);
		await addSession(it3b);

		expect((await logout(it3b.token)).status).toBe(200);

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
	});

	it("counts one student however many sessions or beats they have", async () => {
		await signedInAndActive([it3b]);
		await addSession(it3b);
		await addSession(it3b);
		// `student_activity` is keyed on the account, so repeated beats collapse onto one
		// row however many tabs or devices send them.
		await setActivity(it3b);
		await setActivity(it3b, { ageMs: 1000 });

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
		expect(await readCount(staff.token)).toBe(1);

		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS total FROM student_activity WHERE auth_user_id = ?",
		)
			.bind(it3b.authUserId)
			.first<{ total: number }>();
		expect(rows?.total).toBe(1);
	});

	it("keeps an account counted while another tab for it is still active", async () => {
		/*
		 * The multiple-tab case, and the reason there is no departure signal.
		 *
		 * Two tabs of one account share a single `student_activity` row. Whichever tab is
		 * being used refreshes that row, so the account stays counted -- and there is no
		 * path by which the other tab closing, or going idle, can evict it. A "this
		 * account has gone" request would have to delete this very row, and the server
		 * cannot tell which tab sent it.
		 */
		await signedInAndActive([it3b]);
		await setActivity(it3b);

		// Tab A closes. Nothing is sent, because there is nothing safe to send.
		// Tab B is still being used, so it beats.
		await setActivity(it3b, { at: new Date().toISOString() });

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		// Both tabs then go quiet. Now the account ages out, on the timeout alone.
		await setActivity(it3b, { ageMs: ACTIVITY_WINDOW_MS + 5 * 1000 });
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(0);
	});

	it("does not count an account whose beat is missing entirely", async () => {
		/*
		 * No row at all is the same as a stale row, and both mean the same thing: nobody
		 * has said this account was being used recently.
		 */
		await signedInAndActive([it3b]);
		await clearActivity();

		const activity = await readClassActivity(staff.token, "IT", 3, "B");
		expect(activity.active_students).toBe(0);
		expect(missingRegisters(activity)).toEqual([registerOf(it3b)]);
	});

	it("does not count a malformed activity timestamp", async () => {
		/*
		 * The stored value is text, so a row can in principle hold something unparseable.
		 * `datetime()` turns that into NULL, which fails the comparison rather than
		 * counting the account -- a row nobody can interpret is not evidence of anything.
		 *
		 * `student_activity.last_active_at` is NOT NULL, so this is not reachable by
		 * accident; it is reachable by a restore, or by any tool that seeds the table
		 * directly, which is exactly when it needs to be safe.
		 */
		await signedInOnly([it3b]);
		await setActivity(it3b, { at: "not a timestamp" });
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(0);

		await setActivity(it3b, { at: "" });
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(0);
	});

	it("accepts the SQLite timestamp shape as well as the ISO one", async () => {
		/*
		 * `last_active_at` is written by the Worker as ISO-8601, but `created_at` on the
		 * session table is SQLite's own space-separated form, and the two do not order
		 * against each other as text. Both shapes have to be understood, or a table
		 * restored or seeded by another tool would silently stop counting.
		 */
		await signedInAndActive([it3b]);
		await setActivity(it3b, { at: new Date().toISOString().slice(0, 19).replace("T", " ") });

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);
	});

	it("never counts a non-student role, however fresh the beat", async () => {
		await signedInAndActive([]);
		await clearActivity();

		for (const account of [staff, advisor, admin]) {
			await setActivity(account);
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

		expect(await readCount(staff.token)).toBe(0);
	});

	it("refuses a heartbeat from anything but a student session", async () => {
		/*
		 * The gate is on the server, not only in the client. A staff account on the same
		 * device must not be able to write a row that would put it on a student count.
		 */
		for (const account of [staff, advisor, admin]) {
			expect((await ping(account.token)).status, account.token).toBe(403);
		}
		expect((await ping(null)).status).toBe(401);

		// And nothing was written for them.
		const rows = await env.DB.prepare(
			`SELECT sa.auth_user_id FROM student_activity sa
			 JOIN auth_users au ON au.auth_user_id = sa.auth_user_id
			 WHERE LOWER(au.role) <> 'student'`,
		).all<{ auth_user_id: string }>();
		expect(rows.results).toEqual([]);
	});

	it("applies the same rule to the campus-wide count", async () => {
		/*
		 * The global route and the class route answer the same question, so they have to
		 * agree. A dashboard showing 1 here and 0 there would leave a reader with no way
		 * to tell which number to believe.
		 */
		await signedInAndActive([it3b]);
		expect(await readCount(staff.token)).toBe(1);
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		await setActivity(it3b, { ageMs: ACTIVITY_WINDOW_MS + 5 * 1000 });
		expect(await readCount(staff.token)).toBe(0);
		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(0);
	});

	it("keeps active, missing and total consistent either side of the boundary", async () => {
		/*
		 * The identity the card is built on. Both fixtures are in IT year 3 section A, so
		 * one just inside the window and one just outside it are counted in the same
		 * class and the arithmetic can actually be checked.
		 */
		await signedInAndActive([it3a, it3aOtherCohort]);
		await setActivity(it3a, { ageMs: ACTIVITY_WINDOW_MS - 10 * 1000 });
		await setActivity(it3aOtherCohort, { ageMs: ACTIVITY_WINDOW_MS + 10 * 1000 });

		const activity = await readClassActivity(staff.token, "IT", 3, "A");

		// `readClassActivity` already asserts active + missing === total.
		expect(activity.active_students).toBe(1);
		expect(activity.total_students).toBe(4);
		expect(activity.missing.length).toBe(activity.total_students - 1);
		expect(missingRegisters(activity)).toContain(registerOf(it3aOtherCohort));
		expect(missingRegisters(activity)).not.toContain(registerOf(it3a));
	});

	/*
	 * Only the rows, never the whole `D1Result`. That object carries `meta` with query
	 * timings and a served-by region, which differ between two identical queries and
	 * would fail this on timing rather than on behaviour.
	 */
	const rows = async (table: "auth_sessions" | "student_activity") => {
		const result = await env.DB.prepare(
			table === "auth_sessions"
				? "SELECT token_hash, auth_user_id, expires_at FROM auth_sessions ORDER BY auth_user_id"
				: "SELECT auth_user_id, last_active_at FROM student_activity ORDER BY auth_user_id",
		).all();
		return result.results;
	};

	it("does not let a count change a session or the activity table", async () => {
		await signedInAndActive([it3a, it3b]);

		const sessions = await rows("auth_sessions");
		const activity = await rows("student_activity");
		expect(sessions.length).toBeGreaterThan(0);

		for (let i = 0; i < 3; i += 1) {
			await readCount(staff.token);
			await readClassActivity(staff.token, "IT", 3, "A");
		}

		expect(await rows("auth_sessions")).toEqual(sessions);
		expect(await rows("student_activity")).toEqual(activity);
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
describe("what counts as an active student", () => {
	it("counts one student signing in as exactly one", async () => {
		await signedInAndActive([]);

		const before = await readClassActivity(staff.token, "IT", 3, "B");
		expect(before.active_students).toBe(0);
		expect(before.total_students).toBe(1);

		await signedInAndActive([it3b]);

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
		await signedInAndActive([it2a]);

		const it3a = await readClassActivity(staff.token, "IT", 3, "A");
		expect(it3a.active_students).toBe(0);
		expect(it3a.missing.length).toBe(it3a.total_students);

		const it3b = await readClassActivity(staff.token, "IT", 3, "B");
		expect(it3b.active_students).toBe(0);

		const cse3a = await readClassActivity(staff.token, "CSE", 3, "A");
		expect(cse3a.active_students).toBe(0);
	});

	it("is not moved by a student in another department", async () => {
		await signedInAndActive([cse3a]);

		expect((await readClassActivity(staff.token, "IT", 3, "A")).active_students).toBe(0);
		expect((await readClassActivity(staff.token, "CSE", 3, "A")).active_students).toBe(1);
	});

	it("counts one student however many sessions they hold", async () => {
		await signedInAndActive([it3b]);
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
		await signedInAndActive([it3b]);
		await addSession(it3b);
		await addSession(it3b);

		expect((await readClassActivity(staff.token, "IT", 3, "B")).active_students).toBe(1);

		// And with a second account signed in, the class reads as two -- which is the
		// honest answer when two people are signed in.
		await signedInAndActive([it3a, it3aOtherCohort]);
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

		await signedInAndActive([]);

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
		await signedInAndActive([it3b]);
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
		await signedInAndActive([it3a, it3aOtherCohort, it3b]);
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
		await signedInAndActive([it3a, it3aOtherCohort, student, otherStudent]);

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

		await signedInAndActive([]);
		expect(missingRegisters(await readClassActivity(staff.token, "IT", 3, "A"))).toEqual(everyone);

		// One signs in. Three names come off the list.
		await signedInAndActive([it3a]);
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
		await signedInAndActive([it3b]);
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
		await signedInAndActive([student, otherStudent, it3a]);

		const activity = await readClassActivity(staff.token, "IT", 3, "A");

		expect(activity.total_students).toBe(4);
		expect(activity.active_students).toBe(3);
		expect(missingRegisters(activity)).toEqual([registerOf(it3aOtherCohort)]);
	});

	it("is ordered by register number, so a stable key really is stable", async () => {
		await signedInAndActive([]);

		const first = await readClassActivity(staff.token, "IT", 3, "A");
		const second = await readClassActivity(staff.token, "IT", 3, "A");

		const ordered = first.missing.map((row) => row.register_no);
		expect(ordered.length).toBeGreaterThan(1);
		expect(ordered).toEqual([...ordered].sort());
		// The card keys each row on this value, so it has to be the same list twice.
		expect(second.missing.map((row) => row.register_no)).toEqual(ordered);
	});

	it("never lists a student who is signed in", async () => {
		await signedInAndActive([student, otherStudent, it3a, it3aOtherCohort, it3b, it2a, cse3a]);

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

	it("lists a student as missing once their session ends, whatever their beat says", async () => {
		/*
		 * The same regression guard the count has, applied to the list. A student who
		 * beat seconds ago but has no session is not signed in, and must not be
		 * presented as though they were -- the list is driven by the same `is_active`
		 * tag as the count, so the two cannot disagree.
		 */
		await signedInAndActive([]);
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
		await signedInAndActive([student, otherStudent, it3a, it3aOtherCohort]);

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
		await signedInAndActive([student]);

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
		await signedInAndActive([it3a, it3b]);
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
		await signedInAndActive([it3a, it3b]);

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

			await signedInAndActive([present]);

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
		await signedInAndActive([it3a, it3b, it2a, cse3a]);

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
		await signedInAndActive([]);
		expect((await readClassActivity(staff.token, "IT", 4, "D")).total_students).toBe(0);

		const late = await makeAccount("student", "latejoin", {
			live: true,
			linkedStudent: true,
			table: IT_2024,
			year: 4,
			section: "D",
		});

		try {
			// The arriving student is signed in and using the app, which is what the
			// tracker would have recorded a moment earlier.
			await setActivity(late);

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
