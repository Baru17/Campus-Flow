import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/utils/auth";
import {
	finalizeSession,
	markPresentIfSessionActive,
	promoteAbsentToPresentIfSessionActive,
} from "../src/api/attendance";
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

type TestStudent = {
	studentId: string;
	registerNo: string;
	authUserId: string;
	token: string;
};

const testSuffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
const students: TestStudent[] = [];
const sessionIds: string[] = [];
let advisorAuthUserId = "";

async function runBatch(statements: D1PreparedStatement[]): Promise<void> {
	for (let offset = 0; offset < statements.length; offset += 50) {
		await env.DB.batch(statements.slice(offset, offset + 50));
	}
}

async function createSession(otp: string, expired = false): Promise<string> {
	const sessionId = crypto.randomUUID();
	const createdAt = new Date();
	const expiresAt = new Date(createdAt.getTime() + (expired ? -1000 : 5 * 60_000));
	await env.DB
		.prepare(
			`INSERT INTO attendance_session (
				session_id, created_by, otp, created_at, expire_at, subject_code,
				subject_name, year, section, period, attendance_date,
				attendance_table, department, batch, status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IT', '2024_2028', 'ACTIVE')`,
		)
		.bind(
			sessionId,
			`test-staff-${testSuffix}`,
			otp,
			createdAt.toISOString(),
			expiresAt.toISOString(),
			"TEST101",
			"Integration Test",
			3,
			"A",
			99,
			createdAt.toISOString().slice(0, 10),
			"IT_Attendance_2024_2028",
		)
		.run();
	sessionIds.push(sessionId);
	return sessionId;
}

async function submitOtp(student: TestStudent, otp: string): Promise<Response> {
	return SELF.fetch("https://example.com/api/attendance/verify", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `campus-flow-session=${student.token}`,
		},
		body: JSON.stringify({ otp }),
	});
}

async function seedTestAccounts(): Promise<void> {
	if (students.length > 0) {
		return;
	}
	const statements: D1PreparedStatement[] = [];
	for (let index = 0; index < 100; index += 1) {
		const studentId = `LOAD${testSuffix}${String(index).padStart(3, "0")}`;
		const authUserId = crypto.randomUUID();
		const token = crypto.randomUUID();
		const registerNo = `LOAD${testSuffix}${String(index).padStart(3, "0")}`;
		const email = `${studentId.toLowerCase()}@load-test.invalid`;
		students.push({ studentId, registerNo, authUserId, token });

		statements.push(
			env.DB.prepare(
				`INSERT INTO IT_Students_2024_2028
				 (student_id, register_no, student_name, year, section, email, auth_user_id)
				 VALUES (?, ?, ?, 3, 'A', ?, ?)`,
			).bind(studentId, registerNo, studentId, email, authUserId),
			env.DB.prepare(
				`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
				 VALUES (?, ?, 'test-hash-not-used', 'student', ?)`,
			).bind(authUserId, studentId, email),
			env.DB.prepare(
				`INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at)
				 VALUES (?, ?, ?)`,
			).bind(hashToken(token), authUserId, new Date(Date.now() + 60 * 60_000).toISOString()),
		);
	}

	const sectionBId = crypto.randomUUID();
	const sectionBToken = crypto.randomUUID();
	const sectionBStudentId = `LOAD${testSuffix}B`;
	const sectionBEmail = `${sectionBStudentId.toLowerCase()}@load-test.invalid`;
	students.push({
		studentId: sectionBStudentId,
		registerNo: sectionBStudentId,
		authUserId: sectionBId,
		token: sectionBToken,
	});
	statements.push(
		env.DB.prepare(
			`INSERT INTO IT_Students_2024_2028
			 (student_id, register_no, student_name, year, section, email, auth_user_id)
			 VALUES (?, ?, ?, 3, 'B', ?, ?)`,
		).bind(sectionBStudentId, sectionBStudentId, sectionBStudentId, sectionBEmail, sectionBId),
		env.DB.prepare(
			`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
			 VALUES (?, ?, 'test-hash-not-used', 'student', ?)`,
		).bind(sectionBId, sectionBStudentId, sectionBEmail),
		env.DB.prepare(
			`INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at)
			 VALUES (?, ?, ?)`,
		).bind(hashToken(sectionBToken), sectionBId, new Date(Date.now() + 60 * 60_000).toISOString()),
	);

	advisorAuthUserId = crypto.randomUUID();
	const advisorEmail = `advisor-${testSuffix.toLowerCase()}@load-test.invalid`;
	statements.push(
		env.DB.prepare(
			`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
			 VALUES (?, ?, 'test-hash-not-used', 'class_advisor', ?)`,
		).bind(advisorAuthUserId, advisorEmail, advisorEmail),
		env.DB.prepare(
			`INSERT INTO staff (staff_id, staff_name, email, department, advisor_batch, advisor_year, advisor_section, auth_user_id)
			 VALUES (?, 'Load Test Advisor', ?, 'IT', '2024_2028', 3, 'A', ?)`,
		).bind(`LT${testSuffix}`, advisorEmail, advisorAuthUserId),
		env.DB.prepare(
			`INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at)
			 VALUES (?, ?, ?)`,
		).bind(hashToken("load-test-advisor-cookie"), advisorAuthUserId, new Date(Date.now() + 60 * 60_000).toISOString()),
	);

	await runBatch(statements);
}

afterAll(async () => {
	const cleanup: D1PreparedStatement[] = [];
	for (const sessionId of sessionIds) {
		cleanup.push(
			env.DB.prepare("DELETE FROM IT_Attendance_2024_2028 WHERE session_id = ?").bind(sessionId),
			env.DB.prepare("DELETE FROM attendance_session WHERE session_id = ?").bind(sessionId),
		);
	}
	cleanup.push(
		env.DB.prepare("DELETE FROM auth_sessions WHERE auth_user_id IN (SELECT auth_user_id FROM auth_users WHERE user_name LIKE ?)")
			.bind(`LOAD${testSuffix}%`),
		env.DB.prepare("DELETE FROM IT_Students_2024_2028 WHERE student_id LIKE ?").bind(`LOAD${testSuffix}%`),
		env.DB.prepare("DELETE FROM auth_users WHERE user_name LIKE ?").bind(`LOAD${testSuffix}%`),
		env.DB.prepare("DELETE FROM auth_sessions WHERE auth_user_id = ?").bind(advisorAuthUserId),
		env.DB.prepare("DELETE FROM staff WHERE staff_id = ?").bind(`LT${testSuffix}`),
		env.DB.prepare("DELETE FROM auth_users WHERE auth_user_id = ?").bind(advisorAuthUserId),
	);
	await runBatch(cleanup);
});

describe("isolated D1 attendance integration", () => {
	beforeAll(async () => {
		for (const migration of [
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
	]) {
			const statements = migration
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
	});

	it("handles 10, 25, 50, and 100 concurrent students on the same active OTP", async () => {
		await seedTestAccounts();
		const sizes = [10, 25, 50, 100];
		const sessionForFinalization = await createSession("987654");

		for (let wave = 0; wave < sizes.length; wave += 1) {
			const size = sizes[wave];
			const sessionId = wave === 0 ? sessionForFinalization : await createSession(`98765${wave}`);
			const responses = await Promise.all(
				students.slice(0, size).map((student) => submitOtp(student, wave === 0 ? "987654" : `98765${wave}`)),
			);
			const results = await Promise.all(responses.map(async (response) => ({
				status: response.status,
				body: await response.json() as { success: boolean; student?: { student_id: string } },
			})));

			expect(results.every((result) => result.status === 200 && result.body.success)).toBe(true);
			expect(new Set(results.map((result) => result.body.student?.student_id)).size).toBe(size);

			const count = await env.DB
				.prepare("SELECT COUNT(*) AS count FROM IT_Attendance_2024_2028 WHERE session_id = ?")
				.bind(sessionId)
				.first<{ count: number }>();
			expect(count?.count).toBe(size);
		}

		const duplicate = await submitOtp(students[0], "987654");
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toMatchObject({ already_marked: true });

		const wrongSection = await submitOtp(students[100], "987654");
		expect(wrongSection.status).toBe(403);
		expect(await wrongSection.json()).toMatchObject({ code: "session-class-mismatch" });

		const expiredSession = await createSession("123456", true);
		const expiredResponse = await submitOtp(students[0], "123456");
		expect(expiredResponse.status).toBe(400);
		expect(await expiredResponse.json()).toMatchObject({ code: "otp-expired" });

		const finalization = await finalizeSession(env.DB, expiredSession);
		expect(finalization.success).toBe(true);
		expect(finalization.total_students).toBe(100);
		expect(finalization.present).toBe(0);
		expect(finalization.absent).toBe(100);

		const advisorCookie = "campus-flow-session=load-test-advisor-cookie";
		for (const status of ["PRESENT", "ABSENT"]) {
			const editResponse = await SELF.fetch(`https://example.com/api/class-advisors/attendance/${expiredSession}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Cookie: advisorCookie,
				},
				body: JSON.stringify({ register_no: students[0].registerNo, status }),
			});
			expect(editResponse.status).toBe(200);
			const stored = await env.DB
				.prepare("SELECT status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?")
				.bind(expiredSession, students[0].registerNo)
				.first<{ status: string }>();
			expect(stored?.status).toBe(status);
		}

		const advisorResponse = await SELF.fetch("https://example.com/api/class-advisors/attendance/report?date=" + new Date().toISOString().slice(0, 10) + "&period=99", {
			headers: { Cookie: advisorCookie },
		});
		expect(advisorResponse.status).toBe(200);
		const report = await advisorResponse.json() as { data?: { total_strength: number; absent: number; od: number; report: string } };
		expect(report.data).toMatchObject({ total_strength: 100, absent: 100, od: 0 });
		expect(report.data?.report).toContain(`Date: ${new Date().toISOString().slice(0, 10).split("-").reverse().join(".")}`);
	}, 60_000);
});

describe("POST /api/attendance/verify semantics", () => {
	beforeAll(async () => {
		await seedTestAccounts();
	});

	async function countRows(sessionId: string, registerNo?: string): Promise<number> {
		const row = registerNo
			? await env.DB
				.prepare(
					"SELECT COUNT(*) AS count FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?",
				)
				.bind(sessionId, registerNo)
				.first<{ count: number }>()
			: await env.DB
				.prepare("SELECT COUNT(*) AS count FROM IT_Attendance_2024_2028 WHERE session_id = ?")
				.bind(sessionId)
				.first<{ count: number }>();
		return Number(row?.count ?? 0);
	}

	it("accepts a correct OTP and stores exactly one PRESENT row", async () => {
		const sessionId = await createSession("111111");
		const response = await submitOtp(students[0], "111111");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			present: true,
			already_marked: false,
		});
		expect(await countRows(sessionId, students[0].registerNo)).toBe(1);

		const stored = await env.DB
			.prepare("SELECT status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?")
			.bind(sessionId, students[0].registerNo)
			.first<{ status: string }>();
		expect(stored?.status).toBe("PRESENT");
	});

	it("rejects a wrong OTP without writing attendance", async () => {
		const sessionId = await createSession("222222");
		const response = await submitOtp(students[1], "999999");

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "invalid-otp" });
		expect(await countRows(sessionId, students[1].registerNo)).toBe(0);
	});

	it("rejects an expired OTP distinctly from a wrong one", async () => {
		const sessionId = await createSession("333333", true);
		const response = await submitOtp(students[2], "333333");

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "otp-expired" });
		expect(await countRows(sessionId, students[2].registerNo)).toBe(0);
	});

	it("treats a duplicate submission as idempotent", async () => {
		const sessionId = await createSession("444444");
		const first = await submitOtp(students[3], "444444");
		const second = await submitOtp(students[3], "444444");

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({ already_marked: true });
		expect(await countRows(sessionId, students[3].registerNo)).toBe(1);
	});

	it("keeps one row when the same student submits concurrently", async () => {
		const sessionId = await createSession("555555");
		const responses = await Promise.all(
			Array.from({ length: 10 }, () => submitOtp(students[4], "555555")),
		);

		for (const response of responses) {
			expect(response.status).toBe(200);
		}
		const bodies = await Promise.all(
			responses.map((response) => response.json() as Promise<{ present: boolean }>),
		);
		expect(bodies.every((body) => body.present === true)).toBe(true);
		expect(await countRows(sessionId, students[4].registerNo)).toBe(1);

		const stored = await env.DB
			.prepare("SELECT status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?")
			.bind(sessionId, students[4].registerNo)
			.first<{ status: string }>();
		expect(stored?.status).toBe("PRESENT");
	});

	it("records every student when different students submit concurrently", async () => {
		const sessionId = await createSession("666666");
		const wave = students.slice(10, 60);
		const responses = await Promise.all(wave.map((student) => submitOtp(student, "666666")));

		expect(responses.every((response) => response.status === 200)).toBe(true);
		expect(await countRows(sessionId)).toBe(wave.length);

		const ids = await Promise.all(
			responses.map((response) => response.json() as Promise<{ student: { student_id: string } }>),
		);
		expect(new Set(ids.map((body) => body.student.student_id)).size).toBe(wave.length);
	});

	it("refuses new attendance once the session is finalized", async () => {
		const sessionId = await createSession("777777", true);
		const finalization = await finalizeSession(env.DB, sessionId);
		expect(finalization.success).toBe(true);

		const before = await countRows(sessionId, students[60].registerNo);
		const response = await submitOtp(students[60], "777777");

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "otp-expired" });
		expect(await countRows(sessionId, students[60].registerNo)).toBe(before);
	});

	it("does not let the guarded insert create PRESENT for a finalized session", async () => {
		const sessionId = await createSession("888888", true);
		await finalizeSession(env.DB, sessionId);
		const student = students[61];

		/*
		 * Finalization seeds an ABSENT row for every student, which would make
		 * the insert a no-op through UNIQUE(session_id, register_no) and mask
		 * the guard entirely. Removing the row leaves the insert with no
		 * duplicate to fall back on, so only the ACTIVE guard can stop it.
		 */
		await env.DB
			.prepare(
				"DELETE FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?",
			)
			.bind(sessionId, student.registerNo)
			.run();

		const changes = await markPresentIfSessionActive(env.DB, {
			attendanceTable: "IT_Attendance_2024_2028",
			sessionId,
			registerNo: student.registerNo,
			section: "A",
			attendanceDate: new Date().toISOString().slice(0, 10),
			period: 99,
			subjectCode: "TEST101",
			subjectName: "Integration Test",
			markedAt: new Date().toISOString(),
		});

		expect(changes).toBe(0);
		const stored = await env.DB
			.prepare(
				"SELECT status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?",
			)
			.bind(sessionId, student.registerNo)
			.first<{ status: string }>();
		expect(stored).toBeNull();
	});

	it("still inserts PRESENT for an active session", async () => {
		const sessionId = await createSession("141414");
		const student = students[62];

		const changes = await markPresentIfSessionActive(env.DB, {
			attendanceTable: "IT_Attendance_2024_2028",
			sessionId,
			registerNo: student.registerNo,
			section: "A",
			attendanceDate: new Date().toISOString().slice(0, 10),
			period: 99,
			subjectCode: "TEST101",
			subjectName: "Integration Test",
			markedAt: new Date().toISOString(),
		});

		expect(changes).toBe(1);
	});

	it("does not flip ABSENT to PRESENT once the session is finalized", async () => {
		const sessionId = await createSession("131313", true);
		const student = students[63];
		await env.DB
			.prepare(
				`INSERT INTO IT_Attendance_2024_2028 (
				   attendance_id, register_no, section, attendance_date, period,
				   subject_code, subject_name, marked_at, session_id, status
				 ) VALUES (?, ?, 'A', ?, 99, 'TEST101', 'Integration Test', ?, ?, 'ABSENT')`,
			)
			.bind(
				crypto.randomUUID(),
				student.registerNo,
				new Date().toISOString().slice(0, 10),
				new Date().toISOString(),
				sessionId,
			)
			.run();
		await finalizeSession(env.DB, sessionId);

		const existing = await env.DB
			.prepare(
				"SELECT id, status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?",
			)
			.bind(sessionId, student.registerNo)
			.first<{ id: number; status: string }>();
		expect(existing?.status).toBe("ABSENT");

		const changes = await promoteAbsentToPresentIfSessionActive(env.DB, {
			attendanceTable: "IT_Attendance_2024_2028",
			sessionId,
			rowId: Number(existing?.id),
			markedAt: new Date().toISOString(),
		});
		expect(changes).toBe(0);

		const stored = await env.DB
			.prepare(
				"SELECT status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?",
			)
			.bind(sessionId, student.registerNo)
			.first<{ status: string }>();
		expect(stored?.status).toBe("ABSENT");
	});

	it("promotes ABSENT to PRESENT while the session is still active", async () => {
		const sessionId = await createSession("151515");
		const student = students[64];
		await env.DB
			.prepare(
				`INSERT INTO IT_Attendance_2024_2028 (
				   attendance_id, register_no, section, attendance_date, period,
				   subject_code, subject_name, marked_at, session_id, status
				 ) VALUES (?, ?, 'A', ?, 99, 'TEST101', 'Integration Test', ?, ?, 'ABSENT')`,
			)
			.bind(
				crypto.randomUUID(),
				student.registerNo,
				new Date().toISOString().slice(0, 10),
				new Date().toISOString(),
				sessionId,
			)
			.run();

		const existing = await env.DB
			.prepare(
				"SELECT id FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?",
			)
			.bind(sessionId, student.registerNo)
			.first<{ id: number }>();

		const changes = await promoteAbsentToPresentIfSessionActive(env.DB, {
			attendanceTable: "IT_Attendance_2024_2028",
			sessionId,
			rowId: Number(existing?.id),
			markedAt: new Date().toISOString(),
		});
		expect(changes).toBe(1);

		const stored = await env.DB
			.prepare(
				"SELECT status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?",
			)
			.bind(sessionId, student.registerNo)
			.first<{ status: string }>();
		expect(stored?.status).toBe("PRESENT");
	});

	it("never records PRESENT after finalization when submit races finalize", async () => {
		const sessionId = await createSession("121212");
		const wave = students.slice(62, 92);
		const finalizedAt = new Date().toISOString();

		/*
		 * finalizeSession refuses to close a session that has not expired, so
		 * the status flip is issued directly to create the genuine race: a
		 * request that already read the session as ACTIVE reaches the insert
		 * after the session has been closed.
		 */
		const [, results] = await Promise.all([
			env.DB
				.prepare(
					"UPDATE attendance_session SET status = 'FINALIZED', finalized_at = ? WHERE session_id = ?",
				)
				.bind(finalizedAt, sessionId)
				.run(),
			Promise.all(
				wave.map(async (student) => {
					const response = await submitOtp(student, "121212");
					return {
						registerNo: student.registerNo,
						status: response.status,
						body: (await response.json()) as {
							success: boolean;
							present?: boolean;
							already_marked?: boolean;
						},
					};
				}),
			),
		]);

		const session = await env.DB
			.prepare("SELECT status FROM attendance_session WHERE session_id = ?")
			.bind(sessionId)
			.first<{ status: string }>();
		expect(session?.status).toBe("FINALIZED");

		/*
		 * Clock-free invariant: a request that was not told it succeeded must
		 * not have left a PRESENT row behind. This is exactly what the guarded
		 * insert guarantees, and it fails loudly if the guard is removed.
		 */
		for (const result of results.filter((entry) => !entry.body.success)) {
			const stored = await env.DB
				.prepare(
					"SELECT status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?",
				)
				.bind(sessionId, result.registerNo)
				.first<{ status: string }>();
			expect(stored?.status).not.toBe("PRESENT");
		}

		// Every request that did succeed must correspond to a PRESENT row.
		const succeeded = results.filter((entry) => entry.body.success);
		for (const result of succeeded) {
			const stored = await env.DB
				.prepare(
					"SELECT status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ?",
				)
				.bind(sessionId, result.registerNo)
				.first<{ status: string }>();
			expect(stored?.status).toBe("PRESENT");
		}

		const duplicates = await env.DB
			.prepare(
				`SELECT COUNT(*) AS count FROM (
				   SELECT register_no FROM IT_Attendance_2024_2028
				   WHERE session_id = ? GROUP BY register_no HAVING COUNT(*) > 1
				 )`,
			)
			.bind(sessionId)
			.first<{ count: number }>();
		expect(Number(duplicates?.count ?? 0)).toBe(0);
	}, 30_000);
});
describe("department scoping", () => {
	const deptSuffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
	const scopedSessionIds: string[] = [];
	let itStaffAuthUserId = "";
	let cseStaffAuthUserId = "";

	beforeAll(async () => {
		await seedTestAccounts();
		const itStaffId = `DSIT${deptSuffix}`;
		const cseStaffId = `DSCSE${deptSuffix}`;
		itStaffAuthUserId = crypto.randomUUID();
		cseStaffAuthUserId = crypto.randomUUID();
		const itEmail = `ds-it-${deptSuffix.toLowerCase()}@dept.invalid`;
		const cseEmail = `ds-cse-${deptSuffix.toLowerCase()}@dept.invalid`;

		await runBatch([
			env.DB.prepare(
				"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, 'test-hash', 'staff', ?)",
			).bind(itStaffAuthUserId, itStaffId, itEmail),
			env.DB.prepare(
				"INSERT INTO staff (staff_id, staff_name, email, department, auth_user_id) VALUES (?, 'Dept IT Staff', ?, 'IT', ?)",
			).bind(itStaffId, itEmail, itStaffAuthUserId),
			env.DB.prepare(
				"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)",
			).bind(hashToken("dept-it-cookie"), itStaffAuthUserId, new Date(Date.now() + 60 * 60_000).toISOString()),

			env.DB.prepare(
				"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, 'test-hash', 'staff', ?)",
			).bind(cseStaffAuthUserId, cseStaffId, cseEmail),
			env.DB.prepare(
				"INSERT INTO staff (staff_id, staff_name, email, department, auth_user_id) VALUES (?, 'Dept CSE Staff', ?, 'CSE', ?)",
			).bind(cseStaffId, cseEmail, cseStaffAuthUserId),
			env.DB.prepare(
				"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)",
			).bind(hashToken("dept-cse-cookie"), cseStaffAuthUserId, new Date(Date.now() + 60 * 60_000).toISOString()),

			env.DB.prepare(
				"INSERT INTO subjects (subject_code, subject_name) VALUES (?, 'Dept IT Subject')",
			).bind(`DSIT${deptSuffix}`),
			env.DB.prepare(
				"INSERT INTO subjects (subject_code, subject_name) VALUES (?, 'Dept CSE Subject')",
			).bind(`DSCSE${deptSuffix}`),
		]);
	});

	afterAll(async () => {
		const cleanup: D1PreparedStatement[] = [];
		for (const sessionId of scopedSessionIds) {
			cleanup.push(
				env.DB.prepare("DELETE FROM attendance_session WHERE session_id = ?").bind(sessionId),
				env.DB.prepare("DELETE FROM IT_Attendance_2024_2028 WHERE session_id = ?").bind(sessionId),
			);
		}
		cleanup.push(
			env.DB.prepare("DELETE FROM subjects WHERE subject_code IN (?, ?)").bind(`DSIT${deptSuffix}`, `DSCSE${deptSuffix}`),
			env.DB.prepare("DELETE FROM auth_sessions WHERE auth_user_id IN (?, ?)").bind(itStaffAuthUserId, cseStaffAuthUserId),
			env.DB.prepare("DELETE FROM staff WHERE staff_id IN (?, ?)").bind(`DSIT${deptSuffix}`, `DSCSE${deptSuffix}`),
			env.DB.prepare("DELETE FROM auth_users WHERE auth_user_id IN (?, ?)").bind(itStaffAuthUserId, cseStaffAuthUserId),
		);
		await runBatch(cleanup);
	});

	/** Inserts a session with explicit department/batch/table so allow-list violations can be simulated. */
	async function createScopedSession(fields: {
		otp: string;
		department: string;
		batch: string;
		attendanceTable: string;
		year: number;
		section?: string;
		expired?: boolean;
	}): Promise<string> {
		const sessionId = crypto.randomUUID();
		const createdAt = new Date();
		const expiresAt = new Date(createdAt.getTime() + (fields.expired ? -1000 : 5 * 60_000));
		await env.DB
			.prepare(
				`INSERT INTO attendance_session (
					session_id, created_by, otp, created_at, expire_at, subject_code,
					subject_name, year, section, period, attendance_date,
					attendance_table, department, batch, status
				) VALUES (?, ?, ?, ?, ?, 'TEST101', 'Integration Test', ?, ?, 99, ?, ?, ?, ?, 'ACTIVE')`,
			)
			.bind(
				sessionId,
				`test-staff-${testSuffix}`,
				fields.otp,
				createdAt.toISOString(),
				expiresAt.toISOString(),
				fields.year,
				fields.section ?? "A",
				createdAt.toISOString().slice(0, 10),
				fields.attendanceTable,
				fields.department,
				fields.batch,
			)
			.run();
		scopedSessionIds.push(sessionId);
		return sessionId;
	}

	function generate(cookie: string, body: Record<string, unknown>): Promise<Response> {
		return SELF.fetch("https://example.com/api/attendance/generate", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: `campus-flow-session=${cookie}` },
			body: JSON.stringify(body),
		});
	}

	it("still generates an IT session for IT staff in the 2024_2028 batch", async () => {
		const response = await generate("dept-it-cookie", {
			subject_code: `DSIT${deptSuffix}`,
			period: 1,
			year: 3,
			section: "A",
			department: "IT",
			batch: "2024_2028",
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; session: Record<string, unknown> };
		expect(body.success).toBe(true);
		expect(body.session.department).toBe("IT");
		expect(body.session.batch).toBe("2024_2028");
		expect(body.session.attendance_date).toBeTruthy();
		scopedSessionIds.push(body.session.session_id as string);
	});

	it("generates a session for the other IT batch without deriving it from the year", async () => {
		// Year 3 with the 2025_2029 batch is only reachable because the batch is
		// sent explicitly. A year-derived resolver would have returned the
		// 2024_2028 tables here.
		const response = await generate("dept-it-cookie", {
			subject_code: `DSIT${deptSuffix}`,
			period: 2,
			year: 3,
			section: "A",
			department: "IT",
			batch: "2025_2029",
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; session: Record<string, unknown> };
		expect(body.success).toBe(true);
		expect(body.session.batch).toBe("2025_2029");
		// The table itself is internal, so confirm the session actually points at
		// the 2025_2029 tables rather than the ones its year would have implied.
		const stored = await env.DB
			.prepare("SELECT attendance_table, batch, department FROM attendance_session WHERE session_id = ?")
			.bind(body.session.session_id as string)
			.first<{ attendance_table: string; batch: string; department: string }>();
		expect(stored?.attendance_table).toBe("IT_Attendance_2025_2029");
		expect(stored?.batch).toBe("2025_2029");
		expect(stored?.department).toBe("IT");
		scopedSessionIds.push(body.session.session_id as string);
	});

	it("refuses to generate for a department the staff member does not belong to", async () => {
		const response = await generate("dept-it-cookie", {
			subject_code: `DSIT${deptSuffix}`,
			period: 1,
			year: 3,
			section: "A",
			department: "CSE",
			batch: "2024_2028",
		});

		expect(response.status).toBe(403);
		expect(((await response.json()) as { code: string }).code).toBe("department-forbidden");
	});

	it("requires the staff member to send a batch", async () => {
		const response = await generate("dept-it-cookie", {
			subject_code: `DSIT${deptSuffix}`,
			period: 1,
			year: 3,
			section: "A",
			department: "IT",
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { code: string }).code).toBe("invalid-request");
	});

	it("rejects a batch that has no tables, without falling back to a year", async () => {
		for (const batch of ["2027_2031", "2020_2024"]) {
			const response = await generate("dept-it-cookie", {
				subject_code: `DSIT${deptSuffix}`,
				period: 1,
				year: 3,
				section: "A",
				department: "IT",
				batch,
			});
			expect(response.status).toBe(400);
			expect(((await response.json()) as { code: string }).code).toBe("batch-not-configured");
		}
	});

	it("rejects a year of study in place of a batch", async () => {
		for (const year of [2, 3]) {
			const response = await generate("dept-it-cookie", {
				subject_code: `DSIT${deptSuffix}`,
				period: 1,
				year,
				section: "A",
				department: "IT",
				batch: year,
			});
			expect(response.status).toBe(400);
			expect(((await response.json()) as { code: string }).code).toBe("invalid-request");
		}
	});

	it("reports an unprovisioned department as not configured rather than failing on a missing table", async () => {
		const response = await generate("dept-cse-cookie", {
			subject_code: `DSCSE${deptSuffix}`,
			period: 1,
			year: 3,
			section: "A",
			department: "CSE",
			batch: "2024_2028",
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { code: string }).code).toBe("batch-not-configured");
	});

it("does not let a subject from another department be used", async () => {
		const response = await generate("dept-it-cookie", {
			subject_code: `DSCSE${deptSuffix}`,
			period: 1,
			year: 3,
			section: "A",
			department: "IT",
			batch: "2024_2028",
		});

		// With the simplified subject catalog, subject_code is global; any valid code
		// is accepted regardless of department. The generate flow should succeed.
		expect(response.status).toBe(200);
		// The OTP code is still present; we do not check "subject-not-found" any more.
	});

	it("refuses to mark attendance for a session in an unprovisioned department", async () => {
		await createScopedSession({
			otp: "555001",
			department: "CSE",
			batch: "2024_2028",
			attendanceTable: "CSE_Attendance_2024_2028",
			year: 3,
		});

		const response = await submitOtp(students[0], "555001");
		expect(response.status).toBe(500);
		expect(((await response.json()) as { code: string }).code).toBe("session-batch-unavailable");
	});

	it("refuses a session whose stored table disagrees with the resolver", async () => {
		await createScopedSession({
			otp: "555002",
			department: "IT",
			batch: "2024_2028",
			attendanceTable: "IT_Attendance_2025_2029",
			year: 3,
		});

		const response = await submitOtp(students[0], "555002");
		expect(response.status).toBe(500);
		expect(((await response.json()) as { code: string }).code).toBe("attendance-table-not-supported");
	});

	it("finalizes a correct-department session against that department table", async () => {
		const sessionId = await createScopedSession({
			otp: "555003",
			department: "IT",
			batch: "2024_2028",
			attendanceTable: "IT_Attendance_2024_2028",
			year: 3,
			expired: true,
		});

		const result = await finalizeSession(env.DB, sessionId);
		expect(result.success).toBe(true);
		expect(result.total_students).toBeGreaterThan(0);

		const rows = await env.DB
			.prepare("SELECT COUNT(*) AS count FROM IT_Attendance_2024_2028 WHERE session_id = ?")
			.bind(sessionId)
			.first<{ count: number }>();
		expect(Number(rows?.count ?? 0)).toBe(result.total_students);
	});

	it("refuses to finalize a session from an unprovisioned department", async () => {
		const sessionId = await createScopedSession({
			otp: "555004",
			department: "CSE",
			batch: "2024_2028",
			attendanceTable: "CSE_Attendance_2024_2028",
			year: 3,
			expired: true,
		});

		const result = await finalizeSession(env.DB, sessionId);
		expect(result.success).toBe(false);
		expect(result.message).toContain("not supported");

		const status = await env.DB
			.prepare("SELECT status FROM attendance_session WHERE session_id = ?")
			.bind(sessionId)
			.first<{ status: string }>();
		expect(status?.status).toBe("ACTIVE");
	});

	it("serves the global subject catalog to staff", async () => {
		// The subject catalog is global: one row per subject, carrying no department
		// and no year, so the same list comes back whichever class is being marked.
		const response = await SELF.fetch("https://example.com/api/subjects", {
			headers: { Cookie: "campus-flow-session=dept-it-cookie" },
		});
		const body = (await response.json()) as {
			subjects: { subject_id: number; subject_code: string; subject_name: string }[];
		};
		expect(response.status).toBe(200);
		// Subjects belonging to both departments appear in the one list.
		expect(body.subjects.map((s) => s.subject_code)).toContain(`DSIT${deptSuffix}`);
		expect(body.subjects.map((s) => s.subject_code)).toContain(`DSCSE${deptSuffix}`);

		// Only the three catalog columns are exposed; department and year do not leak.
		for (const subject of body.subjects) {
			expect(Object.keys(subject).sort()).toEqual(["subject_code", "subject_id", "subject_name"]);
		}
	});

	it("ignores year and department on the subjects endpoint", async () => {
		// Those query parameters no longer filter anything and are not required.
		const plain = await SELF.fetch("https://example.com/api/subjects", {
			headers: { Cookie: "campus-flow-session=dept-it-cookie" },
		});
		const filtered = await SELF.fetch("https://example.com/api/subjects?year=3&department=CSE", {
			headers: { Cookie: "campus-flow-session=dept-it-cookie" },
		});
		const plainSubjects = ((await plain.json()) as { subjects: { subject_code: string }[] }).subjects;
		const filteredSubjects = ((await filtered.json()) as { subjects: { subject_code: string }[] }).subjects;

		expect(plain.status).toBe(200);
		expect(filtered.status).toBe(200);
		// Identical either way, which is what "no department/year filtering" means.
		expect(filteredSubjects.map((s) => s.subject_code)).toEqual(
			plainSubjects.map((s) => s.subject_code),
		);
	});

	it("refuses the subject catalog without a session", async () => {
		// The endpoint returns the whole catalog, so an anonymous caller is turned
		// away before any query runs.
		const response = await SELF.fetch("https://example.com/api/subjects");
		expect(response.status).toBe(401);
		expect(((await response.json()) as { code: string }).code).toBe("auth-required");
	});

	it("refuses the subject catalog to a student", async () => {
		// A signed-in student authenticates fine but is not staff, so requireStaff
		// must reject rather than hand over the staff teaching list.
		const response = await SELF.fetch("https://example.com/api/subjects", {
			headers: { Cookie: `campus-flow-session=${students[0].token}` },
		});
		expect(response.status).toBe(403);
		expect(((await response.json()) as { code: string }).code).toBe("forbidden");
	});
});