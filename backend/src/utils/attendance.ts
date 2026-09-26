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