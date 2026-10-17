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

export interface AttendanceReportStudent {
  register_no: string;
  student_name: string;
}

export interface AttendanceMark {
  status?: string | null;
  /**
   * The legacy `od` column on the per-cohort attendance tables. Nothing writes it
   * any more -- new OD is a distinct `status` -- but historical rows may carry
   * `'YES'`, so the classifier still honours it rather than losing that credit.
   */
  od?: string | null;
}

export interface AttendanceReport {
  report: string;
  totalStrength: number;
  presentCount: number;
  absentCount: number;
  odCount: number;
  /**
   * Attendance percentage. OD counts the same as PRESENT, so the numerator is
   * `presentCount + odCount`; ABSENT contributes nothing.
   */
  percentage: number;
  presentStudents: AttendanceReportStudent[];
  absentees: AttendanceReportStudent[];
  odStudents: AttendanceReportStudent[];
}

/**
 * The one status a saved attendance row is in.
 *
 * A row can hold only one, and this is the single place that decides which, so
 * the summary, both copied reports and the percentage can never disagree about
 * the same student. PRESENT is checked first: a student who physically scanned
 * the OTP is present even if a stale `od` flag said otherwise, which is what
 * keeps a student from being counted twice.
 *
 * `OD` is matched either by the row's own status -- what the finalizer writes for
 * an approved day -- or by the legacy `od = 'YES'` column, for rows written before
 * OD became a status. Everything else, including a student with no row at all, is
 * `UNMARKED` and is deliberately *not* folded into ABSENT.
 */
export type AttendanceCategory = "PRESENT" | "OD" | "ABSENT" | "UNMARKED";

export function classifyAttendanceMark(mark: AttendanceMark | undefined): AttendanceCategory {
  if (!mark) return "UNMARKED";
  const status = mark.status?.toUpperCase();
  if (status === "PRESENT") return "PRESENT";
  if (status === "OD" || mark.od?.toUpperCase() === "YES") return "OD";
  if (status === "ABSENT") return "ABSENT";
  return "UNMARKED";
}

/** The report's date label, `DD.MM.YYYY`, from a `YYYY-MM-DD` session date. */
function formatReportDate(date: string): string {
  return date.split("-").reverse().join(".");
}

/**
 * Builds the attendance report text every caller copies.
 *
 * This is the single definition of the report format. The Class Advisor report
 * route and the staff session report route both call it, so the text a staff
 * member copies for their own OTP session is byte-for-byte the text the Class
 * Advisor copies for the same slot. If the format ever changes it changes here
 * and both surfaces move together.
 *
 * `students` is the class roster and `attendanceByRegister` is the saved marks
 * keyed by register number. Each student lands in exactly one section -- PRESENT,
 * OD or ABSENT -- and a student with no row is left out of all three and counted
 * in none, exactly as the roster views treat them. OD is a separate section and is
 * never listed among the absentees, and the percentage credits it as PRESENT.
 */
export function buildAttendanceReport({
  date,
  department,
  section,
  subjectName,
  students,
  attendanceByRegister,
}: {
  date: string;
  department: string;
  section: string;
  subjectName: string;
  students: AttendanceReportStudent[];
  attendanceByRegister: Record<string, AttendanceMark | undefined>;
}): AttendanceReport {
  const totalStrength = students.length;

  const byCategory = (category: AttendanceCategory) =>
    students.filter((s) => classifyAttendanceMark(attendanceByRegister[s.register_no]) === category);

  const presentStudents = byCategory("PRESENT");
  const odStudents = byCategory("OD");
  const absentStudents = byCategory("ABSENT");

  const presentCount = presentStudents.length;
  const odCount = odStudents.length;
  const absentCount = absentStudents.length;

  /*
   * OD earns the same credit as PRESENT. The denominator stays the class strength:
   * an unmarked student is neither credited nor penalised here, matching the roster
   * views, and a cancelled or excluded session is already filtered out upstream by
   * never producing a session to report on.
   */
  const percentage = totalStrength
    ? Math.round(((presentCount + odCount) / totalStrength) * 100)
    : 0;

  const dateLabel = formatReportDate(date);

  const listFor = (list: AttendanceReportStudent[]): string =>
    list.length > 0
      ? list
          .map((s, i) => `${i + 1}. ${s.student_name.toUpperCase()} (${s.register_no})`)
          .join("\n")
      : "Nil";

  const report = [
    "Good Morning Sir,",
    `Date: ${dateLabel}`,
    "",
    `B. Tech - ${department} - ${section}`,
    `Total Strength: ${totalStrength}`,
    `Present: ${presentCount}/${totalStrength}`,
    `Absent: ${absentCount}`,
    `OD: ${odCount}`,
    `Hour: ${subjectName}`,
    "",
    `PRESENT (${presentCount})`,
    "",
    listFor(presentStudents),
    "",
    `OD (${odCount})`,
    "",
    listFor(odStudents),
    "",
    `ABSENT (${absentCount})`,
    "",
    listFor(absentStudents),
    "",
    `Attendance Percentage: ${percentage}%`,
  ].join("\n");

  return {
    report,
    totalStrength,
    presentCount,
    absentCount,
    odCount,
    percentage,
    presentStudents,
    absentees: absentStudents,
    odStudents,
  };
}
