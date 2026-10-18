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
import migration0016 from "../migrations/0016_academic_batches.sql?raw";
import migration0017 from "../migrations/0017_od_requests.sql?raw";
import { expandDateRange } from "../src/utils/odValidation";

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
	migration0016,
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

	it("lets an IT staff member generate for a CSE batch", async () => {
		// The department in the request names the class being marked, not the
		// authoriser. Any signed-in staff member may take attendance for any
		// configured department, so the staff member's own department is irrelevant
		// here and must not gate the request.
		const response = await generate("dept-it-cookie", {
			subject_code: `DSCSE${deptSuffix}`,
			period: 1,
			year: 1,
			section: "A",
			department: "CSE",
			batch: "2026_2030",
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; session: Record<string, unknown> };
		expect(body.success).toBe(true);
		expect(body.session.department).toBe("CSE");
		expect(body.session.batch).toBe("2026_2030");

		// The router must follow the requested department rather than defaulting
		// back to the one on the staff record.
		const stored = await env.DB
			.prepare("SELECT attendance_table, department, batch FROM attendance_session WHERE session_id = ?")
			.bind(body.session.session_id as string)
			.first<{ attendance_table: string; department: string; batch: string }>();
		expect(stored?.attendance_table).toBe("CSE_Attendance_2026_2030");
		expect(stored?.department).toBe("CSE");
		expect(stored?.batch).toBe("2026_2030");
		scopedSessionIds.push(body.session.session_id as string);
	});

	it("still refuses a department+batch pair that is not configured, whichever department the staff belongs to", async () => {
		// Lifting the department check does not widen what exists. The allow-list is
		// now the only gate on the target, so an unprovisioned pair is a 400 and is
		// reported as unconfigured rather than as a permissions problem.
		const response = await generate("dept-it-cookie", {
			subject_code: `DSIT${deptSuffix}`,
			period: 1,
			year: 3,
			section: "A",
			department: "CSE",
			batch: "2024_2028",
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { code: string }).code).toBe("batch-not-configured");
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

/*
 * Regression cover for the removal of the `staff-department-invalid` guard.
 *
 * That guard ran `normalizeDepartment(staff.department)` and refused the request
 * when the staff member's own department was not one of the canonical tokens.
 * The fixtures used by the other blocks in this file all set a canonical
 * department ('IT' / 'CSE'), so they would still pass with the guard in place
 * and cannot detect its removal. The account seeded here therefore carries a
 * department string that normalizeDepartment rejects, which is also what the
 * admin CSV import can actually produce: validateStaffRows requires only
 * staff_name and email and never constrains department.
 */
describe("staff profile department is not a prerequisite for generating", () => {
	const profileSuffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
	const profileStaffId = `DSPF${profileSuffix}`;
	const profileSubject = `DSPF${profileSuffix}`;
	const profileDepartment = "Information Technology";
	let profileAuthUserId = "";
	const profileSessionIds: string[] = [];

	function postGenerate(cookie: string, body: Record<string, unknown>): Promise<Response> {
		return SELF.fetch("https://example.com/api/attendance/generate", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: `campus-flow-session=${cookie}` },
			body: JSON.stringify(body),
		});
	}

	beforeAll(async () => {
		await seedTestAccounts();
		profileAuthUserId = crypto.randomUUID();
		const profileEmail = `ds-profile-${profileSuffix.toLowerCase()}@dept.invalid`;

		await runBatch([
			env.DB.prepare(
				"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, 'test-hash', 'staff', ?)",
			).bind(profileAuthUserId, profileStaffId, profileEmail),
			env.DB.prepare(
				"INSERT INTO staff (staff_id, staff_name, email, department, auth_user_id) VALUES (?, 'Profile Dept Staff', ?, ?, ?)",
			).bind(profileStaffId, profileEmail, profileDepartment, profileAuthUserId),
			env.DB.prepare(
				"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)",
			).bind(hashToken("dept-profile-cookie"), profileAuthUserId, new Date(Date.now() + 60 * 60_000).toISOString()),
			env.DB.prepare(
				"INSERT INTO subjects (subject_code, subject_name) VALUES (?, 'Profile Dept Independent Subject')",
			).bind(profileSubject),
		]);
	});

	afterAll(async () => {
		const cleanup: D1PreparedStatement[] = [];
		for (const sessionId of profileSessionIds) {
			cleanup.push(
				env.DB.prepare("DELETE FROM attendance_session WHERE session_id = ?").bind(sessionId),
				env.DB.prepare("DELETE FROM CSE_Attendance_2026_2030 WHERE session_id = ?").bind(sessionId),
			);
		}
		cleanup.push(
			env.DB.prepare("DELETE FROM subjects WHERE subject_code = ?").bind(profileSubject),
			env.DB.prepare("DELETE FROM auth_sessions WHERE auth_user_id = ?").bind(profileAuthUserId),
			env.DB.prepare("DELETE FROM staff WHERE staff_id = ?").bind(profileStaffId),
			env.DB.prepare("DELETE FROM auth_users WHERE auth_user_id = ?").bind(profileAuthUserId),
		);
		await runBatch(cleanup);
	});

	it("generates for a configured CSE batch even though the staff department is not a canonical token", async () => {
		// IT staff account (its profile department is a free-text import value),
		// requested department CSE, configured batch 2026_2030 -> must succeed.
		const response = await postGenerate("dept-profile-cookie", {
			subject_code: profileSubject,
			period: 1,
			year: 1,
			section: "A",
			department: "CSE",
			batch: "2026_2030",
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { success: boolean; session: Record<string, unknown> };
		expect(body.success).toBe(true);
		expect(body.session.department).toBe("CSE");
		expect(body.session.batch).toBe("2026_2030");

		// The router follows the requested department, not the staff profile.
		const stored = await env.DB
			.prepare("SELECT attendance_table, department, batch FROM attendance_session WHERE session_id = ?")
			.bind(body.session.session_id as string)
			.first<{ attendance_table: string; department: string; batch: string }>();
		expect(stored?.attendance_table).toBe("CSE_Attendance_2026_2030");
		expect(stored?.department).toBe("CSE");
		expect(stored?.batch).toBe("2026_2030");
		profileSessionIds.push(body.session.session_id as string);
	});

	it("still rejects an unconfigured department/batch combination for the same account", async () => {
		// CSE has no 2024_2028 batch. Dropping the staff-department prerequisite
		// must not turn that into a success or a different error: the controlled
		// allow-list is what refuses it.
		const response = await postGenerate("dept-profile-cookie", {
			subject_code: profileSubject,
			period: 1,
			year: 3,
			section: "A",
			department: "CSE",
			batch: "2024_2028",
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { code: string }).code).toBe("batch-not-configured");
	});

	it("still refuses a student, so removing the department prerequisite did not weaken the role check", async () => {
		// The guard that was removed validated a profile field, never a permission.
		// A student must still be stopped by requireStaff before anything else runs.
		const response = await postGenerate(students[0].token, {
			subject_code: profileSubject,
			period: 1,
			year: 1,
			section: "A",
			department: "CSE",
			batch: "2026_2030",
		});

		expect(response.status).toBe(403);
		expect(((await response.json()) as { code: string }).code).toBe("forbidden");
	});
});

/*
 * ---------------------------------------------------------------------------
 * Day-based OD at finalization
 * ---------------------------------------------------------------------------
 *
 * An approved OD request must turn a student's ABSENT into OD for the days it
 * actually covers, and into nothing else. Everything else in the workflow -- a
 * pending request, a rejected one, a half-approved one, a request for a different
 * day, or a request filed by the same student id in a different cohort -- must
 * leave the existing ABSENT behaviour untouched.
 *
 * These tests drive the real finalizer and the real copied-report route against
 * an isolated D1, because the questions worth asking are end-to-end ones: what
 * status is stored, what the copied report says, and that a second run changes
 * neither.
 *
 * The cohort lives in section C so nothing here shares a class with the load
 * test's section A/B students, and the OD date is a fixed literal rather than
 * `new Date()`, so a test cannot pass by accident on the day it happens to run.
 */
describe("day-based OD finalization", () => {
	const odSuffix = `${testSuffix}OD`;
	const OD_DATE = "2026-10-14";
	const NEIGHBOUR_DATE = "2026-10-15";
	/* The day in the middle of the `range` request's span -- the one an ends-only reading would miss. */
	const RANGE_MIDDLE_DATE = "2026-10-13";

	const odSessionIds: string[] = [];
	const odRequestIds: string[] = [];
	let odAdvisorAuthUserId = "";
	const odAdvisorCookie = `od-advisor-cookie-${testSuffix}`;

	type OdStudent = {
		studentId: string;
		registerNo: string;
		authUserId: string;
		token: string;
	};

	/*
	 * One student per rule under test. The key is the rule; the register number is
	 * derived from it, so a failing assertion names the case in the row it found.
	 */
	const CASE_KEYS = [
		"approved",
		"pending",
		"rejected",
		"otherday",
		"multiday",
		"othercohort",
		"badjson",
		"partial",
		"twice",
		"present",
		"range",
	] as const;

	const roster: Record<string, OdStudent> = {};

	async function insertOdRequest({
		id,
		student,
		studentTable = "IT_Students_2024_2028",
		status = "APPROVED",
		dates = [OD_DATE],
		mentorDecision = null,
		coordinatorDecision = null,
	}: {
		id: string;
		student: OdStudent;
		studentTable?: string;
		status?: string;
		dates?: string[] | string;
		mentorDecision?: string | null;
		coordinatorDecision?: string | null;
	}): Promise<void> {
		odRequestIds.push(id);
		const storedDates = typeof dates === "string" ? dates : JSON.stringify(dates);
		await env.DB
			.prepare(
				`INSERT INTO od_requests
				 (od_request_id, auth_user_id, student_table, student_id, student_name, student_email,
				  department, batch, year, section, submitted_date, od_days_requested, od_dates,
				  reason, status, mentor_decision, coordinator_decision)
				 VALUES (?, ?, ?, ?, ?, ?, 'IT', '2024_2028', 3, 'C', ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				student.authUserId,
				studentTable,
				student.studentId,
				student.studentId,
				`${student.studentId.toLowerCase()}@od-test.invalid`,
				OD_DATE,
				typeof dates === "string" ? 1 : dates.length,
				storedDates,
				"integration test",
				status,
				mentorDecision,
				coordinatorDecision,
			)
			.run();
	}

	async function createOdSession(otp: string, period: number, date: string, expired: boolean): Promise<string> {
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
				// Owned by the advisor account, so the same cookie can read the session
				// report route as well as the class-advisor one.
				odAdvisorAuthUserId,
				otp,
				createdAt.toISOString(),
				expiresAt.toISOString(),
				"ODIT401",
				"OD Integration",
				3,
				"C",
				period,
				date,
				"IT_Attendance_2024_2028",
			)
			.run();
		odSessionIds.push(sessionId);
		return sessionId;
	}

	async function statusFor(sessionId: string, registerNo: string): Promise<string | null> {
		const row = await env.DB
			.prepare(
				"SELECT status FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ? LIMIT 1",
			)
			.bind(sessionId, registerNo)
			.first<{ status: string }>();
		return row?.status ?? null;
	}

	async function rowCount(sessionId: string): Promise<number> {
		const row = await env.DB
			.prepare("SELECT COUNT(*) AS count FROM IT_Attendance_2024_2028 WHERE session_id = ?")
			.bind(sessionId)
			.first<{ count: number }>();
		return Number(row?.count ?? 0);
	}

	beforeAll(async () => {
		/*
		 * Only the OD table is applied here. The rest of the file applies 0001..0016
		 * once, at the top, and every describe in the file depends on that having
		 * happened -- later migrations (0015) rebuild tables and drop columns, so
		 * re-applying the chain is not idempotent and is not what this block should
		 * be doing. `0017` is the one migration the rest of the file never applies,
		 * and it is all `CREATE ... IF NOT EXISTS`, so re-running it is free.
		 */
		for (const statement of migration0017
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("--"))
			.join("\n")
			.split(";")
			.map((statement) => statement.trim())
			.filter(Boolean)) {
			await env.DB.prepare(statement).run();
		}

		const seeds: D1PreparedStatement[] = [];
		for (const key of CASE_KEYS) {
			const studentId = `${odSuffix}-${key}`.toUpperCase();
			const registerNo = studentId;
			const authUserId = crypto.randomUUID();
			const token = crypto.randomUUID();
			roster[key] = { studentId, registerNo, authUserId, token };

			seeds.push(
				env.DB.prepare(
					`INSERT INTO IT_Students_2024_2028
					 (student_id, register_no, student_name, year, section, email, auth_user_id)
					 VALUES (?, ?, ?, 3, 'C', ?, ?)`,
				).bind(studentId, registerNo, key, `${key.toLowerCase()}@od-test.invalid`, authUserId),
				env.DB.prepare(
					`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
					 VALUES (?, ?, 'test-hash-not-used', 'student', ?)`,
				).bind(authUserId, studentId, `${studentId.toLowerCase()}@od-test.invalid`),
				env.DB.prepare(
					`INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at)
					 VALUES (?, ?, ?)`,
				).bind(hashToken(token), authUserId, new Date(Date.now() + 60 * 60_000).toISOString()),
			);
		}

		odAdvisorAuthUserId = crypto.randomUUID();
		const odAdvisorEmail = `od-advisor-${testSuffix.toLowerCase()}@load-test.invalid`;
		seeds.push(
			env.DB.prepare(
				`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
				 VALUES (?, ?, 'test-hash-not-used', 'class_advisor', ?)`,
			).bind(odAdvisorAuthUserId, odAdvisorEmail, odAdvisorEmail),
			env.DB.prepare(
				`INSERT INTO staff (staff_id, staff_name, email, department, advisor_batch, advisor_year, advisor_section, auth_user_id)
				 VALUES (?, 'OD Test Advisor', ?, 'IT', '2024_2028', 3, 'C', ?)`,
			).bind(`ODOA${testSuffix}`, odAdvisorEmail, odAdvisorAuthUserId),
			env.DB.prepare(
				`INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at)
				 VALUES (?, ?, ?)`,
			).bind(hashToken(odAdvisorCookie), odAdvisorAuthUserId, new Date(Date.now() + 60 * 60_000).toISOString()),
		);
		await runBatch(seeds);

		// A fully approved request for exactly this day, and the variants that must
		// not grant anything.
		await insertOdRequest({ id: `${odSuffix}-approved`, student: roster.approved });
		await insertOdRequest({
			id: `${odSuffix}-pending`,
			student: roster.pending,
			status: "PENDING_MENTOR",
		});
		await insertOdRequest({
			id: `${odSuffix}-rejected`,
			student: roster.rejected,
			status: "REJECTED",
		});
		await insertOdRequest({
			id: `${odSuffix}-otherday`,
			student: roster.otherday,
			dates: [NEIGHBOUR_DATE],
		});
		await insertOdRequest({
			id: `${odSuffix}-multiday`,
			student: roster.multiday,
			dates: [NEIGHBOUR_DATE, OD_DATE],
		});
		/*
		 * The same student id, filed against a different cohort's student table. A
		 * student id is unique only within its table, so this must not reach across.
		 */
		await insertOdRequest({
			id: `${odSuffix}-othercohort`,
			student: roster.othercohort,
			studentTable: "IT_Students_2025_2029",
		});
		await insertOdRequest({
			id: `${odSuffix}-badjson`,
			student: roster.badjson,
			dates: "{ not an array",
		});
		await insertOdRequest({
			id: `${odSuffix}-partial`,
			student: roster.partial,
			// Mentor approved, then the chain stalled: nothing grants until the HOD.
			status: "PENDING_CLASS_ADVISOR",
			mentorDecision: "APPROVED",
		});
		// Two approved requests that both cover this day, for the one student.
		await insertOdRequest({ id: `${odSuffix}-twice-1`, student: roster.twice });
		await insertOdRequest({
			id: `${odSuffix}-twice-2`,
			student: roster.twice,
			dates: [OD_DATE, NEIGHBOUR_DATE],
		});
		// Approved, but this student scans the OTP anyway: PRESENT must win.
		await insertOdRequest({ id: `${odSuffix}-present`, student: roster.present });
		/*
		 * A request filed as a From Date / To Date range, which is what the form now
		 * sends. It reaches the finalizer as the list of days it covers, exactly as the
		 * `multiday` case above reaches it by hand -- so this is the test that the range
		 * picker did not quietly turn a three-day OD into a two-day one. The 13th is in
		 * the middle of the span and is the day an ends-only reading would miss.
		 */
		await insertOdRequest({
			id: `${odSuffix}-range`,
			student: roster.range,
			dates: expandDateRange(RANGE_MIDDLE_DATE, OD_DATE),
		});
	});

	afterAll(async () => {
		const cleanup: D1PreparedStatement[] = [];
		for (const sessionId of odSessionIds) {
			cleanup.push(
				env.DB.prepare("DELETE FROM IT_Attendance_2024_2028 WHERE session_id = ?").bind(sessionId),
				env.DB.prepare("DELETE FROM attendance_session WHERE session_id = ?").bind(sessionId),
			);
		}
		for (const requestId of odRequestIds) {
			cleanup.push(env.DB.prepare("DELETE FROM od_requests WHERE od_request_id = ?").bind(requestId));
		}
		cleanup.push(
			env.DB.prepare(
				"DELETE FROM auth_sessions WHERE auth_user_id IN (SELECT auth_user_id FROM auth_users WHERE user_name LIKE ?)",
			).bind(`${odSuffix}%`),
			env.DB.prepare("DELETE FROM IT_Students_2024_2028 WHERE student_id LIKE ?").bind(`${odSuffix}%`),
			env.DB.prepare("DELETE FROM auth_users WHERE user_name LIKE ?").bind(`${odSuffix}%`),
			env.DB.prepare("DELETE FROM auth_sessions WHERE auth_user_id = ?").bind(odAdvisorAuthUserId),
			env.DB.prepare("DELETE FROM staff WHERE staff_id = ?").bind(`ODOA${testSuffix}`),
			env.DB.prepare("DELETE FROM auth_users WHERE auth_user_id = ?").bind(odAdvisorAuthUserId),
		);
		await runBatch(cleanup);
	});

	it("writes OD, not ABSENT, only for students whose approved request covers the date", async () => {
		const sessionId = await createOdSession("611111", 1, OD_DATE, true);

		const result = await finalizeSession(env.DB, sessionId);

		expect(result.success).toBe(true);
		expect(await statusFor(sessionId, roster.approved.registerNo)).toBe("OD");
		expect(await statusFor(sessionId, roster.multiday.registerNo)).toBe("OD");
		expect(await statusFor(sessionId, roster.twice.registerNo)).toBe("OD");
		// This student has an approved day too, and did not scan this session.
		expect(await statusFor(sessionId, roster.present.registerNo)).toBe("OD");
		// A request filed as a range covers this day, which is the last day it spans.
		expect(await statusFor(sessionId, roster.range.registerNo)).toBe("OD");

		// Everything that is not a fully approved request for this exact day stays ABSENT.
		expect(await statusFor(sessionId, roster.pending.registerNo)).toBe("ABSENT");
		expect(await statusFor(sessionId, roster.rejected.registerNo)).toBe("ABSENT");
		expect(await statusFor(sessionId, roster.otherday.registerNo)).toBe("ABSENT");
		expect(await statusFor(sessionId, roster.othercohort.registerNo)).toBe("ABSENT");
		expect(await statusFor(sessionId, roster.badjson.registerNo)).toBe("ABSENT");
		expect(await statusFor(sessionId, roster.partial.registerNo)).toBe("ABSENT");

		// The reported split agrees with the rows, and the three parts add up.
		expect(result.od).toBe(5);
		expect(result.present).toBe(0);
		expect(result.total_students).toBe(CASE_KEYS.length);
		expect(result.od + result.present + result.absent).toBe(result.total_students);
		expect(result.absent).toBe(CASE_KEYS.length - 5);

		// One row per student per session, still.
		expect(await rowCount(sessionId)).toBe(CASE_KEYS.length);
	});

	it("grants OD on a day in the middle of a range, not just its two ends", async () => {
		/*
		 * The question the range picker raises. `od_dates` is a list of days, so an
		 * implementation that read a range as "the first and last day only" would still
		 * pass every other case in this file while quietly shortening every multi-day
		 * OD the college grants.
		 */
		const sessionId = await createOdSession("611111R", 11, RANGE_MIDDLE_DATE, true);

		const result = await finalizeSession(env.DB, sessionId);

		expect(result.success).toBe(true);
		expect(await statusFor(sessionId, roster.range.registerNo)).toBe("OD");
		// And only for the student whose approved request actually spans this day.
		expect(await statusFor(sessionId, roster.approved.registerNo)).toBe("ABSENT");
		expect(await statusFor(sessionId, roster.otherday.registerNo)).toBe("ABSENT");
		expect(result.od).toBe(1);
	});

	it("grants OD for the right day only, and nothing for the neighbouring one", async () => {
		const sessionId = await createOdSession("611112", 2, NEIGHBOUR_DATE, true);

		const result = await finalizeSession(env.DB, sessionId);

		expect(result.success).toBe(true);
		// `approved` asked for the 14th only, so on the 15th it is an ordinary absence.
		expect(await statusFor(sessionId, roster.approved.registerNo)).toBe("ABSENT");
		expect(await statusFor(sessionId, roster.otherday.registerNo)).toBe("OD");
		expect(await statusFor(sessionId, roster.multiday.registerNo)).toBe("OD");
		expect(await statusFor(sessionId, roster.twice.registerNo)).toBe("OD");
		expect(result.od).toBe(3);
	});

	it("never overwrites a verified PRESENT with OD", async () => {
		const sessionId = await createOdSession("611113", 3, OD_DATE, false);
		const present = roster.present;

		const scan = await submitOtp(
			{
				studentId: present.studentId,
				registerNo: present.registerNo,
				authUserId: present.authUserId,
				token: present.token,
			},
			"611113",
		);
		expect(scan.status).toBe(200);
		expect(await statusFor(sessionId, present.registerNo)).toBe("PRESENT");

		// The session has to be expired before the finalizer will close it.
		await env.DB
			.prepare("UPDATE attendance_session SET expire_at = ? WHERE session_id = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), sessionId)
			.run();

		const result = await finalizeSession(env.DB, sessionId);
		expect(await statusFor(sessionId, present.registerNo)).toBe("PRESENT");
		expect(result.present).toBe(1);
	});

	it("is idempotent: a second finalization reports the same split and adds no rows", async () => {
		const sessionId = odSessionIds[odSessionIds.length - 1];
		const first = await finalizeSession(env.DB, sessionId);
		const second = await finalizeSession(env.DB, sessionId);

		expect(second).toMatchObject({
			success: true,
			total_students: first.total_students,
			present: first.present,
			absent: first.absent,
			od: first.od,
		});
		expect(await rowCount(sessionId)).toBe(first.total_students);
	});

	it("does not let a late OTP scan turn an OD row into PRESENT", async () => {
		const sessionId = await createOdSession("611114", 4, OD_DATE, true);
		await finalizeSession(env.DB, sessionId);
		expect(await statusFor(sessionId, roster.approved.registerNo)).toBe("OD");

		/*
		 * The student scans after the session is closed. Both write paths carry the
		 * ACTIVE guard, so neither touches the row: the ABSENT-to-PRESENT promotion
		 * only fires on an ABSENT row, and the guarded insert collides with the
		 * existing row and does nothing. The OD status written at finalization stands.
		 */
		const odRow = await env.DB
			.prepare(
				"SELECT id, marked_at FROM IT_Attendance_2024_2028 WHERE session_id = ? AND register_no = ? LIMIT 1",
			)
			.bind(sessionId, roster.approved.registerNo)
			.first<{ id: number; marked_at: string }>();

		const promoted = await promoteAbsentToPresentIfSessionActive(env.DB, {
			attendanceTable: "IT_Attendance_2024_2028",
			sessionId,
			rowId: Number(odRow?.id),
			markedAt: new Date().toISOString(),
		});
		expect(promoted).toBe(0);
		expect(await statusFor(sessionId, roster.approved.registerNo)).toBe("OD");

		const marked = await markPresentIfSessionActive(env.DB, {
			attendanceTable: "IT_Attendance_2024_2028",
			sessionId,
			registerNo: roster.approved.registerNo,
			section: "C",
			attendanceDate: OD_DATE,
			period: 4,
			subjectCode: "ODIT401",
			subjectName: "OD Integration",
			markedAt: new Date().toISOString(),
		});
		expect(marked).toBe(0);
		expect(await rowCount(sessionId)).toBe(CASE_KEYS.length);
		expect(await statusFor(sessionId, roster.approved.registerNo)).toBe("OD");
	});

	it("puts PRESENT, OD and ABSENT in three separate sections of the copied report", async () => {
		const sessionId = await createOdSession("611115", 5, OD_DATE, false);

		/*
		 * One of the OD-eligible students scans before the session closes, so the
		 * report has a row in each of the three sections. This is the case the
		 * requirement cares about most: a verified PRESENT must not be turned into OD
		 * by the same request that would have made an absent student OD.
		 */
		const scan = await submitOtp(
			{
				studentId: roster.present.studentId,
				registerNo: roster.present.registerNo,
				authUserId: roster.present.authUserId,
				token: roster.present.token,
			},
			"611115",
		);
		expect(scan.status).toBe(200);

		await env.DB
			.prepare("UPDATE attendance_session SET expire_at = ? WHERE session_id = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), sessionId)
			.run();
		await finalizeSession(env.DB, sessionId);

		const response = await SELF.fetch(
			`https://example.com/api/class-advisors/attendance/report?date=${OD_DATE}&period=5`,
			{ headers: { Cookie: `campus-flow-session=${odAdvisorCookie}` } },
		);
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			success: boolean;
			data?: {
				report: string;
				present: number;
				od: number;
				absent: number;
				total_strength: number;
				percentage: number;
			};
		};
		expect(body.success).toBe(true);

		const report = body.data?.report ?? "";
		expect(report).toContain("PRESENT (1)");
		expect(report).toContain("OD (4)");
		expect(report).toContain("ABSENT (6)");

		// Names and register numbers, one line each. The roster is register-ordered, so
		// the OD students appear as APPROVED, MULTIDAY, RANGE, TWICE.
		expect(report).toContain(`1. PRESENT (${roster.present.registerNo})`);
		expect(report).toContain(`1. APPROVED (${roster.approved.registerNo})`);
		expect(report).toContain(`2. MULTIDAY (${roster.multiday.registerNo})`);
		expect(report).toContain(`3. RANGE (${roster.range.registerNo})`);
		expect(report).toContain(`4. TWICE (${roster.twice.registerNo})`);

		// The counts the route reports match the text it produced.
		expect(body.data?.total_strength).toBe(CASE_KEYS.length);
		expect(body.data?.present).toBe(1);
		expect(body.data?.od).toBe(4);
		expect(body.data?.absent).toBe(6);
		// (1 present + 4 on duty) / 11 = 45%.
		expect(body.data?.percentage).toBe(45);
		expect(report).toContain("Attendance Percentage: 45%");

		// OD is never also listed as an absentee, and PRESENT is not either.
		const odSection = report.slice(report.indexOf("OD (4)"), report.indexOf("ABSENT (6)"));
		const absentSection = report.slice(report.indexOf("ABSENT (6)"));
		expect(odSection).toContain(roster.approved.registerNo);
		expect(absentSection).not.toContain(roster.approved.registerNo);
		expect(absentSection).not.toContain(roster.present.registerNo);

		// And the PRESENT row is genuinely in the PRESENT section.
		const presentSection = report.slice(report.indexOf("PRESENT (1)"), report.indexOf("OD (4)"));
		expect(presentSection).toContain(roster.present.registerNo);
	});

	it("counts an OD student as marked, not unmarked, in the session summary", async () => {
		const sessionId = await createOdSession("611116", 6, OD_DATE, true);
		await finalizeSession(env.DB, sessionId);

		// The route the staff dashboard's summary reads from.
		const response = await SELF.fetch(
			`https://example.com/api/attendance/session/${sessionId}`,
			{ headers: { Cookie: `campus-flow-session=${odAdvisorCookie}` } },
		);
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			success: boolean;
			data?: {
				students: Array<{ register_no: string; status: string | null }>;
				summary: {
					totalStrength: number;
					presentCount: number;
					absentCount: number;
					odCount: number;
					unmarkedCount: number;
					percentage: number;
				};
			};
		};
		expect(body.success).toBe(true);

		const summary = body.data?.summary;
		expect(summary?.totalStrength).toBe(CASE_KEYS.length);
		expect(summary?.presentCount).toBe(0);
		expect(summary?.odCount).toBe(5);
		expect(summary?.absentCount).toBe(6);
		// The three marked categories account for the whole class; an OD student is
		// not an unmarked one.
		expect(summary?.unmarkedCount).toBe(0);
		// (0 present + 5 on duty) / 11 = 45%.
		expect(summary?.percentage).toBe(45);

		const approvedRow = body.data?.students.find(
			(s) => s.register_no === roster.approved.registerNo,
		);
		expect(approvedRow?.status).toBe("OD");
	});
});