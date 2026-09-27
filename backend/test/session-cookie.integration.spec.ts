import { env, SELF } from "cloudflare:test";
import bcrypt from "bcryptjs";
import { beforeAll, describe, expect, it } from "vitest";
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

const PASSWORD = "correct-horse-battery-staple";
const testSuffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const staffEmail = `cookie-test-${testSuffix}@kiot.ac.in`;
const authUserId = `cookie-test-auth-${testSuffix}`;

async function login(headers: Record<string, string> = {}): Promise<string> {
	const response = await SELF.fetch("https://example.com/api/auth/staff/login", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ email: staffEmail, password: PASSWORD }),
	});
	expect(response.status).toBe(200);
	return response.headers.get("Set-Cookie") ?? "";
}

describe("session cookie attributes", () => {
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

		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
				 VALUES (?, ?, ?, 'staff', ?)`,
			).bind(authUserId, staffEmail, await bcrypt.hash(PASSWORD, 4), staffEmail),
			env.DB.prepare(
				`INSERT INTO staff (staff_id, staff_name, email, department, class_advisor, auth_user_id)
				 VALUES (?, ?, ?, 'IT', 0, ?)`,
			).bind(`9${testSuffix.slice(0, 6)}`, "Cookie Test", staffEmail, authUserId),
		]);
	});

	/*
	 * A dev/preview proxy or the Pages Function re-originates the request over
	 * HTTPS, so the Worker must judge the cookie by the scheme the *browser* is
	 * on. A `Secure; Partitioned; SameSite=None` cookie handed to a page on
	 * http://localhost is third-party and gets dropped without warning, which
	 * is what made login return 200 with an already-dead session.
	 */
	it("drops the cross-site attributes when a proxy reports a plain HTTP client", async () => {
		const cookie = await login({ "X-Forwarded-Proto": "http" });

		expect(cookie).toContain("campus-flow-session=");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).not.toContain("Secure");
		expect(cookie).not.toContain("Partitioned");
	});

	it("keeps the cross-site attributes for a direct HTTPS client", async () => {
		const cookie = await login();

		expect(cookie).toContain("SameSite=None");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("Partitioned");
	});

	it("ignores a forged multi-value header and stays on HTTPS", async () => {
		const cookie = await login({ "X-Forwarded-Proto": "http, https" });

		expect(cookie).toContain("Secure");
	});

	it("always marks the cookie HttpOnly so script cannot read the token", async () => {
		expect(await login({ "X-Forwarded-Proto": "http" })).toContain("HttpOnly");
		expect(await login()).toContain("HttpOnly");
	});

	it("clears the cookie with the same attributes it set it with", async () => {
		const token = new URLSearchParams(
			(await login({ "X-Forwarded-Proto": "http" })).split(";")[0],
		).get("campus-flow-session");
		expect(token).toBeTruthy();

		const response = await SELF.fetch("https://example.com/api/auth/staff/logout", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `campus-flow-session=${token}`,
				"X-Forwarded-Proto": "http",
			},
			body: "{}",
		});

		expect(response.status).toBe(200);
		const cleared = response.headers.get("Set-Cookie") ?? "";
		expect(cleared).toContain("Max-Age=0");
		expect(cleared).toContain("SameSite=Lax");
		expect(cleared).not.toContain("Secure");
	});
});
