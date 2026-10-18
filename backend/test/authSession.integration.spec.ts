/**
 * The session contract behind `GET /api/auth/user`, end to end against a real D1.
 *
 * ## Why this file exists
 *
 * `GET /api/auth/user` answers `401` to a browser that has no valid session, and every
 * browser logs that status line whether or not the application handles it. Reporting
 * repeated 401s for that endpoint is therefore ambiguous by nature: it can be the correct
 * answer to a visitor who has not signed in, or it can be a real authentication
 * regression. These tests make the difference decidable by pinning, for each case, what
 * the server actually says.
 *
 * The four states a session can be in, and the answer each must get:
 *
 *   - **valid** -- a cookie whose hash matches a live `auth_sessions` row: `200` and the
 *     account.
 *   - **missing** -- no cookie at all, which is what every signed-out visitor sends:
 *     `401 auth-required`.
 *   - **unknown** -- a cookie no row matches, e.g. a session deleted by a sign-out the
 *     browser never saw: `401 auth-required`.
 *   - **expired** -- a matching row whose `expires_at` has passed: `401 auth-required`,
 *     reached by writing the timestamp rather than by waiting.
 *
 * `auth-required` is asserted on every one of them, so a change that swapped the code --
 * or the status -- for anything else fails here rather than reaching a browser as an
 * unexplained red line.
 *
 * ## What this file must not become
 *
 * A test for "an unauthenticated page load is fine". It is not fine to be permissive
 * here. Everything below asserts the opposite: that an unauthenticated caller gets `401`
 * from every session-guarded surface, and that a `401` is never softened into a `200`.
 * The one place a signed-out visitor is *expected* to see `401` is the top of the page,
 * which is the answer the browser was reporting.
 *
 * ## Role-based access
 *
 * Every role the application has -- student, staff, class advisor, contest coordinator,
 * HOD, admin -- is exercised against `/api/auth/user` and against a role-gated route, so
 * that a change to the shared read cannot quietly widen or narrow who may enter.
 *
 * ## CORS and the cookie
 *
 * The browser only ever calls this API through the `/api` proxy on its own origin, so
 * the session cookie is first-party and is sent with `credentials: 'include'`. The
 * deployed frontend origin is asserted to be allowed *with credentials*, and an
 * unrelated origin is asserted not to be, because a wildcard or a missing
 * `Allow-Credentials` is what turns a working session into a silent sign-out.
 *
 * Each test file gets isolated storage and applies the migrations itself. Nothing here
 * waits on a clock.
 */

import { env, SELF } from "cloudflare:test";
import bcrypt from "bcryptjs";
import { beforeAll, describe, expect, it } from "vitest";
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
/* Adds the advisor columns `staff` is written against below. */
import migration0013 from "../migrations/0013_department-aware-attendance.sql?raw";
/* Replaces the seeded subject table with the simplified one `/api/subjects` reads. */
import migration0015 from "../migrations/0015_simplify-subjects.sql?raw";
/* `academic_batches`, which the per-request registry hydration reads. */
import migration0016 from "../migrations/0016_academic_batches.sql?raw";
/* The HOD and contest-coordinator directories `/api/od/approver/me` resolves against. */
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
	migration0015,
	migration0016,
	migration0018,
];

const PASSWORD = "correct-horse-battery-staple";
const HOUR_MS = 60 * 60_000;

/* The one name `utils/auth.ts` reads the cookie by. Kept as a literal here on purpose:
 * asserting against the constant would pass even if the constant changed. */
const COOKIE_NAME = "campus-flow-session";

/** The deployed frontend. Requests arrive through the Pages `/api` proxy on this origin. */
const FRONTEND_ORIGIN = "https://campus-flow-cdl.pages.dev";

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

interface Account {
	authUserId: string;
	token: string;
	userName: string;
	role: string;
}

/**
 * Creates an account and, unless told otherwise, one live session for it.
 *
 * `expiresAt` is written directly rather than reached by waiting, so the expiry test is a
 * statement about the comparison rather than a race against a timer.
 */
async function makeAccount(
	role: string,
	label: string,
	options: { expiresAt?: string | null; userName?: string } = {},
): Promise<Account> {
	const { expiresAt, userName } = options;
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
	const authUserId = `c9e9f100-0000-4000-8000-${label}${suffix}`;
	const resolvedUserName = userName ?? `${label}.${suffix}@kiot.ac.in`;
	const token = `${label}-token-${suffix}`;
	const pwdHash = await bcrypt.hash(PASSWORD, 4);

	const statements: D1PreparedStatement[] = [
		env.DB
			.prepare(
				`INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(authUserId, resolvedUserName, pwdHash, role, resolvedUserName),
	];

	if (expiresAt !== null) {
		statements.push(
			env.DB
				.prepare(
					"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)",
				)
				.bind(hashToken(token), authUserId, expiresAt ?? new Date(Date.now() + HOUR_MS).toISOString()),
		);
	}

	await env.DB.batch(statements);
	return { authUserId, token, userName: resolvedUserName, role };
}

/** A student account linked to a roster row, which is what `/api/auth/login` requires. */
async function makeStudent(options: { expiresAt?: string | null } = {}): Promise<Account> {
	const account = await makeAccount("student", "student", options);
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
	await env.DB
		.prepare(
			`INSERT INTO IT_Students_2024_2028
			 (student_id, register_no, student_name, year, section, email, auth_user_id)
			 VALUES (?, ?, ?, 3, 'A', ?, ?)`,
		)
		.bind(`S${suffix.toUpperCase()}`, `R${suffix.toUpperCase()}`, "Session Test", account.userName, account.authUserId)
		.run();
	return account;
}

/**
 * A staff account, with the account role that role actually is.
 *
 * `makeStaff("staff")` is a member of staff and `makeStaff("advisor")` is a class advisor:
 * they are different roles on the account, not one role read two ways, and the assertions
 * below depend on telling them apart.
 */
async function makeStaff(label: string): Promise<Account> {
	const role = label === "advisor" ? "class_advisor" : "staff";
	const account = await makeAccount(role, label);
	await env.DB
		.prepare(
			`INSERT INTO staff (staff_id, staff_name, email, department, class_advisor, auth_user_id)
			 VALUES (?, ?, ?, 'IT', ?, ?)`,
		)
		.bind(
			label.slice(0, 3).toUpperCase() + crypto.randomUUID().replaceAll("-", "").slice(0, 6),
			`Session ${label}`,
			account.userName,
			role === "class_advisor" ? "Y" : "N",
			account.authUserId,
		)
		.run();
	return account;
}

/**
 * An admin account. The admin login route only accepts this exact address, and
 * `auth_users.user_name` is unique, so this file creates exactly one and shares it.
 */
let adminAccount: Account;

async function createAdminAccount(): Promise<Account> {
	return makeAccount("admin", "admin", { userName: "admin@kiot.ac.in" });
}

/* --------------------------------------------------------------- requests */

function cookieFor(account: Account): string {
	return `${COOKIE_NAME}=${account.token}`;
}

function get(path: string, account?: Account): Promise<Response> {
	return SELF.fetch(`https://example.com${path}`, {
		headers: account ? { Cookie: cookieFor(account) } : {},
	});
}

async function post(path: string, account?: Account, body = "{}"): Promise<Response> {
	return SELF.fetch(`https://example.com${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(account ? { Cookie: cookieFor(account) } : {}),
		},
		body,
	});
}

/* --------------------------------------------------------------- the suite */

describe("GET /api/auth/user", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}
		adminAccount = await createAdminAccount();
	});

	describe("a valid session", () => {
		it("answers with the account", async () => {
			const student = await makeStudent();

			const response = await get("/api/auth/user", student);

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				success: boolean;
				user: { auth_user_id: string; role: string };
			};
			expect(body.success).toBe(true);
			expect(body.user.auth_user_id).toBe(student.authUserId);
			expect(body.user.role).toBe("student");
		});

		it("never returns the password hash or the raw token", async () => {
			const student = await makeStudent();

			const response = await get("/api/auth/user", student);
			const raw = await response.text();

			expect(raw).not.toContain("pwd_hash");
			expect(raw).not.toContain(PASSWORD);
			expect(raw).not.toContain(student.token);
		});

		it("carries the session cookie on every call, because the answer depends on it", async () => {
			const student = await makeStudent();

			/* Sent as the browser sends it: first-party, with credentials. */
			const response = await SELF.fetch("https://example.com/api/auth/user", {
				headers: { Cookie: cookieFor(student), Origin: FRONTEND_ORIGIN },
			});

			expect(response.status).toBe(200);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(FRONTEND_ORIGIN);
			expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		});
	});

	describe("a missing session", () => {
		it("answers 401 when no cookie is sent at all", async () => {
			/* What every signed-out visitor sends, and what the browser was reporting. */
			const response = await get("/api/auth/user");

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ success: false, code: "auth-required" });
		});

		it("answers 401 when the cookie is present but empty", async () => {
			const response = await SELF.fetch("https://example.com/api/auth/user", {
				headers: { Cookie: `${COOKIE_NAME}=` },
			});

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ code: "auth-required" });
		});

		it("answers 401 rather than a body describing a user", async () => {
			const response = await get("/api/auth/user");
			const body = (await response.json()) as Record<string, unknown>;

			expect(body.user).toBeUndefined();
			expect(body.success).toBe(false);
		});
	});

	describe("a session that cannot be honoured", () => {
		it("answers 401 for a token no session row matches", async () => {
			/* What is left in the cookie jar after a sign-out the browser never saw. */
			const account = await makeStudent();
			await env.DB.prepare("DELETE FROM auth_sessions WHERE auth_user_id = ?").bind(account.authUserId).run();

			const response = await get("/api/auth/user", account);

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ code: "auth-required" });
		});

		it("answers 401 for a session that expired an hour ago", async () => {
			const student = await makeStudent({
				expiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
			});

			const response = await get("/api/auth/user", student);

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ code: "auth-required" });
		});

		it("answers 401 for a session that expired a second ago", async () => {
			/* The boundary, without a sleep: `expires_at` in the past by one second. */
			const account = await makeAccount("student", "expired", {
				expiresAt: new Date(Date.now() - 1000).toISOString(),
			});

			const response = await get("/api/auth/user", account);

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ code: "auth-required" });
		});

		it("answers 200 for a session that has not expired yet", async () => {
			/* The other side of the same comparison, so the boundary is pinned both ways. */
			const account = await makeAccount("student", "fresh", {
				expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
			});

			const response = await get("/api/auth/user", account);

			expect(response.status).toBe(200);
		});

		it("answers 401 for a session whose account has been deleted", async () => {
			/* The join is what makes this fail closed: a session row alone is not an account. */
			const account = await makeAccount("student", "orphan");
			await env.DB.prepare("DELETE FROM auth_users WHERE auth_user_id = ?").bind(account.authUserId).run();

			const response = await get("/api/auth/user", account);

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ code: "auth-required" });
		});
	});

	describe("an unauthenticated page load", () => {
		/*
		 * A browser opening any page of the app sends no cookie until somebody signs in.
		 * Every session-guarded surface has to say so the same way, because the client's
		 * shared session read treats `401` as "no session" and anything else as a failure
		 * worth reporting.
		 */
		const guarded: ReadonlyArray<{ path: string; method: "GET" | "POST" }> = [
			{ path: "/api/auth/user", method: "GET" },
			{ path: "/api/auth/session", method: "GET" },
			{ path: "/api/auth/auth/student", method: "GET" },
			{ path: "/api/auth/staff/any-account", method: "GET" },
			{ path: "/api/auth/logout", method: "POST" },
			{ path: "/api/auth/staff/logout", method: "POST" },
			{ path: "/api/auth/admin/logout", method: "POST" },
			{ path: "/api/subjects", method: "GET" },
			{ path: "/api/batches", method: "GET" },
			{ path: "/api/od/approver/me", method: "GET" },
			{ path: "/api/activity/ping", method: "POST" },
		];

		for (const route of guarded) {
			it(`answers 401 auth-required for ${route.method} ${route.path} with no session`, async () => {
				const response =
					route.method === "GET" ? await get(route.path) : await post(route.path);

				expect(response.status).toBe(401);
				expect(await response.json()).toMatchObject({ success: false, code: "auth-required" });
			});
		}

		it("still serves the health check, which is not a session surface", async () => {
			const response = await get("/api/health");

			expect(response.status).toBe(200);
		});
	});

	describe("signing out", () => {
		it("deletes the session and refuses the token immediately afterwards", async () => {
			const student = await makeStudent();
			expect((await get("/api/auth/user", student)).status).toBe(200);

			const loggedOut = await post("/api/auth/logout", student);
			expect(loggedOut.status).toBe(200);

			/*
			 * Two separate things are asserted here on purpose. The row is gone, so the
			 * token is dead even if the browser keeps sending it -- which is what stops a
			 * stolen cookie surviving a sign-out.
			 */
			const row = await env.DB
				.prepare("SELECT id FROM auth_sessions WHERE auth_user_id = ?")
				.bind(student.authUserId)
				.first();
			expect(row).toBeNull();

			const afterwards = await get("/api/auth/user", student);
			expect(afterwards.status).toBe(401);
			expect(await afterwards.json()).toMatchObject({ code: "auth-required" });
		});

		it("clears the cookie with the attributes it was set with", async () => {
			const student = await makeStudent();

			const response = await post("/api/auth/logout", student);
			const cleared = response.headers.get("Set-Cookie") ?? "";

			expect(cleared).toContain(`${COOKIE_NAME}=`);
			expect(cleared).toContain("Max-Age=0");
			expect(cleared).toContain("HttpOnly");
			expect(cleared).toContain("Path=/");
			/* SameSite is what the browser enforces, so it has to match what set it. */
			expect(cleared).toContain("SameSite=None");
		});

		it("leaves the other sessions of the same account alone", async () => {
			/* Two devices, one of them signs out. The other is a separate session row. */
			const student = await makeStudent();
			const secondDevice = `${student.token}-device-2`;
			await env.DB
				.prepare(
					"INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)",
				)
				.bind(hashToken(secondDevice), student.authUserId, new Date(Date.now() + HOUR_MS).toISOString())
				.run();

			await post("/api/auth/logout", student);

			const response = await SELF.fetch("https://example.com/api/auth/user", {
				headers: { Cookie: `${COOKIE_NAME}=${secondDevice}` },
			});
			expect(response.status).toBe(200);
		});

		it("refuses to sign out a session that is not there", async () => {
			/* Answered, not crashed: a sign-out with no session is still a sign-out. */
			const response = await post("/api/auth/logout");

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ code: "auth-required" });
		});
	});

	describe("role-based access", () => {
		it("answers for a member of staff", async () => {
			const staff = await makeStaff("staff");

			const response = await get("/api/auth/user", staff);

			expect(response.status).toBe(200);
			expect((await response.json()).user.role).toBe("staff");
		});

		it("answers for a class advisor", async () => {
			const advisor = await makeStaff("advisor");

			const response = await get("/api/auth/user", advisor);

			expect(response.status).toBe(200);
			expect((await response.json()).user.role).toBe("class_advisor");
		});

		it("answers for an admin", async () => {
			const response = await get("/api/auth/user", adminAccount);

			expect(response.status).toBe(200);
			expect((await response.json()).user.role).toBe("admin");
		});

		it("answers for a contest coordinator, whose account role is the staff one", async () => {
			/*
			 * A coordinator is appointed out of the staff roster and reuses that login, so
			 * the account says `staff`. The `/api/auth/user` contract is unchanged: it
			 * reports the account, and the directory decides the dashboard.
			 */
			const coordinator = await makeStaff("coordinator");
			await env.DB
				.prepare(
					`INSERT INTO contest_coordinators (coordinator_name, email, department, auth_user_id)
					 VALUES (?, ?, 'IT', ?)`,
				)
				.bind("Session Coordinator", coordinator.userName, coordinator.authUserId)
				.run();

			const response = await get("/api/auth/user", coordinator);
			expect(response.status).toBe(200);
			expect((await response.json()).user.role).toBe("staff");

			const approver = await get("/api/od/approver/me", coordinator);
			expect(approver.status).toBe(200);
			expect((await approver.json()).approver.role).toBe("contest_coordinator");
		});

		it("answers for a head of department", async () => {
			const hod = await makeAccount("hod", "hod");
			await env.DB
				.prepare(
					`INSERT INTO hods (hod_name, email, department, auth_user_id)
					 VALUES (?, ?, 'IT', ?)`,
				)
				.bind("Session HOD", hod.userName, hod.authUserId)
				.run();

			const response = await get("/api/auth/user", hod);
			expect(response.status).toBe(200);
			expect((await response.json()).user.role).toBe("hod");

			const approver = await get("/api/od/approver/me", hod);
			expect(approver.status).toBe(200);
			expect((await approver.json()).approver.role).toBe("hod");
		});

		it("keeps a student out of the staff-gated catalog", async () => {
			const student = await makeStudent();

			const response = await get("/api/subjects", student);

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "forbidden" });
		});

		it("keeps a student out of the staff-gated batch picker", async () => {
			const student = await makeStudent();

			const response = await get("/api/batches", student);

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "forbidden" });
		});

		it("keeps staff out of the student-only record", async () => {
			const staff = await makeStaff("staff");

			const response = await get("/api/auth/auth/student", staff);

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "forbidden" });
		});

		it("keeps an admin out of the staff-gated catalog", async () => {
			const response = await get("/api/subjects", adminAccount);

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "forbidden" });
		});

		it("lets a class advisor read the staff-gated catalog", async () => {
			const advisor = await makeStaff("advisor");

			const response = await get("/api/subjects", advisor);

			expect(response.status).toBe(200);
		});

		it("keeps a student and an admin out of the approver surface", async () => {
			const student = await makeStudent();

			for (const account of [student, adminAccount]) {
				const response = await get("/api/od/approver/me", account);
				expect(response.status).toBe(403);
				expect(await response.json()).toMatchObject({ code: "od-not-an-approver" });
			}
		});
	});

	describe("CORS", () => {
		it("allows the deployed frontend origin with credentials", async () => {
			const response = await SELF.fetch("https://example.com/api/auth/user", {
				headers: { Origin: FRONTEND_ORIGIN },
			});

			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(FRONTEND_ORIGIN);
			expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		});

		it("allows the deployment preview host on the same project", async () => {
			const previewOrigin = "https://d47477a0.campus-flow-cdl.pages.dev";

			const response = await SELF.fetch("https://example.com/api/auth/user", {
				headers: { Origin: previewOrigin },
			});

			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(previewOrigin);
		});

		it("does not hand an unrelated origin permission to read with credentials", async () => {
			const response = await SELF.fetch("https://example.com/api/auth/user", {
				headers: { Origin: "https://campus-flow.example.com" },
			});

			expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
		});

		it("answers a preflight from the deployed origin", async () => {
			const response = await SELF.fetch("https://example.com/api/auth/user", {
				method: "OPTIONS",
				headers: {
					Origin: FRONTEND_ORIGIN,
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "Content-Type",
				},
			});

			expect(response.status).toBeLessThan(300);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(FRONTEND_ORIGIN);
			expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		});
	});
});
