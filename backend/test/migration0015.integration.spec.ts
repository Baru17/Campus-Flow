import { env } from "cloudflare:test";
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
import migration0013 from "../migrations/0013_department-aware-attendance.sql?raw";
import migration0014 from "../migrations/0014_cse-2026-2030-test-seed.sql?raw";
import migration0015 from "../migrations/0015_simplify-subjects.sql?raw";

/*
 * Migration 0015: the subjects table is reduced to subject_id / subject_code /
 * subject_name.
 *
 * The thing worth protecting here is data, not shape. A migration that rebuilds a
 * table can be perfectly correct on an empty database and still silently drop
 * every production row, so this suite seeds the 16 subjects that actually exist
 * in production, at their real ids, runs the migration, and asserts every one of
 * them survived with its id, code and name intact.
 */

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

/** The subjects that exist in production, captured before the migration ran. */
const PRODUCTION_SUBJECTS: { id: number; subject_code: string; subject_name: string }[] = [
	{ id: 1, subject_code: "BE23MA203", subject_name: "Discrete Mathematics" },
	{ id: 2, subject_code: "BE23CS403", subject_name: "Python for Data Science" },
	{ id: 3, subject_code: "BE23CS404", subject_name: "Data Structures and Algorithms" },
	{ id: 4, subject_code: "BE23CS405", subject_name: "Database Management System" },
	{ id: 5, subject_code: "BE23CS406", subject_name: "Operating Systems" },
	{ id: 6, subject_code: "BE23EN103", subject_name: "Professional Communication Laboratory - I" },
	{ id: 7, subject_code: "BE23PT805", subject_name: "Engineering Clinic - II" },
	{ id: 8, subject_code: "BE23PT807", subject_name: "Aptitude Skills - II" },
	{ id: 9, subject_code: "BE23IT404", subject_name: "System Software" },
	{ id: 10, subject_code: "BE23XXXXX", subject_name: "Open Elective - I" },
	{ id: 11, subject_code: "BE23AC403", subject_name: "Indian Constitution" },
	{ id: 12, subject_code: "BE23MM06", subject_name: "Entrepreneurship and Start-ups" },
	{ id: 13, subject_code: "BE23CS410", subject_name: "C# & .NET" },
	{ id: 14, subject_code: "BE23CS412", subject_name: "ES & IOT" },
	{ id: 15, subject_code: "BE23YYYYY", subject_name: "DIV" },
	{ id: 16, subject_code: "BE23PW701", subject_name: "MAP" },
];

describe("migration 0015 subjects simplification", () => {
	let columnsBefore: string[] = [];
	let subjectsBefore: Record<string, unknown>[] = [];

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
			migration0013,
			migration0014,
		]) {
			await applyMigration(migration);
		}

		// Seed the real production catalog at the pre-0015 shape.
		for (const subject of PRODUCTION_SUBJECTS) {
			await env.DB
				.prepare(
					"INSERT INTO subjects (id, subject_code, subject_name, year, department) VALUES (?, ?, ?, ?, 'IT')",
				)
				.bind(subject.id, subject.subject_code, subject.subject_name, subject.id <= 8 ? 2 : 3)
				.run();
		}

		// Capture the pre-migration shape and data so the assertions compare
		// against what was really there rather than what the test assumed.
		columnsBefore = (await env.DB.prepare("PRAGMA table_info(subjects)").all<{ name: string }>())
			.results.map((column) => column.name);
		subjectsBefore = (await env.DB.prepare("SELECT id, subject_code, subject_name FROM subjects ORDER BY id").all())
			.results as Record<string, unknown>[];

		await applyMigration(migration0015);
	});

	it("starts from the old five-column shape so the test is meaningful", () => {
		// Guards against this suite silently passing because the fixture changed
		// shape: if `year`/`department` were already gone here, the assertions
		// below would prove nothing about the rebuild.
		expect(columnsBefore).toEqual([
			"id",
			"subject_code",
			"subject_name",
			"year",
			"department",
		]);
		expect(subjectsBefore).toHaveLength(16);
	});

	it("leaves exactly the three subject columns", async () => {
		const columns = (await env.DB.prepare("PRAGMA table_info(subjects)").all<{ name: string }>())
			.results.map((column) => column.name);
		expect(columns).toEqual(["subject_id", "subject_code", "subject_name"]);
	});

	it("drops the year and department columns", async () => {
		const columns = (await env.DB.prepare("PRAGMA table_info(subjects)").all<{ name: string }>())
			.results.map((column) => column.name);
		expect(columns).not.toContain("year");
		expect(columns).not.toContain("department");
	});

	it("renames id to subject_id rather than reissuing it", async () => {
		// Historical `subject_id` query parameters and the class advisor's stored
		// references point at these values. Reissuing ids would silently re-point
		// every one of them at a different subject.
		const { results } = await env.DB
			.prepare(
				"SELECT subject_id, subject_code FROM subjects WHERE subject_code != 'CSETST101' ORDER BY subject_id",
			)
			.all<{ subject_id: number; subject_code: string }>();
		expect(results.map((row) => row.subject_id)).toEqual(
			PRODUCTION_SUBJECTS.map((subject) => subject.id),
		);
	});

	it("preserves all 16 existing IT subjects with their ids, codes and names", async () => {
		const { results } = await env.DB
			.prepare(
				"SELECT subject_id, subject_code, subject_name FROM subjects WHERE subject_code != 'CSETST101' ORDER BY subject_id",
			)
			.all<{ subject_id: number; subject_code: string; subject_name: string }>();

		expect(results).toEqual(
			PRODUCTION_SUBJECTS.map((subject) => ({
				subject_id: subject.id,
				subject_code: subject.subject_code,
				subject_name: subject.subject_name,
			})),
		);
	});

	it("preserves the CSE year 1 test subject seeded by 0015", async () => {
		const row = await env.DB
			.prepare("SELECT subject_id, subject_code, subject_name FROM subjects WHERE subject_code = 'CSETST101'")
			.first<{ subject_id: number; subject_code: string; subject_name: string }>();
		expect(row?.subject_name).toBe("CSE Year 1 Test Subject");
	});

	it("ends with exactly 17 subjects", async () => {
		const { results } = await env.DB
			.prepare("SELECT COUNT(*) AS n FROM subjects")
			.all<{ n: number }>();
		expect(results[0].n).toBe(17);
	});

	it("keeps subject_code unique", async () => {
		const indexes = (await env.DB
			.prepare("PRAGMA index_list(subjects)")
			.all<{ name: string; unique: number }>())
			.results;
		const uniqueCode = await env.DB
			.prepare("SELECT subject_code FROM subjects GROUP BY subject_code HAVING COUNT(*) > 1")
			.all();
		expect(uniqueCode.results).toHaveLength(0);
		// The UNIQUE constraint on subject_code survives the rebuild.
		expect(indexes.some((index) => index.unique === 1)).toBe(true);
	});

	it("no longer has indexes built on the dropped columns", async () => {
		const { results } = await env.DB
			.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'subjects'")
			.all<{ name: string; sql: string }>();
		const names = results.map((row) => row.name);
		expect(names).not.toContain("idx_subjects_year_name");
		expect(names).not.toContain("idx_subjects_department_year");
		expect(names).toContain("idx_subjects_name");
		// No surviving index may still reference a dropped column.
		for (const row of results) {
			expect(row.sql ?? "").not.toContain("department");
			expect(row.sql ?? "").not.toContain("year");
		}
	});

	it("leaves no staging table behind", async () => {
		// The rebuild runs through subjects_simplified. If the rename step were
		// skipped the leftover would shadow the real table, so assert it is gone.
		const { results } = await env.DB
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'subjects%'")
			.all<{ name: string }>();
		expect(results.map((row) => row.name)).toEqual(["subjects"]);
	});

	it("leaves the student, staff and attendance tables untouched", async () => {
		// Only the subject entity changes. Batch routing, the student tables and the
		// attendance tables must keep the columns that carry department/year/class.
		for (const table of ["IT_Students_2024_2028", "CSE_Students_2026_2030"]) {
			const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
			const columns = results.map((column) => column.name);
			expect(columns).toContain("year");
			expect(columns).toContain("section");
		}
		for (const table of ["IT_Attendance_2024_2028", "CSE_Attendance_2026_2030"]) {
			const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
			const columns = results.map((column) => column.name);
			expect(columns).toContain("section");
			expect(columns).toContain("subject_code");
			expect(columns).toContain("subject_name");
			expect(columns).toContain("attendance_date");
		}
		const { results } = await env.DB.prepare("PRAGMA table_info(staff)").all<{ name: string }>();
		const staffColumns = results.map((column) => column.name);
		expect(staffColumns).toContain("department");
		expect(staffColumns).toContain("advisor_year");
		expect(staffColumns).toContain("advisor_batch");
	});
});
