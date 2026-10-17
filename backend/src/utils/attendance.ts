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
  od?: string | null;
}

export interface AttendanceReport {
  report: string;
  totalStrength: number;
  presentCount: number;
  absentCount: number;
  odCount: number;
  percentage: number;
  absentees: AttendanceReportStudent[];
  odStudents: AttendanceReportStudent[];
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
 * keyed by register number; a student with no row is neither present nor absent
 * and is simply left out of the counts, exactly as the roster views treat them.
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
  const presentCount = students.filter(
    (s) => attendanceByRegister[s.register_no]?.status === "PRESENT"
  ).length;
  const absentCount = students.filter(
    (s) => attendanceByRegister[s.register_no]?.status === "ABSENT"
  ).length;
  const odCount = students.filter(
    (s) => attendanceByRegister[s.register_no]?.od === "YES"
  ).length;
  const absentStudents = students.filter(
    (s) => attendanceByRegister[s.register_no]?.status === "ABSENT"
  );
  const odStudents = students.filter((s) => attendanceByRegister[s.register_no]?.od === "YES");
  const percentage = totalStrength ? Math.round((presentCount / totalStrength) * 100) : 0;

  const dateLabel = date.split("-").reverse().join(".");

  const absenteesList =
    absentStudents.length > 0
      ? absentStudents
          .map((s, i) => `${i + 1}. ${s.student_name.toUpperCase()} (${s.register_no})`)
          .join("\n")
      : "Nil";

  const odList =
    odStudents.length > 0
      ? odStudents
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
    "Absentees:",
    "",
    absenteesList,
    "",
    "OD:",
    odList,
    "",
    `Attendance Percentage: ${percentage}%`,
  ].join("\n");

  return { report, totalStrength, presentCount, absentCount, odCount, percentage, absentees: absentStudents, odStudents };
}
