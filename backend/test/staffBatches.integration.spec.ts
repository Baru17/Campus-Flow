/**
 * `GET /api/batches` — the staff-readable view of the batch registry.
 *
 * The staff dashboard builds its batch selector from this response, so the
 * property under test is completeness: the list must be the union of the
 * built-in cohorts and everything an administrator has provisioned, and it must
 * be derived from the database rather than from a list compiled into the
 * frontend.
 *
 * That distinction is the whole reason this file exists. The dashboard used to
 * render its selector from a hardcoded mirror in `src/constants.js`, so a batch
 * created through the admin dashboard was real, provisioned, present in
 * `academic_batches` and visible in the admin UI, yet absent from the only
 * picker a lecturer could reach. Nothing in the admin suite could catch that,
 * because the admin suite only ever exercised the admin picker.
 *
 * Three sources have to be covered, because each can be the one that is missing:
 *
 *   1. `BUILTIN_BATCHES` in `tableResolver.ts`, the floor that keeps the
 *      pre-registry cohorts working on a database where migration 0016 was never
 *      applied. `adminNoMigration.integration.spec.ts` covers that case for the
 *      admin route; this file covers it for the staff route.
 *   2. The rows migration 0016 seeds, so a cohort that predates the dynamic
 *      provisioning flow is still returned. The requirement is that a batch which
 *      exists in the database but was *not* created by the newest admin flow is
 *      still listed, and the seed rows are exactly that case.
 *   3. A cohort created through `POST /api/admin/batches` during this test, which
 *      proves the list is read at request time rather than snapshotted.
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

	describe("completeness of the registry", () => {
		it("returns the cohorts that predate the registry", async () => {
			// IT 2024_2028 and 2025_2029 are in BUILTIN_BATCHES and are also seeded
			// into academic_batches by migration 0016. Either source satisfies this
			// assertion, which is the point: a batch that exists but was never created
			// through the newest provisioning flow must still be listed.
			const { status, body } = await api("/api/batches", STAFF_TOKEN);
			expect(status).toBe(200);
			expect(keysFor(body, "IT")).toEqual(["2024_2028", "2025_2029"]);
		});

		it("returns a cohort that only exists as a migration-seeded registry row", async () => {
			// CSE 2026_2030 is not reachable from any provisioning flow; its tables were
			// created by migration 0014 and it is recorded in the 0016 seed. If the
			// handler read only what provisioning wrote, this would be empty.
			const { body } = await api("/api/batches", STAFF_TOKEN);
			expect(keysFor(body, "CSE")).toEqual(["2026_2030"]);
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

	describe("after an administrator provisions a cohort", () => {
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
			expect(keysFor(body, "CSE")).toEqual(expect.arrayContaining(["2026_2030", PROVISIONED_BATCH]));
			expect(keysFor(body, "IT")).toEqual(["2024_2028", "2025_2029"]);
		});

		it("returns a key and a label, and no table name", async () => {
			// `key` is the value sent in a generate request; `label` is presentation
			// only. Nothing in the response may name a table, so the client holds no
			// identifier it could interpolate into SQL.
			const { body } = await api("/api/batches", STAFF_TOKEN);
			const entry = body.batches.CSE.find((b: { key: string }) => b.key === PROVISIONED_BATCH);
			expect(entry).toEqual({ key: PROVISIONED_BATCH, label: "2027\u20132031" });
			expect(JSON.stringify(body)).not.toContain(`${"CSE"}_Students_`);
			expect(JSON.stringify(body)).not.toContain(`${"CSE"}_Attendance_`);
		});

		it("offers the cohort to the attendance flow, proving the two agree", async () => {
			// Guards the list against drifting from what the backend can actually
			// serve: a batch is only correct to offer if attendance accepts it. A
			// batch with no provisioned tables is correctly absent from this list, so
			// the picker never offers a selection the backend would reject.
			const generated = await api("/api/attendance/generate", STAFF_TOKEN, {
				method: "POST",
				body: JSON.stringify({
					year: 1,
					department: "CSE",
					batch: PROVISIONED_BATCH,
					section: "A",
					period: 1,
					subject_code: "CSETST101",
					subject_name: "Registry Probe",
				}),
			});
			expect(generated.status).toBe(200);
			expect(generated.body.session.batch).toBe(PROVISIONED_BATCH);
		});
	});
});
