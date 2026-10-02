/**
 * Heads of department and contest coordinators, end to end against a real D1.
 *
 * Both directories are the same feature under two names -- a person, an address and
 * a department, in a single department-keyed table, with a login account created
 * alongside -- so they are driven from one table-driven suite rather than written
 * twice. That also means a regression in one is a regression in both, which is the
 * property worth pinning.
 *
 * The failures that matter here are the quiet ones, not "the form did not save":
 *
 *   1. A row created without its account. An entry nobody can sign in as is
 *      invisible from the UI, so the account is asserted directly in `auth_users`
 *      rather than inferred from the response.
 *   2. A plaintext password, or a hash in the response. The tests read the raw
 *      `pwd_hash` column and verify it with the same bcrypt call the login handler
 *      uses, and sweep the API responses for the `$2` prefix.
 *   3. A duplicate account. Re-uploading a file, or an address that already has an
 *      account of some other role, must not create a second `auth_users` row and
 *      must not reset an existing password.
 *   4. An id that moved. `hod_id` and `coordinator_id` are database-generated
 *      autoincrement keys; a body naming a different one is refused, not ignored.
 *   5. An edit that strands a login. The address is the sign-in handle, so changing
 *      it has to move the *existing* account with it and leave `pwd_hash` alone.
 *   6. Collateral damage. The student, staff and subject tables, and `auth_users`
 *      itself, are counted before and after, so "this feature touches nothing else"
 *      is an assertion rather than a claim.
 *
 * Each test file gets isolated storage, so this file applies the migrations itself.
 */

import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/utils/auth";
import {
	DEFAULT_INITIAL_PASSWORD,
	hashDefaultPassword,
	verifyDefaultPassword,
} from "../src/utils/accountProvisioning";
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
/*
 * Creates `hods` and `contest_coordinators` with the `auth_user_id` column both approver
 * routes resolve a session through. See the note above the admin credentials for why these
 * two tables are no longer hand-written here.
 */
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

/*
 * The two directory tables now come from `migrations/0018_directory-auth-user-id.sql`.
 *
 * They used to be written out here, and the comment above them claimed the shape was
 * "copied verbatim from the production `sqlite_master` entry". It was not. Production had
 * five columns and no `auth_user_id`; this file had six. So the suites passed against a
 * table the deployed database did not have, and the first attempt to appoint a
 * coordinator in production failed at the database with a 500 on an INSERT naming a
 * column that was not there.
 *
 * The migration is the source of truth for both tables now, and this file applies it like
 * every other migration. That is the point of the change: a hand-written approximation of
 * a table is a table that can drift from the real one, and this one did, silently, for as
 * long as it was here.
 *
 * `auth_user_id` is not optional decoration, which is why the migration adds it. Both roles
 * are permanent users of the existing authentication architecture, and both approver
 * routes resolve a session through that column rather than through the address --
 * `/api/auth/od-approver/login` and `/api/approver/me`. A directory row without it is a
 * row nobody can sign in as.
 */

const ADMIN_ID = "c5e5f000-0000-4000-8000-00000000ad01";
const ADMIN_TOKEN = "directory-admin-session-token";
const STAFF_TOKEN_USER = "c5e5f000-0000-4000-8000-00000000ad02";
const STAFF_TOKEN = "directory-staff-session-token";

function adminCookie(): string {
	return `campus-flow-session=${ADMIN_TOKEN}`;
}

function staffCookie(): string {
	return `campus-flow-session=${STAFF_TOKEN}`;
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

async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
	const response = await SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { "Content-Type": "application/json", Cookie: adminCookie(), ...(init.headers ?? {}) },
	});
	return { status: response.status, body: await response.json() };
}

/** An unauthenticated call, for the authorization assertions. */
async function anon(path: string, init: RequestInit = {}): Promise<ApiResult> {
	const response = await SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
	return { status: response.status, body: await response.json() };
}

/** The `auth_users` row for an address, or null. */
async function accountFor(email: string): Promise<any> {
	return env.DB
		.prepare("SELECT auth_user_id, user_name, role, email, pwd_hash FROM auth_users WHERE LOWER(email) = ? OR LOWER(user_name) = ?")
		.bind(email.toLowerCase(), email.toLowerCase())
		.first<any>();
}

async function countRows(table: string): Promise<number> {
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
	return row?.n ?? 0;
}

/*
 * The two directories, described once.
 *
 * `path`, `table`, `idColumn`, `nameColumn`, `role`, `label`, `plural`, `listKey`
 * and `responseKey` mirror the server's own spec, so a suite case is written once
 * and reads the same for an HOD as for a coordinator.
 */
const DIRECTORIES = [
	{
		label: "HOD",
		path: "/api/admin/hods",
		table: "hods",
		idColumn: "hod_id",
		nameColumn: "hod_name",
		role: "hod",
		plural: "HODs",
		listKey: "hods",
		responseKey: "hod",
		codeStem: "hod",
		invalidId: "invalid-hod-id",
		notFound: "hod-not-found",
		immutable: "hod-id-immutable",
		/* An HOD is appointed to a department rather than appointed out of a roster, so
		 * an address that already holds an account of another role is a conflict and
		 * stays refused. Mirrors the server's `spec.provisionFromStaff`. */
		provisionFromStaff: false,
		/* Nothing in the workflow or the dashboard depends on there being only one HOD, so
		 * the directory carries no such rule. Mirrors the server's `spec.onePerDepartment`. */
		onePerDepartment: false,
		/* Suffixed per directory: this suite runs twice from one table, and
		 * `auth_users.auth_user_id` is UNIQUE, so a shared literal would collide. */
		authIdSuffix: "10",
		makeRow: (email: string, department: string, name: string) => ({
			hod_name: name,
			email,
			department,
		}),
	},
	{
		label: "Coordinator",
		path: "/api/admin/contest-coordinators",
		table: "contest_coordinators",
		idColumn: "coordinator_id",
		nameColumn: "coordinator_name",
		role: "contest_coordinator",
		plural: "Coordinators",
		listKey: "contest_coordinators",
		responseKey: "contest_coordinator",
		codeStem: "coordinator",
		invalidId: "invalid-coordinator-id",
		notFound: "coordinator-not-found",
		immutable: "coordinator-id-immutable",
		/* A coordinator is appointed out of a department's staff roster, so the address
		 * being added belongs to somebody who already has a `staff` account. That account
		 * is reused rather than refused. Mirrors the server's `spec.provisionFromStaff`. */
		provisionFromStaff: true,
		/* A department has exactly one contest coordinator, and the create and edit routes
		 * refuse a second. Mirrors the server's `spec.onePerDepartment`. */
		onePerDepartment: true,
		authIdSuffix: "20",
		makeRow: (email: string, department: string, name: string) => ({
			coordinator_name: name,
			email,
			department,
		}),
	},
] as const;

/**
 * Creates one entry and returns its response, so a suite case can go on to assert
 * against the row it just made.
 */
async function createOne(
	directory: (typeof DIRECTORIES)[number],
	email: string,
	department: string,
	name: string,
): Promise<ApiResult> {
	return api(directory.path, {
		method: "POST",
		body: JSON.stringify({ rows: [directory.makeRow(email, department, name)] }),
	});
}

/**
 * A globally unique address, for suites outside the per-directory loop.
 *
 * The loop's own `unique` is deliberately not reused: it is the same address for every
 * test that names the same slug, which is exactly what those tests want -- they each run
 * against a directory whose table is cleared between cases. The permanent-account cases
 * below run both directories' rows in one test and are parameterised rather than cleared,
 * so they need addresses that cannot collide with each other or with anything above.
 */
let uniqueCounter = 0;
function freshEmail(slug: string): string {
	uniqueCounter += 1;
	return `permanent.${slug}.${uniqueCounter}@kiot.ac.in`;
}

describe("HOD and contest coordinator management", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}

		// The seed ships an advisor and a student but no admin, and every route
		// here is behind requireAdmin, so one has to exist to be tested at all.
		await env.DB
			.prepare(
				"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(ADMIN_ID, "directory-admin", "not-a-real-hash", "admin", "directory.admin@kiot.ac.in")
			.run();
		await createAuthSession(ADMIN_ID, ADMIN_TOKEN);

		// A non-admin, to prove the routes are role-gated and not merely
		// authenticated. This account is never given a directory row.
		await env.DB
			.prepare(
				"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(STAFF_TOKEN_USER, "directory.staff", "not-a-real-hash", "staff", "directory.staff@kiot.ac.in")
			.run();
		await createAuthSession(STAFF_TOKEN_USER, STAFF_TOKEN);
	});

	/*
	 * Every case starts with an empty coordinator directory.
	 *
	 * `contest_coordinators` holds exactly one row per department, so a case that appoints
	 * somebody -- which almost all of them do, because that is what these routes are for --
	 * consumes the only seat its department has. Without a reset the cases would be ordered
	 * around four departments rather than around behaviour, and every one of them after the
	 * fourth would be asserting the *refusal* rather than the appointment.
	 *
	 * Clearing the table is what turns the invariant into the thing under test instead of a
	 * precondition of the test: each case appoints whoever it needs, and the cases that care
	 * about the rule create their own second row on purpose. `hods` carries no such rule and
	 * is deliberately left alone -- its cases still accumulate, which is how the directory
	 * with no uniqueness constraint is shown to behave unchanged.
	 *
	 * These are this file's own rows in this file's own isolated database; nothing here
	 * touches a deployed one.
	 */
	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM contest_coordinators").run();
	});

	describe("authorization", () => {
		for (const directory of DIRECTORIES) {
			it(`refuses an unauthenticated list of ${directory.plural}`, async () => {
				expect((await anon(directory.path)).status).toBe(401);
			});

			it(`refuses a non-admin list of ${directory.plural}`, async () => {
				const response = await SELF.fetch(`https://example.com${directory.path}`, {
					headers: { Cookie: staffCookie() },
				});
				expect(response.status).toBe(403);
			});

			it(`refuses an unauthenticated create of a ${directory.label}`, async () => {
				const { status } = await anon(directory.path, {
					method: "POST",
					body: JSON.stringify({ rows: [directory.makeRow("nope@kiot.ac.in", "IT", "Nope")] }),
				});
				expect(status).toBe(401);
				expect(await countRows(directory.table)).toBe(0);
			});

			it(`refuses a non-admin create of a ${directory.label}`, async () => {
				const response = await SELF.fetch(`https://example.com${directory.path}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: staffCookie() },
					body: JSON.stringify({ rows: [directory.makeRow("nope@kiot.ac.in", "IT", "Nope")] }),
				});
				expect(response.status).toBe(403);
				expect(await countRows(directory.table)).toBe(0);
			});

			it(`refuses a non-admin edit of a ${directory.label}`, async () => {
				const response = await SELF.fetch(`https://example.com${directory.path}/1`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json", Cookie: staffCookie() },
					body: JSON.stringify({ [directory.nameColumn]: "Hijacked" }),
				});
				expect(response.status).toBe(403);
			});
		}
	});

	for (const directory of DIRECTORIES) {
		describe(directory.label, () => {
			const unique = (slug: string) => `${directory.codeStem}.${slug}@kiot.ac.in`;

			describe("create", () => {
				it("creates the record and a matching login account", async () => {
					const email = unique("create");
					const { status, body } = await createOne(directory, email, "CSE", "Asha Raman");

					expect(status).toBe(200);
					expect(body.success).toBe(true);
					expect(body.created).toBe(1);
					expect(body.authAccountsCreated).toBe(1);
					expect(body.invalid).toEqual([]);
					expect(body.duplicates).toEqual([]);
					expect(body.roleMismatches).toEqual([]);

					const row = await env.DB
						.prepare(
							`SELECT ${directory.idColumn}, ${directory.nameColumn}, email, department
							 FROM ${directory.table} WHERE email = ?`,
						)
						.bind(email)
						.first<any>();
					expect(row).toBeTruthy();
					expect(row[directory.nameColumn]).toBe("Asha Raman");
					expect(row.department).toBe("CSE");
					// The id is the database's, not the client's: a positive integer from
					// the autoincrement, and the body never mentioned it.
					expect(Number.isInteger(row[directory.idColumn])).toBe(true);
					expect(row[directory.idColumn]).toBeGreaterThan(0);

					const account = await accountFor(email);
					expect(account).toBeTruthy();
					expect(account.role).toBe(directory.role);
					// The login lookup is `user_name OR email`, so an account holding
					// neither the address nor nothing reachable could never sign in.
					expect(account.user_name).toBe(email.toLowerCase());
					expect(account.email.toLowerCase()).toBe(email.toLowerCase());
				});

				it("never returns the password or its hash", async () => {
					const email = unique("nohash");
					const { body } = await createOne(directory, email, "IT", "No Hash Leak");
					// The documented default is reported so the dashboard can name it
					// once, in aggregate. The per-account password is never echoed, and
					// nothing resembling a hash may appear anywhere in the payload.
					expect(body.defaultPassword).toBe(DEFAULT_INITIAL_PASSWORD);
					expect(body).not.toHaveProperty("pwd_hash");
					expect(body).not.toHaveProperty("pwdHash");
					expect(JSON.stringify(body)).not.toContain("$2");
					expect(JSON.stringify(body)).not.toContain("auth_user_id");
				});

				it("stores 1234 only as a bcrypt hash that verifies", async () => {
					const email = unique("password");
					await createOne(directory, email, "EEE", "Password Check");

					const account = await accountFor(email);
					// Not the plaintext, and recognisably a bcrypt hash.
					expect(account.pwd_hash).not.toBe(DEFAULT_INITIAL_PASSWORD);
					expect(account.pwd_hash.startsWith("$2")).toBe(true);
					// And it actually verifies, which is what a login handler depends on.
					expect(await verifyDefaultPassword(account.pwd_hash)).toBe(true);
					expect(DEFAULT_INITIAL_PASSWORD).toBe("1234");
				});

				it("accepts every supported department", async () => {
					for (const department of ["IT", "CSE", "ECE", "EEE"]) {
						const { status, body } = await createOne(
							directory,
							unique(`dept-${department.toLowerCase()}`),
							department,
							`Head ${department}`,
						);
						expect(status, department).toBe(200);
						expect(body.created).toBe(1);
					}
				});

				it("rejects a department that is not one of the four", async () => {
					const before = await countRows(directory.table);
					for (const department of ["MECH", "CSE_Students_2024_2028", "IT;", "C"]) {
						const { status, body } = await createOne(
							directory,
							unique(`baddept-${String(department).replace(/\W/g, "")}`),
							department,
							"Wrong Department",
						);
						expect(status, department).toBe(400);
						expect(body.code).toBe("import-validation-failed");
						expect(body.details.invalid[0].errors.map((e: any) => e.field)).toContain(
							"department",
						);
					}
					expect(await countRows(directory.table)).toBe(before);
				});

				it("rejects an invalid or missing email", async () => {
					const before = await countRows(directory.table);
					for (const email of ["not-an-email", "@kiot.ac.in", "a@", ""]) {
						const { status, body } = await createOne(directory, email, "IT", "Bad Email");
						expect(status, email).toBe(400);
						expect(body.code).toBe("import-validation-failed");
						expect(body.details.invalid[0].errors.map((e: any) => e.field)).toContain("email");
					}
					expect(await countRows(directory.table)).toBe(before);
				});

				it("rejects a missing name", async () => {
					const { status, body } = await api(directory.path, {
						method: "POST",
						body: JSON.stringify({ rows: [{ email: unique("noname"), department: "IT" }] }),
					});
					expect(status).toBe(400);
					expect(body.details.invalid[0].errors.map((e: any) => e.field)).toContain(
						directory.nameColumn,
					);
				});

				it("reports an address already on the table and creates no second row", async () => {
					const email = unique("dup");
					await createOne(directory, email, "IT", "First Owner");

					const { status, body } = await createOne(directory, email, "CSE", "Impostor");
					// Re-uploading a file that already exists is a legitimate no-op, so
					// it is reported as skipped rather than as a failure.
					expect(status).toBe(200);
					expect(body.created).toBe(0);
					expect(body.skipped).toBe(1);

					const rows = await env.DB
						.prepare(`SELECT ${directory.nameColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(email)
						.all<any>();
					expect(rows.results).toEqual([{ [directory.nameColumn]: "First Owner" }]);

					// And no second account was made for it either.
					const accounts = await env.DB
						.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE LOWER(email) = ?")
						.bind(email.toLowerCase())
						.first<{ n: number }>();
					expect(accounts?.n).toBe(1);
				});

				it("refuses a body with no rows", async () => {
					const { status, body } = await api(directory.path, {
						method: "POST",
						body: JSON.stringify({ rows: [] }),
					});
					expect(status).toBe(400);
					expect(body.code).toBe("empty-rows");
				});

				it("refuses a body whose rows is not an array", async () => {
					const { status, body } = await api(directory.path, {
						method: "POST",
						body: JSON.stringify({ rows: "nope" }),
					});
					expect(status).toBe(400);
					expect(body.code).toBe("invalid-rows");
				});

				it("ignores an id supplied by the client", async () => {
					// The id column is absent from the INSERT, so a client value cannot
					// reach it even if it is sent. The row gets the database's next id.
					const email = unique("clientid");
					const suppliedId = 999999;
					const { status, body } = await api(directory.path, {
						method: "POST",
						body: JSON.stringify({
							rows: [{ ...directory.makeRow(email, "IT", "No Client Id"), [directory.idColumn]: suppliedId }],
						}),
					});
					expect(status).toBe(200);
					expect(body.created).toBe(1);

					const row = await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(email)
						.first<{ [key: string]: number }>();
					expect(row?.[directory.idColumn]).not.toBe(suppliedId);
					expect(row?.[directory.idColumn]).toBeGreaterThan(0);
				});
			});

			describe("bulk import", () => {
				it("imports a valid file and creates one account per row", async () => {
					const rows = [
						directory.makeRow(unique("bulk1"), "IT", "Bulk One"),
						directory.makeRow(unique("bulk2"), "CSE", "Bulk Two"),
						directory.makeRow(unique("bulk3"), "ECE", "Bulk Three"),
					];
					const { status, body } = await api(directory.path, {
						method: "POST",
						body: JSON.stringify({ rows }),
					});
					expect(status).toBe(200);
					expect(body.created).toBe(3);
					expect(body.authAccountsCreated).toBe(3);

					for (const row of rows) {
						const account = await accountFor(row.email);
						expect(account?.role).toBe(directory.role);
						expect(await verifyDefaultPassword(account.pwd_hash)).toBe(true);
					}
				});

				it("imports the valid rows of a mixed file and reports the bad ones", async () => {
					const good = unique("mixed-good");
					const { status, body } = await api(directory.path, {
						method: "POST",
						body: JSON.stringify({
							rows: [
								directory.makeRow(good, "IT", "Mixed Good"),
								directory.makeRow(unique("mixed-dept"), "MECH", "Mixed Bad Department"),
								directory.makeRow("not-an-email", "IT", "Mixed Bad Email"),
								{ email: unique("mixed-noname"), department: "IT" },
							],
						}),
					});

					expect(status).toBe(200);
					expect(body.created).toBe(1);
					expect(body.invalid).toHaveLength(3);
					// Row numbers are 1-based positions in the submitted array.
					expect(body.invalid.map((entry: any) => entry.row)).toEqual([2, 3, 4]);
					expect(body.invalid[0].errors.map((e: any) => e.field)).toContain("department");
					expect(body.invalid[1].errors.map((e: any) => e.field)).toContain("email");

					expect(await countRows(directory.table)).toBeGreaterThan(0);
					expect(await accountFor(good)).toBeTruthy();
					// A row that failed validation must not have produced an account.
					expect(await accountFor(unique("mixed-dept"))).toBeNull();
					expect(await accountFor(unique("mixed-noname"))).toBeNull();
				});

				it("reports a duplicate inside one file and imports the first occurrence", async () => {
					const email = unique("infiledup");
					const { status, body } = await api(directory.path, {
						method: "POST",
						body: JSON.stringify({
							rows: [
								directory.makeRow(email, "IT", "First"),
								directory.makeRow(email, "CSE", "Second"),
							],
						}),
					});
					expect(status).toBe(200);
					expect(body.created).toBe(1);
					expect(body.duplicates).toHaveLength(1);
					expect(body.duplicates[0].reason).toContain(email);

					const rows = await env.DB
						.prepare(`SELECT ${directory.nameColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(email)
						.all<any>();
					expect(rows.results).toEqual([{ [directory.nameColumn]: "First" }]);
				});

				it("is idempotent when the same file is sent twice", async () => {
					const rows = [
						directory.makeRow(unique("idem1"), "IT", "Idem One"),
						directory.makeRow(unique("idem2"), "ECE", "Idem Two"),
					];
					const first = await api(directory.path, {
						method: "POST",
						body: JSON.stringify({ rows }),
					});
					expect(first.body.created).toBe(2);

					const accountsBefore = await countRows("auth_users");
					const second = await api(directory.path, {
						method: "POST",
						body: JSON.stringify({ rows }),
					});
					expect(second.status).toBe(200);
					expect(second.body.created).toBe(0);
					expect(second.body.authAccountsCreated).toBe(0);
					expect(second.body.skipped).toBe(2);
					// Repeated provisioning must not grow `auth_users` either.
					expect(await countRows("auth_users")).toBe(accountsBefore);
				});

				it("reuses an account that already exists with this directory's role", async () => {
					const email = unique("reuse");
					const authUserId = `c5e5f000-0000-4000-8000-0000000a${directory.authIdSuffix}`;
					const pwdHash = await hashDefaultPassword();
					await env.DB
						.prepare(
							"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
						)
						.bind(authUserId, email.toLowerCase(), pwdHash, directory.role, email.toLowerCase())
						.run();

					const { status, body } = await createOne(directory, email, "IT", "Reused Account");
					expect(status).toBe(200);
					expect(body.created).toBe(1);
					// The account existed, so nothing new was written and its password
					// was left exactly as it was.
					expect(body.authAccountsCreated).toBe(0);

					const account = await accountFor(email);
					expect(account.auth_user_id).toBe(authUserId);
					expect(account.pwd_hash).toBe(pwdHash);

					const accounts = await env.DB
						.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE LOWER(email) = ?")
						.bind(email.toLowerCase())
						.first<{ n: number }>();
					expect(accounts?.n).toBe(1);
				});

				it("does not overwrite an existing account's password, and does not duplicate it", async () => {
					const email = unique("keeppwd");
					// An account in some other role, holding a password that is *not* the
					// documented default, so a silent reset would be detectable.
					const originalHash = "$2b$10$abcdefghijklmnopqrstuvwxyz01234567890123456789012345678";
					const originalAuthUserId = `c5e5f000-0000-4000-8000-0000000a${directory.authIdSuffix}1`;
					await env.DB
						.prepare(
							"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
						)
						.bind(
							originalAuthUserId,
							email.toLowerCase(),
							originalHash,
							"staff",
							email.toLowerCase(),
						)
						.run();

					const { body } = await createOne(directory, email, "IT", "Wants This Address");

					/*
					 * The address already belongs to a `staff` login, and `user_name` is
					 * UNIQUE, so the two accounts would collide. What happens next is the
					 * one place the two directories genuinely differ, so it is asserted
					 * per directory rather than parameterised away:
					 *
					 *   - An HOD is appointed to a department and is not expected to be
					 *     staff, so an existing staff login for the address really is a
					 *     different person. The row is excluded and reported, and the
					 *     existing account is left completely alone.
					 *
					 *   - A coordinator is appointed out of a department's staff roster, so
					 *     a staff login for the address is the *expected* case and the
					 *     appointment it was chosen for. The row is written, linking the
					 *     account that already holds the address. Coordinator authority
					 *     follows from the coordinator row rather than from the role --
					 *     `verifyApprover` matches the caller's own address against
					 *     `contest_coordinators` -- so keeping the `staff` role is what
					 *     lets them act on their own OD queue.
					 *
					 * In both cases the account itself is untouched: same id, same role,
					 * same password, and still exactly one row for the address.
					 */
					if (directory.provisionFromStaff) {
						expect(body.created).toBe(1);
						expect(body.roleMismatches).toEqual([]);
						expect(body.authAccountsCreated).toBe(0);
						expect(body.authAccountsReused).toBe(1);

// The row records the account it belongs to. Both roles are
					// permanent users of the existing authentication architecture, and
					// `/api/auth/od-approver/login` and `/api/od/approver/me` both resolve a
					// session with `WHERE auth_user_id = ?`, so a row without this is a row
					// nobody can sign in as. For a coordinator it is the *reused staff
					// account's* own id -- one login, one password, two roles.
					const created = await env.DB
						.prepare(`SELECT ${directory.idColumn}, auth_user_id FROM ${directory.table} WHERE email = ?`)
						.bind(email.toLowerCase())
						.first<{ [key: string]: any }>();
					expect(created?.[directory.idColumn]).toBeGreaterThan(0);
					expect(created?.auth_user_id).toBe(originalAuthUserId);
					} else {
						expect(body.created).toBe(0);
						expect(body.roleMismatches).toHaveLength(1);
						expect(body.roleMismatches[0].reason).toContain('"staff" account');
						expect(body.authAccountsCreated).toBe(0);

						// And no directory row was written, so there is not a record
						// claiming an address that signs in as somebody else's login.
						const rows = await env.DB
							.prepare(`SELECT COUNT(*) AS n FROM ${directory.table} WHERE email = ?`)
							.bind(email.toLowerCase())
							.first<{ n: number }>();
						expect(rows?.n).toBe(0);
					}

					// Never, for either directory: the password is untouched, the role is
					// untouched, and there is still exactly one account for the address.
					const account = await accountFor(email);
					expect(account.role).toBe("staff");
					expect(account.auth_user_id).toBe(originalAuthUserId);
					expect(account.pwd_hash).toBe(originalHash);

					const accounts = await env.DB
						.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE LOWER(email) = ?")
						.bind(email.toLowerCase())
						.first<{ n: number }>();
					expect(accounts?.n).toBe(1);
				});

				/*
				 * Re-appointing somebody who is already a coordinator is a no-op rather
				 * than an error, because `email` is UNIQUE on the directory table: the
				 * second attempt is reported as skipped instead of failing a constraint.
				 */
				it("reports a second appointment of the same person as skipped, not as a failure", async () => {
					const email = unique("already");
					const first = await createOne(directory, email, "CSE", "First Appointment");
					expect(first.status).toBe(200);
					expect(first.body.created).toBe(1);

					const second = await createOne(directory, email, "CSE", "Second Appointment");
					expect(second.status).toBe(200);
					expect(second.body.created).toBe(0);
					expect(second.body.skipped).toBe(1);
					expect(second.body.roleMismatches).toEqual([]);

					const rows = await env.DB
						.prepare(`SELECT COUNT(*) AS n FROM ${directory.table} WHERE email = ?`)
						.bind(email.toLowerCase())
						.first<{ n: number }>();
					expect(rows?.n).toBe(1);
				});
			});

			describe("list", () => {
				it("lists the directory", async () => {
					// The coordinator directory is cleared between cases, so the listing is
					// given something to list. For an HOD the rows are left over from the
					// create cases above, which is the point: the response is the same shape
					// whether or not the table has just been emptied.
					await createOne(directory, unique("listed"), "IT", "Listed Person");

					const { status, body } = await api(directory.path);
					expect(status).toBe(200);
					expect(Array.isArray(body[directory.listKey])).toBe(true);
					expect(body[directory.listKey].length).toBeGreaterThan(0);

					const row = body[directory.listKey][0];
					expect(row).toHaveProperty(directory.idColumn);
					expect(row).toHaveProperty(directory.nameColumn);
					expect(row).toHaveProperty("email");
					expect(row).toHaveProperty("department");
					// The projection is an explicit column list, which is the reason
					// this response cannot grow a password hash.
					expect(row).not.toHaveProperty("pwd_hash");
				});

				it("narrows to one department when asked", async () => {
					await createOne(directory, unique("narrowed"), "CSE", "Narrowed Person");

					const { status, body } = await api(`${directory.path}?department=CSE`);
					expect(status).toBe(200);
					expect(body.department).toBe("CSE");
					expect(
						body[directory.listKey].every((row: any) => row.department === "CSE"),
					).toBe(true);
					// Not vacuously true: something was actually returned.
					expect(body[directory.listKey].length).toBeGreaterThan(0);
				});

				it("refuses an unsupported department", async () => {
					const { status, body } = await api(`${directory.path}?department=MECH`);
					expect(status).toBe(400);
					expect(body.code).toBe("invalid-department");
				});
			});

			describe("edit", () => {
				it("updates the name and the department", async () => {
					const email = unique("edit");
					await createOne(directory, email, "IT", "Before Name");
					const before = await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(email)
						.first<{ [key: string]: number }>();
					const id = before?.[directory.idColumn];

					const { status, body } = await api(`${directory.path}/${id}`, {
						method: "PATCH",
						body: JSON.stringify({
							[directory.nameColumn]: "After Name",
							department: "EEE",
						}),
					});
					expect(status).toBe(200);
					expect(body.success).toBe(true);
					expect(body[directory.responseKey][directory.nameColumn]).toBe("After Name");
					expect(body[directory.responseKey].department).toBe("EEE");
					// The id is echoed from D1 and is the same value.
					expect(body[directory.responseKey][directory.idColumn]).toBe(id);

					const row = await env.DB
						.prepare(`SELECT ${directory.nameColumn}, department FROM ${directory.table} WHERE ${directory.idColumn} = ?`)
						.bind(id)
						.first<any>();
					expect(row).toEqual({ [directory.nameColumn]: "After Name", department: "EEE" });
				});

				it("keeps a field that was not sent", async () => {
					const email = unique("partial");
					await createOne(directory, email, "CSE", "Keep My Name");
					const before = await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(email)
						.first<{ [key: string]: number }>();
					const id = before?.[directory.idColumn];

					const { status } = await api(`${directory.path}/${id}`, {
						method: "PATCH",
						body: JSON.stringify({ department: "IT" }),
					});
					expect(status).toBe(200);

					const row = await env.DB
						.prepare(
							`SELECT ${directory.nameColumn}, email, department FROM ${directory.table} WHERE ${directory.idColumn} = ?`,
						)
						.bind(id)
						.first<any>();
					expect(row[directory.nameColumn]).toBe("Keep My Name");
					expect(row.email).toBe(email);
					expect(row.department).toBe("IT");
				});

				it("leaves the id immutable", async () => {
					const email = unique("immutable");
					await createOne(directory, email, "IT", "Fixed Identity");
					const before = await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(email)
						.first<{ [key: string]: number }>();
					const id = before?.[directory.idColumn] as number;

					// A body that echoes the same id is allowed; one that names a
					// different one is refused rather than ignored, so a caller is never
					// told it moved a record it did not.
					const echo = await api(`${directory.path}/${id}`, {
						method: "PATCH",
						body: JSON.stringify({ [directory.idColumn]: id, department: "ECE" }),
					});
					expect(echo.status).toBe(200);

					const change = await api(`${directory.path}/${id}`, {
						method: "PATCH",
						body: JSON.stringify({ [directory.idColumn]: id + 1, department: "ECE" }),
					});
					expect(change.status).toBe(400);
					expect(change.body.code).toBe(directory.immutable);

					// The row is untouched by the refused request.
					const row = await env.DB
						.prepare(`SELECT ${directory.idColumn}, department FROM ${directory.table} WHERE ${directory.idColumn} = ?`)
						.bind(id)
						.first<any>();
					expect(row[directory.idColumn]).toBe(id);
				});

				it("validates before updating", async () => {
					const email = unique("editinvalid");
					await createOne(directory, email, "IT", "Will Stay Valid");
					const before = await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(email)
						.first<{ [key: string]: number }>();
					const id = before?.[directory.idColumn];

					for (const [body, field] of [
						[{ email: "not-an-email" }, "email"],
						[{ department: "MECH" }, "department"],
						[{ [directory.nameColumn]: "" }, directory.nameColumn],
					] as const) {
						const { status, response } = await invalidPatch(directory.path, id, body);
						expect(status, field).toBe(400);
						expect(
							(response as any).details.errors.map((e: any) => e.field),
						).toContain(field);
					}

					const row = await env.DB
						.prepare(
							`SELECT ${directory.nameColumn}, email, department FROM ${directory.table} WHERE ${directory.idColumn} = ?`,
						)
						.bind(id)
						.first<any>();
					expect(row[directory.nameColumn]).toBe("Will Stay Valid");
					expect(row.email).toBe(email);
					expect(row.department).toBe("IT");
				});

				it("refuses an address that already belongs to another entry", async () => {
					const taken = unique("taken");
					const own = unique("own");
					await createOne(directory, taken, "IT", "Taken Address");
					await createOne(directory, own, "CSE", "Own Address");

					const row = await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(own)
						.first<{ [key: string]: number }>();

					const { status, body } = await api(`${directory.path}/${row?.[directory.idColumn]}`, {
						method: "PATCH",
						body: JSON.stringify({ email: taken }),
					});
					expect(status).toBe(409);
					expect(body.code).toBe("duplicate-email");
				});

				it("moves the sign-in handle with a changed email and keeps the password", async () => {
					const originalEmail = unique("move-old");
					const newEmail = unique("move-new");
					await createOne(directory, originalEmail, "IT", "Moving Person");

					const accountBefore = await accountFor(originalEmail);
					expect(accountBefore?.role).toBe(directory.role);

					const row = await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(originalEmail)
						.first<{ [key: string]: number }>();
					const id = row?.[directory.idColumn];

					const { status, body } = await api(`${directory.path}/${id}`, {
						method: "PATCH",
						body: JSON.stringify({ email: newEmail }),
					});
					expect(status).toBe(200);
					expect(body.authAccountUpdated).toBe(true);

					// The same account moved: same id, same password, new handle.
					const accountAfter = await accountFor(newEmail);
					expect(accountAfter.auth_user_id).toBe(accountBefore.auth_user_id);
					expect(accountAfter.pwd_hash).toBe(accountBefore.pwd_hash);
					expect(accountAfter.role).toBe(directory.role);
					expect(accountAfter.user_name).toBe(newEmail.toLowerCase());
					// And the old address now reaches nothing.
					expect(await accountFor(originalEmail)).toBeNull();

					// Still exactly one account for this person.
					const accounts = await env.DB
						.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE auth_user_id = ?")
						.bind(accountBefore.auth_user_id)
						.first<{ n: number }>();
					expect(accounts?.n).toBe(1);
				});

				it("refuses an email that already belongs to another login account", async () => {
					const originalEmail = unique("clash-old");
					await createOne(directory, originalEmail, "IT", "Will Clash");

					const row = await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(originalEmail)
						.first<{ [key: string]: number }>();

					// A staff login already holds this address.
					await env.DB
						.prepare(
							"INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)",
						)
						.bind(
							`c5e5f000-0000-4000-8000-0000000a${directory.authIdSuffix}2`,
							unique("clash-other").toLowerCase(),
							"not-a-real-hash",
							"staff",
							unique("clash-other").toLowerCase(),
						)
						.run();

					const { status, body } = await api(`${directory.path}/${row?.[directory.idColumn]}`, {
						method: "PATCH",
						body: JSON.stringify({ email: unique("clash-other") }),
					});
					expect(status).toBe(409);
					expect(body.code).toBe("auth-email-conflict");
				});

				it("refuses a missing record", async () => {
					const { status, body } = await api(`${directory.path}/987654`, {
						method: "PATCH",
						body: JSON.stringify({ department: "IT" }),
					});
					expect(status).toBe(404);
					expect(body.code).toBe(directory.notFound);
				});

				it("refuses an id that is not a positive integer", async () => {
					for (const badId of ["abc", "0", "-1", "1.5"]) {
						const { status, body } = await api(`${directory.path}/${badId}`, {
							method: "PATCH",
							body: JSON.stringify({ department: "IT" }),
						});
						expect(status, badId).toBe(400);
						expect(body.code).toBe(directory.invalidId);
					}
				});

				it("writes nothing when the values have not changed", async () => {
					const email = unique("noop");
					await createOne(directory, email, "IT", "Unchanged Person");
					const row = await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(email)
						.first<{ [key: string]: number }>();
					const id = row?.[directory.idColumn];

					const accountBefore = await accountFor(email);
					const { status, body } = await api(`${directory.path}/${id}`, {
						method: "PATCH",
						body: JSON.stringify({
							[directory.nameColumn]: "Unchanged Person",
							email,
							department: "IT",
						}),
					});
					expect(status).toBe(200);
					expect(body.success).toBe(true);
					// One statement at most: the row UPDATE, and no auth write when the
					// address did not move.
					expect(body.authAccountUpdated).toBe(false);

					const accountAfter = await accountFor(email);
					expect(accountAfter.pwd_hash).toBe(accountBefore.pwd_hash);
				});

				it("refuses a body that is not a JSON object", async () => {
					const { status, body } = await api(`${directory.path}/1`, {
						method: "PATCH",
						body: JSON.stringify([1, 2, 3]),
					});
					expect(status).toBe(400);
					expect(body.code).toBe("invalid-body");
				});
			});
		});
	}

	/*
	 * The rule that makes the OD workflow answerable: a department has exactly one contest
	 * coordinator.
	 *
	 * Everything else about these two directories is shared, so this is the one behaviour
	 * asserted for the coordinator alone. It is asserted through the API rather than through
	 * the validator, because the answer has to come from the table: the same person
	 * re-uploaded, a different person, a second row inside one file, and an edit that moves
	 * somebody into a department that is already filled are four different requests, and
	 * three of them have to be refused for reasons that are not the same.
	 */
	describe("one contest coordinator per department", () => {
		const directory = DIRECTORIES[1];
		const PATH = directory.path;
		const TABLE = directory.table;

		/** Every row the directory holds for one department. */
		async function rowsFor(department: string): Promise<Record<string, string>[]> {
			const { results } = await env.DB
				.prepare(
					`SELECT ${directory.nameColumn}, email FROM ${TABLE} WHERE department = ? ORDER BY ${directory.idColumn}`,
				)
				.bind(department)
				.all<Record<string, string>>();
			return results ?? [];
		}

		async function coordinatorIdFor(email: string): Promise<number> {
			const row = await env.DB
				.prepare(`SELECT ${directory.idColumn} FROM ${TABLE} WHERE email = ?`)
				.bind(email.toLowerCase())
				.first<Record<string, number>>();
			return row?.[directory.idColumn] as number;
		}

		it("appoints one coordinator for a department that has none", async () => {
			const { status, body } = await createOne(directory, freshEmail("solo"), "ECE", "First For Ece");

			expect(status).toBe(200);
			expect(body.created).toBe(1);
			expect(body.invalid).toEqual([]);
			expect(await rowsFor("ECE")).toHaveLength(1);
		});

		it("refuses a second coordinator for a department that already has one", async () => {
			await createOne(directory, freshEmail("held"), "CSE", "The Incumbent");

			const { status, body } = await createOne(directory, freshEmail("challenger"), "CSE", "The Challenger");

			/*
			 * A refusal, not a second row and not a silent skip.
			 *
			 * The error is on `department` because that is the field the admin has to
			 * change, and it is on the per-row `invalid` list rather than in the message
			 * alone so the dashboard can point at the input and say which row it was.
			 */
			expect(status).toBe(400);
			expect(body.success).toBe(false);
			expect(body.code).toBe("import-validation-failed");
			expect(body.details.invalid).toHaveLength(1);
			expect(body.details.invalid[0].row).toBe(1);
			expect(body.details.invalid[0].errors.map((e: any) => e.field)).toContain("department");
			expect(body.details.invalid[0].errors[0].message).toContain("CSE");

			// Still one row, and still the person appointed first.
			const rows = await rowsFor("CSE");
			expect(rows).toHaveLength(1);
			expect(rows[0][directory.nameColumn]).toBe("The Incumbent");
		});

		it("still appoints one for each of the four departments", async () => {
			// The rule is one *per department*, not one in total: a file covering all four
			// has to import all four.
			const departments = ["IT", "CSE", "ECE", "EEE"];
			const { status, body } = await api(PATH, {
				method: "POST",
				body: JSON.stringify({
					rows: departments.map((department) =>
						directory.makeRow(freshEmail(`each-${department}`), department, `Coordinator ${department}`),
					),
				}),
			});

			expect(status).toBe(200);
			expect(body.created).toBe(4);
			expect(body.invalid).toEqual([]);
			for (const department of departments) {
				expect(await rowsFor(department), department).toHaveLength(1);
			}
		});

		it("reports the second of two rows in one file that claim the same department", async () => {
			const { status, body } = await api(PATH, {
				method: "POST",
				body: JSON.stringify({
					rows: [
						directory.makeRow(freshEmail("first"), "IT", "First In File"),
						directory.makeRow(freshEmail("second"), "IT", "Second In File"),
					],
				}),
			});

			// The first row is appointed and the second is reported by its 1-based row
			// number, so a file is never silently short a row.
			expect(status).toBe(200);
			expect(body.created).toBe(1);
			expect(body.invalid).toHaveLength(1);
			expect(body.invalid[0].row).toBe(2);
			expect(body.invalid[0].errors.map((e: any) => e.field)).toContain("department");

			const rows = await rowsFor("IT");
			expect(rows).toHaveLength(1);
			expect(rows[0][directory.nameColumn]).toBe("First In File");
		});

		it("imports the rest of a file whose other row takes an occupied department", async () => {
			await createOne(directory, freshEmail("occupied"), "EEE", "The Incumbent");

			const { status, body } = await api(PATH, {
				method: "POST",
				body: JSON.stringify({
					rows: [
						directory.makeRow(freshEmail("blocked"), "EEE", "Blocked"),
						directory.makeRow(freshEmail("allowed"), "IT", "Allowed"),
					],
				}),
			});

			expect(status).toBe(200);
			expect(body.created).toBe(1);
			expect(body.invalid).toHaveLength(1);
			expect(await rowsFor("EEE")).toHaveLength(1);
			expect(await rowsFor("IT")).toHaveLength(1);
		});

		it("treats re-uploading an unchanged file as a no-op rather than a conflict", async () => {
			const rows = [directory.makeRow(freshEmail("idem"), "CSE", "Reuploaded")];
			const first = await api(PATH, { method: "POST", body: JSON.stringify({ rows }) });
			expect(first.body.created).toBe(1);

			const second = await api(PATH, { method: "POST", body: JSON.stringify({ rows }) });

			/*
			 * Skipped, because the row is already there -- and emphatically not rejected,
			 * which would tell an admin that their own saved coordinator conflicts with
			 * itself. The department check runs after the address check for exactly this
			 * reason.
			 */
			expect(second.status).toBe(200);
			expect(second.body.created).toBe(0);
			expect(second.body.skipped).toBe(1);
			expect(second.body.invalid).toEqual([]);
			expect(await rowsFor("CSE")).toHaveLength(1);
		});

		it("creates no login account for the refused appointment", async () => {
			const challenger = freshEmail("rejected");
			await createOne(directory, freshEmail("holder"), "ECE", "The Incumbent");

			const accountsBefore = await countRows("auth_users");
			const { status } = await createOne(directory, challenger, "ECE", "The Challenger");
			expect(status).toBe(400);

			// A refused row provisions nothing: no directory row and no account, so the
			// refused person has not been handed a login they cannot use.
			expect(await accountFor(challenger)).toBeNull();
			expect(await countRows("auth_users")).toBe(accountsBefore);
			expect(await rowsFor("ECE")).toHaveLength(1);
		});

		it("refuses to move a coordinator into a department that already has one", async () => {
			const moving = freshEmail("moving");
			await createOne(directory, moving, "IT", "Moving Person");
			await createOne(directory, freshEmail("staying"), "CSE", "Staying Person");

			const { status, body } = await api(`${PATH}/${await coordinatorIdFor(moving)}`, {
				method: "PATCH",
				body: JSON.stringify({ department: "CSE" }),
			});
			expect(status).toBe(409);
			expect(body.code).toBe("duplicate-department");

			// And the refused move left both rows exactly where they were.
			expect(await rowsFor("IT")).toHaveLength(1);
			expect(await rowsFor("CSE")).toHaveLength(1);
		});

		it("allows a coordinator to be moved into a free department", async () => {
			const moving = freshEmail("move-free");
			await createOne(directory, moving, "IT", "Moving Person");

			const { status, body } = await api(`${PATH}/${await coordinatorIdFor(moving)}`, {
				method: "PATCH",
				body: JSON.stringify({ department: "EEE" }),
			});
			expect(status).toBe(200);
			expect(body[directory.responseKey].department).toBe("EEE");
			expect(await rowsFor("IT")).toHaveLength(0);
			expect(await rowsFor("EEE")).toHaveLength(1);
		});

		it("is not a conflict with itself when the department is not being changed", async () => {
			const email = freshEmail("self");
			await createOne(directory, email, "IT", "Unchanged Person");

			// The ordinary edit, and the one that repairs a missing `auth_user_id`: the row
			// being saved is excluded from the department check, so it cannot conflict with
			// the very department it is in.
			const { status } = await api(`${PATH}/${await coordinatorIdFor(email)}`, {
				method: "PATCH",
				body: JSON.stringify({ [directory.nameColumn]: "Renamed Person" }),
			});
			expect(status).toBe(200);

			const rows = await rowsFor("IT");
			expect(rows).toHaveLength(1);
			expect(rows[0][directory.nameColumn]).toBe("Renamed Person");
		});

		it("leaves a duplicate pair it did not create exactly as it found it", async () => {
			/*
			 * Two rows for one department, written straight into the table because that is
			 * the only way they can come to exist. Nothing here is allowed to resolve that
			 * by deleting one of them: which of two coordinators is real is an
			 * administrative decision about a person's appointment, so an unrelated save
			 * must leave both rows -- and both people -- alone.
			 */
			const legacy = [
				[freshEmail("legacy-a"), "Legacy One"],
				[freshEmail("legacy-b"), "Legacy Two"],
			] as const;
			for (const [email, name] of legacy) {
				await env.DB
					.prepare(
						`INSERT INTO ${TABLE} (${directory.nameColumn}, email, department, auth_user_id)
						 VALUES (?, ?, ?, NULL)`,
					)
					.bind(name, email.toLowerCase(), "IT")
					.run();
			}

			// An appointment for a different department, then a save that touches nothing
			// about the pair.
			await createOne(directory, freshEmail("unrelated"), "ECE", "Unrelated Appointment");
			await api(`${PATH}/${await coordinatorIdFor(legacy[0][0])}`, {
				method: "PATCH",
				body: JSON.stringify({ [directory.nameColumn]: "Legacy One" }),
			});

			const rows = await rowsFor("IT");
			expect(rows).toHaveLength(2);
			expect(rows.map((row) => row.email).sort()).toEqual([legacy[0][0].toLowerCase(), legacy[1][0].toLowerCase()]);
		});

		it("does not apply the rule to heads of department", async () => {
			// Nothing in the workflow or the dashboard depends on there being only one HOD, so
			// the rule is not extended to the directory beside it. Pinned here because the
			// failure mode this guards against is the rule quietly becoming "one row per
			// directory" and starting to refuse heads of department too.
			const hod = DIRECTORIES[0];
			for (const email of [freshEmail("hod-a"), freshEmail("hod-b")]) {
				const { status, body } = await api(hod.path, {
					method: "POST",
					body: JSON.stringify({ rows: [hod.makeRow(email, "IT", "Head Of Department")] }),
				});
				expect(status, email).toBe(200);
				expect(body.created, email).toBe(1);
			}

			const { results } = await env.DB
				.prepare("SELECT COUNT(*) AS n FROM hods WHERE department = ?")
				.bind("IT")
				.all<{ n: number }>();
			expect(Number(results?.[0]?.n)).toBeGreaterThan(1);
		});
	});

	/*
	 * The property the whole feature is least likely to get right by accident: the
	 * two directories do not disturb anything that already worked. Every table the
	 * application depends on is counted, and the existing student, staff and subject
	 * endpoints are exercised, so a change to shared validation or shared
	 * provisioning would show up here rather than in production.
	 */
	describe("regressions in existing admin functionality", () => {
		it("leaves the student, staff, subject and registry tables untouched", async () => {
			// Snapshot taken after this file's own fixtures exist, so the comparison is
			// about what a directory write does to the rest of the database.
			const before = {
				staff: await countRows("staff"),
				subjects: await countRows("subjects"),
				academicBatches: await countRows("academic_batches"),
				attendanceSession: await countRows("attendance_session"),
				students: await env.DB
					.prepare("SELECT COUNT(*) AS n FROM CSE_Students_2026_2030")
					.first<{ n: number }>()
					.then((row) => row?.n ?? 0),
				authUsers: await countRows("auth_users"),
			};

			await createOne(DIRECTORIES[0], "regression.hod@kiot.ac.in", "IT", "Regression HOD");
			await createOne(DIRECTORIES[1], "regression.coord@kiot.ac.in", "IT", "Regression Coord");

			// `auth_users` is expected to grow by exactly two -- one account per new
			// entry. Everything else must be identical.
			expect(await countRows("staff")).toBe(before.staff);
			expect(await countRows("subjects")).toBe(before.subjects);
			expect(await countRows("academic_batches")).toBe(before.academicBatches);
			expect(await countRows("attendance_session")).toBe(before.attendanceSession);
			expect(
				await env.DB.prepare("SELECT COUNT(*) AS n FROM CSE_Students_2026_2030").first<{ n: number }>(),
			).toEqual({ n: before.students });
			expect(await countRows("auth_users")).toBe(before.authUsers + 2);
		});

		it("still serves the existing admin endpoints", async () => {
			const batches = await api("/api/admin/batches");
			expect(batches.status).toBe(200);
			expect(batches.body.departments).toContain("CSE");

			const subjects = await api("/api/admin/subjects");
			expect(subjects.status).toBe(200);
			expect(Array.isArray(subjects.body.subjects)).toBe(true);

			const staff = await api("/api/admin/staff?department=CSE");
			expect(staff.status).toBe(200);
			expect(staff.body.staff.every((member: any) => member.department === "CSE")).toBe(true);

			const students = await api("/api/admin/students?department=CSE&batch=2026_2030");
			expect(students.status).toBe(200);
			expect(Array.isArray(students.body.students)).toBe(true);
		});

		it("still refuses the existing admin routes to a non-admin", async () => {
			for (const path of [
				"/api/admin/batches",
				"/api/admin/subjects",
				"/api/admin/staff?department=CSE",
				DIRECTORIES[0].path,
				DIRECTORIES[1].path,
			]) {
				const response = await SELF.fetch(`https://example.com${path}`, {
					headers: { Cookie: staffCookie() },
				});
				expect(response.status, path).toBe(403);
			}
		});

		it("does not give a directory account any staff or class-advisor access", async () => {
			// The roles are deliberately separate, so an HOD or coordinator account
			// cannot reach a staff-only route even with a valid session.
			const email = "privilege.hod@kiot.ac.in";
			await createOne(DIRECTORIES[0], email, "IT", "Privilege HOD");
			const account = await accountFor(email);
			await createAuthSession(account.auth_user_id, "privilege-hod-token");

			// `requireStaff` authorises on "staff" or "class_advisor" only.
			const subjects = await SELF.fetch("https://example.com/api/subjects", {
				headers: { Cookie: "campus-flow-session=privilege-hod-token" },
			});
			expect(subjects.status).toBe(403);

			const batches = await SELF.fetch("https://example.com/api/batches", {
				headers: { Cookie: "campus-flow-session=privilege-hod-token" },
			});
			expect(batches.status).toBe(403);

			// And the class-advisor routes, which are the other role staff hold.
			const advisors = await SELF.fetch("https://example.com/api/class-advisors?staff_id=1", {
				headers: { Cookie: "campus-flow-session=privilege-hod-token" },
			});
			expect(advisors.status).toBe(403);
		});

		it("still authenticates a staff account with its own password", async () => {
			// The staff login path is unchanged, and this is the check that would fail
			// if the directory provisioning had altered the shared bcrypt
			// configuration or the password used for new accounts.
			const { body } = await api("/api/admin/staff?department=IT", {
				method: "POST",
				body: JSON.stringify({ rows: [{ staff_name: "Still Works", email: "still.works@kiot.ac.in" }] }),
			});
			expect(body.defaultPassword).toBe(DEFAULT_INITIAL_PASSWORD);

			const response = await SELF.fetch("https://example.com/api/auth/staff/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "still.works@kiot.ac.in", password: DEFAULT_INITIAL_PASSWORD }),
			});
			expect(response.status).toBe(200);
			const login = (await response.json()) as any;
			expect(login.success).toBe(true);
			expect(login.staff.email).toBe("still.works@kiot.ac.in");
			expect(JSON.stringify(login)).not.toContain("$2");
		});

		it("leaves no plaintext password anywhere in auth_users", async () => {
			// A blunt sweep rather than a targeted check: whatever the directory
			// imports wrote, no row anywhere may hold the literal.
			const { results } = await env.DB
				.prepare("SELECT auth_user_id FROM auth_users WHERE pwd_hash = ?")
				.bind(DEFAULT_INITIAL_PASSWORD)
				.all<{ auth_user_id: string }>();
			expect(results).toEqual([]);
		});
	});

	/* ============================================ permanent accounts */

	/**
	 * Both roles are permanent Campus-Flow users, and this block is what holds them to
	 * that. Everything here is a property of the *account*, not of a workflow, so it is
	 * asserted once per directory rather than folded into the import cases above.
	 */
	describe("permanent authentication", () => {
		for (const directory of DIRECTORIES) {
			it(`${directory.label}: an appointment is a usable login, not a pending invitation`, async () => {
				const email = freshEmail("permanent");
				const { status, body } = await createOne(directory, email, "IT", "Permanent Person");
				expect(status).toBe(200);
				expect(body.created).toBe(1);

				// 1. The row is linked to the account it was created with.
				const row = await env.DB
					.prepare(`SELECT ${directory.idColumn}, auth_user_id FROM ${directory.table} WHERE email = ?`)
					.bind(email.toLowerCase())
					.first<Record<string, string>>();
				const account = await accountFor(email);
				expect(row?.[directory.idColumn]).toBeGreaterThan(0);
				expect(row?.auth_user_id).toBe(account.auth_user_id);

				// 2. The credentials work, through the existing approver login.
				const response = await SELF.fetch("https://example.com/api/auth/od-approver/login", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, password: DEFAULT_INITIAL_PASSWORD }),
				});
				expect(response.status).toBe(200);
				const login = (await response.json()) as any;
				expect(login.success).toBe(true);
				expect(login.approver.role).toBe(directory.role);
				expect(login.approver.department).toBe("IT");
				expect(login.approver.name).toBe("Permanent Person");

				// 3. The session resolves back to the directory row, not just to the
				//    account -- which is the only thing `auth_user_id` is for.
				const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
				const me = await SELF.fetch("https://example.com/api/od/approver/me", {
					headers: { Cookie: cookie },
				});
				expect(me.status).toBe(200);
				const profile = (await me.json()) as any;
				expect(profile.approver.role).toBe(directory.role);
				expect(profile.approver.name).toBe("Permanent Person");
				expect(profile.approver.department).toBe("IT");
			});

			it(`${directory.label}: the account does not expire`, async () => {
				const email = freshEmail("nottl");
				expect((await createOne(directory, email, "IT", "Permanent Person")).status).toBe(200);

				/*
				 * Stated as a schema fact rather than as a wait.
				 *
				 * There is no time-based assertion that could fail this meaningfully -- an
				 * expiry test would have to out-wait the expiry to prove its absence. What
				 * *can* be asserted, and is the thing an expiry would actually be built from,
				 * is that the account carries no expiry column and that nothing in the
				 * account table can be used to expire it.
				 */
				const columns = await env.DB
					.prepare("SELECT name FROM pragma_table_info('auth_users')")
					.all<{ name: string }>();
				const names = (columns.results ?? []).map((c) => c.name.toLowerCase());
				for (const forbidden of ["expires_at", "expires", "valid_until", "disabled_at", "deleted_at", "ttl"]) {
					expect(names, `${directory.label} must not have ${forbidden}`).not.toContain(forbidden);
				}

				// And the directory row has no expiry either, so re-saving it months later
				// is not something the row itself would reject.
				const rowColumns = await env.DB
					.prepare(`SELECT name FROM pragma_table_info('${directory.table}')`)
					.all<{ name: string }>();
				const rowNames = (rowColumns.results ?? []).map((c) => c.name.toLowerCase());
				for (const forbidden of ["expires_at", "valid_until", "ttl"]) {
					expect(rowNames, `${directory.label} row must not have ${forbidden}`).not.toContain(forbidden);
				}

				// The account still signs in, which is the practical statement of "no TTL".
				const response = await SELF.fetch("https://example.com/api/auth/od-approver/login", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, password: DEFAULT_INITIAL_PASSWORD }),
				});
				expect(response.status).toBe(200);
			});

			it(`${directory.label}: re-appointing the same person is refused, not duplicated`, async () => {
				const email = freshEmail("nodupe");

				// On staff existence alone, or on the account existing, the first
				// appointment is always allowed -- so this proves the *second* is refused by
				// the directory's own uniqueness rather than by either of those.
				expect((await createOne(directory, email, "IT", "First")).body.created).toBe(1);
				const second = await createOne(directory, email, "IT", "Second");
				expect(second.status).toBe(200);
				expect(second.body.created).toBe(0);
				expect(second.body.skipped).toBe(1);

				// Exactly one row, and it kept the first name.
				const rows = await env.DB
					.prepare(`SELECT ${directory.nameColumn} FROM ${directory.table} WHERE email = ?`)
					.bind(email.toLowerCase())
					.all<Record<string, string>>();
				expect(rows.results ?? []).toHaveLength(1);
				expect(rows.results?.[0]?.[directory.nameColumn]).toBe("First");
			});

			it(`${directory.label}: re-saving repairs a missing auth_user_id`, async () => {
				const email = freshEmail("repair");
				const created = await createOne(directory, email, "IT", "Repairable");
				expect(created.body.created).toBe(1);

				// A row from before the migration: linked to nothing, and so not signable-in
				// as. Re-saving it is the point at which the link becomes knowable.
				await env.DB
					.prepare(`UPDATE ${directory.table} SET auth_user_id = NULL WHERE email = ?`)
					.bind(email.toLowerCase())
					.run();

				const id = (
					await env.DB
						.prepare(`SELECT ${directory.idColumn} FROM ${directory.table} WHERE email = ?`)
						.bind(email.toLowerCase())
						.first<Record<string, number>>()
				)?.[directory.idColumn];
				expect(id).toBeGreaterThan(0);

				const saved = await api(`${directory.path}/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ [directory.nameColumn]: "Repairable" }),
				});
				expect(saved.status).toBe(200);

				const repaired = await env.DB
					.prepare(`SELECT auth_user_id FROM ${directory.table} WHERE email = ?`)
					.bind(email.toLowerCase())
					.first<{ auth_user_id: string | null }>();
				expect(repaired?.auth_user_id).toBe((await accountFor(email)).auth_user_id);
			});
		}
	});
});

/** A PATCH that is expected to fail validation, with the body echoed back. */
async function invalidPatch(
	path: string,
	id: number | undefined,
	body: Record<string, unknown>,
): Promise<{ status: number; response: unknown }> {
	const { status, body: response } = await api(`${path}/${id}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
	return { status, response };
}