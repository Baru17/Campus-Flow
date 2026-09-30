/*
 * Departments a staff member or student may pick.
 *
 * This is a list of departments, not of cohorts: it says nothing about which
 * batches exist. Every academic batch in this application comes from the backend
 * batch registry, so there is deliberately no batch list in this file. A list here
 * used to exist and it was wrong twice over: it could not know about a cohort
 * provisioned after the build shipped, and it kept offering a cohort that had
 * been removed from the database entirely.
 *
 * The batch selector reads `/api/batches` instead. See `api/batchesApi.js`.
 */
export const DEPARTMENTS = ['IT', 'CSE', 'ECE', 'EEE']

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
export {
  ALLOWED_SECTIONS,
  normalizeSection,
  isAllowedSection,
  validateSection,
  isAdvisorFlag,
} from './utils/sectionValidation'

import { ALLOWED_SECTIONS } from './utils/sectionValidation'

export const SECTIONS = ALLOWED_SECTIONS

export const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8]

export const OTP_LENGTH = 6

export const MIN_PASSWORD_LENGTH = 6

export const OTP_VALIDITY_SECONDS = 20

export const STUDENT_EMAIL_DOMAIN = 'kiot.ac.in'
