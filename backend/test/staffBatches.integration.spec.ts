/**
 * `GET /api/batches` and the registry behind it.
 *
 * The staff dashboard builds its batch selector from this response, so the
 * property under test is that the list is *exactly* what the database says and
 * nothing else. That is the whole reason this file exists. The selector used to
 * be rendered from a hardcoded mirror in `src/constants.js`, fed by a hardcoded
 * floor in `tableResolver.ts`, so a cohort could be real in D1 and absent from
 * the only picker a lecturer could reach - and, once the mirror existed on both
 * sides, a cohort that had been deleted outright kept being offered forever.
 *
 * A cohort is offered if and only if it is registered in `academic_batches` and
 * both of its physical tables exist. Each of those three inputs is exercised
 * below, because each can independently be the one that is wrong:
 *
 *   1. `academic_batches` rows, which is what provisioning writes.
 *   2. Physical table existence, so a registered row whose tables were dropped
 *      is not offered. Offering it would put a choice in the UI that the API
 *      then refuses.
 *   3. Removal, so a cohort that is deregistered stops being offered rather than
 *      lingering for the life of the Worker isolate.
 *
 * Each test file gets isolated storage, so this file applies the migrations itself.
 */

import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
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

const ADMIN_ID = "c5e5f200-0000-4000-8000-0000000000ad";
const STAFF_ID = "c5e5f200-0000-4000-8000-0000000000st";
const STUDENT_ID = "c5e5f200-0000-4000-8000-0000000000sd";
const ADMIN_TOKEN = "staff-batches-admin-token";
const STAFF_TOKEN = "staff-batches-staff-token";
const STUDENT_TOKEN = "staff-batches-student-token";

/** A cohort provisioned through the admin API rather than by a migration. */
const PROVISIONED_BATCH = "2027_2031";

/** The cohort whose tables migration 0014 created and which 0016 registered. */
const MIGRATED_CSE_BATCH = "2026_2030";

async function seedUser(id: string, token: string, name: string, role: string, email: string): Promise<void> {
	await env.DB
		.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
		.bind(id, name, "not-a-real-hash", role, email)
		.run();
	await env.DB
		.prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
		.bind(hashToken(token), id, new Date(Date.now() + 60 * 60_000).toISOString())
		.run();
}

async function api(path: string, token?: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token) headers.Cookie = `campus-flow-session=${token}`;
	const response = await SELF.fetch(`https://example.com${path}`, { ...init, headers });
	return { status: response.status, body: await response.json() };
}

const keysFor = (body: any, department: string): string[] =>
	(body?.batches?.[department] ?? []).map((b: { key: string }) => b.key);

describe("GET /api/batches for the staff dashboard", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}
		await seedUser(ADMIN_ID, ADMIN_TOKEN, "sb-admin", "admin", "sb.admin@kiot.ac.in");
		await seedUser(STAFF_ID, STAFF_TOKEN, "sb-staff", "staff", "sb.staff@kiot.ac.in");
		await seedUser(STUDENT_ID, STUDENT_TOKEN, "sb-student", "student", "sb.student@kiot.ac.in");
		// The attendance generate handler requires a staff row, so the one test that
		// drives that flow needs a lecturer to exist as well as an auth user.
		await env.DB
			.prepare(
				"INSERT INTO staff (staff_id, staff_name, email, department, auth_user_id) VALUES (?, ?, ?, ?, ?)",
			)
			.bind("SBSTF001", "Registry Probe Lecturer", "sb.staff@kiot.ac.in", "CSE", STAFF_ID)
			.run();
	});

	describe("authorization", () => {
		it("serves a signed-in staff member", async () => {
			// The regression this whole file guards: the only batch list a lecturer
			// could reach used to be the one compiled into the frontend bundle.
			const { status } = await api("/api/batches", STAFF_TOKEN);
			expect(status).toBe(200);
		});

		it("requires a session at all", async () => {
			expect((await api("/api/batches")).status).toBe(401);
		});

		it("refuses a student session", async () => {
			// A batch list is teaching data, not administrative data, so it stops at
			// staff. A student has no business enumerating the cohorts.
			const { status, body } = await api("/api/batches", STUDENT_TOKEN);
			expect(status).toBe(403);
			expect(body.batches).toBeUndefined();
		});
	});

	describe("a batch appears because the database says so", () => {
		it("lists a cohort that exists only as a migration-seeded registry row", async () => {
			// CSE 2026_2030 is not reachable from any provisioning flow: its tables
			// were created by migration 0014 and it is recorded in the 0016 seed. If the
			// handler read only what provisioning wrote, this would be empty.
			const { body } = await api("/api/batches", STAFF_TOKEN);
			expect(keysFor(body, "CSE")).toContain(MIGRATED_CSE_BATCH);
		});

		it("lists the cohorts that predate the registry", async () => {
			// IT 2024_2028 and 2025_2029 are registered by the 0016 seed and their
			// tables come from 0001. Neither was created through the newest
			// provisioning flow, and both must still be listed.
			const { status, body } = await api("/api/batches", STAFF_TOKEN);
			expect(status).toBe(200);
			expect(keysFor(body, "IT")).toEqual(["2024_2028", "2025_2029"]);
		});

		it("has an entry for every advertised department", async () => {
			// The selector indexes into this object by the chosen department, so a
			// missing key would read as "no cohorts" rather than as an error.
			const { body } = await api("/api/batches", STAFF_TOKEN);
			for (const department of body.departments) {
				expect(body.batches).toHaveProperty(department);
			}
			expect(body.departments).toEqual(["IT", "CSE", "ECE", "EEE"]);
		});

		it("agrees with the admin batch list", async () => {
			// The two pickers must not be able to disagree about which batches exist,
			// which is why the staff route reuses the admin route's shape and registry.
			const staff = await api("/api/batches", STAFF_TOKEN);
			const admin = await api("/api/admin/batches", ADMIN_TOKEN);
			expect(staff.body.batches).toEqual(admin.body.batches);
			expect(staff.body.departments).toEqual(admin.body.departments);
		});
	});

	describe("a batch appears automatically once an administrator provisions it", () => {
		beforeAll(async () => {
			await api("/api/admin/batches", ADMIN_TOKEN, {
				method: "POST",
				body: JSON.stringify({ department: "CSE", batch: PROVISIONED_BATCH }),
			});
		});

		it("appears for staff on the very next request", async () => {
			// No rebuild, no migration, no restart. The registry is hydrated per
			// request and provisioning invalidates the per-isolate cache, so this is
			// the assertion that the staff picker tracks the admin flow at runtime.
			const { status, body } = await api("/api/batches", STAFF_TOKEN);
			expect(status).toBe(200);
			expect(keysFor(body, "CSE")).toContain(PROVISIONED_BATCH);
		});

		it("does not disturb the cohorts that were already there", async () => {
			// The union, not a replacement: provisioning a new cohort must never hide
			// an existing one from the staff picker.
			const { body } = await api("/api/batches", STAFF_TOKEN);
			expect(keysFor(body, "CSE")).toEqual(
				expect.arrayContaining([MIGRATED_CSE_BATCH, PROVISIONED_BATCH])
			);
			expect(keysFor(body, "IT")).toEqual(["2024_2028", "2025_2029"]);
		});

		it("returns a key and a label, and no table name", async () => {
			// `key` is the value sent in a generate request; `label` is presentation
			// only. Nothing in the response may name a table, so the client holds no
			// identifier it could interpolate into SQL.
			const { body } = await api("/api/batches", STAFF_TOKEN);
			const entry = body.batches.CSE.find((b: { key: string }) => b.key === PROVISIONED_BATCH);
			expect(entry).toEqual({ key: PROVISIONED_BATCH, label: "2027\u20132031" });
			expect(JSON.stringify(body)).not.toContain("_Students_");
			expect(JSON.stringify(body)).not.toContain("_Attendance_");
		});

		it("offers the cohort to the attendance flow, proving the two agree", async () => {
			// Guards the list against drifting from what the backend can actually
			// serve: a batch is only correct to offer if attendance accepts it.
			const generated = await api("/api/attendance/generate", STAFF_TOKEN, {
				method: "POST",
				body: JSON.stringify({
					year: 1,
					department: "CSE",
					batch: PROVISIONED_BATCH,
					section: "A",
					period: 1,
					subject_code: "CSETST101",
					subject_name: "CSE Year 1 Test Subject",
				}),
			});
			expect(generated.status).toBe(200);
			expect(generated.body.session.batch).toBe(PROVISIONED_BATCH);
		});
	});

	describe("a batch disappears once it is no longer valid", () => {
		/*
		 * This is the reported production state: the row was deleted from
		 * `academic_batches` and both physical tables were dropped, yet the staff
		 * selector kept offering the cohort. It is reproduced here exactly.
		 */
		beforeAll(async () => {
			await env.DB
				.prepare("DELETE FROM academic_batches WHERE department = ? AND batch = ?")
				.bind("CSE", MIGRATED_CSE_BATCH)
				.run();
			for (const table of [
				"CSE_Students_" + MIGRATED_CSE_BATCH,
				"CSE_Attendance_" + MIGRATED_CSE_BATCH,
			]) {
				await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
			}
		});

		it("stops listing a cohort that was unregistered and had its tables dropped", async () => {
			const { status, body } = await api("/api/batches", STAFF_TOKEN);
			expect(status).toBe(200);
			expect(keysFor(body, "CSE")).not.toContain(MIGRATED_CSE_BATCH);
		});

		it("does not list it while the other cohorts are unaffected", async () => {
			// Removal must be surgical: deregistering one cohort cannot empty the rest.
			const { body } = await api("/api/batches", STAFF_TOKEN);
			expect(keysFor(body, "CSE")).toEqual([PROVISIONED_BATCH]);
			expect(keysFor(body, "IT")).toEqual(["2024_2028", "2025_2029"]);
		});

		it("refuses attendance for the deleted cohort", async () => {
			// The list and the API agree, so the UI can no longer produce a request
			// the backend will reject.
			const generated = await api("/api/attendance/generate", STAFF_TOKEN, {
				method: "POST",
				body: JSON.stringify({
					year: 1,
					department: "CSE",
					batch: MIGRATED_CSE_BATCH,
					section: "A",
					period: 1,
					subject_code: "CSETST101",
					subject_name: "CSE Year 1 Test Subject",
				}),
			});
			expect(generated.status).toBe(400);
			expect(generated.body.code).toBe("batch-not-configured");
		});
	});

	describe("a registered row is not enough on its own", () => {
		it("does not list a cohort whose tables were dropped but whose row survives", async () => {
			// Re-register the row without recreating the tables. The tables stay gone,
			// so this isolates table existence from registration.
			await env.DB
				.prepare(
					`INSERT OR REPLACE INTO academic_batches
					   (department, batch, start_year, end_year, student_table, attendance_table)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					"CSE",
					MIGRATED_CSE_BATCH,
					2026,
					2030,
					`CSE_Students_${MIGRATED_CSE_BATCH}`,
					`CSE_Attendance_${MIGRATED_CSE_BATCH}`
				)
				.run();

			const { body } = await api("/api/batches", STAFF_TOKEN);
			// Offering a batch the API would refuse is worse than not offering it, so a
			// row without its tables is not a cohort.
			expect(keysFor(body, "CSE")).not.toContain(MIGRATED_CSE_BATCH);
		});
	});
});
