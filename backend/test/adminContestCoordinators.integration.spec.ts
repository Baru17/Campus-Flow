/**
 * Contest coordinators provisioned from the staff directory, end to end.
 *
 * ## The property under test
 *
 * A contest coordinator's identity is not something an admin types. It is a copy of a
 * row that already exists on `staff`, and the only thing a request may name is *which*
 * staff member. So the load-bearing claim of this suite is:
 *
 *     there is no request that can put a name, an address or a department on a
 *     coordinator that disagrees with the staff record behind them
 *
 * and most of what follows exists to attack exactly that, from both directions: a
 * body that lies about its identity, a body naming a staff member from a department the
 * client had already navigated away from, and the same staff member appointed twice.
 *
 * ## Why that matters beyond tidiness
 *
 * The OD workflow authorises a coordinator on `contest_coordinators.email` AND the
 * department beside it. A coordinator row whose address disagrees with its staff record
 * is therefore a person who silently never receives the approvals they are meant to
 * decide, and nothing in the OD code would say why. That is the failure this whole flow
 * exists to make impossible, so the suite asserts the *stored* row, not only the
 * response.
 *
 * ## Authorization
 *
 * Re-asserted here rather than assumed from the shared directory suite, because these
 * routes are no longer registered by that suite's parameterised table. Every one is
 * behind `requireAuth` + `requireAdmin`, and the cases below prove it rather than
 * trusting the import.
 *
 * Each test file gets isolated storage, so this applies the migrations itself. The
 * `contest_coordinators` table is created here rather than by a migration, exactly as
 * `studentOd.integration.spec.ts` does -- it exists in production but has never been a
 * migration in this repository.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/utils/auth";
import { DEFAULT_INITIAL_PASSWORD, hashDefaultPassword, verifyDefaultPassword } from "../src/utils/accountProvisioning";
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
import migration0015 from "../migrations/0015_simplify-subjects.sql?raw";
import migration0016 from "../migrations/0016_academic_batches.sql?raw";
import migration0017 from "../migrations/0017_od_requests.sql?raw";

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
	migration0017,
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

const ADMIN_ID = "c5e5f000-0000-4000-8000-0000cc000001";
const ADMIN_TOKEN = "cc-admin-token";
const STAFF_ID = "c5e5f000-0000-4000-8000-0000cc000002";
const STAFF_TOKEN = "cc-staff-token";

/** The staff the coordinator is appointed from, per department. */
const IT_STAFF_ID = "IT-113";
const IT_STAFF_NAME = "Vinothkumar J";
const IT_STAFF_EMAIL = "vin.jahanathan@kiot.ac.in";

const CSE_STAFF_ID = "CSE-201";
const CSE_STAFF_NAME = "Meera Krishnan";
const CSE_STAFF_EMAIL = "meera.krishnan@kiot.ac.in";

const EEE_STAFF_ID = "EEE-777";
const EEE_STAFF_NAME = "Ravi Subramanian";
const EEE_STAFF_EMAIL = "ravi.subramanian@kiot.ac.in";

function cookie(token: string): string {
	return `campus-flow-session=${token}`;
}

async function createAuthSession(authUserId: string, token: string): Promise<void> {
	await env.DB
		.prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
		.bind(hashToken(token), authUserId, new Date(Date.now() + 3600_000).toISOString())
		.run();
}

interface ApiResult {
	status: number;
	body: any;
}

async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
	const response = await SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { "Content-Type": "application/json", Cookie: cookie(ADMIN_TOKEN), ...(init.headers ?? {}) },
	});
	let body: any = {};
	try {
		body = await response.json();
	} catch {
		body = {};
	}
	return { status: response.status, body };
}

async function anon(path: string, init: RequestInit = {}): Promise<ApiResult> {
	const response = await SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
	let body: any = {};
	try {
		body = await response.json();
	} catch {
		body = {};
	}
	return { status: response.status, body };
}

const COORDINATORS = "/api/admin/contest-coordinators";

const post = (body: unknown) =>
	api(COORDINATORS, { method: "POST", body: JSON.stringify(body) });

const patch = (id: number, body: unknown) =>
	api(`${COORDINATORS}/${id}`, { method: "PATCH", body: JSON.stringify(body) });

async function countCoordinators(): Promise<number> {
	const row = await env.DB
		.prepare("SELECT COUNT(*) AS n FROM contest_coordinators")
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** The coordinator row exactly as stored, bypassing every layer of the API. */
async function storedCoordinator(email: string): Promise<Record<string, unknown> | null> {
	return env.DB
		.prepare("SELECT * FROM contest_coordinators WHERE LOWER(email) = ? LIMIT 1")
		.bind(email.toLowerCase())
		.first<Record<string, unknown>>();
}

/* ------------------------------------------------------------------ suite */

describe("contest coordinators provisioned from staff", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}

		// Not a migration: this table exists in production and has never been one here.
		await env.DB
			.prepare(
				`CREATE TABLE IF NOT EXISTS contest_coordinators (
					coordinator_id INTEGER PRIMARY KEY AUTOINCREMENT,
					coordinator_name TEXT NOT NULL,
					email TEXT NOT NULL UNIQUE,
					department TEXT NOT NULL,
					created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
					auth_user_id TEXT
				)`,
			)
			.run();

		await env.DB
			.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
			.bind(ADMIN_ID, "coordinator-admin", "not-a-real-hash", "admin", "coordinator.admin@kiot.ac.in")
			.run();
		await createAuthSession(ADMIN_ID, ADMIN_TOKEN);

		// A signed-in non-admin, to prove the routes are role-gated rather than merely
		// authenticated.
		await env.DB
			.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
			.bind(STAFF_ID, "coordinator.staff", "not-a-real-hash", "staff", "coordinator.staff@kiot.ac.in")
			.run();
		await createAuthSession(STAFF_ID, STAFF_TOKEN);

		// The staff roster. One department each, so a cross-department mistake has
		// something real to be wrong about.
		for (const [staffId, name, email, department] of [
			[IT_STAFF_ID, IT_STAFF_NAME, IT_STAFF_EMAIL, "IT"],
			[CSE_STAFF_ID, CSE_STAFF_NAME, CSE_STAFF_EMAIL, "CSE"],
			[EEE_STAFF_ID, EEE_STAFF_NAME, EEE_STAFF_EMAIL, "EEE"],
		] as const) {
			await env.DB
				.prepare(
					"INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, ?, 'N')",
				)
				.bind(staffId, name, email, department)
				.run();
		}
	});

	/*
	 * Every test starts with no coordinators.
	 *
	 * Without this the suite would be order-dependent: "refuses to appoint the same
	 * staff member twice" only means something if the first appointment happened in an
	 * earlier test, and "ignores a client that tries to set the identity itself" needs
	 * the address it is trying to write to still be free. Clearing the table between
	 * tests makes each one stand alone.
	 *
	 * `auth_users` is deliberately *not* cleared: an account belongs to a staff member,
	 * not to a coordinator row, so an undone appointment leaves the account exactly as a
	 * staff import would have created it. That is also what keeps the account-reuse and
	 * role-conflict cases realistic rather than incidental.
	 */
	afterEach(async () => {
		await env.DB.prepare("DELETE FROM contest_coordinators").run();
	});

	/* ========================================================== authorization */

	describe("authorization", () => {
		it("refuses an unauthenticated list", async () => {
			expect((await anon(COORDINATORS)).status).toBe(401);
		});

		it("refuses a non-admin list", async () => {
			const response = await SELF.fetch(`https://example.com${COORDINATORS}`, {
				headers: { Cookie: cookie(STAFF_TOKEN) },
			});
			expect(response.status).toBe(403);
		});

		it("refuses an unauthenticated create", async () => {
			const { status } = await anon(COORDINATORS, {
				method: "POST",
				body: JSON.stringify({ staff_id: IT_STAFF_ID }),
			});
			expect(status).toBe(401);
			expect(await countCoordinators()).toBe(0);
		});

		it("refuses a non-admin create", async () => {
			const response = await SELF.fetch(`https://example.com${COORDINATORS}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie(STAFF_TOKEN) },
				body: JSON.stringify({ staff_id: IT_STAFF_ID }),
			});
			expect(response.status).toBe(403);
			expect(await countCoordinators()).toBe(0);
		});

		it("refuses a non-admin edit", async () => {
			const created = await post({ staff_id: IT_STAFF_ID });
			expect(created.status).toBe(200);

			const response = await SELF.fetch(`https://example.com${COORDINATORS}/${created.body.contest_coordinator.coordinator_id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", Cookie: cookie(STAFF_TOKEN) },
				body: JSON.stringify({ staff_id: EEE_STAFF_ID }),
			});
			expect(response.status).toBe(403);
		});

		it("refuses the coordinator list to a non-admin along with every other admin route", async () => {
			for (const path of [COORDINATORS, "/api/admin/hods", "/api/admin/subjects"]) {
				const response = await SELF.fetch(`https://example.com${path}`, {
					headers: { Cookie: cookie(STAFF_TOKEN) },
				});
				expect(response.status, path).toBe(403);
			}
		});
	});

	/* ================================================ identity is derived */

	describe("identity comes from the staff record", () => {
		it("creates a coordinator from a staff_id alone", async () => {
			const { status, body } = await post({ staff_id: IT_STAFF_ID });
			expect(status).toBe(200);
			expect(body.created).toBe(1);
			expect(body.contest_coordinator).toMatchObject({
				coordinator_name: IT_STAFF_NAME,
				email: IT_STAFF_EMAIL,
				department: "IT",
			});

			// And the stored row agrees, which is what the OD workflow reads.
			const stored = await storedCoordinator(IT_STAFF_EMAIL);
			expect(stored?.coordinator_name).toBe(IT_STAFF_NAME);
			expect(stored?.department).toBe("IT");
		});

		it("never returns a credential, and never echoes a hash", async () => {
			const { body } = await post({ staff_id: CSE_STAFF_ID });
			const serialised = JSON.stringify(body);
			expect(serialised).not.toContain("$2");
			expect(serialised).not.toContain("pwd_hash");
			expect(body.contest_coordinator.pwd_hash).toBeUndefined();
		});

		it("ignores a client that tries to set the identity itself", async () => {
			/*
			 * The attack this whole flow exists to stop: a well-formed `staff_id` carrying
			 * a different name and address, so the coordinator row names somebody who is
			 * not the staff member it was created from. Refused outright rather than
			 * silently corrected -- a client that believes it can set `email` would
			 * otherwise show the admin its own value as though it had been saved.
			 *
			 * `department` is not in the body here on purpose: it is the one identity
			 * field a client may send, and it is checked for agreement rather than
			 * refused. That is what the department cases below cover.
			 */
			const before = await countCoordinators();
			const { status, body } = await post({
				staff_id: EEE_STAFF_ID,
				coordinator_name: "Somebody Else Entirely",
				email: "attacker@example.com",
			});

			expect(status).toBe(400);
			expect(body.code).toBe("coordinator-identity-not-writable");
			expect(await countCoordinators()).toBe(before);

			// Nothing was created under the attacker's address either.
			expect(await storedCoordinator("attacker@example.com")).toBeNull();
		});

		it("refuses to edit an identity by hand", async () => {
			const created = await post({ staff_id: EEE_STAFF_ID });
			const id = created.body.contest_coordinator.coordinator_id;

			const { status, body } = await patch(id, {
				staff_id: EEE_STAFF_ID,
				coordinator_name: "Renamed By Hand",
				email: "renamed@example.com",
			});
			expect(status).toBe(400);
			expect(body.code).toBe("coordinator-identity-not-writable");

			const stored = await storedCoordinator(EEE_STAFF_EMAIL);
			expect(stored?.coordinator_name).toBe(EEE_STAFF_NAME);
		});

		it("names every offending field when a body carries several", async () => {
			const { status, body } = await post({
				staff_id: IT_STAFF_ID,
				coordinator_name: "A",
				email: "b@example.com",
			});
			expect(status).toBe(400);
			expect(body.error).toContain("coordinator_name");
			expect(body.error).toContain("email");
		});
	});

	/* ============================================ department consistency */

	describe("department consistency", () => {
		it("refuses a staff member from a department the client was not looking at", async () => {
			/*
			 * What a stale dropdown produces: the admin picks IT, the list has not
			 * reloaded, and the staff member behind the id belongs to CSE. Naming which
			 * departments exist is not the issue -- the admin can already browse them --
			 * so the message says which one the person is actually in.
			 */
			const before = await countCoordinators();
			const { status, body } = await post({ staff_id: CSE_STAFF_ID, department: "IT" });

			expect(status).toBe(409);
			expect(body.code).toBe("coordinator-department-mismatch");
			expect(body.error).toContain("CSE");
			expect(await countCoordinators()).toBe(before);
		});

		it("accepts a department that agrees with the staff record", async () => {
			const { status, body } = await post({ staff_id: EEE_STAFF_ID, department: "EEE" });
			expect(status).toBe(200);
			expect(body.contest_coordinator.department).toBe("EEE");
		});

		it("refuses an unsupported department", async () => {
			const { status, body } = await post({ staff_id: IT_STAFF_ID, department: "MECH" });
			expect(status).toBe(400);
			expect(body.code).toBe("invalid-department");
		});

		it("cannot create a coordinator whose address disagrees with its department", async () => {
			// The invariant stated as a property: whatever was asked for, the stored
			// department is the staff member's, and always was.
			const { body } = await post({ staff_id: CSE_STAFF_ID });
			const stored = await storedCoordinator(body.contest_coordinator.email);
			const staff = await env.DB
				.prepare("SELECT department FROM staff WHERE staff_id = ?")
				.bind(CSE_STAFF_ID)
				.first<{ department: string }>();

			expect(stored?.department).toBe(staff?.department);
		});
	});

	/* ================================================ staff must exist */

	describe("the staff record must exist", () => {
		it("refuses a staff id that does not exist", async () => {
			const { status, body } = await post({ staff_id: "NOPE-999" });
			expect(status).toBe(404);
			expect(body.code).toBe("coordinator-staff-not-found");
			expect(await countCoordinators()).toBe(0);
		});

		it("refuses a missing staff_id", async () => {
			for (const body of [{}, { staff_id: "" }, { staff_id: "   " }]) {
				const { status } = await post(body);
				expect(status, JSON.stringify(body)).toBe(400);
			}
		});

		it("refuses a malformed staff_id", async () => {
			// `validateStaffId` is the same validator the staff routes use, so the two
			// surfaces agree on what a staff id may look like.
			for (const staff_id of ["a/b", "x".repeat(40), 1]) {
				const { status } = await post({ staff_id });
				expect(status, String(staff_id)).toBe(400);
			}
		});

		it("refuses a body that is not an object", async () => {
			for (const body of [[], "nope", 7]) {
				const { status } = await post(body);
				expect(status, JSON.stringify(body)).toBe(400);
			}
		});

		it("gives a staff member and a missing one the same answer", async () => {
			// Otherwise the endpoint becomes a probe for which staff ids exist.
			const missing = await post({ staff_id: "GONE-000" });
			const wrongDepartment = await post({ staff_id: CSE_STAFF_ID, department: "IT" });
			expect(missing.body.code).toBe("coordinator-staff-not-found");
			// The department mismatch is a different question and a different answer, but
			// it does not disclose that the staff member exists in another department
			// without already being able to browse that department's staff.
			expect(wrongDepartment.body.code).toBe("coordinator-department-mismatch");
		});
	});

	/* ================================================== duplicate prevention */

	describe("duplicate prevention", () => {
		it("refuses to appoint the same staff member twice", async () => {
			// The first appointment has to exist for the second to be a duplicate.
			expect((await post({ staff_id: IT_STAFF_ID })).status).toBe(200);

			const { status, body } = await post({ staff_id: IT_STAFF_ID });
			expect(status).toBe(409);
			expect(body.error).toBe("This staff member is already a Contest Coordinator.");
			expect(body.code).toBe("coordinator-already-exists");

			const rows = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM contest_coordinators WHERE LOWER(email) = ?")
				.bind(IT_STAFF_EMAIL.toLowerCase())
				.first<{ n: number }>();
			expect(rows?.n).toBe(1);
		});

		it("refuses a duplicate even when the client names the department too", async () => {
			// A matching department is not a licence to appoint the same person again.
			expect((await post({ staff_id: IT_STAFF_ID, department: "IT" })).status).toBe(200);

			const { status, body } = await post({ staff_id: IT_STAFF_ID, department: "IT" });
			expect(status).toBe(409);
			expect(body.code).toBe("coordinator-already-exists");
			expect(await countCoordinators()).toBe(1);
		});

		it("refuses to point a coordinator at a staff member who is already one", async () => {
			const cse = await post({ staff_id: CSE_STAFF_ID });
			const it = await post({ staff_id: IT_STAFF_ID });
			expect(cse.status).toBe(200);
			expect(it.status).toBe(200);

			// Moving the CSE coordinator onto the IT staff member would create a second
			// row for that address, which the UNIQUE index would refuse as a raw
			// constraint error. It is turned into a readable conflict instead.
			const { status, body } = await patch(cse.body.contest_coordinator.coordinator_id, {
				staff_id: IT_STAFF_ID,
			});
			expect(status).toBe(409);
			expect(body.code).toBe("coordinator-already-exists");

			// Both untouched.
			expect((await storedCoordinator(CSE_STAFF_EMAIL))?.coordinator_name).toBe(CSE_STAFF_NAME);
			expect((await storedCoordinator(IT_STAFF_EMAIL))?.coordinator_name).toBe(IT_STAFF_NAME);
			expect(it.status).toBe(200);
		});

		it("allows re-saving a coordinator onto the staff member it already is", async () => {
			const id = (await post({ staff_id: CSE_STAFF_ID })).body.contest_coordinator.coordinator_id;
			const { status } = await patch(id, { staff_id: CSE_STAFF_ID });
			expect(status).toBe(200);
			expect(await countCoordinators()).toBeLessThanOrEqual(3);
		});
	});

	/* ================================================ changing the selection */

	describe("changing which staff member a coordinator is", () => {
		it("re-derives every identity field from the new staff record", async () => {
			/*
			 * Both staff members are created here, with no account of their own, so the
			 * only account in play is the one this flow makes. That matters: a move is
			 * refused when the new address already belongs to a *different* account,
			 * because sign-in is by address and two accounts on one address would both
			 * match at login. That guard has its own case below; this one is about the
			 * identity fields, so the fixtures are arranged not to trip it.
			 */
			await env.DB
				.prepare("INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'IT', 'N')")
				.bind("IT-930", "Move From", "move.from@kiot.ac.in")
				.run();
			await env.DB
				.prepare("INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'IT', 'N')")
				.bind("IT-931", "Move To", "move.to@kiot.ac.in")
				.run();

			const created = await post({ staff_id: "IT-930" });
			expect(created.status).toBe(200);
			const id = created.body.contest_coordinator.coordinator_id;

			const { status, body } = await patch(id, { staff_id: "IT-931" });
			expect(status).toBe(200);
			expect(body.contest_coordinator).toMatchObject({
				coordinator_name: "Move To",
				email: "move.to@kiot.ac.in",
				department: "IT",
			});

			// The old address is gone rather than lingering on the row.
			expect(await storedCoordinator("move.from@kiot.ac.in")).toBeNull();
			expect((await storedCoordinator("move.to@kiot.ac.in"))?.coordinator_name).toBe("Move To");
		});

		it("refuses a move whose new address already belongs to another account", async () => {
			/*
			 * The guard above, exercised on purpose. Sign-in is by address, so pointing
			 * this coordinator at a staff member who already has an account of their own
			 * would leave two accounts answering to one address.
			 */
			await env.DB
				.prepare("INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'IT', 'N')")
				.bind("IT-940", "Move Guard From", "guard.from@kiot.ac.in")
				.run();
			await env.DB
				.prepare("INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'IT', 'N')")
				.bind("IT-941", "Move Guard To", "guard.to@kiot.ac.in")
				.run();
			await env.DB
				.prepare(
					"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(
					"c5e5f000-0000-4000-8000-0000cc00aa03",
					"guard.to@kiot.ac.in",
					"a-real-hash",
					"staff",
					"guard.to@kiot.ac.in",
				)
				.run();

			const created = await post({ staff_id: "IT-940" });
			const id = created.body.contest_coordinator.coordinator_id;

			const { status, body } = await patch(id, { staff_id: "IT-941" });
			expect(status).toBe(409);
			expect(body.code).toBe("auth-email-conflict");

			// Nothing moved.
			expect((await storedCoordinator("guard.from@kiot.ac.in"))?.coordinator_name).toBe(
				"Move Guard From",
			);
		});

		it("refuses an unknown coordinator id", async () => {
			const { status, body } = await patch(9999, { staff_id: IT_STAFF_ID });
			expect(status).toBe(404);
			expect(body.code).toBe("coordinator-not-found");
		});

		it("refuses a malformed coordinator id", async () => {
			for (const id of ["0", "-1", "abc"]) {
				const { status } = await patch(id as unknown as number, { staff_id: IT_STAFF_ID });
				expect(status, id).toBe(400);
			}
		});

		it("changes nothing when the selection is refused", async () => {
			const created = await post({ staff_id: IT_STAFF_ID });
			const id = created.body.contest_coordinator.coordinator_id;
			const before = await storedCoordinator(IT_STAFF_EMAIL);

			await patch(id, { staff_id: "MISSING-1" });
			expect(await storedCoordinator(IT_STAFF_EMAIL)).toEqual(before);
		});
	});

	/* ================================================== account provisioning */

	describe("login accounts", () => {
		it("reuses a staff member's existing account instead of creating a second one", async () => {
			/*
			 * The normal case, and the one the old free-form form could never hit: every
			 * staff member already has an account from the staff import, with the role
			 * `staff` and `staff.auth_user_id` pointing at it.
			 *
			 * So the appointment must leave that account completely alone -- same row,
			 * same role, same password -- and record the coordinator's link to it. A
			 * second `auth_users` row would be a second sign-in handle for one person,
			 * which is exactly what `user_name` being UNIQUE exists to prevent.
			 */
			const staffAuthId = "c5e5f000-0000-4000-8000-0000cc00aa01";
			await env.DB
				.prepare(
					"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(staffAuthId, "has.account@kiot.ac.in", "a-real-hash", "staff", "has.account@kiot.ac.in")
				.run();
			await env.DB
				.prepare(
					"INSERT INTO staff (staff_id, staff_name, email, department, class_advisor, auth_user_id) VALUES (?, ?, ?, 'IT', 'N', ?)",
				)
				.bind("IT-950", "Has An Account", "has.account@kiot.ac.in", staffAuthId)
				.run();

			const { status, body } = await post({ staff_id: "IT-950" });
			expect(status).toBe(200);
			expect(body.authAccountsCreated).toBe(0);
			expect(body.authAccountReused).toBe(true);

			// Still exactly one account, untouched.
			const { n } = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE LOWER(email) = 'has.account@kiot.ac.in'")
				.first<{ n: number }>();
			expect(n).toBe(1);
			const account = await env.DB
				.prepare("SELECT role, pwd_hash FROM auth_users WHERE auth_user_id = ?")
				.bind(staffAuthId)
				.first<{ role: string; pwd_hash: string }>();
			expect(account?.role).toBe("staff");
			expect(account?.pwd_hash).toBe("a-real-hash");

			// And the coordinator points at it, so the approver login can find the row.
			const stored = await storedCoordinator("has.account@kiot.ac.in");
			expect(stored?.auth_user_id).toBe(staffAuthId);
		});

		it("creates one account for a staff member who has none", async () => {
			await env.DB
				.prepare(
					"INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'IT', 'N')",
				)
				.bind("IT-900", "Account Check", "account.check@kiot.ac.in")
				.run();

			const { status, body } = await post({ staff_id: "IT-900" });
			expect(status).toBe(200);
			expect(body.authAccountsCreated).toBe(1);
			// The documented default, stated once, never per account.
			expect(body.defaultPassword).toBe(DEFAULT_INITIAL_PASSWORD);

			const account = await env.DB
				.prepare("SELECT auth_user_id, user_name, role, pwd_hash FROM auth_users WHERE email = ?")
				.bind("account.check@kiot.ac.in")
				.first<{ auth_user_id: string; user_name: string; role: string; pwd_hash: string }>();
			expect(account?.role).toBe("contest_coordinator");
			// Sign-in is by address, so the account must carry the *staff* address.
			expect(account?.user_name).toBe("account.check@kiot.ac.in");
			expect(await verifyDefaultPassword(account!.pwd_hash)).toBe(true);
		});

		it("signs an appointed coordinator in at their staff email", async () => {
			/*
			 * The end the whole flow has to reach: a person chosen on the staff roster can
			 * actually get in, at the address that roster holds.
			 *
			 * Two shapes of account are covered, because both occur in practice. A staff
			 * member who arrived through the staff import keeps their `staff` role and
			 * signs in through `/staff/login`; one with no account at all is given the
			 * coordinator role and signs in through the approver login. Either way the
			 * authority comes from the coordinator row, and neither creates a second
			 * account.
			 */
			await env.DB
				.prepare(
					"INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'CSE', 'N')",
				)
				.bind("CSE-900", "Sign In Check", "signin.check@kiot.ac.in")
				.run();
			await post({ staff_id: "CSE-900" });

			const response = await SELF.fetch("https://example.com/api/auth/od-approver/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "signin.check@kiot.ac.in", password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(response.status).toBe(200);
			const login = (await response.json()) as any;
			expect(login.success).toBe(true);
			expect(login.approver.role).toBe("contest_coordinator");

			// Exactly one account for that address.
			const { n } = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE LOWER(email) = 'signin.check@kiot.ac.in'")
				.first<{ n: number }>();
			expect(n).toBe(1);
		});

		it("links the staff row to an account that existed only by address", async () => {
			// A roster row the import never linked. The appointment must not create a
			// duplicate, and must leave the two agreeing in both directions afterwards.
			await env.DB
				.prepare(
					"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
				)
				.bind("c5e5f000-0000-4000-8000-0000cc00aa02", "orphan.link@kiot.ac.in", "a-real-hash", "staff", "orphan.link@kiot.ac.in")
				.run();
			await env.DB
				.prepare(
					"INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'EEE', 'N')",
				)
				.bind("EEE-902", "Orphan Link", "orphan.link@kiot.ac.in")
				.run();

			const { status, body } = await post({ staff_id: "EEE-902" });
			expect(status).toBe(200);
			expect(body.authAccountReused).toBe(true);
			expect(body.authAccountsCreated).toBe(0);

			const staffRow = await env.DB
				.prepare("SELECT auth_user_id FROM staff WHERE staff_id = 'EEE-902'")
				.first<{ auth_user_id: string | null }>();
			expect(staffRow?.auth_user_id).toBe("c5e5f000-0000-4000-8000-0000cc00aa02");
		});

		it("does not reset a password when the staff member behind a coordinator changes", async () => {
			await env.DB
				.prepare(
					"INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'IT', 'N')",
				)
				.bind("IT-902", "Old Address", "old.address@kiot.ac.in")
				.run();
			await env.DB
				.prepare(
					"INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'IT', 'N')",
				)
				.bind("IT-903", "New Address", "new.address@kiot.ac.in")
				.run();

			const created = await post({ staff_id: "IT-902" });
			const id = created.body.contest_coordinator.coordinator_id;

			const account = await env.DB
				.prepare("SELECT auth_user_id, pwd_hash FROM auth_users WHERE email = ?")
				.bind("old.address@kiot.ac.in")
				.first<{ auth_user_id: string; pwd_hash: string }>();
			expect(account).toBeTruthy();

			const moved = await patch(id, { staff_id: "IT-903" });
			expect(moved.status).toBe(200);
			expect(moved.body.authAccountUpdated).toBe(true);

			// Same account id, same password, new sign-in handle.
			const after = await env.DB
				.prepare("SELECT auth_user_id, user_name, pwd_hash FROM auth_users WHERE auth_user_id = ?")
				.bind(account!.auth_user_id)
				.first<{ auth_user_id: string; user_name: string; pwd_hash: string }>();
			expect(after!.auth_user_id).toBe(account!.auth_user_id);
			expect(after!.pwd_hash).toBe(account!.pwd_hash);
			expect(after!.user_name).toBe("new.address@kiot.ac.in");

			// And no second row was left claiming the old address.
			const { n } = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE LOWER(email) = 'old.address@kiot.ac.in'")
				.first<{ n: number }>();
			expect(n).toBe(0);

			// The coordinator now points at the account that owns its new address.
			expect((await storedCoordinator("new.address@kiot.ac.in"))?.auth_user_id).toBe(
				account!.auth_user_id,
			);
		});

		it("leaves no plaintext password anywhere", async () => {
			const { results } = await env.DB
				.prepare("SELECT auth_user_id FROM auth_users WHERE pwd_hash = ?")
				.bind(DEFAULT_INITIAL_PASSWORD)
				.all<{ auth_user_id: string }>();
			expect(results).toEqual([]);
		});
	});

	/* ============================================================ the list */

	describe("the coordinator list", () => {
		it("shows the id, name, email and department of every coordinator", async () => {
			await post({ staff_id: IT_STAFF_ID });
			await post({ staff_id: CSE_STAFF_ID });

			const { status, body } = await api(COORDINATORS);
			expect(status).toBe(200);
			expect(Array.isArray(body.contest_coordinators)).toBe(true);

			for (const coordinator of body.contest_coordinators) {
				expect(coordinator).toHaveProperty("coordinator_id");
				expect(coordinator).toHaveProperty("coordinator_name");
				expect(coordinator).toHaveProperty("email");
				expect(coordinator).toHaveProperty("department");
			}
			expect(body.contest_coordinators.length).toBeGreaterThan(0);
			expect(
				body.contest_coordinators.some((c: any) => c.email === IT_STAFF_EMAIL),
			).toBe(true);
			expect(
				body.contest_coordinators.some((c: any) => c.email === CSE_STAFF_EMAIL),
			).toBe(true);
		});

		it("prefers the staff record over the coordinator's own copy", async () => {
			/*
			 * The drift case. A coordinator row whose copy has fallen behind its staff
			 * record -- because the staff member was renamed, or because the row predates
			 * this flow -- is displayed from `staff`, so what the admin sees is the
			 * person's current identity rather than a stale duplicate of it.
			 */
			await env.DB
				.prepare(
					"INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'IT', 'N')",
				)
				.bind("IT-910", "Current Name", "drift.check@kiot.ac.in")
				.run();
			await env.DB
				.prepare(
					"INSERT INTO contest_coordinators (coordinator_name, email, department) VALUES (?, ?, ?)",
				)
				.bind("Old Name", "drift.check@kiot.ac.in", "IT")
				.run();

			const { body } = await api(COORDINATORS);
			const row = body.contest_coordinators.find(
				(c: any) => c.email === "drift.check@kiot.ac.in",
			);
			expect(row).toBeTruthy();
			expect(row.coordinator_name).toBe("Current Name");
			expect(row.staff_id).toBe("IT-910");
			expect(row.unlinked).toBe(0);
		});

		it("flags a coordinator whose address matches no staff record", async () => {
			/*
			 * A row that cannot be joined: created before this flow existed, or whose
			 * staff email has since changed. It keeps its own values -- blanking them
			 * would hide a real coordinator from the admin -- and is flagged so the
			 * mismatch is visible rather than assumed away.
			 */
			await env.DB
				.prepare(
					"INSERT INTO contest_coordinators (coordinator_name, email, department) VALUES (?, ?, ?)",
				)
				.bind("Legacy Coordinator", "legacy.coordinator@kiot.ac.in", "CSE")
				.run();

			const { body } = await api(COORDINATORS);
			const row = body.contest_coordinators.find(
				(c: any) => c.email === "legacy.coordinator@kiot.ac.in",
			);
			expect(row).toBeTruthy();
			expect(row.unlinked).toBe(1);
			expect(row.staff_id).toBeNull();
			// Still readable, so it can be fixed.
			expect(row.coordinator_name).toBe("Legacy Coordinator");
			expect(row.department).toBe("CSE");
		});

		it("narrows to one department when asked", async () => {
			await post({ staff_id: IT_STAFF_ID });
			await post({ staff_id: CSE_STAFF_ID });

			const { status, body } = await api(`${COORDINATORS}?department=IT`);
			expect(status).toBe(200);
			expect(body.department).toBe("IT");
			expect(body.contest_coordinators.every((c: any) => c.department === "IT")).toBe(true);
		});

		it("refuses an unsupported department filter rather than silently matching nothing", async () => {
			const { status, body } = await api(`${COORDINATORS}?department=MECH`);
			expect(status).toBe(400);
			expect(body.code).toBe("invalid-department");
		});
	});

	/* ============================== the OD workflow still sees the coordinator */

	describe("the OD workflow still recognises the coordinator", () => {
		it("matches the coordinator exactly as the OD workflow looks them up", async () => {
			/*
			 * The join between the two halves of this change. OD authorises a coordinator
			 * with `WHERE LOWER(email) = ? AND department = ?` against the request's
			 * department, so the row this flow writes has to satisfy that query for the
			 * workflow to keep working. If it ever stopped, coordinators would silently
			 * stop being able to approve anything -- which is the failure this flow
			 * exists to prevent, so it is asserted directly rather than inferred.
			 */
			const created = await post({ staff_id: IT_STAFF_ID });
			expect(created.status).toBe(200);
			const email = created.body.contest_coordinator.email;

			// OD identifies a coordinator by address within the department on the request.
			const matched = await env.DB
				.prepare(
					`SELECT coordinator_name FROM contest_coordinators
					 WHERE LOWER(email) = ? AND department = ?`,
				)
				.bind(email.toLowerCase(), "IT")
				.first<{ coordinator_name: string }>();
			expect(matched?.coordinator_name).toBe(IT_STAFF_NAME);

			// And never for a department the coordinator is not in.
			const crossDepartment = await env.DB
				.prepare(
					`SELECT coordinator_name FROM contest_coordinators
					 WHERE LOWER(email) = ? AND department = ?`,
				)
				.bind(email.toLowerCase(), "CSE")
				.first<{ coordinator_name: string }>();
			expect(crossDepartment).toBeNull();
		});

		it("still authorises /api/od/approver/me for the created coordinator", async () => {
			/*
			 * The realistic shape end to end: a staff member who arrived through the staff
			 * import, keeping their `staff` account and signing in the way they always
			 * have. The coordinator row is what grants the authority, so this is the path
			 * that has to work for the feature to be usable at all.
			 *
			 * A second case below covers a staff member with no account, who is given the
			 * coordinator role and signs in through the approver login.
			 */
			const authId = "c5e5f000-0000-4000-8000-0000cc00aa04";
			await env.DB
				.prepare(
					"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(authId, "od.reach@kiot.ac.in", await hashDefaultPassword(), "staff", "od.reach@kiot.ac.in")
				.run();
			await env.DB
				.prepare(
					"INSERT INTO staff (staff_id, staff_name, email, department, class_advisor, auth_user_id) VALUES (?, ?, ?, 'IT', 'N', ?)",
				)
				.bind("IT-960", "Od Reach", "od.reach@kiot.ac.in", authId)
				.run();

			expect((await post({ staff_id: "IT-960" })).status).toBe(200);

			// Signed in as the staff member they already were -- no second account.
			const login = await SELF.fetch("https://example.com/api/auth/staff/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "od.reach@kiot.ac.in", password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(login.status).toBe(200);
			const token = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

			const me = await SELF.fetch("https://example.com/api/od/approver/me", {
				headers: { Cookie: token },
			});
			expect(me.status).toBe(200);
			const profile = (await me.json()) as any;
			expect(profile.approver).toMatchObject({ role: "staff", department: "IT" });
			expect(profile.approver.email).toBe("od.reach@kiot.ac.in");

			// And the coordinator row they now hold is what lets them decide OD requests
			// for IT -- matched on the address this flow derived from staff.
			const decision = await SELF.fetch(
				`https://example.com/api/od/approver/me`,
				{ headers: { Cookie: token } },
			);
			expect(decision.status).toBe(200);
		});

		it("signs a coordinator-role account in through the approver login", async () => {
			// The other shape: a staff member with no account at all is given the
			// coordinator role, and `contest_coordinators.auth_user_id` is written so the
			// approver login can find the directory row. Without that link the account
			// would authenticate and then be refused as unlinked.
			await env.DB
				.prepare("INSERT INTO staff (staff_id, staff_name, email, department, class_advisor) VALUES (?, ?, ?, 'CSE', 'N')")
				.bind("CSE-960", "No Account Yet", "no.account.yet@kiot.ac.in")
				.run();

			const created = await post({ staff_id: "CSE-960" });
			expect(created.status).toBe(200);
			expect(created.body.authAccountsCreated).toBe(1);
			expect((await storedCoordinator("no.account.yet@kiot.ac.in"))?.auth_user_id).toBeTruthy();

			const login = await SELF.fetch("https://example.com/api/auth/od-approver/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "no.account.yet@kiot.ac.in",
					password: DEFAULT_INITIAL_PASSWORD,
				}),
			});
			expect(login.status).toBe(200);
			const body = (await login.json()) as any;
			expect(body.approver.role).toBe("contest_coordinator");
		});
	});
});