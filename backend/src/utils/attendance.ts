export interface AttendanceClass {
  year: number;
  section: string;
}

export function studentMatchesAttendanceClass(
  student: AttendanceClass,
  session: AttendanceClass
): boolean {
  return student.year === session.year &&
    student.section.trim().toUpperCase() === session.section.trim().toUpperCase();
}

/*
|--------------------------------------------------------------------------
| DEPARTMENT
|--------------------------------------------------------------------------
|
| Neither student table stores a department column. The department is encoded
| in the student ID instead, e.g. 2K24IT001 or 2K25CSE001, where the code sits
| after the four-character admission prefix.
|
| The code is matched against the known department list rather than sliced at
| a fixed width, so three-letter codes such as CSE are not truncated to CS.
| Returns an empty string when the ID carries no recognised code, so callers
| can decide how to present an unknown department.
|
|--------------------------------------------------------------------------
*/

export const DEPARTMENTS = ["IT", "CSE", "ECE", "EEE"] as const;

export function extractDepartment(studentId: string | null | undefined): string {
  const normalized = (studentId ?? "").trim().toUpperCase();

  if (normalized.length < 6) {
    return "";
  }

  const remainder = normalized.slice(4);
  return DEPARTMENTS.find((department) => remainder.startsWith(department)) ?? "";
}