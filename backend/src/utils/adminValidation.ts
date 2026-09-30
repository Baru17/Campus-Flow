/**
 * Normalisation and validation for admin-supplied rows.
 *
 * The rules here are the contract between the dashboard and the student, staff
 * and subject tables. They are deliberately strict and deliberately server-side:
 * the frontend previews and filters rows, but nothing reaches D1 without passing
 * through this module, because a client that is only validating in the browser
 * is not validating at all.
 *
 * Every function returns a discriminated result rather than throwing, so a bulk
 * import can report all of its row errors at once instead of failing on the first.
 */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Years of study. Matches what the student table stores and what login reads. */
export const MIN_YEAR = 1;
export const MAX_YEAR = 4;

/**
 * Sections a cohort may use. Section D is included because CSE 2024_2028 runs an
 * A and a D section, and a hardcoded A-C list silently dropped the D roster on
 * import. A section is uppercase-normalised before it is compared.
 */
export const ALLOWED_SECTIONS = ["A", "B", "C", "D"] as const;
export type Section = (typeof ALLOWED_SECTIONS)[number];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function email(value: unknown): string {
  return text(value).toLowerCase();
}

function upper(value: unknown): string {
  return text(value).toUpperCase();
}

export interface FieldError {
  field: string;
  message: string;
}

export type RowResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

/* ------------------------------------------------------------------ students */

export interface StudentInput {
  student_id: string;
  register_no: string;
  student_name: string;
  year: number;
  section: string;
  email: string;
}

export function normalizeSection(value: unknown): string {
  return upper(value);
}

export function validateSection(value: unknown): RowResult<string> {
  const section = normalizeSection(value);
  if (!section) {
    return { ok: false, errors: [{ field: "section", message: "Section is required" }] };
  }
  if (!(ALLOWED_SECTIONS as readonly string[]).includes(section)) {
    return {
      ok: false,
      errors: [
        {
          field: "section",
          message: `Section must be one of ${ALLOWED_SECTIONS.join(", ")}`,
        },
      ],
    };
  }
  return { ok: true, value: section };
}

export function validateYear(value: unknown): RowResult<number> {
  /*
   * A year can arrive as three different things: the number 3 from a typed form or
   * a hand-written JSON body, the string "3" from a spreadsheet cell, or a blank
   * cell. Each is handled separately rather than funnelled through `text`, which
   * only understands strings and would report a numeric 3 as empty.
   */
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < MIN_YEAR || value > MAX_YEAR) {
      return {
        ok: false,
        errors: [{ field: "year", message: `Year must be a whole number from ${MIN_YEAR} to ${MAX_YEAR}` }],
      };
    }
    return { ok: true, value };
  }

  const asText = text(value);
  if (asText === "") {
    return { ok: false, errors: [{ field: "year", message: "Year is required" }] };
  }

  const parsed = Number(asText);
  if (!Number.isInteger(parsed) || parsed < MIN_YEAR || parsed > MAX_YEAR) {
    return {
      ok: false,
      errors: [{ field: "year", message: `Year must be a whole number from ${MIN_YEAR} to ${MAX_YEAR}` }],
    };
  }
  return { ok: true, value: parsed };
}

export function validateEmail(value: unknown): RowResult<string> {
  const candidate = email(value);
  if (!candidate) {
    return { ok: false, errors: [{ field: "email", message: "Email is required" }] };
  }
  if (!EMAIL_SHAPE.test(candidate)) {
    return { ok: false, errors: [{ field: "email", message: "Enter a valid email address" }] };
  }
  return { ok: true, value: candidate };
}

/**
 * The existing application has no formal student-id grammar; the live data is
 * `2K24IT001`-style codes and the login handler upper-cases whatever it is given.
 * Rather than invent a pattern that would reject valid future cohorts, the id is
 * required, upper-cased, and constrained to characters that are safe in a login
 * field and in a filename.
 */
export function validateStudentId(value: unknown): RowResult<string> {
  const studentId = upper(value);
  if (!studentId) {
    return { ok: false, errors: [{ field: "student_id", message: "Student ID is required" }] };
  }
  if (studentId.length > 32) {
    return {
      ok: false,
      errors: [{ field: "student_id", message: "Student ID must be 32 characters or fewer" }],
    };
  }
  if (!/^[A-Z0-9._-]+$/.test(studentId)) {
    return {
      ok: false,
      errors: [
        {
          field: "student_id",
          message: "Student ID may contain letters, digits, dots, dashes and underscores only",
        },
      ],
    };
  }
  return { ok: true, value: studentId };
}

export function validateRegisterNo(value: unknown): RowResult<string> {
  const registerNo = text(value);
  if (!registerNo) {
    return { ok: false, errors: [{ field: "register_no", message: "Register number is required" }] };
  }
  if (registerNo.length > 64) {
    return {
      ok: false,
      errors: [{ field: "register_no", message: "Register number must be 64 characters or fewer" }],
    };
  }
  return { ok: true, value: registerNo };
}

export function validateStudentName(value: unknown): RowResult<string> {
  const name = text(value);
  if (!name) {
    return { ok: false, errors: [{ field: "student_name", message: "Student name is required" }] };
  }
  if (name.length > 120) {
    return {
      ok: false,
      errors: [{ field: "student_name", message: "Student name must be 120 characters or fewer" }],
    };
  }
  return { ok: true, value: name };
}

export function validateStudentRow(row: unknown): RowResult<StudentInput> {
  const source = (row ?? {}) as Record<string, unknown>;
  const parts = [
    validateStudentId(source.student_id),
    validateRegisterNo(source.register_no),
    validateStudentName(source.student_name),
    validateYear(source.year),
    validateSection(source.section),
    validateEmail(source.email),
  ];

  const errors = parts.flatMap((part) => (part.ok ? [] : part.errors));
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      student_id: (parts[0] as { ok: true; value: string }).value,
      register_no: (parts[1] as { ok: true; value: string }).value,
      student_name: (parts[2] as { ok: true; value: string }).value,
      year: (parts[3] as { ok: true; value: number }).value,
      section: (parts[4] as { ok: true; value: string }).value,
      email: (parts[5] as { ok: true; value: string }).value,
    },
  };
}

/* -------------------------------------------------------------------- staff */

export interface StaffInput {
  staff_name: string;
  email: string;
  class_advisor: string;
  advisor_year: number | null;
  advisor_section: string;
  advisor_batch: string;
}

function optionalYear(value: unknown): RowResult<number | null> {
  // An advisor assignment is optional, so a blank year is null rather than an
  // error, but a value that is present must still be a real year. Absence is
  // decided on the raw value as well as the text, because a numeric 0 is present
  // and out of range rather than absent.
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "number" && text(value) === "") {
    return { ok: true, value: null };
  }
  return validateYear(value);
}

function optionalSection(value: unknown): RowResult<string> {
  if (text(value) === "") {
    return { ok: true, value: "" };
  }
  return validateSection(value);
}

/**
 * Whether a staff row claims to be a class advisor.
 *
 * The flag is explicit rather than inferred from the presence of an advisor year
 * and section. Inferring it made an omitted flag and a genuine "no" impossible to
 * tell apart, and it meant a row could silently become an advisor just by carrying
 * a stray year. A missing value is treated as "no", which is the safe default:
 * non-advisors are the large majority of staff and requiring the three advisor
 * fields from them would make the common case the awkward one.
 *
 * Accepts the several spellings a spreadsheet or a hand-typed form produces.
 */
function isAdvisorFlag(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const normalized = text(value).trim().toLowerCase();
  if (normalized === "") return false;
  return normalized === "y" || normalized === "yes" || normalized === "true" || normalized === "1";
}

export function validateStaffRow(row: unknown): RowResult<StaffInput> {
  const source = (row ?? {}) as Record<string, unknown>;

  const name = text(source.staff_name);
  const emailResult = validateEmail(source.email);
  const isAdvisor = isAdvisorFlag(source.class_advisor);
  const yearResult = optionalYear(source.advisor_year);
  const sectionResult = optionalSection(source.advisor_section);
  const batch = text(source.advisor_batch);

  const errors: FieldError[] = [];
  if (!name) {
    errors.push({ field: "staff_name", message: "Staff name is required" });
  } else if (name.length > 120) {
    errors.push({ field: "staff_name", message: "Staff name must be 120 characters or fewer" });
  }
  if (!emailResult.ok) errors.push(...emailResult.errors);
  if (!yearResult.ok) errors.push(...yearResult.errors);
  if (!sectionResult.ok) errors.push(...sectionResult.errors);

  const advisorYear = yearResult.ok ? yearResult.value : null;
  const advisorSection = sectionResult.ok ? sectionResult.value : "";

  if (isAdvisor) {
    /*
     * An advisor is scoped to a cohort, a year of study and a section, and the
     * attendance routes resolve tables from all three. Each is therefore required
     * together: a batch without a section would route to a class the advisor does
     * not teach, and a year without a batch has no table to resolve.
     */
    if (advisorYear === null) {
      errors.push({ field: "advisor_year", message: "A class advisor needs an advisor year" });
    }
    if (advisorSection === "") {
      errors.push({
        field: "advisor_section",
        message: `A class advisor needs an advisor section (${ALLOWED_SECTIONS.join(", ")})`,
      });
    }
    if (!batch) {
      errors.push({ field: "advisor_batch", message: "A class advisor needs an advisor batch" });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      staff_name: name,
      email: (emailResult as { ok: true; value: string }).value,
      // `class_advisor` mirrors the flag the class-advisor endpoints authorise on.
      // Only carried through for an advisor, so a stray year on a non-advisor row
      // cannot promote them to one.
      class_advisor: isAdvisor ? "Y" : "N",
      advisor_year: isAdvisor ? advisorYear : null,
      advisor_section: isAdvisor ? advisorSection : "",
      advisor_batch: isAdvisor ? batch : "",
    },
  };
}

/* ----------------------------------------------------------------- subjects */

export interface SubjectInput {
  subject_code: string;
  subject_name: string;
}

export function validateSubjectRow(row: unknown): RowResult<SubjectInput> {
  const source = (row ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];

  const subjectCode = upper(source.subject_code);
  const subjectName = text(source.subject_name);

  if (!subjectCode) {
    errors.push({ field: "subject_code", message: "Subject code is required" });
  } else if (subjectCode.length > 20) {
    errors.push({ field: "subject_code", message: "Subject code must be 20 characters or fewer" });
  } else if (!/^[A-Z0-9._-]+$/.test(subjectCode)) {
    errors.push({
      field: "subject_code",
      message: "Subject code may contain letters, digits, dots, dashes and underscores only",
    });
  }

  if (!subjectName) {
    errors.push({ field: "subject_name", message: "Subject name is required" });
  } else if (subjectName.length > 120) {
    errors.push({ field: "subject_name", message: "Subject name must be 120 characters or fewer" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { subject_code: subjectCode, subject_name: subjectName } };
}
