/**
 * The student tables do not store a department. The API determines it from the
 * table a record was found in and returns it on the attendance result, so it is
 * read from there rather than guessed.
 *
 * An earlier version parsed the student ID, because the department used to be
 * implied by the IT-only table the student was found in. Now that a session can
 * belong to any department, a parsed value could disagree with the real one, so
 * a missing value is shown as unknown instead of being inferred.
 */
export function resolveDepartment(student) {
  if (!student) {
    return '—'
  }
  return student.department || '—'
}
