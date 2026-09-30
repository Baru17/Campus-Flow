import { describe, expect, it } from "vitest";
import {
  assertAllowedAttendanceTable,
  assertAllowedStudentTable,
  listAllowedStudentTables,
  listBatchesForDepartment,
  normalizeBatch,
  normalizeDepartment,
  resolveSessionTables,
  resolveTables,
  SUPPORTED_DEPARTMENTS,
} from "../src/utils/tableResolver";

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

describe("resolveTables", () => {
  it("resolves the IT batches that exist, by department and batch", () => {
    expect(resolveTables("IT", "2024_2028")).toMatchObject({
      department: "IT",
      batch: "2024_2028",
      studentTable: "IT_Students_2024_2028",
      attendanceTable: "IT_Attendance_2024_2028",
    });
    expect(resolveTables("it", "2025_2029")).toMatchObject({
      department: "IT",
      batch: "2025_2029",
      studentTable: "IT_Students_2025_2029",
      attendanceTable: "IT_Attendance_2025_2029",
    });
  });

  it("never derives a batch from a year of study", () => {
    // 2 and 3 are years of study, not batch labels. They must not resolve.
    expect(resolveTables("IT", 2 as unknown as string)).toBeNull();
    expect(resolveTables("IT", 3 as unknown as string)).toBeNull();
    expect(resolveTables("IT", "2")).toBeNull();
    expect(resolveTables("IT", "3")).toBeNull();
  });

  it("returns null for batches that are not provisioned", () => {
    expect(resolveTables("IT", "2020_2024")).toBeNull();
    expect(resolveTables("IT", "2027_2031")).toBeNull();
  });

  it("returns null for departments that have no tables provisioned", () => {
    for (const department of ["CSE", "ECE", "EEE"]) {
      expect(resolveTables(department, "2024_2028")).toBeNull();
      expect(resolveTables(department, "2025_2029")).toBeNull();
    }
  });

  it("resolves the provisioned CSE batch to its own pair of tables", () => {
    const tables = resolveTables("CSE", "2026_2030");
    expect(tables?.studentTable).toBe("CSE_Students_2026_2030");
    expect(tables?.attendanceTable).toBe("CSE_Attendance_2026_2030");
  });

  it("keeps the IT and CSE table sets disjoint", () => {
    // A CSE request must never be able to reach an IT table, and vice versa.
    const cse = resolveTables("CSE", "2026_2030");
    for (const batch of ["2024_2028", "2025_2029"]) {
      const it = resolveTables("IT", batch);
      expect(cse?.studentTable).not.toBe(it?.studentTable);
      expect(cse?.attendanceTable).not.toBe(it?.attendanceTable);
    }
  });

  it("rejects an IT batch asked for as CSE and vice versa", () => {
    // Neither direction is configured, so both are refused rather than guessed.
    expect(resolveTables("CSE", "2024_2028")).toBeNull();
    expect(resolveTables("CSE", "2025_2029")).toBeNull();
    expect(resolveTables("IT", "2026_2030")).toBeNull();
  });

  it("rejects a CSE batch that was never provisioned", () => {
    expect(resolveTables("CSE", "2027_2031")).toBeNull();
  });

  it("returns null for unknown departments and malformed input", () => {
    expect(resolveTables("MECH", "2024_2028")).toBeNull();
    expect(resolveTables(null, "2024_2028")).toBeNull();
    expect(resolveTables("IT", null)).toBeNull();
    expect(resolveTables("IT", "")).toBeNull();
  });
});

describe("listBatchesForDepartment", () => {
  it("lists only batches that can be resolved", () => {
    expect(listBatchesForDepartment("IT").sort()).toEqual(["2024_2028", "2025_2029"]);
    for (const batch of listBatchesForDepartment("IT")) {
      expect(resolveTables("IT", batch)).not.toBeNull();
    }
  });

  it("is empty for departments without tables", () => {
    expect(listBatchesForDepartment("ECE")).toEqual([]);
    expect(listBatchesForDepartment("EEE")).toEqual([]);
    expect(listBatchesForDepartment("MECH")).toEqual([]);
    expect(listBatchesForDepartment(null)).toEqual([]);
  });

  it("lists the provisioned CSE batch", () => {
    expect(listBatchesForDepartment("CSE")).toEqual(["2026_2030"]);
    expect(resolveTables("CSE", "2026_2030")).not.toBeNull();
  });
});

describe("resolveSessionTables", () => {
  it("resolves from the stored department and batch", () => {
    const tables = resolveSessionTables({ department: "IT", batch: "2024_2028", year: 2 });
    expect(tables?.batch).toBe("2024_2028");
    expect(tables?.attendanceTable).toBe("IT_Attendance_2024_2028");
  });

  it("does not fall back to the year when the batch is missing", () => {
    expect(resolveSessionTables({ department: "IT", batch: null, year: 2 })).toBeNull();
    expect(resolveSessionTables({ department: "IT", year: 2 })).toBeNull();
  });

  it("refuses a batch that is not allow-listed for the department", () => {
    expect(resolveSessionTables({ department: "IT", batch: "2020_2024" })).toBeNull();
    expect(resolveSessionTables({ department: "CSE", batch: "2024_2028" })).toBeNull();
  });

  it("returns null without a usable department", () => {
    expect(resolveSessionTables(null)).toBeNull();
    expect(resolveSessionTables({ department: "CSE", batch: "2024_2028" })).toBeNull();
    expect(resolveSessionTables({ batch: "2024_2028" })).toBeNull();
  });
});

describe("allow-list assertions", () => {
  it("only exposes the student tables that exist", () => {
    const names = listAllowedStudentTables().map((tables) => tables.studentTable).sort();
    expect(names).toEqual([
      "CSE_Students_2026_2030",
      "IT_Students_2024_2028",
      "IT_Students_2025_2029",
    ]);
  });

  it("accepts every resolved name", () => {
    for (const tables of listAllowedStudentTables()) {
      expect(() => assertAllowedStudentTable(tables.studentTable)).not.toThrow();
      expect(() => assertAllowedAttendanceTable(tables.attendanceTable)).not.toThrow();
    }
  });

  it("rejects table names that are not on the allow-list", () => {
    expect(() => assertAllowedStudentTable("IT_Students_2020_2024")).toThrow();
    expect(() => assertAllowedStudentTable("sqlite_master")).toThrow();
    expect(() => assertAllowedAttendanceTable("IT_Attendance_2024_2028; DROP TABLE students")).toThrow();
    expect(() => assertAllowedAttendanceTable("CSE_Attendance_2024_2028")).toThrow();
  });
});
