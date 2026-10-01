import { describe, expect, it } from "vitest";
import {
  MAX_NAME_LENGTH,
  validateContestCoordinatorRow,
  validateDepartment,
  validateHodRow,
} from "../src/utils/adminValidation";
import { SUPPORTED_DEPARTMENTS } from "../src/utils/tableResolver";

/*
 * Directory row validation, without a database.
 *
 * Heads of department and contest coordinators are the same three facts under two
 * names -- a person, an address, and the department they belong to -- so they are
 * asserted as a pair throughout. The interesting cases are inputs rather than
 * outcomes: a department in the wrong case, an address that is not one, a name that
 * is only whitespace, and a name long enough to matter.
 *
 * The database-backed behaviour of the same rules -- duplicate emails, account
 * reuse, id immutability -- is covered in adminDirectory.integration.
 */

/**
 * The validated value, for the success cases.
 *
 * A narrow read rather than a cast, so the assertion below still compares real
 * objects: `expect(...).toEqual` checks the whole value, and a cast would only
 * silence the compiler.
 */
function valueOf(result: { ok: boolean; value?: unknown }): unknown {
  if (!result.ok) throw new Error("expected the row to validate");
  return result.value;
}

/** The first field name each of these errors, in order. */
function fieldErrors(result: { ok: boolean; errors?: { field: string }[] }): string[] {
  return result.ok ? [] : (result.errors ?? []).map((error) => error.field);
}

function firstMessage(result: { ok: boolean; errors?: { message: string }[] }): string {
  return result.ok ? "" : (result.errors?.[0]?.message ?? "");
}

const DIRECTORIES = [
  {
    label: "HOD",
    validate: validateHodRow,
    nameField: "hod_name",
    nameColumn: "hod_name",
  },
  {
    label: "Coordinator",
    validate: validateContestCoordinatorRow,
    nameField: "coordinator_name",
    nameColumn: "coordinator_name",
  },
] as const;

describe("directory row validation", () => {
  describe("validateDepartment", () => {
    it("accepts every supported department", () => {
      for (const department of SUPPORTED_DEPARTMENTS) {
        const result = validateDepartment(department);
        expect(result.ok, `${department} should be accepted`).toBe(true);
        expect((result as { value: string }).value).toBe(department);
      }
    });

    it("upper-cases a department typed in any case", () => {
      // A spreadsheet cell is the most likely source of "it", and a department
      // column is compared against a list of capitals.
      expect((validateDepartment("cse") as { value: string }).value).toBe("CSE");
      expect((validateDepartment("  ece  ") as { value: string }).value).toBe("ECE");
    });

    it("requires a department", () => {
      expect(fieldErrors(validateDepartment(""))).toEqual(["department"]);
      expect(fieldErrors(validateDepartment("   "))).toEqual(["department"]);
      expect(fieldErrors(validateDepartment(undefined))).toEqual(["department"]);
    });

    it("rejects a department that is not one of the four", () => {
      // The list is the same one the backend builds table names from, so a value
      // outside it could never name a cohort.
      for (const bad of ["MECH", "CSE_Students_2024_2028", "IT;", "C"]) {
        const result = validateDepartment(bad);
        expect(result.ok, `${bad} should be rejected`).toBe(false);
        expect(fieldErrors(result)).toEqual(["department"]);
      }
      expect(firstMessage(validateDepartment("MECH"))).toContain("IT, CSE, ECE, EEE");
    });
  });

  for (const { label, validate, nameField } of DIRECTORIES) {
    describe(label, () => {
      it("accepts a complete row and normalises it", () => {
        const result = validate({
          [nameField]: "  Asha Raman  ",
          email: "  Asha.Raman@kiot.ac.in ",
          department: " cse ",
        });
        expect(result.ok).toBe(true);
        expect(valueOf(result)).toEqual({
          [nameField]: "Asha Raman",
          email: "asha.raman@kiot.ac.in",
          department: "CSE",
        });
      });

      it("requires the name", () => {
        expect(fieldErrors(validate({ email: "a@kiot.ac.in", department: "IT" }))).toEqual([
          nameField,
        ]);
        // Whitespace is not a name: it is trimmed away and then absent.
        expect(fieldErrors(validate({ [nameField]: "   ", email: "a@kiot.ac.in", department: "IT" }))).toEqual([
          nameField,
        ]);
      });

      it("requires a valid email", () => {
        for (const email of ["", "   ", "not-an-email", "@kiot.ac.in", "a@", "a b@kiot.ac.in"]) {
          expect(fieldErrors(validate({ [nameField]: "Asha", email, department: "IT" })), email).toEqual([
            "email",
          ]);
        }
      });

      it("requires a supported department", () => {
        expect(fieldErrors(validate({ [nameField]: "Asha", email: "a@kiot.ac.in", department: "MECH" }))).toEqual([
          "department",
        ]);
        expect(
          fieldErrors(validate({ [nameField]: "Asha", email: "a@kiot.ac.in", department: "" })),
        ).toEqual(["department"]);
      });

      it(`caps the name at ${MAX_NAME_LENGTH} characters`, () => {
        const long = "A".repeat(MAX_NAME_LENGTH + 1);
        expect(fieldErrors(validate({ [nameField]: long, email: "a@kiot.ac.in", department: "IT" }))).toEqual([
          nameField,
        ]);
        const atLimit = "A".repeat(MAX_NAME_LENGTH);
        expect(
          validate({ [nameField]: atLimit, email: "a@kiot.ac.in", department: "IT" }).ok,
        ).toBe(true);
      });

      it("reports every problem at once rather than only the first", () => {
        // A bulk import reports per-row errors, so a row with two faults has to
        // produce two of them or the admin fixes one problem per upload.
        expect(fieldErrors(validate({ email: "", department: "" }))).toEqual([
          nameField,
          "email",
          "department",
        ]);
      });

      it("treats a missing row as empty rather than throwing", () => {
        expect(fieldErrors(validate(undefined))).toEqual([nameField, "email", "department"]);
        expect(fieldErrors(validate(null))).toEqual([nameField, "email", "department"]);
        expect(fieldErrors(validate({}))).toEqual([nameField, "email", "department"]);
      });
    });
  }

  it("keeps the two directories' column names distinct", () => {
    // The error objects name a field, and the dashboard highlights an input by that
    // name. A shared validator reporting a generic "name" would leave every message
    // pointing at a field no form has.
const hod = validateHodRow({ email: "a@kiot.ac.in", department: "IT" });
	const coordinator = validateContestCoordinatorRow({ email: "a@kiot.ac.in", department: "IT" });
    expect(fieldErrors(hod)).toEqual(["hod_name"]);
    expect(fieldErrors(coordinator)).toEqual(["coordinator_name"]);
    expect(firstMessage(hod)).toBe("HOD name is required");
    expect(firstMessage(coordinator)).toBe("Coordinator name is required");
  });
});