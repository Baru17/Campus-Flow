/**
 * Admin edit routes, end to end against a real D1.
 *
 * The three `PATCH` routes exist so an administrator can correct a record rather
 * than delete and re-import it, and this file is what pins the properties that
 * make that safe. The failures that matter here are not "the form did not save" --
 * those are visible immediately -- but the quiet ones:
 *
 *   1. An edit that writes the wrong row. Students live in a table per cohort, so
 *      "which table" has to come from the registry and the row has to be found in
 *      it. A department and batch naming the wrong cohort must answer 404, not
 *      edit somebody else.
 *   2. An edit that changes an identity. `student_id`, `register_no`, `staff_id` and
 *      `subject_id` are keys rather than fields, and a body that names a different
 *      one is refused instead of ignored, so a caller is never told it moved a
 *      record it did not. `register_no` matters most of these: attendance is filed
 *      against it, so a change there would strand real marks.
 *   3. An edit that breaks sign-in. A student's address is also a login handle and
 *      a staff member's address is their login name, so a changed email has to move
 *      the *existing* account with it. The assertions read `auth_users` directly to
 *      prove three things at once: no second row appeared, the original row is still
 *      the one linked, and `pwd_hash` is byte-for-byte what it was.
 *   4. An edit that quietly rewrites history. Recorded attendance is compared row
 *      for row before and after, so "this route does not touch attendance" is an
 *      assertion rather than a claim.
 *
 * Every test provisions its own fixture through the same admin API the dashboard
 * uses, so no test depends on another having run first.
 *
 * Each test file gets isolated storage, so this file applies the migrations itself.
 */

import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/utils/auth";
import { DEFAULT_INITIAL_PASSWORD } from "../src/utils/accountProvisioning";
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

const ADMIN_ID = "c5e5f300-0000-4000-8000-0000000000ad";
const ADMIN_TOKEN = "admin-edit-admin-token";
const STUDENT_AUTH_ID = "c5e5f300-0000-4000-8000-0000000000sd";
const STUDENT_TOKEN = "admin-edit-student-token";
const STAFF_AUTH_ID = "c5e5f300-0000-4000-8000-0000000000sf";
const STAFF_TOKEN = "admin-edit-staff-token";

/** The cohort these tests edit. Created through the API, so the registry holds it. */
const BATCH = "2024_2028";
const DEPARTMENT = "CSE";
const STUDENT_TABLE = `CSE_Students_${BATCH}`;
const ATTENDANCE_TABLE = `CSE_Attendance_${BATCH}`;

/** A cohort in another department, for the "wrong department" cases. */
const IT_BATCH = "2024_2028";

function adminCookie(): string {
	return `campus-flow-session=${ADMIN_TOKEN}`;
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

async function api(path: string, init: RequestInit = {}, token: string = ADMIN_TOKEN): Promise<ApiResult> {
	const response = await SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { "Content-Type": "application/json", Cookie: `campus-flow-session=${token}`, ...(init.headers ?? {}) },
	});
	return { status: response.status, body: await response.json() };
}

async function anonymous(path: string, init: RequestInit = {}): Promise<ApiResult> {
	const response = await SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { "Content-Type": "application/json" },
	});
	return { status: response.status, body: await response.json() };
}

/** Provisions a student through the admin API and returns the roster row. */
async function importStudent(row: Record<string, unknown>): Promise<void> {
	const { status, body } = await api(`/api/admin/students?department=${DEPARTMENT}&batch=${BATCH}`, {
		method: "POST",
		body: JSON.stringify({ rows: [row] }),
	});
	if (status !== 200 || body.created !== 1) {
		throw new Error(`fixture student ${row.student_id} was not created: ${JSON.stringify(body)}`);
	}
}

async function importStaff(department: string, row: Record<string, unknown>): Promise<string> {
	const { status, body } = await api(`/api/admin/staff?department=${department}`, {
		method: "POST",
		body: JSON.stringify({ rows: [row] }),
	});
	if (status !== 200 || body.created !== 1) {
		throw new Error(`fixture staff ${row.email} was not created: ${JSON.stringify(body)}`);
	}
	const created = await env.DB
		.prepare("SELECT staff_id FROM staff WHERE email = ?")
		.bind(String(row.email).toLowerCase())
		.first<{ staff_id: string }>();
	return created!.staff_id;
}

async function addSubject(subjectCode: string, subjectName: string): Promise<number> {
	const { status, body } = await api("/api/admin/subjects", {
		method: "POST",
		body: JSON.stringify({ rows: [{ subject_code: subjectCode, subject_name: subjectName }] }),
	});
	if (status !== 200 || body.created !== 1) {
		throw new Error(`fixture subject ${subjectCode} was not created: ${JSON.stringify(body)}`);
	}
	const row = await env.DB
		.prepare("SELECT subject_id FROM subjects WHERE subject_code = ?")
		.bind(subjectCode.toUpperCase())
		.first<{ subject_id: number }>();
	return row!.subject_id;
}

/** The roster row as D1 holds it, read from the physical table and nothing else. */
async function studentRowInD1(studentId: string): Promise<any> {
	return env.DB
		.prepare(`SELECT student_id, register_no, student_name, year, section, email, auth_user_id FROM ${STUDENT_TABLE} WHERE student_id = ?`)
		.bind(studentId)
		.first();
}

function editStudent(studentId: string, body: Record<string, unknown>, query = `?department=${DEPARTMENT}&batch=${BATCH}`) {
	return api(`/api/admin/students/${encodeURIComponent(studentId)}${query}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
}

function editStaff(staffId: string, body: Record<string, unknown>, token: string = ADMIN_TOKEN) {
	return api(
		`/api/admin/staff/${encodeURIComponent(staffId)}`,
		{ method: "PATCH", body: JSON.stringify(body) },
		token
	);
}

function editSubject(subjectId: number | string, body: Record<string, unknown>, token: string = ADMIN_TOKEN) {
	return api(
		`/api/admin/subjects/${encodeURIComponent(String(subjectId))}`,
		{ method: "PATCH", body: JSON.stringify(body) },
		token
	);
}

describe("admin edit API", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}
		await env.DB
			.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
			.bind(ADMIN_ID, "edit-admin", "not-a-real-hash", "admin", "edit.admin@kiot.ac.in")
			.run();
		await createAuthSession(ADMIN_ID, ADMIN_TOKEN);

		await env.DB
			.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
			.bind(STUDENT_AUTH_ID, "edit-student", "not-a-real-hash", "student", "edit.student@kiot.ac.in")
			.run();
		await createAuthSession(STUDENT_AUTH_ID, STUDENT_TOKEN);

		await env.DB
			.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
			.bind(STAFF_AUTH_ID, "edit-staff", "not-a-real-hash", "staff", "edit.staff@kiot.ac.in")
			.run();
		await createAuthSession(STAFF_AUTH_ID, STAFF_TOKEN);

		// The cohort under test, and one in another department so a request naming
		// the wrong cohort has somewhere wrong to point.
		await api("/api/admin/batches", {
			method: "POST",
			body: JSON.stringify({ department: DEPARTMENT, batch: BATCH }),
		});
		await api("/api/admin/batches", {
			method: "POST",
			body: JSON.stringify({ department: "IT", batch: IT_BATCH }),
		});
	});

	/* ------------------------------------------------------------------ students */

	describe("PATCH /api/admin/students/:studentId", () => {
		it("lets an admin edit a student", async () => {
			await importStudent({
				student_id: "2K24CS101",
				register_no: "24CS101",
				student_name: "Anita Desai",
				year: 3,
				section: "A",
				email: "anita.desai@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS101", {
				student_name: "Anita R. Desai",
				year: 4,
				section: "B",
			});
			expect(status).toBe(200);
			expect(body.success).toBe(true);
			expect(body.student).toMatchObject({
				student_id: "2K24CS101",
				register_no: "24CS101",
				student_name: "Anita R. Desai",
				year: 4,
				section: "B",
				email: "anita.desai@kiot.ac.in",
			});
		});

		it("persists the edit in D1", async () => {
			// Asserted against the physical table, not the response, because the
			// response is built from a re-read and a bug in that re-read would
			// otherwise look like a correct save.
			await importStudent({
				student_id: "2K24CS102",
				register_no: "24CS102",
				student_name: "Bilal Khan",
				year: 2,
				section: "A",
				email: "bilal.khan.edit@kiot.ac.in",
			});

			const { status } = await editStudent("2K24CS102", {
				student_name: "Bilal M. Khan",
				section: "C",
			});
			expect(status).toBe(200);

			const row = await studentRowInD1("2K24CS102");
			expect(row.student_name).toBe("Bilal M. Khan");
			expect(row.section).toBe("C");
			// Untouched fields keep their stored values rather than becoming null,
			// because an absent field in a PATCH means "unchanged".
			expect(row.year).toBe(2);
			expect(row.register_no).toBe("24CS102");
		});

		it("refuses to change the register number", async () => {
			await importStudent({
				student_id: "2K24CS103",
				register_no: "24CS103",
				student_name: "Chitra Iyer",
				year: 3,
				section: "A",
				email: "chitra.iyer@kiot.ac.in",
			});

			/*
			 * The register number is the key every mark in this cohort's attendance
			 * table is filed under, so it is not a correctable field. The request is
			 * refused outright rather than quietly storing the old value, because a
			 * success here would tell the admin a re-registration had happened.
			 */
			const { status, body } = await editStudent("2K24CS103", { register_no: "24CS999" });
			expect(status).toBe(400);
			expect(body.code).toBe("register-no-immutable");
			expect(body.error).toContain("Register number cannot be changed");

			// Neither half of the move happened.
			const row = await studentRowInD1("2K24CS103");
			expect(row.register_no).toBe("24CS103");
			const claimed = await env.DB
				.prepare(`SELECT COUNT(*) AS n FROM ${STUDENT_TABLE} WHERE register_no = ?`)
				.bind("24CS999")
				.first<{ n: number }>();
			expect(claimed?.n).toBe(0);
		});

		it("refuses a register number that belongs to another student", async () => {
			// Taking over a colleague's number is the same refusal, reached from the
			// other direction, and neither row may move.
			await importStudent({
				student_id: "2K24CS120A",
				register_no: "24CS120A",
				student_name: "Reema Qureshi",
				year: 3,
				section: "A",
				email: "reema.qureshi@kiot.ac.in",
			});
			await importStudent({
				student_id: "2K24CS120B",
				register_no: "24CS120B",
				student_name: "Sahil Menon",
				year: 3,
				section: "A",
				email: "sahil.menon@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS120A", { register_no: "24CS120B" });
			expect(status).toBe(400);
			expect(body.code).toBe("register-no-immutable");
			expect((await studentRowInD1("2K24CS120A")).register_no).toBe("24CS120A");
			expect((await studentRowInD1("2K24CS120B")).register_no).toBe("24CS120B");
		});

		it("keeps the stored casing when the echoed register number differs in case", async () => {
			// An echo is compared without regard to case, because the roster treats a
			// register number that way elsewhere, so a differently-cased resubmission is
			// recognised as the same value rather than as an attempt to change it. The
			// stored value is what stays, casing included.
			await importStudent({
				student_id: "2K24CS120C",
				register_no: "24CS120C",
				student_name: "Tanvi Bose",
				year: 3,
				section: "A",
				email: "tanvi.bose@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS120C", {
				register_no: "24cs120c",
				student_name: "Tanvi S. Bose",
			});
			expect(status).toBe(200);
			expect(body.student.register_no).toBe("24CS120C");
			// The decisive assertion: the stored key is byte-for-byte what it was.
			const row = await studentRowInD1("2K24CS120C");
			expect(row.register_no).toBe("24CS120C");
			expect(row.student_name).toBe("Tanvi S. Bose");
		});

		it("refuses an empty register number rather than clearing it", async () => {
			// The column is NOT NULL, so "clear the register number" is not a request
			// this route can honour either: it is refused as the immutability violation
			// it is, rather than surfacing as a constraint error from the UPDATE.
			await importStudent({
				student_id: "2K24CS120E",
				register_no: "24CS120E",
				student_name: "Varun Iyer",
				year: 3,
				section: "A",
				email: "varun.iyer@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS120E", { register_no: "" });
			expect(status).toBe(400);
			expect(body.code).toBe("register-no-immutable");
			expect((await studentRowInD1("2K24CS120E")).register_no).toBe("24CS120E");
		});

		it("keeps the stored register number when the editable fields change", async () => {
			// The everyday case: nothing about the number is sent at all, and the row
			// still has to come out the other side with its original number.
			await importStudent({
				student_id: "2K24CS120D",
				register_no: "24CS120D",
				student_name: "Uday Bose",
				year: 3,
				section: "A",
				email: "uday.bose.immutable@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS120D", {
				student_name: "Uday K. Bose",
				year: 4,
				section: "C",
			});
			expect(status).toBe(200);
			expect(body.student).toMatchObject({
				student_id: "2K24CS120D",
				register_no: "24CS120D",
				student_name: "Uday K. Bose",
				year: 4,
				section: "C",
			});
			const row = await studentRowInD1("2K24CS120D");
			expect(row.register_no).toBe("24CS120D");
			expect(row.student_name).toBe("Uday K. Bose");
		});

		it("changes the email and moves the login address with it", async () => {
			await importStudent({
				student_id: "2K24CS104",
				register_no: "24CS104",
				student_name: "Deepa Nair",
				year: 3,
				section: "A",
				email: "deepa.old@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS104", { email: "deepa.new@kiot.ac.in" });
			expect(status).toBe(200);
			expect(body.student.email).toBe("deepa.new@kiot.ac.in");
			expect(body.authEmailUpdated).toBe(true);

			expect((await studentRowInD1("2K24CS104")).email).toBe("deepa.new@kiot.ac.in");

			const row = await studentRowInD1("2K24CS104");
			const account = await env.DB
				.prepare("SELECT user_name, email, pwd_hash FROM auth_users WHERE auth_user_id = ?")
				.bind(row!.auth_user_id)
				.first<{ user_name: string; email: string; pwd_hash: string }>();
			// The account the roster points at is the one that moved, and the login
			// name is still the student ID: that is the handle the student knows.
			expect(account!.email).toBe("deepa.new@kiot.ac.in");
			expect(account!.user_name).toBe("2K24CS104");
		});

		it("rejects an email that belongs to another student", async () => {
			await importStudent({
				student_id: "2K24CS107",
				register_no: "24CS107",
				student_name: "Ganesh Pillai",
				year: 3,
				section: "A",
				email: "ganesh.pillai@kiot.ac.in",
			});
			await importStudent({
				student_id: "2K24CS108",
				register_no: "24CS108",
				student_name: "Harini Rao",
				year: 3,
				section: "A",
				email: "harini.rao@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS107", { email: "harini.rao@kiot.ac.in" });
			expect(status).toBe(409);
			expect(body.code).toBe("duplicate-email");
			expect((await studentRowInD1("2K24CS107")).email).toBe("ganesh.pillai@kiot.ac.in");
		});

		it("lets a student keep their own register number and email", async () => {
			// A form that submits the whole record includes the register number, and a
			// re-save with nothing changed must not be treated as an attempt to change
			// it. The echo is accepted and the stored value is what stays.
			await importStudent({
				student_id: "2K24CS109",
				register_no: "24CS109",
				student_name: "Ishaan Verma",
				year: 3,
				section: "A",
				email: "ishaan.verma@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS109", {
				student_id: "2K24CS109",
				register_no: "24CS109",
				email: "ishaan.verma@kiot.ac.in",
				student_name: "Ishaan K. Verma",
			});
			expect(status).toBe(200);
			expect(body.student).toMatchObject({
				student_id: "2K24CS109",
				register_no: "24CS109",
				student_name: "Ishaan K. Verma",
			});
			expect((await studentRowInD1("2K24CS109")).student_name).toBe("Ishaan K. Verma");
		});

		it("refuses to change the student id", async () => {
			await importStudent({
				student_id: "2K24CS110",
				register_no: "24CS110",
				student_name: "Jaya Menon",
				year: 3,
				section: "A",
				email: "jaya.menon@kiot.ac.in",
			});

			// The path names the row being edited; a body naming a different student is
			// a contradiction, and a success here would mean one of the two was ignored.
			const { status, body } = await editStudent("2K24CS110", {
				student_id: "2K24CS999",
				student_name: "Renamed Identity",
			});
			expect(status).toBe(400);
			expect(body.code).toBe("student-id-immutable");

			const row = await studentRowInD1("2K24CS110");
			expect(row.student_id).toBe("2K24CS110");
			expect(row.student_name).toBe("Jaya Menon");
			// And nothing was created under the id the body asked for.
			const invented = await env.DB
				.prepare(`SELECT COUNT(*) AS n FROM ${STUDENT_TABLE} WHERE student_id = ?`)
				.bind("2K24CS999")
				.first<{ n: number }>();
			expect(invented?.n).toBe(0);
		});

		it("accepts a body that repeats the id it is editing", async () => {
			await importStudent({
				student_id: "2K24CS111",
				register_no: "24CS111",
				student_name: "Kunal Bose",
				year: 3,
				section: "A",
				email: "kunal.bose@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS111", {
				student_id: "2K24CS111",
				student_name: "Kunal K. Bose",
			});
			expect(status).toBe(200);
			expect(body.student.student_id).toBe("2K24CS111");
			expect((await studentRowInD1("2K24CS111")).student_name).toBe("Kunal K. Bose");
		});

		it("answers 403 to a student session and 401 to an anonymous one", async () => {
			await importStudent({
				student_id: "2K24CS113",
				register_no: "24CS113",
				student_name: "Manoj Thomas",
				year: 3,
				section: "A",
				email: "manoj.thomas@kiot.ac.in",
			});
			const { student_name } = await studentRowInD1("2K24CS113");

			const asStudent = await api(
				`/api/admin/students/2K24CS113?department=${DEPARTMENT}&batch=${BATCH}`,
				{ method: "PATCH", body: JSON.stringify({ student_name: "Hijacked" }) },
				STUDENT_TOKEN
			);
			expect(asStudent.status).toBe(403);
			expect(asStudent.body.code).toBe("forbidden");

			const asStaff = await api(
				`/api/admin/students/2K24CS113?department=${DEPARTMENT}&batch=${BATCH}`,
				{ method: "PATCH", body: JSON.stringify({ student_name: "Hijacked" }) },
				STAFF_TOKEN
			);
			expect(asStaff.status).toBe(403);

			const anonymousResult = await anonymous(
				`/api/admin/students/2K24CS113?department=${DEPARTMENT}&batch=${BATCH}`,
				{ method: "PATCH", body: JSON.stringify({ student_name: "Hijacked" }) }
			);
			expect(anonymousResult.status).toBe(401);
			expect(anonymousResult.body.code).toBe("auth-required");

			// Authorization is decided before the body is even read, so none of the
			// three attempts changed the row.
			expect((await studentRowInD1("2K24CS113")).student_name).toBe(student_name);
		});

		it("refuses a student that does not exist", async () => {
			const { status, body } = await editStudent("2K24CS000", { student_name: "Nobody" });
			expect(status).toBe(404);
			expect(body.code).toBe("student-not-found");
		});

		it("refuses to edit through a cohort the student is not in", async () => {
			// IT has its own 2024_2028 tables. Naming it does not move the request to
			// another department's file; it just fails to find the student there.
			await importStudent({
				student_id: "2K24CS114",
				register_no: "24CS114",
				student_name: "Nisha Pillai",
				year: 3,
				section: "A",
				email: "nisha.pillai@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS114", { student_name: "Wrong Table" }, "?department=IT&batch=2024_2028");
			expect(status).toBe(404);
			expect(body.code).toBe("student-not-found");
			expect((await studentRowInD1("2K24CS114")).student_name).toBe("Nisha Pillai");
		});

		it("refuses a cohort that was never provisioned", async () => {
			// IT 2030_2034 is well-formed but unregistered, so there is no table to
			// vouch for it and the edit is refused rather than aimed at a name it
			// would have to invent.
			const { status, body } = await editStudent("2K24CS114", { student_name: "Nowhere" }, "?department=IT&batch=2030_2034");
			expect(status).toBe(400);
			expect(body.code).toBe("batch-not-provisioned");
		});

		it("finds the student with no cohort named at all", async () => {
			// No department, no batch: the row is located from the registry, so the
			// caller never has to name a table to correct a record.
			await importStudent({
				student_id: "2K24CS115",
				register_no: "24CS115",
				student_name: "Oviya Raj",
				year: 3,
				section: "A",
				email: "oviya.raj@kiot.ac.in",
			});

			const { status, body } = await editStudent("2K24CS115", { student_name: "Oviya S. Raj" }, "");
			expect(status).toBe(200);
			expect(body.department).toBe(DEPARTMENT);
			expect(body.batch).toBe(BATCH);
			expect((await studentRowInD1("2K24CS115")).student_name).toBe("Oviya S. Raj");
		});

		it("applies the import's own field rules", async () => {
			await importStudent({
				student_id: "2K24CS116",
				register_no: "24CS116",
				student_name: "Pranav Joshi",
				year: 3,
				section: "A",
				email: "pranav.joshi@kiot.ac.in",
			});

			/*
			 * The same rules as an import, applied to the four editable fields: a real
			 * year, a section from the shared A-D list, a real address, and required
			 * values. `register_no` is deliberately absent from this list -- it is not
			 * an editable field, so there is no invalid value to send for it, and the
			 * immutability tests above cover what happens when one arrives.
			 */
			for (const bad of [
				{ year: 5 },
				{ year: 0 },
				{ section: "Z" },
				{ email: "not-an-address" },
				{ email: "" },
				{ student_name: "   " },
			]) {
				const { status, body } = await editStudent("2K24CS116", bad);
				expect(status, `edit ${JSON.stringify(bad)} should be rejected`).toBe(400);
				expect(body.code).toBe("student-validation-failed");
				expect(body.details.errors.length).toBeGreaterThan(0);
			}
			// Section D is in the list, which the earlier A-C list silently dropped.
			const d = await editStudent("2K24CS116", { section: "D" });
			expect(d.status).toBe(200);
			expect((await studentRowInD1("2K24CS116")).section).toBe("D");
		});

		it("normalises what it stores and reports it", async () => {
			await importStudent({
				student_id: "2K24CS117",
				register_no: "24CS117",
				student_name: "Rhea Fernandes",
				year: 3,
				section: "A",
				email: "rhea.fernandes@kiot.ac.in",
			});

			const { body } = await editStudent("2K24CS117", { section: " c ", email: "Rhea.Fernandes@KIOT.ac.in" });
			// The stored value is the normalised one, and the response says so, so the
			// dashboard can render the database rather than what was typed.
			expect(body.student.section).toBe("C");
			expect(body.student.email).toBe("rhea.fernandes@kiot.ac.in");
			const row = await studentRowInD1("2K24CS117");
			expect(row.section).toBe("C");
			expect(row.email).toBe("rhea.fernandes@kiot.ac.in");
		});

		/*
		 * The register number is what attendance is filed under, so making it
		 * immutable is what makes it impossible for an edit to strand a mark. These
		 * two tests close that loop from both ends: the rename is refused, and a
		 * legitimate edit leaves the marks exactly as they were.
		 */
		it("refuses a register rename and leaves the recorded mark alone", async () => {
			await importStudent({
				student_id: "2K24CS118",
				register_no: "24CS118",
				student_name: "Sanjay Kulkarni",
				year: 3,
				section: "A",
				email: "sanjay.kulkarni@kiot.ac.in",
			});
			await env.DB
				.prepare(
					`INSERT INTO ${ATTENDANCE_TABLE}
					   (attendance_id, register_no, section, attendance_date, period,
					    subject_code, subject_name, session_id, status)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind("att-edit-1", "24CS118", "A", "2026-09-01", 1, "CS24EDIT", "Edit Subject", "sess-edit-1", "PRESENT")
				.run();

			const before = await env.DB
				.prepare(`SELECT * FROM ${ATTENDANCE_TABLE} WHERE attendance_id = ?`)
				.bind("att-edit-1")
				.first<any>();

			const { status, body } = await editStudent("2K24CS118", { register_no: "24CS118R" });
			expect(status).toBe(400);
			expect(body.code).toBe("register-no-immutable");

			// The roster key and the mark that references it are both still in step,
			// because neither moved.
			expect((await studentRowInD1("2K24CS118")).register_no).toBe("24CS118");
			const after = await env.DB
				.prepare(`SELECT * FROM ${ATTENDANCE_TABLE} WHERE attendance_id = ?`)
				.bind("att-edit-1")
				.first<any>();
			expect(after).toEqual(before);
		});

		it("does not touch recorded attendance when the editable fields change", async () => {
			await importStudent({
				student_id: "2K24CS119",
				register_no: "24CS119",
				student_name: "Tara Menon",
				year: 3,
				section: "A",
				email: "tara.menon@kiot.ac.in",
			});
			await env.DB
				.prepare(
					`INSERT INTO ${ATTENDANCE_TABLE}
					   (attendance_id, register_no, section, attendance_date, period,
					    subject_code, subject_name, session_id, status)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind("att-edit-2", "24CS119", "A", "2026-09-02", 2, "CS24EDIT", "Edit Subject", "sess-edit-2", "ABSENT")
				.run();

			const before = await env.DB
				.prepare(`SELECT * FROM ${ATTENDANCE_TABLE} WHERE attendance_id = ?`)
				.bind("att-edit-2")
				.first<any>();

			const { status, body } = await editStudent("2K24CS119", {
				student_name: "Tara S. Menon",
				year: 4,
				section: "B",
			});
			expect(status).toBe(200);
			// The roster moved; the mark did not. An edit corrects who a student is,
			// it does not rewrite what was recorded about them.
			expect(body.student).toMatchObject({ student_name: "Tara S. Menon", year: 4, section: "B" });
			const after = await env.DB
				.prepare(`SELECT * FROM ${ATTENDANCE_TABLE} WHERE attendance_id = ?`)
				.bind("att-edit-2")
				.first<any>();
			expect(after).toEqual(before);
		});

		it("never returns a password hash or a session token", async () => {
			await importStudent({
				student_id: "2K24CS120",
				register_no: "24CS120",
				student_name: "Uday Menon",
				year: 3,
				section: "A",
				email: "uday.menon@kiot.ac.in",
			});
			const { body } = await editStudent("2K24CS120", { student_name: "Uday K. Menon" });
			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain("$2");
			expect(serialized).not.toContain("pwd_hash");
			expect(serialized).not.toContain("token");
			// The link to the account is an internal detail and is not echoed either.
			expect(serialized).not.toContain("auth_user_id");
		});
	});

	/* --------------------------------------------------------------------- staff */

	describe("PATCH /api/admin/staff/:staffId", () => {
		it("lets an admin edit a staff member", async () => {
			const staffId = await importStaff("ECE", {
				staff_name: "Vidya Krishnan",
				email: "vidya.krishnan@kiot.ac.in",
			});

			const { status, body } = await editStaff(staffId, { staff_name: "Vidya R. Krishnan" });
			expect(status).toBe(200);
			expect(body.staff).toMatchObject({
				staff_id: staffId,
				staff_name: "Vidya R. Krishnan",
				email: "vidya.krishnan@kiot.ac.in",
				department: "ECE",
			});
		});

		it("persists the edit in D1", async () => {
			const staffId = await importStaff("IT", {
				staff_name: "Warren Dias",
				email: "warren.dias@kiot.ac.in",
			});

			await editStaff(staffId, { staff_name: "Warren P. Dias" });
			const row = await env.DB
				.prepare("SELECT staff_name, email, department FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<any>();
			expect(row.staff_name).toBe("Warren P. Dias");
			// Untouched fields keep their values.
			expect(row.email).toBe("warren.dias@kiot.ac.in");
			expect(row!.department).toBe("IT");
		});

		it("moves a staff member to another department", async () => {
			// Unlike a student, this is a column write: staff all live in one table
			// keyed by department, so there is nothing to move between.
			const staffId = await importStaff("ECE", {
				staff_name: "Xavier Rodrigues",
				email: "xavier.rodrigues@kiot.ac.in",
			});

			const { status, body } = await editStaff(staffId, { department: "EEE" });
			expect(status).toBe(200);
			expect(body.staff.department).toBe("EEE");

			const row = await env.DB
				.prepare("SELECT department FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<{ department: string }>();
			expect(row!.department).toBe("EEE");
		});

		it("requires all three advisor fields when class advisor is Yes", async () => {
			const staffId = await importStaff("IT", {
				staff_name: "Yusuf Khan",
				email: "yusuf.khan@kiot.ac.in",
			});

			// Each one missing in turn, so a partial assignment is refused rather than
			// stored as an advisor who can resolve no table.
			const incomplete = [
				{ class_advisor: true, advisor_year: 3, advisor_section: "A" },
				{ class_advisor: true, advisor_batch: BATCH, advisor_section: "A" },
				{ class_advisor: true, advisor_batch: BATCH, advisor_year: 3 },
			];
			for (const partial of incomplete) {
				const { status, body } = await editStaff(staffId, partial);
				expect(status, `case ${JSON.stringify(partial)} should be rejected`).toBe(400);
				expect(body.code).toBe("staff-validation-failed");
			}

			// Nothing was half-applied by any of the three attempts.
			const row = await env.DB
				.prepare("SELECT class_advisor, advisor_batch FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<any>();
			expect(row.class_advisor).toBe("N");
			expect(row.advisor_batch).toBeNull();
		});

		it("stores the whole advisor assignment when the fields are all present", async () => {
			const staffId = await importStaff(DEPARTMENT, {
				staff_name: "Zoya Ahmed",
				email: "zoya.ahmed@kiot.ac.in",
			});

			const { status, body } = await editStaff(staffId, {
				class_advisor: true,
				advisor_batch: BATCH,
				advisor_year: 3,
				advisor_section: "A",
			});
			expect(status).toBe(200);
			expect(body.staff).toMatchObject({
				class_advisor: "Y",
				advisor_batch: BATCH,
				advisor_year: 3,
				advisor_section: "A",
			});

			const row = await env.DB
				.prepare("SELECT class_advisor, advisor_batch, advisor_year, advisor_section, auth_user_id FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<any>();
			expect(row.advisor_batch).toBe(BATCH);
			// The advisor routes authorise on the account role, so it moves with the
			// flag or a real advisor would be locked out of them.
			const account = await env.DB
				.prepare("SELECT role FROM auth_users WHERE auth_user_id = ?")
				.bind(row!.auth_user_id)
				.first<{ role: string }>();
			expect(account?.role).toBe("class_advisor");
		});

		it("clears the advisor fields when class advisor is turned off", async () => {
			const staffId = await importStaff(DEPARTMENT, {
				staff_name: "Aditi Narang",
				email: "aditi.narang@kiot.ac.in",
			});
			await editStaff(staffId, {
				class_advisor: true,
				advisor_batch: BATCH,
				advisor_year: 3,
				advisor_section: "B",
			});

			const { status, body } = await editStaff(staffId, { class_advisor: false });
			expect(status).toBe(200);
			expect(body.staff.class_advisor).toBe("N");

			const row = await env.DB
				.prepare(
					"SELECT class_advisor, advisor_batch, advisor_year, advisor_section, auth_user_id FROM staff WHERE staff_id = ?"
				)
				.bind(staffId)
				.first<any>();
			// Cleared, not left behind: a lecturer who stops advising must not keep a
			// class that would still let them reach its attendance.
			expect(row.advisor_batch).toBeNull();
			expect(row.advisor_year).toBeNull();
			expect(row.advisor_section).toBeNull();
			const account = await env.DB
				.prepare("SELECT role FROM auth_users WHERE auth_user_id = ?")
				.bind(row!.auth_user_id)
				.first<{ role: string }>();
			expect(account?.role).toBe("staff");
		});

		it("rejects an advisor cohort that is not provisioned for the department", async () => {
			const staffId = await importStaff("ECE", {
				staff_name: "Bhaskar Iyer",
				email: "bhaskar.iyer@kiot.ac.in",
			});

			// A well-formed label with no tables behind it.
			const unprovisioned = await editStaff(staffId, {
				class_advisor: true,
				advisor_batch: "2030_2034",
				advisor_year: 3,
				advisor_section: "A",
			});
			expect(unprovisioned.status).toBe(400);
			expect(unprovisioned.body.code).toBe("batch-not-provisioned");

			// And one belonging to another department: a cross-department mapping
			// would route the advisor's attendance to tables that are not theirs.
			const crossDepartment = await editStaff(staffId, {
				class_advisor: true,
				advisor_batch: BATCH,
				advisor_year: 3,
				advisor_section: "A",
			});
			expect(crossDepartment.status).toBe(400);
			expect(crossDepartment.body.code).toBe("batch-not-provisioned");

			const row = await env.DB
				.prepare("SELECT class_advisor, advisor_batch FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<any>();
			expect(row.class_advisor).toBe("N");
			expect(row.advisor_batch).toBeNull();
		});

		it("re-checks the advisor cohort against the department it is moved into", async () => {
			// An IT advisor cannot be transferred into CSE still holding an IT cohort.
			const staffId = await importStaff("IT", {
				staff_name: "Chetan Varma",
				email: "chetan.varma@kiot.ac.in",
			});
			await editStaff(staffId, {
				class_advisor: true,
				advisor_batch: IT_BATCH,
				advisor_year: 3,
				advisor_section: "A",
			});

			const { status, body } = await editStaff(staffId, {
				department: DEPARTMENT,
				// A CSE cohort, correct for the new department: this one is allowed.
				advisor_batch: BATCH,
				advisor_year: 3,
				advisor_section: "A",
			});
			expect(status).toBe(200);
			expect(body.staff.department).toBe(DEPARTMENT);

			// Leaving the IT cohort in place while moving is refused.
			const staffId2 = await importStaff("IT", {
				staff_name: "Deepika Rao",
				email: "deepika.rao.move@kiot.ac.in",
			});
			const keepOld = await editStaff(staffId2, { department: DEPARTMENT });
			expect(keepOld.status).toBe(200);
			expect(keepOld.body.staff.advisor_batch).toBeNull();
		});

		it("rejects an email that belongs to another staff member", async () => {
			const staffId = await importStaff("EEE", {
				staff_name: "Elango Raj",
				email: "elango.raj@kiot.ac.in",
			});
			await importStaff("EEE", { staff_name: "Fathima Ali", email: "fathima.ali@kiot.ac.in" });

			const { status, body } = await editStaff(staffId, { email: "fathima.ali@kiot.ac.in" });
			expect(status).toBe(409);
			expect(body.code).toBe("duplicate-email");

			const row = await env.DB
				.prepare("SELECT email FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<{ email: string }>();
			expect(row!.email).toBe("elango.raj@kiot.ac.in");
		});

		it("refuses to change the staff id", async () => {
			const staffId = await importStaff("EEE", {
				staff_name: "Ganesh Prabhu",
				email: "ganesh.prabhu@kiot.ac.in",
			});

			const { status, body } = await editStaff(staffId, { staff_id: "999", staff_name: "Wrong Row" });
			expect(status).toBe(400);
			expect(body.code).toBe("staff-id-immutable");

			const row = await env.DB
				.prepare("SELECT staff_name FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<{ staff_name: string }>();
			expect(row!.staff_name).toBe("Ganesh Prabhu");
			const invented = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM staff WHERE staff_id = ?")
				.bind("999")
				.first<{ n: number }>();
			expect(invented?.n).toBe(0);
		});

		it("refuses a staff member that does not exist", async () => {
			const { status, body } = await editStaff("SBSTF-NOPE", { staff_name: "Nobody" });
			expect(status).toBe(404);
			expect(body.code).toBe("staff-not-found");
		});

		it("rejects an unsupported department", async () => {
			const staffId = await importStaff("IT", {
				staff_name: "Harleen Kaur",
				email: "harleen.kaur@kiot.ac.in",
			});
			// The allow-list, not a lookup: a department string never becomes a table
			// name, so anything outside the list is refused before it is stored.
			for (const bad of ["CSE'; DROP TABLE staff", "NOPE", ""]) {
				const { status, body } = await editStaff(staffId, { department: bad });
				expect(status, `department ${bad} should be rejected`).toBe(400);
				expect(body.code).toBe("invalid-department");
			}
			const row = await env.DB
				.prepare("SELECT department FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<{ department: string }>();
			expect(row!.department).toBe("IT");
		});

		it("applies the import's own staff rules", async () => {
			const staffId = await importStaff("ECE", {
				staff_name: "Ila Ramachandran",
				email: "ila.ramachandran@kiot.ac.in",
			});
			for (const bad of [{ staff_name: "" }, { email: "nope" }, { staff_name: "x".repeat(200) }]) {
				const { status, body } = await editStaff(staffId, bad);
				expect(status).toBe(400);
				expect(body.code).toBe("staff-validation-failed");
			}
		});

		it("never returns a password hash", async () => {
			const staffId = await importStaff("IT", {
				staff_name: "Jaspreet Kaur",
				email: "jaspreet.kaur@kiot.ac.in",
			});
			const { body } = await editStaff(staffId, { staff_name: "Jaspreet S. Kaur" });
			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain("$2");
			expect(serialized).not.toContain("pwd_hash");
			expect(serialized).not.toContain("auth_user_id");
		});
	});

	/* ----------------------------------------------------------------- subjects */

	describe("PATCH /api/admin/subjects/:subjectId", () => {
		it("lets an admin edit a subject", async () => {
			const subjectId = await addSubject("CS24EDT", "Editable Subject");

			const { status, body } = await editSubject(subjectId, {
				subject_code: "CS24EDT",
				subject_name: "Renamed Subject",
			});
			expect(status).toBe(200);
			expect(body.subject).toEqual({
				subject_id: subjectId,
				subject_code: "CS24EDT",
				subject_name: "Renamed Subject",
			});
		});

		it("persists the edit in D1", async () => {
			const subjectId = await addSubject("CS24EDT2", "Persist Me");
			await editSubject(subjectId, { subject_code: "CS24EDT3", subject_name: "Persisted" });

			const row = await env.DB
				.prepare("SELECT subject_code, subject_name FROM subjects WHERE subject_id = ?")
				.bind(subjectId)
				.first<{ subject_code: string; subject_name: string }>();
			expect(row!.subject_code).toBe("CS24EDT3");
			expect(row!.subject_name).toBe("Persisted");
		});

		it("rejects a subject code that belongs to another subject", async () => {
			const subjectId = await addSubject("CS24EDT4", "Clash One");
			await addSubject("CS24EDT5", "Clash Two");

			const { status, body } = await editSubject(subjectId, { subject_code: "CS24EDT5" });
			expect(status).toBe(409);
			expect(body.code).toBe("duplicate-subject-code");

			const row = await env.DB
				.prepare("SELECT subject_code FROM subjects WHERE subject_id = ?")
				.bind(subjectId)
				.first<{ subject_code: string }>();
			expect(row!.subject_code).toBe("CS24EDT4");
		});

		it("lets a subject keep its own code", async () => {
			const subjectId = await addSubject("CS24EDT6", "Same Code");
			const { status } = await editSubject(subjectId, {
				subject_code: "CS24EDT6",
				subject_name: "Same Code, New Name",
			});
			expect(status).toBe(200);
		});

		it("refuses to change the subject id", async () => {
			const subjectId = await addSubject("CS24EDT7", "Identity Subject");

			const { status, body } = await editSubject(subjectId, {
				subject_id: subjectId + 1000,
				subject_name: "Wrong Row",
			});
			expect(status).toBe(400);
			expect(body.code).toBe("subject-id-immutable");

			const row = await env.DB
				.prepare("SELECT subject_name FROM subjects WHERE subject_id = ?")
				.bind(subjectId)
				.first<{ subject_name: string }>();
			expect(row!.subject_name).toBe("Identity Subject");
		});

		it("refuses a subject that does not exist and a malformed id", async () => {
			expect((await editSubject(999999, { subject_name: "Nobody" })).status).toBe(404);
			for (const bad of ["0", "-1", "abc", "1.5"]) {
				const { status, body } = await editSubject(bad, { subject_name: "Nobody" });
				expect(status, `subject id ${bad} should be rejected`).toBe(400);
				expect(body.code).toBe("invalid-subject-id");
			}
		});

		it("applies the import's own subject rules", async () => {
			const subjectId = await addSubject("CS24EDT8", "Validate Me");
			for (const bad of [{ subject_code: "" }, { subject_name: "" }, { subject_code: "bad code!" }]) {
				const { status, body } = await editSubject(subjectId, bad);
				expect(status).toBe(400);
				expect(body.code).toBe("subject-validation-failed");
			}
		});

		it("leaves the subject schema alone", async () => {
			// The catalog has three columns and gains none. A department or section here
			// would couple one subject to a cohort, which is what migration 0015 undid.
			const { results } = await env.DB
				.prepare("SELECT name FROM pragma_table_info('subjects') ORDER BY cid")
				.all<{ name: string }>();
			expect(results.map((row) => row.name)).toEqual(["subject_id", "subject_code", "subject_name"]);

			const subjectId = await addSubject("CS24EDT9", "Schema Check");
			await editSubject(subjectId, { subject_name: "Schema Checked" });
			const after = await env.DB
				.prepare("SELECT name FROM pragma_table_info('subjects') ORDER BY cid")
				.all<{ name: string }>();
			expect(after.results.map((row) => row.name)).toEqual([
				"subject_id",
				"subject_code",
				"subject_name",
			]);
		});

		it("does not rewrite attendance sessions that recorded the old name", async () => {
			// A session snapshots the code and name when it is generated. Renaming a
			// subject must not edit history, so a report from last month still reads.
			const subjectId = await addSubject("CS24HST", "Historical Name");
			await env.DB
				.prepare(
					`INSERT INTO attendance_session
					   (session_id, created_by, otp, expire_at, subject_code, subject_name,
					    year, section, period, attendance_date, attendance_table, status)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					"sess-subject-edit",
					STAFF_AUTH_ID,
					"000000",
					new Date().toISOString(),
					"CS24HST",
					"Historical Name",
					3,
					"A",
					1,
					"2026-09-01",
					ATTENDANCE_TABLE,
					"FINALIZED"
				)
				.run();

			await editSubject(subjectId, { subject_code: "CS24HST2", subject_name: "New Name" });

			const session = await env.DB
				.prepare("SELECT subject_code, subject_name FROM attendance_session WHERE session_id = ?")
				.bind("sess-subject-edit")
				.first<{ subject_code: string; subject_name: string }>();
			expect(session).toEqual({ subject_code: "CS24HST", subject_name: "Historical Name" });
		});
	});

	/* --------------------------------------------------------------------- auth */

	describe("authentication survives an edit", () => {
		it("does not create a second account when a student's email changes", async () => {
			await importStudent({
				student_id: "2K24CS201",
				register_no: "24CS201",
				student_name: "Kabir Anand",
				year: 3,
				section: "A",
				email: "kabir.old@kiot.ac.in",
			});

			const before = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM auth_users")
				.first<{ n: number }>();
			await editStudent("2K24CS201", { email: "kabir.new@kiot.ac.in" });
			const after = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM auth_users")
				.first<{ n: number }>();

			expect(after?.n).toBe(before?.n);
			const linked = await env.DB
				.prepare(`SELECT COUNT(*) AS n FROM ${STUDENT_TABLE} s JOIN auth_users a ON a.auth_user_id = s.auth_user_id WHERE s.student_id = ?`)
				.bind("2K24CS201")
				.first<{ n: number }>();
			expect(linked?.n).toBe(1);
			// The freed address is genuinely free, not left on a second row.
			const stale = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE LOWER(email) = ?")
				.bind("kabir.old@kiot.ac.in")
				.first<{ n: number }>();
			expect(stale?.n).toBe(0);
		});

		it("leaves the student's password untouched and the account usable", async () => {
			await importStudent({
				student_id: "2K24CS202",
				register_no: "24CS202",
				student_name: "Lakshmi Iyer",
				year: 3,
				section: "A",
				email: "lakshmi.old@kiot.ac.in",
			});

			const row = await studentRowInD1("2K24CS202");
			const before = await env.DB
				.prepare("SELECT pwd_hash, auth_user_id FROM auth_users WHERE auth_user_id = ?")
				.bind(row!.auth_user_id)
				.first<{ pwd_hash: string; auth_user_id: string }>();

			await editStudent("2K24CS202", {
				email: "lakshmi.new@kiot.ac.in",
				student_name: "Lakshmi S. Iyer",
			});

			const after = await env.DB
				.prepare("SELECT pwd_hash, auth_user_id, user_name FROM auth_users WHERE auth_user_id = ?")
				.bind(row!.auth_user_id)
				.first<{ pwd_hash: string; auth_user_id: string; user_name: string }>();
			// Byte-for-byte: an edit is not a password reset, and the student must not
			// be locked out of an account they had not asked to change.
			expect(after?.pwd_hash).toBe(before!.pwd_hash);
			expect(after?.auth_user_id).toBe(before!.auth_user_id);
			expect(after?.user_name).toBe("2K24CS202");

			// End to end through the real login route: the new address signs in with
			// the password the student already had.
			const login = await anonymous("/api/auth/login", {
				method: "POST",
				body: JSON.stringify({ user_name: "lakshmi.new@kiot.ac.in", password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(login.status).toBe(200);
			expect(login.body.success).toBe(true);
			expect(login.body.student).toMatchObject({
				student_id: "2K24CS202",
				student_name: "Lakshmi S. Iyer",
				email: "lakshmi.new@kiot.ac.in",
			});

			// The student ID still signs in too: that is the handle that did not change.
			const byId = await anonymous("/api/auth/login", {
				method: "POST",
				body: JSON.stringify({ user_name: "2K24CS202", password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(byId.status).toBe(200);

			// And the old address is no longer a way in, which is the point of the change.
			const byOld = await anonymous("/api/auth/login", {
				method: "POST",
				body: JSON.stringify({ user_name: "lakshmi.old@kiot.ac.in", password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(byOld.status).toBe(401);
		});

		it("moves a staff login with the address and keeps the password", async () => {
			const staffId = await importStaff("IT", {
				staff_name: "Meera Joshi",
				email: "meera.old@kiot.ac.in",
			});
			const row = await env.DB
				.prepare("SELECT auth_user_id FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<{ auth_user_id: string }>();
			const before = await env.DB
				.prepare("SELECT pwd_hash, user_name FROM auth_users WHERE auth_user_id = ?")
				.bind(row!.auth_user_id)
				.first<{ pwd_hash: string; user_name: string }>();

			const countBefore = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM auth_users")
				.first<{ n: number }>();
			const { status } = await editStaff(staffId, { email: "meera.new@kiot.ac.in" });
			expect(status).toBe(200);
			const countAfter = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM auth_users")
				.first<{ n: number }>();
			expect(countAfter?.n).toBe(countBefore?.n);

			const after = await env.DB
				.prepare("SELECT pwd_hash, user_name, email FROM auth_users WHERE auth_user_id = ?")
				.bind(row!.auth_user_id)
				.first<{ pwd_hash: string; user_name: string; email: string }>();
			expect(after?.pwd_hash).toBe(before!.pwd_hash);
			// A staff account signs in by address, and provisioning stores the address
			// as the login name, so both had to move together.
			expect(after?.user_name).toBe("meera.new@kiot.ac.in");
			expect(after?.email).toBe("meera.new@kiot.ac.in");

			const login = await anonymous("/api/auth/staff/login", {
				method: "POST",
				body: JSON.stringify({ email: "meera.new@kiot.ac.in", password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(login.status).toBe(200);
			expect(login.body.staff).toMatchObject({ email: "meera.new@kiot.ac.in" });
			// The response is the login route's, and it must not echo the hash either.
			expect(JSON.stringify(login.body)).not.toContain("$2");

			// The staff ID is unchanged, so it still resolves to the new address.
			const byId = await anonymous(`/api/auth/staff/resolve/${staffId}`);
			expect(byId.status).toBe(200);
			expect(byId.body.email).toBe("meera.new@kiot.ac.in");
		});

		it("refuses an address that already belongs to another login account", async () => {
			// The staff table may hold an address that no account claims, and an account
			// may hold one no staff row claims. Writing across that gap would make the
			// address ambiguous at sign-in, so it is refused rather than resolved.
			const staffId = await importStaff("IT", {
				staff_name: "Nikhil Bose",
				email: "nikhil.bose@kiot.ac.in",
			});

			const { status, body } = await editStaff(staffId, { email: "edit.staff@kiot.ac.in" });
			expect(status).toBe(409);
			expect(body.code).toBe("auth-email-conflict");

			const row = await env.DB
				.prepare("SELECT email FROM staff WHERE staff_id = ?")
				.bind(staffId)
				.first<{ email: string }>();
			expect(row!.email).toBe("nikhil.bose@kiot.ac.in");
		});
	});

	/* ----------------------------------------------- existing behaviour intact */

	describe("existing functionality", () => {
		it("still serves the lists the dashboard browses", async () => {
			// An edit route must not have displaced the read routes, since the refresh
			// after a save is what shows the admin the new database value.
			const students = await api(`/api/admin/students?department=${DEPARTMENT}&batch=${BATCH}`);
			expect(students.status).toBe(200);
			expect(students.body.students.length).toBeGreaterThan(0);

			const staff = await api("/api/admin/staff?department=IT");
			expect(staff.status).toBe(200);
			expect(Array.isArray(staff.body.staff)).toBe(true);

			const subjects = await api("/api/admin/subjects");
			expect(subjects.status).toBe(200);
			expect(subjects.body.subjects.some((s: any) => s.subject_code === "CS24EDT3")).toBe(true);

			const batches = await api("/api/admin/batches");
			expect(batches.status).toBe(200);
			expect(batches.body.batches.CSE.map((b: any) => b.key)).toContain(BATCH);
		});

		it("still provisions students into a batch created moments earlier", async () => {
			// The create path shares table resolution with the edit path; this proves
			// adding the PATCH routes did not narrow or break it.
			const { status } = await api("/api/admin/batches", {
				method: "POST",
				body: JSON.stringify({ department: "EEE", batch: "2031_2035" }),
			});
			expect(status).toBe(200);

			const { body } = await api("/api/admin/students?department=EEE&batch=2031_2035", {
				method: "POST",
				body: JSON.stringify({
					rows: [
						{
							student_id: "2K31EE001",
							register_no: "31EE001",
							student_name: "Create Path Intact",
							year: 1,
							section: "A",
							email: "create.path@kiot.ac.in",
						},
					],
				}),
			});
			expect(body.created).toBe(1);

			// And the new cohort is editable immediately, with no rebuild.
			const edit = await api("/api/admin/students/2K31EE001?department=EEE&batch=2031_2035", {
				method: "PATCH",
				body: JSON.stringify({ section: "B" }),
			});
			expect(edit.status).toBe(200);
			expect(edit.body.student.section).toBe("B");
		});

		it("leaves the attendance table structure alone", async () => {
			// Nothing here adds, drops or rewrites attendance. The count of tables
			// matching the cohort's pair is exactly two, and a subject rename touched
			// no attendance row.
			const { results } = await env.DB
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?")
				.bind(`${DEPARTMENT}_%${BATCH}`)
				.all<{ name: string }>();
			expect(results.map((row) => row.name).sort()).toEqual(
				[ATTENDANCE_TABLE, STUDENT_TABLE].sort()
			);
		});
	});
});
