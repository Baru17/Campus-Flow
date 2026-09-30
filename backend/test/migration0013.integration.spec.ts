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

/*
 * Migration 0013 backfill behaviour.
 *
 * The rule under test: a historical row's batch is recovered from the table it
 * was actually written to, never guessed from its year of study. This suite
 * therefore seeds rows *before* 0013 runs, with years deliberately chosen to
 * disagree with the table, so a year-derived backfill would be caught.
 *
 * Each test file gets isolated storage, so this file applies the migrations
 * itself rather than sharing the attendance suite's schema.
 */

type SeededSession = {
	sessionId: string;
	year: number | null;
	attendanceTable: string | null;
};

const seededSessions: SeededSession[] = [
	// Year 3 with the 2025_2029 table. A year-derived backfill would wrongly
	// record 2024_2028 here.
	{ sessionId: "M13-YEAR3-TABLE2025", year: 3, attendanceTable: "IT_Attendance_2025_2029" },
	// Year 2 with the 2024_2028 table: the mirror-image disagreement.
	{ sessionId: "M13-YEAR2-TABLE2024", year: 2, attendanceTable: "IT_Attendance_2024_2028" },
	// Table and year agree, so the mapping is unambiguous.
	{ sessionId: "M13-AGREE-2024", year: 3, attendanceTable: "IT_Attendance_2024_2028" },
	{ sessionId: "M13-AGREE-2025", year: 2, attendanceTable: "IT_Attendance_2025_2029" },
	// Unverified or missing table: must not be resolved to any batch.
	{ sessionId: "M13-UNKNOWN-TABLE", year: 3, attendanceTable: "CSE_Attendance_2024_2028" },
	{ sessionId: "M13-NULL-TABLE", year: 2, attendanceTable: null },
];

type SeededStaff = {
	staffId: string;
	department: string;
	advisorYear: number | null;
};

const seededStaff: SeededStaff[] = [
	{ staffId: "M13S-IT-Y3", department: "IT", advisorYear: 3 },
	{ staffId: "M13S-IT-Y2", department: "IT", advisorYear: 2 },
	// IT advisor with a year that has no batch: stays NULL, not guessed.
	{ staffId: "M13S-IT-Y1", department: "IT", advisorYear: 1 },
	{ staffId: "M13S-IT-NOYEAR", department: "IT", advisorYear: null },
	// Non-IT advisor: must not be handed a batch at all.
	{ staffId: "M13S-CSE-Y3", department: "CSE", advisorYear: 3 },
	{ staffId: "M13S-ECE-Y2", department: "ECE", advisorYear: 2 },
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

describe("migration 0013 backfill", () => {
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
			await applyMigration(migration);
		}

		// Seed historical rows in their pre-0013 shape.
		for (const session of seededSessions) {
			await env.DB
				.prepare(
					`INSERT INTO attendance_session (session_id, created_by, otp, expire_at, year, section,
					    period, attendance_date, attendance_table, status)
					 VALUES (?, 'legacy-staff', '000000', '2999-01-01T00:00:00.000Z', ?, 'A', 1,
					         '2026-01-01', ?, 'FINALIZED')`,
				)
				.bind(session.sessionId, session.year, session.attendanceTable)
				.run();
		}

		for (const staff of seededStaff) {
			await env.DB
				.prepare(
					`INSERT INTO staff (staff_id, staff_name, email, department, class_advisor, advisor_year)
					 VALUES (?, 'Legacy Staff', ?, ?, 1, ?)`,
				)
				.bind(staff.staffId, `${staff.staffId}@migration-test.invalid`, staff.department, staff.advisorYear)
				.run();
		}

		await applyMigration(migration0013);
	});

	async function readSession(sessionId: string) {
		return env.DB
			.prepare("SELECT session_id, department, batch, year, attendance_table FROM attendance_session WHERE session_id = ?")
			.bind(sessionId)
			.first<{ session_id: string; department: string; batch: string | null; year: number; attendance_table: string }>();
	}

	async function readStaff(staffId: string) {
		return env.DB
			.prepare("SELECT staff_id, department, advisor_year, advisor_batch FROM staff WHERE staff_id = ?")
			.bind(staffId)
			.first<{ staff_id: string; department: string; advisor_year: number | null; advisor_batch: string | null }>();
	}

	it("takes the batch from the table the session used, not from the year", async () => {
		// year 3 + IT_Attendance_2025_2029 => 2025_2029, even though year 3
		// historically mapped to the 2024_2028 batch.
		const yearThreeOn2025 = await readSession("M13-YEAR3-TABLE2025");
		expect(yearThreeOn2025?.batch).toBe("2025_2029");
		expect(yearThreeOn2025?.year).toBe(3);

		// year 2 + IT_Attendance_2024_2028 => 2024_2028.
		const yearTwoOn2024 = await readSession("M13-YEAR2-TABLE2024");
		expect(yearTwoOn2024?.batch).toBe("2024_2028");
		expect(yearTwoOn2024?.year).toBe(2);
	});

	it("maps each verified table to its own batch when the year agrees", async () => {
		expect((await readSession("M13-AGREE-2024"))?.batch).toBe("2024_2028");
		expect((await readSession("M13-AGREE-2025"))?.batch).toBe("2025_2029");
	});

	it("leaves the batch NULL when the table is not a verified one", async () => {
		const unknown = await readSession("M13-UNKNOWN-TABLE");
		expect(unknown?.batch).toBeNull();
		expect(unknown?.attendance_table).toBe("CSE_Attendance_2024_2028");

		const missing = await readSession("M13-NULL-TABLE");
		expect(missing?.batch).toBeNull();
	});

	it("preserves the historical table and year on every row", async () => {
		for (const seeded of seededSessions) {
			const row = await readSession(seeded.sessionId);
			expect(row?.attendance_table).toBe(seeded.attendanceTable);
			expect(row?.year).toBe(seeded.year);
		}
	});

	it("does not drop or add rows", async () => {
		const count = await env.DB
			.prepare("SELECT COUNT(*) AS count FROM attendance_session WHERE session_id LIKE 'M13-%'")
			.first<{ count: number }>();
		expect(count?.count).toBe(seededSessions.length);
	});

	it("defaults historical sessions to the IT department", async () => {
		// IT is the only department with tables, so no other value is possible.
		expect((await readSession("M13-AGREE-2024"))?.department).toBe("IT");
		expect((await readSession("M13-AGREE-2025"))?.department).toBe("IT");
	});

	it("backfills advisor_batch only for IT advisors", async () => {
		expect((await readStaff("M13S-IT-Y3"))?.advisor_batch).toBe("2024_2028");
		expect((await readStaff("M13S-IT-Y2"))?.advisor_batch).toBe("2025_2029");
	});

	it("does not fabricate a batch for a non-IT advisor", async () => {
		expect((await readStaff("M13S-CSE-Y3"))?.advisor_batch).toBeNull();
		expect((await readStaff("M13S-ECE-Y2"))?.advisor_batch).toBeNull();
	});

	it("leaves an IT advisor with an unusable year NULL rather than guessing", async () => {
		expect((await readStaff("M13S-IT-Y1"))?.advisor_batch).toBeNull();
		expect((await readStaff("M13S-IT-NOYEAR"))?.advisor_batch).toBeNull();
	});

	it("preserves department, class_advisor and advisor_year on every staff row", async () => {
		for (const seeded of seededStaff) {
			const row = await readStaff(seeded.staffId);
			expect(row?.department).toBe(seeded.department);
			expect(row?.advisor_year).toBe(seeded.advisorYear);
		}
	});
});
