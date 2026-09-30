/**
 * The admin API on a database where migration 0016 has never been applied.
 *
 * This file used to assert the opposite: that the cohorts baked into
 * `tableResolver.ts` were still listed, that a built-in roster was still served,
 * and that a built-in cohort was still accepted as an advisor batch. Those
 * assertions are gone because the built-in list is gone.
 *
 * That list was a hardcoded floor merged into the in-process registry, and it was
 * the cause of a real production bug. A cohort was deleted from the database and
 * its tables were dropped, but because the floor was merged in and only ever
 * added to, the pair stayed resolvable and kept being offered in the staff batch
 * selector. A batch in this application now exists if and only if it is registered
 * in `academic_batches`, so there is nothing in the source to fall back to.
 *
 * What still has to hold on a database without the registry table is the
 * *behaviour*, not the contents:
 *
 *   1. The batch list is empty rather than a 500, and every department is still
 *      keyed, because the picker indexes into that object by department and a
 *      missing key would read as an error instead of as "nothing here yet".
 *   2. A request for a batch that is not registered is refused cleanly, and a
 *      roster is not served from a table the registry does not vouch for.
 *   3. Staff can still be created, because a batch is an advisor attribute and
 *      not a requirement for adding a lecturer. Creating an advisor *is* subject
 *      to provisioning, since an advisor names a cohort that has to exist.
 *
 * `hydrateBatchRegistry` swallows the missing-table error by design, so these
 * assertions are the only thing standing between that swallow and a broken admin
 * dashboard on a not-yet-migrated database.
 */

import { env, SELF } from "cloudflare:test";
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
import migration0013 from "../migrations/0013_department-aware-attendance.sql?raw";
import migration0014 from "../migrations/0014_cse-2026-2030-test-seed.sql?raw";
import migration0015 from "../migrations/0015_simplify-subjects.sql?raw";

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

const ADMIN_ID = "c5e5f000-0000-4000-8000-0000000000ad";
const ADMIN_TOKEN = "no-migration-admin-token";

async function api(path: string, init: RequestInit = {}) {
	const response = await SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { "Content-Type": "application/json", Cookie: `campus-flow-session=${ADMIN_TOKEN}` },
	});
	return { status: response.status, body: await response.json() };
}

describe("admin API on a database without migration 0016", () => {
	beforeAll(async () => {
		for (const migration of APPLY_ORDER) {
			await applyMigration(migration);
		}
		await env.DB
			.prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
			.bind(ADMIN_ID, "no-mig-admin", "not-a-real-hash", "admin", "no.mig.admin@kiot.ac.in")
			.run();
		await env.DB
			.prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
			.bind(hashToken(ADMIN_TOKEN), ADMIN_ID, new Date(Date.now() + 60 * 60_000).toISOString())
			.run();
	});

	it("has no academic_batches table, which is the point of this file", async () => {
		const table = await env.DB
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'academic_batches'")
			.first();
		expect(table).toBeNull();
	});

	it("still has the physical tables migration 0014 created", async () => {
		// The distinction the whole change rests on: the tables are here, the
		// registry row is not, so the cohort is not offered. Presence of a table
		// alone is not what makes a batch real.
		const table = await env.DB
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
			.bind("CSE_Students_2026_2030")
			.first();
		expect(table).not.toBeNull();
	});

	describe("batch listing", () => {
		it("returns the response under a 'batches' key, which the dashboard reads", async () => {
			// A regression guard for the page bug where this map was read under a
			// different key, so every department showed no cohorts at all.
			const { status, body } = await api("/api/admin/batches");
			expect(status).toBe(200);
			expect(body).toHaveProperty("batches");
			expect(typeof body.batches).toBe("object");
			expect(body.batchesByDepartment).toBeUndefined();
		});

		it("lists no cohorts rather than inventing any", async () => {
			// Not a 500 and not a phantom cohort. With no registry there is no
			// source of truth, so the honest answer is an empty list.
			const { status, body } = await api("/api/admin/batches");
			expect(status).toBe(200);
			for (const department of ["IT", "CSE", "ECE", "EEE"]) {
				expect(body.batches[department]).toEqual([]);
			}
		});

		it("returns a department entry for every advertised department", async () => {
			// The picker indexes into this object by the chosen department, so a missing
			// key would read as "no cohorts" rather than as an error.
			const { body } = await api("/api/admin/batches");
			for (const department of ["IT", "CSE", "ECE", "EEE"]) {
				expect(body.batches).toHaveProperty(department);
			}
		});

		it("does not serve a roster for an unregistered batch", async () => {
			// The table exists, but nothing vouches for it, so it is refused rather
			// than served. Serving it would let anyone read a cohort the application
			// does not consider real.
			const { status } = await api("/api/admin/students?department=IT&batch=2024_2028");
			expect(status).toBe(400);
		});
	});

	describe("staff creation", () => {
		it("creates a non-advisor with no batch in the request", async () => {
			const { status, body } = await api("/api/admin/staff?department=IT", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ staff_name: "No Batch Needed", email: "no.batch@kiot.ac.in", class_advisor: false }],
				}),
			});
			expect(status).toBe(200);
			expect(body.created).toBe(1);

			const row = await env.DB
				.prepare("SELECT staff_id, department, class_advisor, advisor_year, advisor_section, advisor_batch FROM staff WHERE email = ?")
				.bind("no.batch@kiot.ac.in")
				.first<any>();
			expect(row.class_advisor).toBe("N");
			expect(row.advisor_batch).toBeNull();
			expect(row.advisor_year).toBeNull();
			expect(row.advisor_section).toBeNull();
			expect(row.department).toBe("IT");
		});

		it("creates a non-advisor when the row carries no advisor keys at all", async () => {
			const { status, body } = await api("/api/admin/staff?department=IT", {
				method: "POST",
				body: JSON.stringify({ rows: [{ staff_name: "Bare Row", email: "bare.row@kiot.ac.in" }] }),
			});
			expect(status).toBe(200);
			expect(body.created).toBe(1);
		});

		it("does not answer a non-advisor request with a batch-label error", async () => {
			// The exact symptom that was reported: a valid non-advisor row rejected
			// with "Enter a batch label." Any 400 here means a batch requirement crept
			// back into the handler.
			const { status, body } = await api("/api/admin/staff?department=CSE", {
				method: "POST",
				body: JSON.stringify({
					rows: [{ staff_name: "Reported Case", email: "reported.case@kiot.ac.in", class_advisor: "No", advisor_batch: "", advisor_year: "", advisor_section: "" }],
				}),
			});
			expect(status).toBe(200);
			expect(body.success).toBe(true);
			expect(body.error).toBeUndefined();
			expect(body.code).toBeUndefined();
		});

		it("refuses an advisor naming a cohort that is not registered", async () => {
			// An advisor must be attached to a cohort the application can serve, so
			// with no registry there is nothing valid to name. This used to pass
			// because the cohort was hardcoded.
			const { status, body } = await api("/api/admin/staff?department=IT", {
				method: "POST",
				body: JSON.stringify({
					rows: [
						{
							staff_name: "Built In Advisor",
							email: "builtin.advisor@kiot.ac.in",
							class_advisor: true,
							advisor_year: 3,
							advisor_section: "A",
							advisor_batch: "2024_2028",
						},
					],
				}),
			});
			expect(status).toBe(400);
			expect(body.code).toBe("batch-not-provisioned");
		});

		it("still rejects an advisor naming a cohort from another department", async () => {
			const { status, body } = await api("/api/admin/staff?department=IT", {
				method: "POST",
				body: JSON.stringify({
					rows: [
						{ staff_name: "Cross Dept", email: "cross.dept@kiot.ac.in", class_advisor: true, advisor_year: 3, advisor_section: "A", advisor_batch: "2026_2030" },
					],
				}),
			});
			expect(status).toBe(400);
			expect(body.code).toBe("batch-not-provisioned");
		});
	});
});
