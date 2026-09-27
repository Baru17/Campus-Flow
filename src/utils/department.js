import { DEPARTMENTS } from '../constants'

/**
 * The student tables do not store a department. It is encoded in the student
 * ID after the four-character admission prefix, e.g. 2K24IT001 or 2K25CSE001.
 *
 * The API returns the department on attendance results, so this is only a
 * fallback for records that predate that field. The code is matched against
 * the known department list instead of a fixed slice so three-letter codes
 * such as CSE are not truncated.
 */
export function extractDepartment(studentId) {
  const normalized = typeof studentId === 'string' ? studentId.trim().toUpperCase() : ''

  if (normalized.length < 6) {
    return ''
  }

  const remainder = normalized.slice(4)
  return DEPARTMENTS.find((department) => remainder.startsWith(department)) ?? ''
}

/**
 * Prefers the department supplied by the API and falls back to the student ID.
 */
export function resolveDepartment(student) {
  if (!student) {
    return '—'
  }
  return student.department || extractDepartment(student.student_id) || '—'
}
