import { describe, expect, it } from "vitest";
import {
  ALLOWED_SECTIONS,
  validateStaffRow,
  validateStudentRow,
  validateSubjectRow,
  validateYear,
} from "../src/utils/adminValidation";
import { normalizeBatchInput, validateBatchInput } from "../src/utils/batchValidation";

/*
 * Row-level validation, without a database.
 *
 * These are the checks that stand between a spreadsheet cell and a row in a
 * student or staff table. They are asserted here as pure functions because the
 * interesting cases are inputs rather than outcomes: a numeric year arriving as a
 * number instead of a string, an explicit class-advisor flag, a section outside the
 * allowed set. The database-backed behaviour is covered in adminApi.integration.
 */

const validStudent = {
  student_id: "2K24CS001",
  register_no: "24CS001",
  student_name: "Asha Raman",
  year: 3,
  section: "A",
  email: "asha.raman@kiot.ac.in",
};

function fieldErrors(result: ReturnType<typeof validateStudentRow>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.field);
}

describe("validateStudentRow", () => {
  it("accepts a complete row", () => {
    const result = validateStudentRow(validStudent);
    expect(result.ok).toBe(true);
  });

  it("accepts a year sent as a string, which is how a spreadsheet cell arrives", () => {
    const result = validateStudentRow({ ...validStudent, year: "3" });
    expect(result.ok).toBe(true);
  });

  it("accepts a numeric year, which is how a typed form or JSON body sends it", () => {
    // A regression guard: the original implementation routed every value through a
    // string-only helper, so `year: 3` was reported as "Year is required" and every
    // hand-typed student import was rejected.
    const result = validateStudentRow({ ...validStudent, year: 3 });
    expect(result.ok).toBe(true);
  });

  it("normalises the id, section and email", () => {
    const result = validateStudentRow({
      ...validStudent,
      student_id: " 2k24cs001 ",
      section: " a ",
      email: "ASHA.RAMAN@KIOT.AC.IN",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.student_id).toBe("2K24CS001");
      expect(result.value.section).toBe("A");
      expect(result.value.email).toBe("asha.raman@kiot.ac.in");
    }
  });

  it("requires an email, because the login handler matches on it", () => {
    expect(fieldErrors(validateStudentRow({ ...validStudent, email: "" }))).toContain("email");
    expect(fieldErrors(validateStudentRow({ ...validStudent, email: "not-an-email" }))).toContain("email");
  });

  it.each(ALLOWED_SECTIONS)("accepts section %s", (section) => {
    const result = validateStudentRow({ ...validStudent, section });
    expect(result.ok).toBe(true);
  });

  it("keeps section D available, which the previous A-C list dropped", () => {
    expect(ALLOWED_SECTIONS).toContain("D");
    expect(validateStudentRow({ ...validStudent, section: "D" }).ok).toBe(true);
  });

  it("rejects a section outside the allowed set", () => {
    expect(fieldErrors(validateStudentRow({ ...validStudent, section: "Z" }))).toContain("section");
  });

  it("rejects a year outside 1-4 and a non-integer year", () => {
    for (const year of [0, 5, 2.5, -1]) {
      expect(fieldErrors(validateStudentRow({ ...validStudent, year })), `year ${year}`).toContain("year");
    }
  });

  it("rejects a student id with characters that are unsafe in a login field", () => {
    expect(fieldErrors(validateStudentRow({ ...validStudent, student_id: "2K24 CS/01" }))).toContain("student_id");
    expect(fieldErrors(validateStudentRow({ ...validStudent, student_id: "a".repeat(33) }))).toContain("student_id");
  });

  it("reports every bad field at once, so one import shows all its problems", () => {
    const errors = fieldErrors(validateStudentRow({ student_id: "", register_no: "", year: 9, section: "Q" }));
    expect(errors).toEqual(expect.arrayContaining(["student_id", "register_no", "year", "section"]));
  });
});

describe("validateYear", () => {
  it("treats a blank cell as missing rather than as zero", () => {
    expect(validateYear("").ok).toBe(false);
    expect(validateYear(null).ok).toBe(false);
    expect(validateYear(undefined).ok).toBe(false);
  });

  it("rejects a numeric zero as out of range rather than as absent", () => {
    const result = validateYear(0);
    expect(result.ok).toBe(false);
  });
});

describe("validateStaffRow", () => {
  const base = { staff_name: "Nisha Iyer", email: "nisha.iyer@kiot.ac.in" };

  function staffFieldErrors(row: unknown): string[] {
    const result = validateStaffRow(row);
    return result.ok ? [] : result.errors.map((error) => error.field);
  }

  it("treats a row with no advisor flag as a non-advisor", () => {
    const result = validateStaffRow(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.class_advisor).toBe("N");
      expect(result.value.advisor_year).toBeNull();
      expect(result.value.advisor_batch).toBe("");
    }
  });

  it("does not require advisor fields when the flag is false", () => {
    expect(staffFieldErrors({ ...base, class_advisor: false })).toEqual([]);
    expect(staffFieldErrors({ ...base, class_advisor: "No" })).toEqual([]);
  });

  it("ignores stray advisor fields on a non-advisor rather than promoting them", () => {
    // A year present but no flag must not silently make someone a class advisor.
    const result = validateStaffRow({ ...base, advisor_year: 3, advisor_section: "A", advisor_batch: "2024_2028" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.class_advisor).toBe("N");
      expect(result.value.advisor_batch).toBe("");
      expect(result.value.advisor_year).toBeNull();
    }
  });

  it("accepts a complete advisor row", () => {
    const result = validateStaffRow({
      ...base,
      class_advisor: true,
      advisor_year: 3,
      advisor_section: "D",
      advisor_batch: "2024_2028",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.class_advisor).toBe("Y");
      expect(result.value.advisor_batch).toBe("2024_2028");
      expect(result.value.advisor_section).toBe("D");
    }
  });

  it.each([
    ["class_advisor", "yes"],
    ["class_advisor", "1"],
    ["class_advisor", true],
  ])("reads %s=%s as a claim to be an advisor", (field, value) => {
    // The column has been written as 'Y', '1' and NULL by different migrations.
    const errors = staffFieldErrors({ ...base, [field]: value });
    expect(errors).toEqual(expect.arrayContaining(["advisor_batch", "advisor_year", "advisor_section"]));
  });

  it("requires the whole advisor set together", () => {
    expect(staffFieldErrors({ ...base, class_advisor: true })).toEqual(
      expect.arrayContaining(["advisor_year", "advisor_section", "advisor_batch"]),
    );
    // Batch and section but no year: the routes could not resolve a class.
    expect(staffFieldErrors({ ...base, class_advisor: true, advisor_batch: "2024_2028", advisor_section: "A" })).toContain(
      "advisor_year",
    );
  });

  it("still validates an advisor section against the allowed set", () => {
    const errors = staffFieldErrors({
      ...base,
      class_advisor: true,
      advisor_year: 3,
      advisor_section: "Z",
      advisor_batch: "2024_2028",
    });
    expect(errors).toContain("advisor_section");
  });

  it("requires a name and a valid email", () => {
    expect(staffFieldErrors({ staff_name: "", email: "nisha.iyer@kiot.ac.in" })).toContain("staff_name");
    expect(staffFieldErrors({ staff_name: "Nisha", email: "nope" })).toContain("email");
  });
});

describe("validateSubjectRow", () => {
  it("upper-cases the code so duplicates collapse", () => {
    const result = validateSubjectRow({ subject_code: " cs3451 ", subject_name: "Operating Systems" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.subject_code).toBe("CS3451");
  });

  it("requires both fields", () => {
    expect(validateSubjectRow({ subject_code: "", subject_name: "X" }).ok).toBe(false);
    expect(validateSubjectRow({ subject_code: "CS3451", subject_name: "" }).ok).toBe(false);
  });
});

describe("batch input", () => {
  it("normalises a space or dash to the stored key", () => {
    expect(normalizeBatchInput(" 2027 - 2031 ")).toBe("2027_2031");
    expect(normalizeBatchInput("2027-2031")).toBe("2027_2031");
  });

  it("accepts a four-year cohort", () => {
    const result = validateBatchInput("2027_2031");
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.batch).toBe("2027_2031");
  });

  it("rejects a cohort that is not four years long", () => {
    expect(validateBatchInput("2024_2029").valid).toBe(false);
  });

  it("rejects anything that could become part of a table name", () => {
    for (const bad of [
      "2027_2031; DROP TABLE x",
      "2027_2031 extra",
      "CSE_Students_2027_2031",
      "2027_2031'--",
      "../../etc",
      "20_31",
      "0000_0004",
    ]) {
      expect(validateBatchInput(bad).valid, `batch "${bad}" should be rejected`).toBe(false);
    }
  });
});
