export const DEPARTMENTS = ['IT', 'CSE', 'ECE', 'EEE']

/*
 * Batches that have student and attendance tables, per department.
 *
 * BATCH IS THE SOURCE OF TRUTH. It is the value that selects the attendance and
 * student tables, on the frontend and in the backend alike. Nothing in this
 * codebase may derive a batch from an academic year, and no year may stand in
 * for a batch.
 *
 * This mirrors the allow-list in backend/src/utils/tableResolver.ts. Only the
 * batch names are mirrored, not the table names: the backend owns table
 * resolution, and the UI only needs to know which batches it may offer.
 *
 * A department with no entries cannot take attendance yet. The backend rejects
 * such a request with "batch not configured", so the UI says so rather than
 * offering a batch that would be rejected.
 */
export const BATCHES_BY_DEPARTMENT = {
  IT: ['2024_2028', '2025_2029'],
  CSE: ['2026_2030'],
  ECE: [],
  EEE: [],
}

export function batchesForDepartment(department) {
  return BATCHES_BY_DEPARTMENT[String(department || '').trim().toUpperCase()] || []
}

/*
 * Batch keys are stored in the backend's exact format ("2024_2028") and that is
 * the value sent in the generate request. This is presentation only: the label
 * is derived from the key, so a display choice can never drift from the value
 * that reaches the API.
 */
export function formatBatchLabel(batch) {
  const key = String(batch || '').trim()
  if (!key) return ''
  return key.replace('_', '-').replace('-', '\u2013')
}

export function batchOptionsForDepartment(department) {
  return batchesForDepartment(department).map((key) => ({ value: key, label: formatBatchLabel(key) }))
}

/*
 * Academic year, kept for the class-within-batch distinction only. The backend
 * matches the subject and the student roster on (year, section) within the
 * already-resolved batch, so this is a secondary selector that follows batch.
 * It must never be used to pick a batch or a table.
 */
export const YEARS = [1, 2, 3, 4]

export const YEAR_LABELS = {
  1: 'I Year',
  2: 'II Year',
  3: 'III Year',
  4: 'IV Year',
}

/*
 * Sections a cohort may use.
 *
 * Re-exported from `utils/sectionValidation`, which is the single source: the
 * admin upload parser and the student form both need the list, and two copies
 * drifted before, which is how section D came to be missing.
 *
 * The backend enforces the same list in `backend/src/utils/adminValidation.ts`.
 */
export { ALLOWED_SECTIONS, normalizeSection, isAllowedSection, validateSection } from './utils/sectionValidation'

import { ALLOWED_SECTIONS } from './utils/sectionValidation'

export const SECTIONS = ALLOWED_SECTIONS

export const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8]

export const OTP_LENGTH = 6

export const MIN_PASSWORD_LENGTH = 6

export const OTP_VALIDITY_SECONDS = 20

export const STUDENT_EMAIL_DOMAIN = 'kiot.ac.in'
