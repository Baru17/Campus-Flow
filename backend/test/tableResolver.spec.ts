import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertAllowedAttendanceTable,
  assertAllowedStudentTable,
  buildTableNames,
  hydrateBatchRegistry,
  invalidateBatchRegistry,
  listAllowedStudentTables,
  listBatchesForDepartment,
  normalizeBatch,
  normalizeDepartment,
  resolveSessionTables,
  resolveTables,
  SUPPORTED_DEPARTMENTS,
} from "../src/utils/tableResolver";

/*
 * The resolver's registry is built entirely from `academic_batches` and the
 * physical tables, so it has to be hydrated from a real database before anything
 * can be resolved. These are unit tests over that contract, using the local D1
 * the test pool provides.
 *
 * The important shift from the previous version of this file is that no batch
 * resolves until the database says so. It used to assert that IT 2024_2028 and
 * CSE 2026_2030 resolved straight out of a hardcoded list in the source file,
 * which is precisely the behaviour that kept a deleted cohort alive: the pair was
 * merged into the in-process index at module load and never removed.
 */

const STUDENT_DDL = (table: string) =>
  `CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, student_id TEXT)`;
const ATTENDANCE_DDL = (table: string) =>
  `CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, register_no TEXT)`;

/**
 * Runs statements in one D1 batch.
 *
 * Batching matters here: every case provisions and tears down tables, and issuing
 * those one round trip at a time was slow enough to blow the 5s per-test timeout.
 * A timed-out case then leaves its tables behind, which cascades into the next
 * case and makes a correct assertion look broken.
 */
async function run(...statements: string[]): Promise<void> {
  const prepared = statements
    .flatMap((sql) => sql.split(";"))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((sql) => env.DB.prepare(sql));
  if (prepared.length === 0) return;
  await env.DB.batch(prepared);
}

/** Creates the physical tables for a pair, as provisioning would. */
async function provision(department: string, batch: string): Promise<void> {
  const { studentTable, attendanceTable } = buildTableNames(department as never, batch);
  await run(STUDENT_DDL(studentTable), ATTENDANCE_DDL(attendanceTable));
}

async function register(department: string, batch: string): Promise<void> {
  const { studentTable, attendanceTable } = buildTableNames(department as never, batch);
  // The years are not part of resolution, and a deliberately malformed batch must
  // still be writable so the resolver can be observed rejecting it.
  const startYear = Number.parseInt(batch.slice(0, 4), 10);
  const endYear = Number.parseInt(batch.slice(5, 9), 10);
  await env.DB
    .prepare(
      `INSERT OR REPLACE INTO academic_batches
         (department, batch, start_year, end_year, student_table, attendance_table)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      department,
      batch,
      Number.isFinite(startYear) ? startYear : 0,
      Number.isFinite(endYear) ? endYear : 0,
      studentTable,
      attendanceTable
    )
    .run();
}

async function unregister(department: string, batch: string): Promise<void> {
  await env.DB
    .prepare("DELETE FROM academic_batches WHERE department = ? AND batch = ?")
    .bind(department, batch)
    .run();
}

async function dropTables(department: string, batch: string): Promise<void> {
  const { studentTable, attendanceTable } = buildTableNames(department as never, batch);
  await run(`DROP TABLE IF EXISTS ${studentTable}`, `DROP TABLE IF EXISTS ${attendanceTable}`);
}

async function resetRegistryTable(): Promise<void> {
  /*
   * The local D1 persists across tests in a file, so a table created by an earlier
   * case would make a later "this batch must not resolve" case resolve anyway. Every
   * case therefore starts from an empty set of batch tables, otherwise the
   * table-existence check cannot be observed at all.
   *
   * The registry table itself is emptied rather than dropped and recreated: it is
   * the same shape every time, and recreating it per case was the bulk of the cost.
   */
  const { results } = await env.DB
    .prepare(
      // GLOB rather than LIKE: `_` is a literal in GLOB and a wildcard in LIKE,
      // which is exactly what is wanted here and needs no ESCAPE clause.
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND (name GLOB '*_Students_*' OR name GLOB '*_Attendance_*')`,
    )
    .all<{ name: string }>();
  const drops = (results ?? []).map((row) => `DROP TABLE IF EXISTS "${row.name}"`);

  await run(
    ...drops,
    // Created if absent, because one case deliberately drops the table to observe
    // a failed read. Emptied rather than recreated, since the shape never varies.
    `CREATE TABLE IF NOT EXISTS academic_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department TEXT NOT NULL,
      batch TEXT NOT NULL,
      start_year INTEGER NOT NULL,
      end_year INTEGER NOT NULL,
      student_table TEXT NOT NULL,
      attendance_table TEXT NOT NULL,
      UNIQUE (department, batch))`,
    "DELETE FROM academic_batches"
  );
}

/** The registry is per-isolate state, so every case starts from a fresh hydrate. */
async function hydrate(): Promise<void> {
  invalidateBatchRegistry();
  await hydrateBatchRegistry(env.DB as unknown as D1Database);
}

beforeEach(async () => {
  await resetRegistryTable();
  await hydrate();
});

describe("normalizeDepartment", () => {
  it("upper-cases and trims a supported department", () => {
    expect(normalizeDepartment("it")).toBe("IT");
    expect(normalizeDepartment("  CSE ")).toBe("CSE");
  });

  it("rejects unknown, empty and non-string values", () => {
    expect(normalizeDepartment("XYZ")).toBeNull();
    expect(normalizeDepartment("")).toBeNull();
    expect(normalizeDepartment("   ")).toBeNull();
    expect(normalizeDepartment(null)).toBeNull();
    expect(normalizeDepartment(42)).toBeNull();
  });

  it("accepts every advertised department", () => {
    for (const department of SUPPORTED_DEPARTMENTS) {
      expect(normalizeDepartment(department)).toBe(department);
    }
  });
});

describe("normalizeBatch", () => {
  it("accepts a well-formed batch label", () => {
    expect(normalizeBatch("2024_2028")).toBe("2024_2028");
    expect(normalizeBatch("  2025_2029  ")).toBe("2025_2029");
  });

  it("rejects malformed batch labels", () => {
    expect(normalizeBatch("2024-2028")).toBeNull();
    expect(normalizeBatch("2024")).toBeNull();
    expect(normalizeBatch("2024_2028; DROP TABLE students")).toBeNull();
    expect(normalizeBatch("")).toBeNull();
    expect(normalizeBatch(null)).toBeNull();
    expect(normalizeBatch(2024)).toBeNull();
  });
});

describe("buildTableNames", () => {
  it("derives the pair of table names from the department and batch", () => {
    expect(buildTableNames("CSE", "2024_2028")).toEqual({
      studentTable: "CSE_Students_2024_2028",
      attendanceTable: "CSE_Attendance_2024_2028",
    });
  });
});

describe("registry discovery", () => {
  it("resolves nothing until the database says a batch exists", () => {
    // The behaviour that matters most: an empty registry means no batches, with no
    // residual list of cohorts baked into the module.
    expect(listBatchesForDepartment("IT")).toEqual([]);
    expect(listBatchesForDepartment("CSE")).toEqual([]);
    expect(resolveTables("IT", "2024_2028")).toBeNull();
    expect(listAllowedStudentTables()).toEqual([]);
  });

  it("resolves a registered and provisioned pair", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    expect(resolveTables("IT", "2024_2028")).toMatchObject({
      department: "IT",
      batch: "2024_2028",
      studentTable: "IT_Students_2024_2028",
      attendanceTable: "IT_Attendance_2024_2028",
    });
    expect(listBatchesForDepartment("IT")).toEqual(["2024_2028"]);
  });

  it("resolves several cohorts across departments without mixing them", async () => {
    for (const [department, batch] of [
      ["IT", "2024_2028"],
      ["IT", "2025_2029"],
      ["CSE", "2024_2028"],
      ["CSE", "2026_2030"],
    ] as const) {
      await provision(department, batch);
      await register(department, batch);
    }
    await hydrate();

    expect(listBatchesForDepartment("IT")).toEqual(["2024_2028", "2025_2029"]);
    expect(listBatchesForDepartment("CSE")).toEqual(["2024_2028", "2026_2030"]);

    // A CSE request must never reach an IT table and vice versa.
    expect(resolveTables("CSE", "2024_2028")?.studentTable).toBe("CSE_Students_2024_2028");
    expect(resolveTables("IT", "2024_2028")?.studentTable).toBe("IT_Students_2024_2028");
  });

  it("does not resolve a registered batch whose tables do not exist", async () => {
    // Registered but not provisioned. Offering it would put a choice in the
    // selector that the API then refuses with "batch not configured".
    await register("CSE", "2026_2030");
    await hydrate();
    expect(resolveTables("CSE", "2026_2030")).toBeNull();
    expect(listBatchesForDepartment("CSE")).toEqual([]);
  });

  it("does not resolve a provisioned batch that is not registered", async () => {
    await provision("CSE", "2026_2030");
    await hydrate();
    expect(resolveTables("CSE", "2026_2030")).toBeNull();
  });

  it("does not resolve a pair where only one of the two tables exists", async () => {
    // The roster and the marks live in different tables, so a batch with only one
    // of them cannot take attendance and is not a usable cohort.
    await run(STUDENT_DDL("IT_Students_2024_2028"));
    await register("IT", "2024_2028");
    await hydrate();
    expect(resolveTables("IT", "2024_2028")).toBeNull();
  });

  it("never derives a batch from a year of study", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    for (const year of [2, 3, "2", "3"] as unknown[]) {
      expect(resolveTables("IT", year as string)).toBeNull();
    }
  });

  it("ignores rows with an unsupported department or a malformed batch", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    // Neither of these may become resolvable, however they are stored.
    await register("MECH", "2024_2028");
    await register("IT", "not-a-batch");
    await register("IT", "2024_2028; DROP TABLE students");
    await hydrate();
    expect(resolveTables("MECH", "2024_2028")).toBeNull();
    expect(resolveTables("IT", "not-a-batch")).toBeNull();
    expect(listBatchesForDepartment("IT")).toEqual(["2024_2028"]);
  });

  it("ignores a row whose stored table names disagree with the derived ones", async () => {
    // The names are recomputed from the department and batch, so a tampered row
    // cannot point the resolver at a table it would not otherwise have built.
    await provision("IT", "2024_2028");
    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO academic_batches
           (department, batch, start_year, end_year, student_table, attendance_table)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind("IT", "2024_2028", 2024, 2028, "IT_Students_9999_9999", "IT_Attendance_9999_9999")
      .run();
    await hydrate();
    expect(resolveTables("IT", "2024_2028")?.studentTable).toBe("IT_Students_2024_2028");
  });

  it("rejects a malformed department in the registry read", async () => {
    // A row whose department could break out of an interpolated identifier is
    // dropped rather than resolved.
    await run(STUDENT_DDL("IT_Students_2024_2028"));
    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO academic_batches
           (department, batch, start_year, end_year, student_table, attendance_table)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind('IT"; DROP TABLE students--', "2024_2028", 2024, 2028, "x", "y")
      .run();
    await hydrate();
    expect(listBatchesForDepartment("IT")).toEqual([]);
  });
});

describe("registry refresh", () => {
  it("drops a batch once its registry row is removed", async () => {
    // The regression this whole change exists for. The index used to be merged
    // into, so a cohort deleted from the database stayed resolvable and stayed in
    // the staff dropdown for the life of the isolate.
    await provision("CSE", "2026_2030");
    await register("CSE", "2026_2030");
    await hydrate();
    expect(listBatchesForDepartment("CSE")).toEqual(["2026_2030"]);

    await unregister("CSE", "2026_2030");
    await hydrate();
    expect(listBatchesForDepartment("CSE")).toEqual([]);
    expect(resolveTables("CSE", "2026_2030")).toBeNull();
  });

  it("drops a batch once its physical tables are gone", async () => {
    await provision("CSE", "2026_2030");
    await register("CSE", "2026_2030");
    await hydrate();
    expect(listBatchesForDepartment("CSE")).toEqual(["2026_2030"]);

    await dropTables("CSE", "2026_2030");
    await hydrate();
    expect(listBatchesForDepartment("CSE")).toEqual([]);
  });

  it("picks up a batch registered after the previous hydrate", async () => {
    expect(listBatchesForDepartment("IT")).toEqual([]);
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    expect(listBatchesForDepartment("IT")).toEqual(["2024_2028"]);
  });

  it("keeps the previous registry when the read fails", async () => {
    // A transient D1 error must not empty the registry: that would make every
    // existing cohort vanish and break student login and attendance outright.
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    expect(listBatchesForDepartment("IT")).toEqual(["2024_2028"]);

    await env.DB.prepare("DROP TABLE academic_batches").run();
    await hydrate();
    expect(listBatchesForDepartment("IT")).toEqual(["2024_2028"]);
  });
});

describe("listBatchesForDepartment", () => {
  it("is empty for unknown departments and non-strings", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    expect(listBatchesForDepartment("MECH")).toEqual([]);
    expect(listBatchesForDepartment(null)).toEqual([]);
    expect(listBatchesForDepartment(7)).toEqual([]);
  });

  it("lists only batches that can also be resolved", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await register("IT", "2025_2029");
    await hydrate();
    for (const batch of listBatchesForDepartment("IT")) {
      expect(resolveTables("IT", batch)).not.toBeNull();
    }
    expect(listBatchesForDepartment("IT")).toEqual(["2024_2028"]);
  });
});

describe("resolveTables", () => {
  it("rejects an IT batch asked for as CSE and vice versa", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await provision("CSE", "2024_2028");
    await register("CSE", "2024_2028");
    await hydrate();
    expect(resolveTables("CSE", "2025_2029")).toBeNull();
    expect(resolveTables("IT", "2026_2030")).toBeNull();
  });

  it("returns null for unknown departments and malformed input", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    expect(resolveTables("MECH", "2024_2028")).toBeNull();
    expect(resolveTables(null, "2024_2028")).toBeNull();
    expect(resolveTables("IT", null)).toBeNull();
    expect(resolveTables("IT", "")).toBeNull();
  });
});

describe("resolveSessionTables", () => {
  it("resolves from the stored department and batch", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    const tables = resolveSessionTables({ department: "IT", batch: "2024_2028", year: 2 });
    expect(tables?.batch).toBe("2024_2028");
    expect(tables?.attendanceTable).toBe("IT_Attendance_2024_2028");
  });

  it("does not fall back to the year when the batch is missing", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    expect(resolveSessionTables({ department: "IT", batch: null, year: 2 })).toBeNull();
    expect(resolveSessionTables({ department: "IT", year: 2 })).toBeNull();
  });

  it("returns null without a usable department", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    expect(resolveSessionTables(null)).toBeNull();
    expect(resolveSessionTables({ batch: "2024_2028" })).toBeNull();
  });
});

describe("allow-list assertions", () => {
  it("only exposes the student tables the registry backs", async () => {
    for (const [department, batch] of [
      ["IT", "2024_2028"],
      ["IT", "2025_2029"],
      ["CSE", "2024_2028"],
    ] as const) {
      await provision(department, batch);
      await register(department, batch);
    }
    await hydrate();
    expect(listAllowedStudentTables().map((tables) => tables.studentTable).sort()).toEqual([
      "CSE_Students_2024_2028",
      "IT_Students_2024_2028",
      "IT_Students_2025_2029",
    ]);
  });

  it("accepts every resolved name", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    for (const tables of listAllowedStudentTables()) {
      expect(() => assertAllowedStudentTable(tables.studentTable)).not.toThrow();
      expect(() => assertAllowedAttendanceTable(tables.attendanceTable)).not.toThrow();
    }
  });

  it("rejects table names that are not on the allow-list", async () => {
    await provision("IT", "2024_2028");
    await register("IT", "2024_2028");
    await hydrate();
    expect(() => assertAllowedStudentTable("IT_Students_2020_2024")).toThrow();
    expect(() => assertAllowedStudentTable("sqlite_master")).toThrow();
    expect(() => assertAllowedAttendanceTable("IT_Attendance_2024_2028; DROP TABLE students")).toThrow();
    // Registered in another department, so not reachable from here.
    expect(() => assertAllowedAttendanceTable("CSE_Attendance_2024_2028")).toThrow();
  });
});
