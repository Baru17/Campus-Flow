import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/utils/auth";
import { finalizeSession } from "../src/api/attendance";
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
				attendance_table, status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
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
			`INSERT INTO staff (staff_id, staff_name, email, department, advisor_year, advisor_section, auth_user_id)
			 VALUES (?, 'Load Test Advisor', ?, 'IT', 3, 'A', ?)`,
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