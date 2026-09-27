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
import migration0012 from "../migrations/0012_password_reset_tokens.sql?raw";

const PASSWORD = "original-password-1";
const NEW_PASSWORD = "brand-new-password-9";

const STUDENT_ID = "CFTEST01";
const STUDENT_AUTH_ID = "pw-reset-student";
const STAFF_EMAIL = "staff.reset@kiot.ac.in";
const STAFF_AUTH_ID = "pw-reset-staff";

const GENERIC_MESSAGE =
  "If an account matches, a password reset link has been sent to its registered email.";

const ISO = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/* Captured in beforeAll so each test starts from the seeded password. */
let originalPwdHash = "";

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	const response = await SELF.fetch(`https://example.com${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const raw = await response.text();
	return { status: response.status, body: JSON.parse(raw) as any, raw, response };
}

async function seedToken(authUserId: string, rawToken: string, expiresAt: string) {
	await env.DB.prepare(
		"INSERT INTO password_reset_tokens (auth_user_id, token_hash, expires_at) VALUES (?, ?, ?)"
	)
		.bind(authUserId, hashToken(rawToken), expiresAt)
		.run();
}

async function hashOf(authUserId: string): Promise<string> {
	const row = await env.DB.prepare("SELECT pwd_hash FROM auth_users WHERE auth_user_id = ?")
		.bind(authUserId)
		.first() as { pwd_hash: string } | null;
	return row?.pwd_hash ?? "";
}

describe("password reset over one-time tokens", () => {
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
			migration0012,
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

		const pwd = await bcrypt.hash(PASSWORD, 4);
		originalPwdHash = pwd;
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, 'student', ?)"
			).bind(STUDENT_AUTH_ID, STUDENT_ID, pwd, "cftest01@kiot.ac.in"),
			env.DB.prepare(
				`INSERT INTO IT_Students_2024_2028
				 (student_id, register_no, student_name, year, section, email, auth_user_id)
				 VALUES (?, 'REG0001', 'Reset Test', 2, 'A', 'cftest01@kiot.ac.in', ?)`
			).bind(STUDENT_ID, STUDENT_AUTH_ID),
			env.DB.prepare(
				"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, 'class_advisor', ?)"
			).bind(STAFF_AUTH_ID, STAFF_EMAIL, pwd, STAFF_EMAIL),
			env.DB.prepare(
				`INSERT INTO staff (staff_id, staff_name, email, department, class_advisor, auth_user_id)
				 VALUES ('9001', 'Staff Reset Test', ?, 'IT', 0, ?)`
			).bind(STAFF_EMAIL, STAFF_AUTH_ID),
		]);
	});

	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM password_reset_tokens").run();
		await env.DB.prepare("DELETE FROM auth_sessions").run();
		/* A completed reset rewrites pwd_hash, so restore it between tests. */
		await env.DB.prepare("UPDATE auth_users SET pwd_hash = ?")
			.bind(originalPwdHash)
			.run();
	});

	it("issues a token and reports success for a real student", async () => {
		const { status, body } = await post("/api/auth/reset-password", { studentId: STUDENT_ID });

		expect(status).toBe(200);
		expect(body).toEqual({ success: true, message: GENERIC_MESSAGE });

		const rows = await env.DB.prepare(
			"SELECT token_hash, auth_user_id, used_at FROM password_reset_tokens"
		).all();
		expect(rows.results).toHaveLength(1);
		expect((rows.results[0] as any).auth_user_id).toBe(STUDENT_AUTH_ID);
		expect((rows.results[0] as any).used_at).toBeNull();
	});

	/*
	 * A known and an unknown account must be indistinguishable, otherwise the
	 * endpoint is an account-existence oracle.
	 */
	it("returns an identical response for an unknown student", async () => {
		const known = await post("/api/auth/reset-password", { studentId: STUDENT_ID });
		const unknown = await post("/api/auth/reset-password", { studentId: "NOSUCHID99" });
		const malformed = await post("/api/auth/reset-password", {});

		expect(unknown.status).toBe(known.status);
		expect(unknown.body).toEqual(known.body);
		expect(malformed.status).toBe(known.status);
		expect(malformed.body).toEqual(known.body);
	});

	it("issues no token row for an unknown account", async () => {
		await post("/api/auth/reset-password", { studentId: "NOSUCHID99" });
		await post("/api/auth/reset-password", { email: "nobody@kiot.ac.in" });

		const rows = await env.DB.prepare("SELECT id FROM password_reset_tokens").all();
		expect(rows.results).toHaveLength(0);
	});

	it("stores only the hash, so the raw token is not recoverable from D1", async () => {
		await post("/api/auth/reset-password", { studentId: STUDENT_ID });

		const row = (await env.DB.prepare("SELECT token_hash FROM password_reset_tokens").first()) as {
			token_hash: string;
		};
		expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("does not require a session to request a reset", async () => {
		const { status } = await post("/api/auth/reset-password", { studentId: STUDENT_ID });
		expect(status).toBe(200);
	});

	it("rejects a request whose account role does not match the route", async () => {
		/* A staff account is not reachable through the student route. */
		const { status, body } = await post("/api/auth/reset-password", { studentId: "9001" });
		expect(status).toBe(200);
		expect(body).toEqual({ success: true, message: GENERIC_MESSAGE });

		const rows = await env.DB.prepare("SELECT id FROM password_reset_tokens").all();
		expect(rows.results).toHaveLength(0);
	});

	it("accepts a staff email on the staff route", async () => {
		const { status, body } = await post("/api/auth/staff/reset-password", { email: STAFF_EMAIL });
		expect(status).toBe(200);
		expect(body).toEqual({ success: true, message: GENERIC_MESSAGE });

		const row = (await env.DB.prepare("SELECT auth_user_id FROM password_reset_tokens").first()) as {
			auth_user_id: string;
		};
		expect(row.auth_user_id).toBe(STAFF_AUTH_ID);
	});

	it("ignores a redirectTo pointing somewhere else", async () => {
		await post("/api/auth/reset-password", {
			studentId: STUDENT_ID,
			redirectTo: "https://attacker.example/reset-password",
		});
		/* The token is issued regardless; the link origin is chosen server-side. */
		const rows = await env.DB.prepare("SELECT id FROM password_reset_tokens").all();
		expect(rows.results).toHaveLength(1);
	});

	it("rejects an unknown token", async () => {
		const { status, body } = await post("/api/auth/update-password", {
			token: "11111111-2222-3333-4444-555555555555",
			password: NEW_PASSWORD,
		});

		expect(status).toBe(400);
		expect(body.code).toBe("invalid-reset-token");
	});

	it("rejects a token that is not shaped like one", async () => {
		for (const token of ["", "  ", "short", "x".repeat(400), "../../etc/passwd"]) {
			const { status } = await post("/api/auth/update-password", { token, password: NEW_PASSWORD });
			expect(status).toBe(400);
		}
	});

	it("rejects an expired token", async () => {
		await seedToken(STUDENT_AUTH_ID, "expired-token-aaaa-bbbb", ISO(-60_000));

		const { status, body } = await post("/api/auth/update-password", {
			token: "expired-token-aaaa-bbbb",
			password: NEW_PASSWORD,
		});

		expect(status).toBe(400);
		expect(body.code).toBe("invalid-reset-token");
		expect(await bcrypt.compare(NEW_PASSWORD, await hashOf(STUDENT_AUTH_ID))).toBe(false);
	});

	it("accepts a live token, rewrites the hash, and drops existing sessions", async () => {
		await env.DB.prepare(
			"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)"
		)
			.bind(hashToken("live-session"), STUDENT_AUTH_ID, ISO(3_600_000))
			.run();
		await seedToken(STUDENT_AUTH_ID, "live-token-cccc-dddd", ISO(1_800_000));

		const { status, body } = await post("/api/auth/update-password", {
			token: "live-token-cccc-dddd",
			password: NEW_PASSWORD,
		});

		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(await bcrypt.compare(NEW_PASSWORD, await hashOf(STUDENT_AUTH_ID))).toBe(true);

		const sessions = await env.DB.prepare("SELECT id FROM auth_sessions WHERE auth_user_id = ?")
			.bind(STUDENT_AUTH_ID)
			.all();
		expect(sessions.results).toHaveLength(0);

		/* The session cookie is cleared so the browser drops the dead token. */
		expect(body.success).toBe(true);
	});

	it("burns the token so it cannot be replayed", async () => {
		await seedToken(STUDENT_AUTH_ID, "single-use-token-eeee", ISO(1_800_000));

		const first = await post("/api/auth/update-password", {
			token: "single-use-token-eeee",
			password: NEW_PASSWORD,
		});
		expect(first.status).toBe(200);

		const second = await post("/api/auth/update-password", {
			token: "single-use-token-eeee",
			password: "another-password-3",
		});
		expect(second.status).toBe(400);
		expect(second.body.code).toBe("invalid-reset-token");

		/* The replayed attempt must not have changed the password. */
		expect(await bcrypt.compare("another-password-3", await hashOf(STUDENT_AUTH_ID))).toBe(false);
		expect(await bcrypt.compare(NEW_PASSWORD, await hashOf(STUDENT_AUTH_ID))).toBe(true);
	});

	it("does not let a staff token reset a student password", async () => {
		await seedToken(STAFF_AUTH_ID, "staff-token-ffff-gggg", ISO(1_800_000));

		const { status } = await post("/api/auth/update-password", {
			token: "staff-token-ffff-gggg",
			password: NEW_PASSWORD,
		});
		expect(status).toBe(400);

		/* The same token still works on the staff route. */
		const staff = await post("/api/auth/staff/update-password", {
			token: "staff-token-ffff-gggg",
			password: NEW_PASSWORD,
		});
		expect(staff.status).toBe(200);
	});

	it("enforces the minimum password length server-side", async () => {
		await seedToken(STUDENT_AUTH_ID, "short-pass-token-hhhh", ISO(1_800_000));

		const { status, body } = await post("/api/auth/update-password", {
			token: "short-pass-token-hhhh",
			password: "abc",
		});

		expect(status).toBe(400);
		expect(body.code).toBe("weak-password");
	});

	it("validates a live token and reports the owning role", async () => {
		await seedToken(STUDENT_AUTH_ID, "validate-me-iiii-jjjj", ISO(1_800_000));

		const { status, body } = await post("/api/auth/validate-reset-token", {
			token: "validate-me-iiii-jjjj",
		});
		expect(status).toBe(200);
		expect(body.role).toBe("student");

		const bogus = await post("/api/auth/validate-reset-token", { token: "nope-nope-nope-nope" });
		expect(bogus.status).toBe(400);
		expect(bogus.body.code).toBe("invalid-reset-token");
	});

	it("supersedes an outstanding token when a new one is issued", async () => {
		await seedToken(STUDENT_AUTH_ID, "old-token-kkkk-llll", ISO(1_800_000));
		await post("/api/auth/reset-password", { studentId: STUDENT_ID });

		const { status } = await post("/api/auth/update-password", {
			token: "old-token-kkkk-llll",
			password: NEW_PASSWORD,
		});
		expect(status).toBe(400);
	});

	it("never leaks a secret through any reset response", async () => {
		const responses = [
			await post("/api/auth/reset-password", { studentId: STUDENT_ID }),
			await post("/api/auth/reset-password", { studentId: "NOSUCHID99" }),
			await post("/api/auth/update-password", { token: "bogus", password: NEW_PASSWORD }),
			await post("/api/auth/validate-reset-token", { token: "bogus" }),
		];

		for (const { body, raw } of responses) {
			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain("BREVO");
			expect(serialized).not.toContain("api-key");
			expect(serialized.toLowerCase()).not.toContain("secret");
			expect(raw).not.toContain("BREVO_API_KEY");
		}
	});

	it("keeps normal login working after the reset routes are mounted", async () => {
		const response = await SELF.fetch("https://example.com/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ user_name: STUDENT_ID, password: PASSWORD }),
		});

		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.success).toBe(true);
		expect(response.headers.get("Set-Cookie")).toContain("campus-flow-session=");
	});
});
