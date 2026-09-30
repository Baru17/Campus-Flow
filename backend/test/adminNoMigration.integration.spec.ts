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

/*
 * The batch list and staff creation must both work on a database where migration
 * 0016 has never been applied.
 *
 * Every other admin suite applies 0016, which means a handler that silently
 * depended on the `academic_batches` table would still pass all of them. This file
 * deliberately stops at 0015 so the built-in batch mappings are the only thing
 * available, and then checks the two behaviours that matter when the registry
 * table is missing:
 *
 *   1. The cohorts that already exist in production are still listed, so the admin
 *      can browse them and the staff picker can name them. This is the requirement
 *      that "displaying existing batches must not require migration 0016".
 *   2. Staff can be created without a batch, because a batch is an advisor
 *      attribute and not a requirement for adding a lecturer.
 *
 * `hydrateBatchRegistry` swallows the missing-table error by design, so these
 * assertions are the only thing standing between that fallback and a broken admin
 * dashboard on a not-yet-migrated database.
 */

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

		it("still lists the built-in IT cohorts", async () => {
			const { status, body } = await api("/api/admin/batches?department=IT");
			expect(status).toBe(200);
			expect(body.batches.IT.map((b: { key: string }) => b.key)).toEqual([
				"2024_2028",
				"2025_2029",
			]);
		});

		it("still lists the built-in CSE cohort", async () => {
			const { status, body } = await api("/api/admin/batches?department=CSE");
			expect(status).toBe(200);
			expect(body.batches.CSE.map((b: { key: string }) => b.key)).toEqual(["2026_2030"]);
		});

		it("returns a department entry for every advertised department", async () => {
			// The picker indexes into this object by the chosen department, so a missing
			// key would read as "no cohorts" rather than as an error.
			const { body } = await api("/api/admin/batches");
			for (const department of ["IT", "CSE", "ECE", "EEE"]) {
				expect(body.batches).toHaveProperty(department);
			}
		});

		it("serves a built-in roster without the registry", async () => {
			const { status, body } = await api("/api/admin/students?department=IT&batch=2024_2028");
			expect(status).toBe(200);
			expect(Array.isArray(body.students)).toBe(true);
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

		it("still resolves a built-in cohort as an advisor batch", async () => {
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
			expect(status).toBe(200);
			expect(body.created).toBe(1);

			const row = await env.DB
				.prepare("SELECT class_advisor, advisor_batch FROM staff WHERE email = ?")
				.bind("builtin.advisor@kiot.ac.in")
				.first<any>();
			expect(row.class_advisor).toBe("Y");
			expect(row.advisor_batch).toBe("2024_2028");
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
