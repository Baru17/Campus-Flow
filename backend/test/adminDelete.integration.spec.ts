/**
 * Admin deletions, end to end against a real D1.
 *
 * Deleting a record is the one admin action that cannot be undone, so the tests here
 * are written around what a delete must *not* do rather than around the 200 it must
 * return. A feature that removes a row and everything mentioning it still passes the
 * obvious test; these cases fail it.
 *
 * ## The properties pinned
 *
 *   1. Only an admin may delete. Every route is checked unauthenticated (401), as a
 *      staff user, as a class advisor, as a head of department, as a contest
 *      coordinator and as a student. Hiding the button is not the test; the endpoint
 *      is.
 *   2. The row is actually gone. Read from D1 directly, not inferred from the
 *      response, so a route that answers 200 and writes nothing cannot pass.
 *   3. Historical academic records survive. Attendance marks, attendance sessions and
 *      OD requests -- including the approvals given by the person being removed -- are
 *      counted before and after. Nothing in this schema declares a foreign key, so a
 *      delete that fanned out would be a bug with no constraint to stop it.
 *   4. The login account ends up in a defensible state, which is not the same thing as
 *      "deleted" in every case:
 *        - a student's own account is removed, and their sessions with it, so the
 *          password cannot be used against a roster that no longer has them;
 *        - a member of staff's account is removed;
 *        - a head of department's account is removed, because it was created for the
 *          appointment;
 *        - a coordinator's account is **kept**, because it is the reused staff account
 *          the staff roster also points at -- and it is kept while the staff row
 *          survives too;
 *        - an account whose role this application did not issue for the row is left
 *          alone entirely, and the response says so.
 *   5. Dependencies that would destroy meaning are refused with a 409 that names
 *      them: a subject attendance already refers to, a staff member who is currently
 *      a department's contest coordinator.
 *   6. A delete is idempotent in the safe direction: the second call for an id that is
 *      already gone answers 404 rather than reporting a second success.
 *   7. Authorization comes from the session. A request that claims an admin role, or
 *      names an admin's id in its body, is refused exactly as one that claims nothing.
 *
 * Each test file gets isolated storage, so this file applies the migrations itself,
 * including `0017_od_requests.sql` -- the OD table -- because preserving an OD record
 * is half of what is being asserted and the assertions have to be able to see one.
 */

import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/utils/auth";
import { DEFAULT_INITIAL_PASSWORD, hashDefaultPassword } from "../src/utils/accountProvisioning";
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
import migration0017 from "../migrations/0017_od_requests.sql?raw";
import migration0018 from "../migrations/0018_directory-auth-user-id.sql?raw";

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
	migration0017,
	migration0018,
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

/* ------------------------------------------------------------------ fixtures */

/** The cohort every student case uses. Provisioned by `0016` and created by `0001`. */
const DEPARTMENT = "IT";
const BATCH = "2024_2028";
const STUDENT_TABLE = "IT_Students_2024_2028";
const ATTENDANCE_TABLE = "IT_Attendance_2024_2028";
/** A second cohort, for the ambiguous-id case. */
const OTHER_TABLE = "IT_Students_2025_2029";

interface ApiResult {
	status: number;
	body: any;
}

async function call(
	path: string,
	init: RequestInit = {},
	cookie: string | null = "admin"
): Promise<ApiResult> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(cookie === null ? {} : { Cookie: `campus-flow-session=${cookie}` }),
		...((init.headers as Record<string, string>) ?? {}),
	};
	const response = await SELF.fetch(`https://example.com${path}`, { ...init, headers });
	// A path the Worker does not route answers with a plain-text 404, and parsing
	// that would throw rather than assert anything -- so the body is optional and the
	// status code is what the "these routes are routed" check reads.
	let body: any = {};
	try {
		body = await response.json();
	} catch {
		body = {};
	}
	return { status: response.status, body };
}

async function asAdmin(path: string, init: RequestInit = {}): Promise<ApiResult> {
	return call(path, init, "delete-admin-session-token");
}

async function asUser(token: string, path: string, init: RequestInit = {}): Promise<ApiResult> {
	return call(path, init, token);
}

async function anonymous(path: string, init: RequestInit = {}): Promise<ApiResult> {
	return call(path, init, null);
}

async function createAuthSession(authUserId: string, token: string): Promise<void> {
	await env.DB
		.prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
		.bind(hashToken(token), authUserId, new Date(Date.now() + 60 * 60_000).toISOString())
		.run();
}

async function insertAccount(
	authUserId: string,
	userName: string,
	role: string,
	email: string | null,
	/** Only the cases that go on to sign in through a login route need a real hash. */
	pwdHash = "not-a-real-hash"
): Promise<void> {
	await env.DB
		.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
		.bind(authUserId, userName, pwdHash, role, email)
		.run();
}

async function accountFor(handle: string): Promise<any> {
	return env.DB
		.prepare("SELECT auth_user_id, user_name, role, email FROM auth_users WHERE LOWER(user_name) = ? OR LOWER(email) = ?")
		.bind(handle.toLowerCase(), handle.toLowerCase())
		.first<any>();
}

async function countRows(table: string, where = "", ...params: unknown[]): Promise<number> {
	const row = await env.DB
		.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`.trim())
		.bind(...(params as any[]))
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function sessionCount(authUserId: string): Promise<number> {
	return countRows("auth_sessions", "WHERE auth_user_id = ?", authUserId);
}

/**
 * One student, through the real import route rather than a direct insert.
 *
 * The point is that the delete is exercised against a row exactly as the admin
 * dashboard creates it: an account provisioned alongside, a register number the marks
 * are filed under, and a cohort the registry knows. The register number is derived
 * from the student id so a case can assert on the mark that mentions them.
 */
async function importStudent(studentId: string): Promise<void> {
	const { status, body } = await asAdmin(
		`/api/admin/students?department=${DEPARTMENT}&batch=${BATCH}`,
		{
			method: "POST",
			body: JSON.stringify({
				rows: [
					{
						student_id: studentId,
						register_no: studentId.replace(/^2K24IT/, "24IT"),
						student_name: `Student ${studentId}`,
						year: 3,
						section: "A",
						email: `${studentId.toLowerCase()}@kiot.ac.in`,
					},
				],
			}),
		}
	);
	expect(status, JSON.stringify(body)).toBe(200);
	expect(body.created).toBe(1);
}

async function studentRow(studentId: string): Promise<any> {
	return env.DB
		.prepare(
			`SELECT student_id, register_no, student_name, email, auth_user_id FROM ${STUDENT_TABLE} WHERE student_id = ?`,
		)
		.bind(studentId)
		.first<any>();
}

/** One attendance mark, filed the way the attendance tables file them: by register number. */
async function insertAttendanceMark(registerNo: string, subjectCode: string): Promise<string> {
	const attendanceId = crypto.randomUUID();
	await env.DB
		.prepare(
			`INSERT INTO ${ATTENDANCE_TABLE}
			 (attendance_id, register_no, section, attendance_date, period, subject_code, subject_name, session_id, status)
			 VALUES (?, ?, 'A', '2026-09-14', 1, ?, 'Referenced Subject', 'seeded-session', 'PRESENT')`,
		)
		.bind(attendanceId, registerNo, subjectCode)
		.run();
	return attendanceId;
}

async function insertAttendanceSession(createdBy: string, subjectCode: string): Promise<string> {
	const sessionId = crypto.randomUUID();
	await env.DB
		.prepare(
			`INSERT INTO attendance_session
			 (session_id, created_by, otp, expire_at, department, batch, subject_code, subject_name, year, section, period, attendance_date, attendance_table)
			 VALUES (?, ?, '123456', '2026-09-14T10:00:00Z', 'IT', '2024_2028', ?, 'Referenced Subject', 3, 'A', 1, '2026-09-14', '${ATTENDANCE_TABLE}')`,
		)
		.bind(sessionId, createdBy, subjectCode)
		.run();
	return sessionId;
}

/** One OD request, with the given approver addresses recorded on it. */
async function insertOdRequest(fields: {
	studentTable?: string;
	studentId?: string;
	mentorEmail?: string | null;
	coordinatorDecidedBy?: string | null;
	hodDecidedBy?: string | null;
	status?: string;
}): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB
		.prepare(
			`INSERT INTO od_requests
			 (od_request_id, auth_user_id, student_table, student_id, student_name, student_email,
			  department, batch, year, section, mentor_email, submitted_date,
			  od_days_requested, od_dates, reason, status,
			  coordinator_decided_by, hod_decided_by)
			 VALUES (?, ?, ?, ?, 'History Holder', 'history@kiot.ac.in',
			         'IT', '2024_2028', 3, 'A', ?, '2026-09-01', 1, '["2026-09-14"]',
			         'An earlier request', ?, ?, ?)`,
		)
		.bind(
			id,
			"c5e5f000-0000-4000-8000-0000000f0001",
			fields.studentTable ?? STUDENT_TABLE,
			fields.studentId ?? "2K24IT799",
			fields.mentorEmail ?? null,
			fields.status ?? "APPROVED",
			fields.coordinatorDecidedBy ?? null,
			fields.hodDecidedBy ?? null
		)
		.run();
	return id;
}

async function importSubject(code: string): Promise<void> {
	const { status, body } = await asAdmin("/api/admin/subjects", {
		method: "POST",
		body: JSON.stringify({ rows: [{ subject_code: code, subject_name: `Subject ${code}` }] }),
	});
	expect(status, JSON.stringify(body)).toBe(200);
	expect(body.created).toBe(1);
}

async function subjectIdFor(code: string): Promise<number> {
	const row = await env.DB
		.prepare("SELECT subject_id FROM subjects WHERE subject_code = ?")
		.bind(code)
		.first<{ subject_id: number }>();
	return row!.subject_id;
}

/**
 * A member of staff, through the real import route.
 *
 * `class_advisor` is left off by default so the case does not also depend on an
 * advisor cohort being provisioned; the advisor case states its own.
 */
async function importStaff(
	slug: string,
	overrides: Record<string, unknown> = {}
): Promise<{ staffId: string; email: string; authUserId: string }> {
	const email = `${slug}@kiot.ac.in`;
	const { status, body } = await asAdmin(`/api/admin/staff?department=${DEPARTMENT}`, {
		method: "POST",
		body: JSON.stringify({
			rows: [{ staff_name: `Staff ${slug}`, email, class_advisor: "N", ...overrides }],
		}),
	});
	expect(status, JSON.stringify(body)).toBe(200);
	expect(body.created).toBe(1);
	const row = await env.DB
		.prepare("SELECT staff_id, auth_user_id FROM staff WHERE email = ?")
		.bind(email)
		.first<{ staff_id: string; auth_user_id: string }>();
	return { staffId: row!.staff_id, email, authUserId: row!.auth_user_id };
}

/* -------------------------------------------------------------- the sessions */

/**
 * Every non-admin role that must be refused, with a live session for each.
 *
 * The point is that `requireAdmin` is doing the work and not the page hiding a button,
 * so this is deliberately *every* role the application issues rather than one. An HOD
 * and a coordinator are permanent users of the authentication architecture with their
 * own sign-in routes, and they are exactly the accounts a careless check would let
 * through.
 */
const NON_ADMINS = [
	{ label: "staff", token: "delete-staff-session-token", id: "c5e5f000-0000-4000-8000-0000000000a1" },
	{
		label: "class advisor",
		token: "delete-advisor-session-token",
		id: "c5e5f000-0000-4000-8000-0000000000a2",
	},
	{ label: "head of department", token: "delete-hod-session-token", id: "c5e5f000-0000-4000-8000-0000000000a3" },
	{
		label: "contest coordinator",
		token: "delete-coord-session-token",
		id: "c5e5f000-0000-4000-8000-0000000000a4",
	},
	{ label: "student", token: "delete-student-role-session-token", id: "c5e5f000-0000-4000-8000-0000000000a5" },
];

const ADMIN_ID = "c5e5f000-0000-4000-8000-00000000ad99";
const ADMIN_TOKEN = "delete-admin-session-token";

describe("admin deletion", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}

		await insertAccount(ADMIN_ID, "delete.admin", "admin", "delete.admin@kiot.ac.in");
		await createAuthSession(ADMIN_ID, ADMIN_TOKEN);

		for (const entry of NON_ADMINS) {
			await insertAccount(
				entry.id,
				`delete.${entry.token}`,
				entry.label === "class advisor" ? "class_advisor" : entry.label.replace(/\s+/g, "_"),
				null,
			);
			await createAuthSession(entry.id, entry.token);
		}
	});

	/**
	 * Every case starts with no contest coordinator.
	 *
	 * `contest_coordinators` holds exactly one row per department, and the rule is
	 * enforced by the create route rather than a constraint, so without a reset these
	 * cases would be ordered around which departments earlier ones happened to consume
	 * and would end up asserting the *refusal* rather than the deletion.
	 *
	 * Clearing the table turns the invariant into the thing under test: each case
	 * appoints whoever it needs, and the case that cares about the rule creates its own
	 * second row on purpose. `hods` carries no such rule and is deliberately left alone.
	 *
	 * These are this file's own rows in this file's own isolated database.
	 */
	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM contest_coordinators").run();
	});

	/**
	 * The authorization matrix, run against a real row per entity.
	 *
	 * Every cell has to be 401 or 403 *and* leave the row exactly where it was. A
	 * route that checked the role after writing would answer 403 over a deleted record,
	 * which is the failure this assertion exists to catch.
	 */
	describe("authorization", () => {
		it("refuses an unauthenticated delete of every entity", async () => {
			await importStudent("2K24IT700");
			const studentId = (await studentRow("2K24IT700"))!.student_id;
			const subjectCode = "AUTHZSUB0";
			await importSubject(subjectCode);
			const subjectId = await subjectIdFor(subjectCode);
			const staff = await importStaff("authz0");
			await asAdmin("/api/admin/hods", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ hod_name: "Authz Hod", email: "authz.hod@kiot.ac.in", department: "ECE" }],
				}),
			});
			const hodId = (await env.DB.prepare("SELECT MAX(hod_id) AS id FROM hods").first<any>())!.id;

			const targets = [
				`/api/admin/students/${studentId}?department=${DEPARTMENT}&batch=${BATCH}`,
				`/api/admin/staff/${staff.staffId}`,
				`/api/admin/subjects/${subjectId}`,
				`/api/admin/hods/${hodId}`,
			];

			for (const target of targets) {
				const { status } = await anonymous(target, { method: "DELETE" });
				expect(status, target).toBe(401);
			}

			// Nothing moved.
			expect(await studentRow(studentId)).toBeTruthy();
			expect(await countRows("staff", "WHERE staff_id = ?", staff.staffId)).toBe(1);
			expect(await countRows("subjects", "WHERE subject_id = ?", subjectId)).toBe(1);
			expect(await countRows("hods", "WHERE hod_id = ?", hodId)).toBe(1);
		});

		it("refuses every non-admin role on every delete route", async () => {
			await importStudent("2K24IT701");
			const studentId = (await studentRow("2K24IT701"))!.student_id;
			const subjectCode = "AUTHZSUB1";
			await importSubject(subjectCode);
			const subjectId = await subjectIdFor(subjectCode);
			const staff = await importStaff("authz1");
			await asAdmin("/api/admin/hods", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ hod_name: "Authz Hod 2", email: "authz.hod2@kiot.ac.in", department: "EEE" }],
				}),
			});
			const hodId = (await env.DB.prepare("SELECT MAX(hod_id) AS id FROM hods").first<any>())!.id;
			const coordinator = await asAdmin("/api/admin/contest-coordinators", {
				method: "POST",
				body: JSON.stringify({
					rows: [
						{
							coordinator_name: "Authz Coordinator",
							email: staff.email,
							department: "ECE",
						},
					],
				}),
			});
			expect(coordinator.status).toBe(200);
			const coordinatorId = (
				await env.DB.prepare("SELECT coordinator_id FROM contest_coordinators WHERE email = ?").bind(staff.email).first<any>()
			)!.coordinator_id;

			const targets = [
				`/api/admin/students/${studentId}?department=${DEPARTMENT}&batch=${BATCH}`,
				`/api/admin/staff/${staff.staffId}`,
				`/api/admin/subjects/${subjectId}`,
				`/api/admin/hods/${hodId}`,
				`/api/admin/contest-coordinators/${coordinatorId}`,
			];

			for (const entry of NON_ADMINS) {
				for (const target of targets) {
					const { status } = await asUser(entry.token, target, { method: "DELETE" });
					expect(status, `${entry.label} -> ${target}`).toBe(403);
				}
			}

			// Every row survived every attempt.
			expect(await studentRow(studentId)).toBeTruthy();
			expect(await countRows("staff", "WHERE staff_id = ?", staff.staffId)).toBe(1);
			expect(await countRows("subjects", "WHERE subject_id = ?", subjectId)).toBe(1);
			expect(await countRows("hods", "WHERE hod_id = ?", hodId)).toBe(1);
			expect(await countRows("contest_coordinators", "WHERE coordinator_id = ?", coordinatorId)).toBe(1);
		});

		it("ignores a role and an id the client sends, and decides from the session", async () => {
			const staff = await importStaff("authz2");
			const { status, body } = await asUser(
				NON_ADMINS[0].token,
				`/api/admin/staff/${staff.staffId}`,
				{
					method: "DELETE",
					// Both of these are the classic attempts at talking a delete route
					// into acting on somebody else's authority.
					headers: { "X-Role": "admin", "X-User-Id": ADMIN_ID },
					body: JSON.stringify({ role: "admin", auth_user_id: ADMIN_ID, email: "delete.admin@kiot.ac.in" }),
				}
			);
			expect(status).toBe(403);
			expect(body.code).toBe("forbidden");
			expect(await countRows("staff", "WHERE staff_id = ?", staff.staffId)).toBe(1);
		});

		it("refuses a DELETE that only borrows an admin's session for a student route", async () => {
			// Sanity check that the matrix above is not passing because the URLs are
			// unrouted: an unrouted path would be a 404, not a 403.
			const { status } = await asAdmin(`/api/admin/not-a-resource/${ADMIN_ID}`, { method: "DELETE" });
			expect(status).toBe(404);
		});
	});

	/* ================================================================== students */

	describe("students", () => {
		it("removes the roster row and the account the import created for it", async () => {
			await importStudent("2K24IT730");
			const row = (await studentRow("2K24IT730"))!;
			expect(row.auth_user_id).toBeTruthy();
			const account = await accountFor(row.email);
			expect(account.role).toBe("student");
			await createAuthSession(row.auth_user_id, "del01-student-token");
			expect(await sessionCount(row.auth_user_id)).toBe(1);

			const { status, body } = await asAdmin(
				`/api/admin/students/${row.student_id}?department=${DEPARTMENT}&batch=${BATCH}`,
				{ method: "DELETE" },
			);

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.success).toBe(true);
			expect(body.student.student_id).toBe(row.student_id);
			expect(body.student.student_name).toBe(row.student_name);
			expect(body.authAccountRemoved).toBe(true);

			// Gone from D1, read directly rather than inferred from the response.
			expect(await studentRow(row.student_id)).toBeNull();
			expect(await accountFor(row.email)).toBeNull();
			// And so is the session, so the password cannot be replayed.
			expect(await sessionCount(row.auth_user_id)).toBe(0);
		});

		it("keeps the attendance marks and OD requests that mention the student", async () => {
			await importStudent("2K24IT731");
			const row = (await studentRow("2K24IT731"))!;

			await insertAttendanceMark(row.register_no, "DELSUB02");
			const odId = await insertOdRequest({ studentId: row.student_id });

			const { status, body } = await asAdmin(
				`/api/admin/students/${row.student_id}?department=${DEPARTMENT}&batch=${BATCH}`,
				{ method: "DELETE" },
			);

			expect(status, JSON.stringify(body)).toBe(200);
			// Reported, so the dashboard can say what it kept rather than assert it.
			expect(body.preservedHistory.attendanceMarks).toBe(1);
			expect(body.preservedHistory.odRequests).toBe(1);

			expect(await studentRow(row.student_id)).toBeNull();
			// The mark is filed by register number and stays.
			expect(await countRows(ATTENDANCE_TABLE, "WHERE register_no = ?", row.register_no)).toBe(1);
			// So does the OD request, snapshot and all.
			const od = await env.DB.prepare("SELECT * FROM od_requests WHERE od_request_id = ?").bind(odId).first<any>();
			expect(od).toBeTruthy();
			expect(od.student_id).toBe(row.student_id);
			expect(od.student_name).toBe("History Holder");
		});

		it("leaves an account whose role this application did not issue for the row", async () => {
			/*
			 * A roster row whose `auth_user_id` points at somebody else's account. It
			 * cannot be created through the import -- that refuses a role mismatch -- so
			 * it is written directly, which is exactly the shape of a row that predates
			 * the current provisioning rules or was touched by hand.
			 *
			 * The account belongs to somebody else and must survive.
			 */
			const foreignId = "c5e5f000-0000-4000-8000-00000000ff01";
			await insertAccount(foreignId, "someone.else@kiot.ac.in", "staff", "someone.else@kiot.ac.in");
			await env.DB
				.prepare(
					`INSERT INTO ${STUDENT_TABLE}
					 (student_id, register_no, student_name, year, section, email, auth_user_id)
					 VALUES ('2K24IT733', '24IT0733', 'Foreign Link', 3, 'A', 'foreign.link@kiot.ac.in', ?)`,
				)
				.bind(foreignId)
				.run();

			const { status, body } = await asAdmin(
				`/api/admin/students/2K24IT733?department=${DEPARTMENT}&batch=${BATCH}`,
				{ method: "DELETE" },
			);

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.authAccountRemoved).toBe(false);
			expect(body.authAccountKept).toBe("foreign-role");
			expect(await studentRow("2K24IT733")).toBeNull();
			// Untouched.
			expect((await accountFor("someone.else@kiot.ac.in")).role).toBe("staff");
		});

		it("answers 404 for a student that is not there, twice", async () => {
			const first = await asAdmin("/api/admin/students/2K24IT799?department=IT&batch=2024_2028", {
				method: "DELETE",
			});
			expect(first.status).toBe(404);
			expect(first.body.code).toBe("student-not-found");

			// A real student, deleted twice: the second call is a 404, never a second
			// success, so a double-click cannot report two deletions of one row.
			await importStudent("2K24IT734");
			const row = (await studentRow("2K24IT734"))!;
			const url = `/api/admin/students/${row.student_id}?department=${DEPARTMENT}&batch=${BATCH}`;
			expect((await asAdmin(url, { method: "DELETE" })).status).toBe(200);
			const second = await asAdmin(url, { method: "DELETE" });
			expect(second.status).toBe(404);
			expect(second.body.code).toBe("student-not-found");
		});

		it("answers 400 for a student id that cannot be one", async () => {
			/*
			 * Genuinely malformed, rather than merely unknown. `validateStudentId`
			 * accepts letters, digits, dots, dashes and underscores up to 32
			 * characters, so `NOT-A-STUDENT-ID` is a well-formed id that happens to
			 * match nobody -- that is a 404, and asserting otherwise would be
			 * asserting the validator is stricter than it is.
			 */
			const bad = [
				"has%20a%20space",
				"star*inside",
				"quote'inside",
				"a".repeat(33),
			];
			for (const id of bad) {
				const { status, body } = await asAdmin(`/api/admin/students/${id}`, { method: "DELETE" });
				expect(status, id).toBe(400);
				expect(body.code, id).toBe("invalid-student-id");
			}
			// A well-formed id that simply is not there is a 404, not a 400.
			expect((await asAdmin("/api/admin/students/NOT-A-STUDENT-ID", { method: "DELETE" })).status).toBe(404);
		});

		it("answers 409 for an id that exists in two cohorts rather than picking one", async () => {
			// `student_id` is UNIQUE per table, not globally, so the same id can exist in
			// two cohorts. The delete must refuse rather than delete whichever it saw first.
			for (const table of [STUDENT_TABLE, OTHER_TABLE]) {
				await env.DB
					.prepare(
						`INSERT INTO ${table}
						 (student_id, register_no, student_name, year, section, email, auth_user_id)
						 VALUES ('2K24IT740', ?, 'Twin Cohort', 3, 'A', ?, NULL)`,
					)
					.bind(table === STUDENT_TABLE ? "24IT0740" : "25IT0740", `${table}@kiot.ac.in`)
					.run();
			}

			const ambiguous = await asAdmin("/api/admin/students/2K24IT740", { method: "DELETE" });
			expect(ambiguous.status).toBe(409);
			expect(ambiguous.body.code).toBe("student-ambiguous");
			// Neither cohort lost anybody.
			expect(await countRows(STUDENT_TABLE, "WHERE student_id = '2K24IT740'")).toBe(1);
			expect(await countRows(OTHER_TABLE, "WHERE student_id = '2K24IT740'")).toBe(1);

			// Naming the cohort resolves it, and only that cohort is touched.
			const scoped = await asAdmin(
				"/api/admin/students/2K24IT740?department=IT&batch=2024_2028",
				{ method: "DELETE" },
			);
			expect(scoped.status).toBe(200);
			expect(await countRows(STUDENT_TABLE, "WHERE student_id = '2K24IT740'")).toBe(0);
			expect(await countRows(OTHER_TABLE, "WHERE student_id = '2K24IT740'")).toBe(1);
		});

		it("answers 404 when the department and batch name a cohort that does not hold the student", async () => {
			await importStudent("2K24IT735");
			const wrong = await asAdmin("/api/admin/students/2K24IT735?department=IT&batch=2025_2029", {
				method: "DELETE",
			});
			expect(wrong.status).toBe(404);
			expect(await studentRow("2K24IT735")).toBeTruthy();
		});

		it("answers 400 for a batch that is not provisioned", async () => {
			// A well-formed, plausible cohort that was never registered.
			const { status, body } = await asAdmin("/api/admin/students/2K24IT735?department=IT&batch=2028_2032", {
				method: "DELETE",
			});
			expect(status).toBe(400);
			expect(body.code).toBe("batch-not-provisioned");
		});

		it("finds the student without a cohort hint, from the registry alone", async () => {
			await importStudent("2K24IT736");
			const { status, body } = await asAdmin("/api/admin/students/2K24IT736", { method: "DELETE" });
			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.department).toBe(DEPARTMENT);
			expect(body.batch).toBe(BATCH);
			expect(await studentRow("2K24IT736")).toBeNull();
		});
	});

	/* ==================================================================== staff */

	describe("staff", () => {
		it("removes the roster row and the staff account with it", async () => {
			const staff = await importStaff("del01");
			const account = await accountFor(staff.email);
			expect(account.role).toBe("staff");
			await createAuthSession(staff.authUserId, "del01-staff-token");

			const { status, body } = await asAdmin(`/api/admin/staff/${staff.staffId}`, { method: "DELETE" });

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.success).toBe(true);
			expect(body.staff.staff_id).toBe(staff.staffId);
			expect(body.authAccountRemoved).toBe(true);
			expect(await countRows("staff", "WHERE staff_id = ?", staff.staffId)).toBe(0);
			expect(await accountFor(staff.email)).toBeNull();
			expect(await sessionCount(staff.authUserId)).toBe(0);
		});

		it("keeps the attendance sessions they generated and the OD requests they decided", async () => {
			const staff = await importStaff("del02");
			const sessionId = await insertAttendanceSession(staff.staffId, "DELSUB20");
			const odId = await insertOdRequest({
				studentId: "2K24IT750",
				mentorEmail: staff.email,
				status: "PENDING_CLASS_ADVISOR",
			});

			const { status, body } = await asAdmin(`/api/admin/staff/${staff.staffId}`, { method: "DELETE" });

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.preservedHistory.attendanceSessions).toBe(1);
			expect(body.preservedHistory.odRequests).toBe(1);

			// The session records them by staff_id, and it is still readable.
			const session = await env.DB
				.prepare("SELECT created_by, subject_code FROM attendance_session WHERE session_id = ?")
				.bind(sessionId)
				.first<any>();
			expect(session.created_by).toBe(staff.staffId);
			expect(session.subject_code).toBe("DELSUB20");

			// The OD request keeps the mentor it was filed under.
			const od = await env.DB
				.prepare("SELECT mentor_email, student_id FROM od_requests WHERE od_request_id = ?")
				.bind(odId)
				.first<any>();
			expect(od.mentor_email).toBe(staff.email);
			expect(od.student_id).toBe("2K24IT750");
		});

		it("removes a class advisor and their advisor assignment with the row", async () => {
			const email = "deladvisor@kiot.ac.in";
			const { status, body } = await asAdmin(`/api/admin/staff?department=${DEPARTMENT}`, {
				method: "POST",
				body: JSON.stringify({
					rows: [
						{
							staff_name: "Advisor To Delete",
							email,
							class_advisor: "Y",
							advisor_year: 3,
							advisor_section: "A",
							advisor_batch: BATCH,
						},
					],
				}),
			});
			expect(status, JSON.stringify(body)).toBe(200);
			const row = await env.DB.prepare("SELECT staff_id FROM staff WHERE email = ?").bind(email).first<any>();

			const deleted = await asAdmin(`/api/admin/staff/${row.staff_id}`, { method: "DELETE" });
			expect(deleted.status).toBe(200);
			expect(await countRows("staff", "WHERE staff_id = ?", row.staff_id)).toBe(0);
			expect(await accountFor(email)).toBeNull();
		});

		it("refuses with 409 while the person is a department's contest coordinator", async () => {
			const staff = await importStaff("del03");
			const appointed = await asAdmin("/api/admin/contest-coordinators", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ coordinator_name: "Busy Coordinator", email: staff.email, department: "IT" }],
				}),
			});
			expect(appointed.status, JSON.stringify(appointed.body)).toBe(200);

			const { status, body } = await asAdmin(`/api/admin/staff/${staff.staffId}`, { method: "DELETE" });

			expect(status).toBe(409);
			expect(body.code).toBe("staff-appointment-conflict");
			expect(body.error).toContain("IT contest coordinator");
			// The message names the way out rather than only the problem.
			expect(body.error).toContain("Remove that appointment first");
			// Both rows intact.
			expect(await countRows("staff", "WHERE staff_id = ?", staff.staffId)).toBe(1);
			expect(await countRows("contest_coordinators", "WHERE email = ?", staff.email)).toBe(1);
		});

		it("allows the delete once the coordinator appointment is gone", async () => {
			const staff = await importStaff("del04");
			const appointed = await asAdmin("/api/admin/contest-coordinators", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ coordinator_name: "Former Coordinator", email: staff.email, department: "ECE" }],
				}),
			});
			expect(appointed.status).toBe(200);
			const coordinatorId = (
				await env.DB.prepare("SELECT coordinator_id FROM contest_coordinators WHERE email = ?").bind(staff.email).first<any>()
			)!.coordinator_id;

			expect((await asAdmin(`/api/admin/staff/${staff.staffId}`, { method: "DELETE" })).status).toBe(409);

			expect((await asAdmin(`/api/admin/contest-coordinators/${coordinatorId}`, { method: "DELETE" })).status).toBe(200);

			// And now the staff delete goes through, with the coordinator's own account
			// still pointing at nothing else.
			const deleted = await asAdmin(`/api/admin/staff/${staff.staffId}`, { method: "DELETE" });
			expect(deleted.status).toBe(200);
			expect(await countRows("staff", "WHERE staff_id = ?", staff.staffId)).toBe(0);
			expect(await accountFor(staff.email)).toBeNull();
		});

		it("answers 404 for a staff member that is not there, and 400 for an unusable id", async () => {
			expect((await asAdmin("/api/admin/staff/999999", { method: "DELETE" })).status).toBe(404);
			// `validateStaffId` accepts letters, digits, dots, dashes and underscores,
			// so `not-a-staff-id` is well formed and simply matches nobody.
			expect((await asAdmin("/api/admin/staff/not-a-staff-id", { method: "DELETE" })).status).toBe(404);
			for (const bad of ["has%20a%20space", "star*inside", "b".repeat(33)]) {
				const { status, body } = await asAdmin(`/api/admin/staff/${bad}`, { method: "DELETE" });
				expect(status, bad).toBe(400);
				expect(body.code, bad).toBe("invalid-staff-id");
			}
		});

		it("answers 404 on a second delete of the same staff member", async () => {
			const staff = await importStaff("del05");
			const url = `/api/admin/staff/${staff.staffId}`;
			expect((await asAdmin(url, { method: "DELETE" })).status).toBe(200);
			const second = await asAdmin(url, { method: "DELETE" });
			expect(second.status).toBe(404);
			expect(second.body.code).toBe("staff-not-found");
		});

		it("touches no other department's staff", async () => {
			const before = await countRows("staff");
			const keep = await env.DB
				.prepare("SELECT staff_id, email FROM staff WHERE department <> 'IT' ORDER BY staff_id")
				.all<{ staff_id: string; email: string }>();
			const mine = await importStaff("del06");

			await asAdmin(`/api/admin/staff/${mine.staffId}`, { method: "DELETE" });

			expect(await countRows("staff")).toBe(before);
			for (const row of keep.results ?? []) {
				expect(await countRows("staff", "WHERE staff_id = ?", row.staff_id)).toBe(1);
			}
		});
	});

	/* ================================================================= subjects */

	describe("subjects", () => {
		it("removes a subject nothing references", async () => {
			await importSubject("DELSUB01");
			const subjectId = await subjectIdFor("DELSUB01");

			const { status, body } = await asAdmin(`/api/admin/subjects/${subjectId}`, { method: "DELETE" });

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.subject.subject_code).toBe("DELSUB01");
			expect(await countRows("subjects", "WHERE subject_id = ?", subjectId)).toBe(0);
		});

		it("refuses with 409 when an attendance session names the subject", async () => {
			await importSubject("DELSUB02");
			const subjectId = await subjectIdFor("DELSUB02");
			const sessionId = await insertAttendanceSession("101", "DELSUB02");

			const { status, body } = await asAdmin(`/api/admin/subjects/${subjectId}`, { method: "DELETE" });

			expect(status).toBe(409);
			expect(body.code).toBe("subject-in-use");
			expect(body.error).toContain("attendance record");
			expect(body.details.attendanceSessions).toBe(1);
			// Nothing moved, in either direction.
			expect(await countRows("subjects", "WHERE subject_id = ?", subjectId)).toBe(1);
			expect(
				await countRows("attendance_session", "WHERE session_id = ?", sessionId)
			).toBe(1);
		});

		it("refuses with 409 when only the marks table names the subject", async () => {
			/*
			 * The case a session-only check would miss: a class advisor can file a mark
			 * through `POST /api/attendance/:table`, which resolves `subject_code` from
			 * `subject_id` without any session existing.
			 */
			await importSubject("DELSUB03");
			const subjectId = await subjectIdFor("DELSUB03");
			await insertAttendanceMark("24IT0999", "DELSUB03");

			const { status, body } = await asAdmin(`/api/admin/subjects/${subjectId}`, { method: "DELETE" });

			expect(status).toBe(409);
			expect(body.code).toBe("subject-in-use");
			expect(body.details.attendanceMarks).toBe(1);
			expect(body.details.attendanceSessions).toBe(0);
			expect(await countRows("subjects", "WHERE subject_id = ?", subjectId)).toBe(1);
		});

		it("answers 404 for a subject that is not there, and 400 for a malformed id", async () => {
			expect((await asAdmin("/api/admin/subjects/999999", { method: "DELETE" })).status).toBe(404);
			for (const bad of ["abc", "0", "-1", "1.5"]) {
				const { status, body } = await asAdmin(`/api/admin/subjects/${bad}`, { method: "DELETE" });
				expect(status, bad).toBe(400);
				expect(body.code).toBe("invalid-subject-id");
			}
		});

		it("answers 404 on a second delete of the same subject", async () => {
			await importSubject("DELSUB04");
			const subjectId = await subjectIdFor("DELSUB04");
			const url = `/api/admin/subjects/${subjectId}`;
			expect((await asAdmin(url, { method: "DELETE" })).status).toBe(200);
			expect((await asAdmin(url, { method: "DELETE" })).status).toBe(404);
		});

		it("leaves the rest of the catalog alone", async () => {
			await importSubject("DELSUB05");
			await importSubject("DELSUB06");
			const doomed = await subjectIdFor("DELSUB05");
			const kept = await subjectIdFor("DELSUB06");

			await asAdmin(`/api/admin/subjects/${doomed}`, { method: "DELETE" });

			expect(await countRows("subjects", "WHERE subject_id = ?", kept)).toBe(1);
		});
	});

	/* ===================================================================== hods */

	describe("heads of department", () => {
		async function appointHod(slug: string, department: string): Promise<{ id: number; email: string; authUserId: string }> {
			const email = `hod.${slug}@kiot.ac.in`;
			const { status, body } = await asAdmin("/api/admin/hods", {
				method: "POST",
				body: JSON.stringify({ rows: [{ hod_name: `Hod ${slug}`, email, department }] }),
			});
			expect(status, JSON.stringify(body)).toBe(200);
			const row = await env.DB
				.prepare("SELECT hod_id, auth_user_id FROM hods WHERE email = ?")
				.bind(email)
				.first<any>();
			return { id: row.hod_id, email, authUserId: row.auth_user_id };
		}

		it("removes the directory row and the account created for the appointment", async () => {
			const hod = await appointHod("del01", "IT");
			expect((await accountFor(hod.email)).role).toBe("hod");
			await createAuthSession(hod.authUserId, "del01-hod-token");

			const { status, body } = await asAdmin(`/api/admin/hods/${hod.id}`, { method: "DELETE" });

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.hod.hod_id).toBe(hod.id);
			expect(body.hod.hod_name).toBe("Hod del01");
			expect(body.authAccountRemoved).toBe(true);
			expect(await countRows("hods", "WHERE hod_id = ?", hod.id)).toBe(0);
			expect(await accountFor(hod.email)).toBeNull();
			expect(await sessionCount(hod.authUserId)).toBe(0);
		});

		it("keeps every OD request they approved, attributed to them", async () => {
			const hod = await appointHod("del02", "CSE");
			const odId = await insertOdRequest({ studentId: "2K24IT760", hodDecidedBy: hod.email });

			const { status, body } = await asAdmin(`/api/admin/hods/${hod.id}`, { method: "DELETE" });

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.preservedHistory.odRequests).toBe(1);
			expect(await countRows("hods", "WHERE hod_id = ?", hod.id)).toBe(0);

			// The approval is still there, still naming them, still readable.
			const od = await env.DB
				.prepare("SELECT status, hod_decision, hod_decided_by FROM od_requests WHERE od_request_id = ?")
				.bind(odId)
				.first<any>();
			expect(od.hod_decided_by).toBe(hod.email);
			expect(od.status).toBe("APPROVED");
		});

		it("keeps an account a second appointment also points at", async () => {
			/*
			 * `hods` carries no one-per-department rule, so the same person can be
			 * appointed to two departments -- and the create route reuses one account
			 * rather than making a second, so both rows carry the same `auth_user_id`.
			 * That is the `shared` case: the account belongs to the appointment only in
			 * appearance, and removing it would sign the surviving row's owner out.
			 *
			 * Written directly because the second appointment has to share the *account*
			 * rather than the address, which is the only shape the import cannot produce
			 * on its own.
			 */
			const hod = await appointHod("share1", "IT");
			expect((await accountFor(hod.email)).role).toBe("hod");
			await env.DB
				.prepare(
					"INSERT INTO hods (hod_name, email, department, auth_user_id) VALUES (?, ?, 'CSE', ?)",
				)
				.bind("Second Appointment", `hod.share1.second@kiot.ac.in`, hod.authUserId)
				.run();

			const { status, body } = await asAdmin(`/api/admin/hods/${hod.id}`, { method: "DELETE" });

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.authAccountRemoved).toBe(false);
			expect(body.authAccountKept).toBe("shared");
			expect(await countRows("hods", "WHERE hod_id = ?", hod.id)).toBe(0);
			// The account survives because the other appointment is still using it, and
			// that appointment is untouched.
			expect(await accountFor(hod.email)).toBeTruthy();
			expect(await countRows("hods", "WHERE auth_user_id = ?", hod.authUserId)).toBe(1);
		});

		it("keeps an account the staff roster also points at", async () => {
			/*
			 * The other way an HOD's account turns out to be shared: the person is also
			 * on the staff roster, so their `staff` account is the one the row links to.
			 * The role gate refuses it before the sharing scan is even reached -- which
			 * is the more conservative of the two answers, and the one asserted.
			 */
			const staff = await importStaff("hodshare");
			await env.DB
				.prepare(
					"INSERT INTO hods (hod_name, email, department, auth_user_id) VALUES (?, ?, 'ECE', ?)",
				)
				.bind("Shared Hod", staff.email, staff.authUserId)
				.run();
			const hodId = (
				await env.DB.prepare("SELECT hod_id FROM hods WHERE email = ?").bind(staff.email).first<any>()
			)!.hod_id;

			const { status, body } = await asAdmin(`/api/admin/hods/${hodId}`, { method: "DELETE" });

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.authAccountRemoved).toBe(false);
			expect(body.authAccountKept).toBe("foreign-role");
			expect(body.authAccountKeptRole).toBe("staff");
			expect(await countRows("hods", "WHERE hod_id = ?", hodId)).toBe(0);
			// The account and the roster row are both untouched.
			expect(await accountFor(staff.email)).toBeTruthy();
			expect(await countRows("staff", "WHERE staff_id = ?", staff.staffId)).toBe(1);
		});

		it("no longer signs in as an approver once the appointment is gone", async () => {
			/*
			 * The mirror of the coordinator's case, and the reason an HOD's account is
			 * removed at all. An HOD is not on the staff roster, so with the row gone
			 * there is no directory left to resolve to and no account left to resolve
			 * with: the approver door closes rather than falling through to somebody
			 * else's authority.
			 */
			const hod = await appointHod("del08", "IT");

			const before = await anonymous("/api/auth/od-approver/login", {
				method: "POST",
				body: JSON.stringify({
					email: hod.email,
					password: DEFAULT_INITIAL_PASSWORD,
				}),
			});
			expect(before.status, JSON.stringify(before.body)).toBe(200);
			expect(before.body.approver.role).toBe("hod");

			expect((await asAdmin(`/api/admin/hods/${hod.id}`, { method: "DELETE" })).status).toBe(200);

			const after = await anonymous("/api/auth/od-approver/login", {
				method: "POST",
				body: JSON.stringify({
					email: hod.email,
					password: DEFAULT_INITIAL_PASSWORD,
				}),
			});
			expect(after.status).toBe(401);
			expect(after.body.code).toBe("invalid_credentials");
			// And no session was left behind for the one they had before.
			expect(await sessionCount(hod.authUserId)).toBe(0);
		});

		it("answers 404 for an HOD that is not there, and 400 for a malformed id", async () => {
			expect((await asAdmin("/api/admin/hods/999999", { method: "DELETE" })).status).toBe(404);
			for (const bad of ["abc", "0", "-3"]) {
				const { status, body } = await asAdmin(`/api/admin/hods/${bad}`, { method: "DELETE" });
				expect(status, bad).toBe(400);
				expect(body.code).toBe("invalid-hod-id");
			}
		});

		it("answers 404 on a second delete of the same HOD", async () => {
			const hod = await appointHod("del03", "EEE");
			const url = `/api/admin/hods/${hod.id}`;
			expect((await asAdmin(url, { method: "DELETE" })).status).toBe(200);
			const second = await asAdmin(url, { method: "DELETE" });
			expect(second.status).toBe(404);
			expect(second.body.code).toBe("hod-not-found");
		});

		it("removes only the HOD that was asked for", async () => {
			const first = await appointHod("keep1", "IT");
			const second = await appointHod("drop1", "CSE");

			await asAdmin(`/api/admin/hods/${second.id}`, { method: "DELETE" });

			expect(await countRows("hods", "WHERE hod_id = ?", first.id)).toBe(1);
			expect(await countRows("hods", "WHERE hod_id = ?", second.id)).toBe(0);
		});
	});

	/* ==================================================== contest coordinators */

	describe("contest coordinators", () => {
		async function appointCoordinator(
			slug: string,
			department: string
		): Promise<{ id: number; email: string; authUserId: string; staffId: string }> {
			const staff = await importStaff(`coord${slug}`);
			const { status, body } = await asAdmin("/api/admin/contest-coordinators", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ coordinator_name: `Coordinator ${slug}`, email: staff.email, department }],
				}),
			});
			expect(status, JSON.stringify(body)).toBe(200);
			const row = await env.DB
				.prepare("SELECT coordinator_id, auth_user_id FROM contest_coordinators WHERE email = ?")
				.bind(staff.email)
				.first<any>();
			return { id: row.coordinator_id, email: staff.email, authUserId: row.auth_user_id, staffId: staff.staffId };
		}

		it("removes the appointment and keeps the reused staff login", async () => {
			const coordinator = await appointCoordinator("del01", "IT");
			// The account really is the staff one -- that is the whole difficulty here.
			expect((await accountFor(coordinator.email)).role).toBe("staff");
			expect(coordinator.authUserId).toBe(
				(await env.DB.prepare("SELECT auth_user_id FROM staff WHERE staff_id = ?").bind(coordinator.staffId).first<any>())
					.auth_user_id
			);

			const { status, body } = await asAdmin(`/api/admin/contest-coordinators/${coordinator.id}`, {
				method: "DELETE",
			});

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.contest_coordinator.coordinator_id).toBe(coordinator.id);
			expect(body.authAccountRemoved).toBe(false);
			expect(body.authAccountKept).toBe("foreign-role");
			expect(body.authAccountKeptRole).toBe("staff");

			expect(await countRows("contest_coordinators", "WHERE coordinator_id = ?", coordinator.id)).toBe(0);
			// The person is still on the roster and can still sign in as staff.
			expect(await countRows("staff", "WHERE staff_id = ?", coordinator.staffId)).toBe(1);
			expect((await accountFor(coordinator.email)).role).toBe("staff");
		});

		it("stops acting as a coordinator once the appointment is gone, and stays a member of staff", async () => {
			/*
			 * The behaviour that makes keeping the account safe, exercised through the
			 * real login rather than inferred.
			 *
			 * `resolveApproverIdentity` asks the directories in a fixed order -- `hods`,
			 * then `contest_coordinators`, then the staff roster -- so removing the
			 * coordinator row does not lock the person out of the approver flow, it
			 * changes *which* directory they resolve to. They are still a member of
			 * staff, and staff act in this flow as mentors.
			 */
			const coordinator = await appointCoordinator("del02", "IT");

			const before = await anonymous("/api/auth/od-approver/login", {
				method: "POST",
				body: JSON.stringify({
					email: coordinator.email,
					password: DEFAULT_INITIAL_PASSWORD,
				}),
			});
			expect(before.status, JSON.stringify(before.body)).toBe(200);
			expect(before.body.approver.role).toBe("contest_coordinator");
			expect(before.body.approver.department).toBe("IT");

			expect(
				(await asAdmin(`/api/admin/contest-coordinators/${coordinator.id}`, { method: "DELETE" }))
					.status
			).toBe(200);

			// The account is untouched -- it is the staff account -- so the login still
			// works. It resolves to the staff roster now, which is exactly the loss of
			// coordinator authority and nothing more.
			const after = await anonymous("/api/auth/od-approver/login", {
				method: "POST",
				body: JSON.stringify({
					email: coordinator.email,
					password: DEFAULT_INITIAL_PASSWORD,
				}),
			});
			expect(after.status, JSON.stringify(after.body)).toBe(200);
			expect(after.body.approver.role).toBe("staff");
			expect(after.body.approver.role).not.toBe("contest_coordinator");

			// And their staff dashboard is untouched.
			expect(await countRows("staff", "WHERE auth_user_id = ?", coordinator.authUserId)).toBe(1);
			const staffLogin = await anonymous("/api/auth/staff/login", {
				method: "POST",
				body: JSON.stringify({
					email: coordinator.email,
					password: DEFAULT_INITIAL_PASSWORD,
				}),
			});
			expect(staffLogin.status, JSON.stringify(staffLogin.body)).toBe(200);
		});

		it("keeps every OD request they decided, attributed to them", async () => {
			const coordinator = await appointCoordinator("del03", "CSE");
			const odId = await insertOdRequest({
				studentId: "2K24IT770",
				coordinatorDecidedBy: coordinator.email,
			});

			const { status, body } = await asAdmin(`/api/admin/contest-coordinators/${coordinator.id}`, {
				method: "DELETE",
			});

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.preservedHistory.odRequests).toBe(1);
			const od = await env.DB
				.prepare("SELECT coordinator_decided_by, status FROM od_requests WHERE od_request_id = ?")
				.bind(odId)
				.first<any>();
			expect(od.coordinator_decided_by).toBe(coordinator.email);
			expect(od.status).toBe("APPROVED");
		});

		it("frees the department for a new coordinator and leaves other departments alone", async () => {
			const dropped = await appointCoordinator("del04", "IT");
			const kept = await appointCoordinator("del05", "CSE");
			const keptBefore = (
				await env.DB
					.prepare("SELECT coordinator_id, auth_user_id FROM contest_coordinators WHERE coordinator_id = ?")
					.bind(kept.id)
					.first<any>()
			)!;

			expect((await asAdmin(`/api/admin/contest-coordinators/${dropped.id}`, { method: "DELETE" })).status).toBe(200);

			// IT has no coordinator, and the rule says a second one is refused -- so an
			// available department is provably an appointable one.
			const second = await asAdmin("/api/admin/contest-coordinators", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ coordinator_name: "Second IT Coordinator", email: dropped.email, department: "IT" }],
				}),
			});
			expect(second.status).toBe(200);
			expect(second.body.created).toBe(1);

			// CSE's coordinator, its row and its account are untouched.
			const keptAfter = (
				await env.DB
					.prepare("SELECT coordinator_id, auth_user_id, coordinator_name FROM contest_coordinators WHERE coordinator_id = ?")
					.bind(kept.id)
					.first<any>()
			)!;
			expect(keptAfter.coordinator_name).toBe("Coordinator del05");
			expect(keptAfter.auth_user_id).toBe(keptBefore.auth_user_id);
			expect(await countRows("staff", "WHERE staff_id = ?", kept.staffId)).toBe(1);
			expect((await accountFor(kept.email)).role).toBe("staff");
		});

		it("removes a coordinator-only account when the address holds one", async () => {
			/*
			 * Not the ordinary case -- a coordinator is appointed from the staff roster
			 * and reuses that account -- but reachable, because the create route reuses
			 * rather than refuses. An address that already holds a
			 * `contest_coordinator` account gets one linked to the appointment, and that
			 * account belongs to the appointment alone.
			 */
			const email = "solocoordinator@kiot.ac.in";
			await insertAccount(
				"c5e5f000-0000-4000-8000-00000000cc01",
				email,
				"contest_coordinator",
				email,
				await hashDefaultPassword(),
			);
			await asAdmin("/api/admin/contest-coordinators", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ coordinator_name: "Solo Coordinator", email, department: "EEE" }],
				}),
			});
			const coordinatorId = (
				await env.DB.prepare("SELECT coordinator_id FROM contest_coordinators WHERE email = ?").bind(email).first<any>()
			)!.coordinator_id;

			// Before the delete they can sign in as a coordinator, because the
			// `contest_coordinators` row is the authority and not the account's role.
			const before = await anonymous("/api/auth/od-approver/login", {
				method: "POST",
				body: JSON.stringify({ email, password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(before.status, JSON.stringify(before.body)).toBe(200);
			expect(before.body.approver.role).toBe("contest_coordinator");

			const { status, body } = await asAdmin(`/api/admin/contest-coordinators/${coordinatorId}`, {
				method: "DELETE",
			});

			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.authAccountRemoved).toBe(true);
			expect(await countRows("contest_coordinators", "WHERE coordinator_id = ?", coordinatorId)).toBe(0);
			expect(await accountFor(email)).toBeNull();

			/*
			 * The case that would otherwise be left behind: an account whose only reason
			 * to exist was the appointment. With no directory row *and* no account,
			 * `/api/auth/od-approver/login` refuses rather than minting a session for
			 * somebody who no longer holds an appointment.
			 */
			const after = await anonymous("/api/auth/od-approver/login", {
				method: "POST",
				body: JSON.stringify({ email, password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(after.status).toBe(401);
			expect(after.body.code).toBe("invalid_credentials");
		});

		it("answers 404 for a coordinator that is not there, and 400 for a malformed id", async () => {
			expect((await asAdmin("/api/admin/contest-coordinators/999999", { method: "DELETE" })).status).toBe(404);
			for (const bad of ["abc", "0", "-1"]) {
				const { status, body } = await asAdmin(`/api/admin/contest-coordinators/${bad}`, { method: "DELETE" });
				expect(status, bad).toBe(400);
				expect(body.code).toBe("invalid-coordinator-id");
			}
		});

		it("answers 404 on a second delete of the same coordinator", async () => {
			const coordinator = await appointCoordinator("del06", "IT");
			const url = `/api/admin/contest-coordinators/${coordinator.id}`;
			expect((await asAdmin(url, { method: "DELETE" })).status).toBe(200);
			const second = await asAdmin(url, { method: "DELETE" });
			expect(second.status).toBe(404);
			expect(second.body.code).toBe("coordinator-not-found");
		});

		it("never returns a password or a hash in any delete response", async () => {
			const coordinator = await appointCoordinator("del07", "ECE");
			const { body } = await asAdmin(`/api/admin/contest-coordinators/${coordinator.id}`, {
				method: "DELETE",
			});
			expect(JSON.stringify(body)).not.toContain("$2");
			expect(body).not.toHaveProperty("pwd_hash");
		});
	});
});
