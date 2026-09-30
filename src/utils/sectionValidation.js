/**
 * The one copy of the section rules, shared by every form and the upload parser.
 *
 * The section list lives here rather than in each component because it previously
 * existed in `src/constants.js` as `SECTIONS = ['A', 'B', 'C']`, with no D. CSE
 * 2024_2028 runs an A and a D section, so a D student was rejected by the browser
 * while the database would have accepted them, and the mismatch was invisible
 * until an import was attempted.
 *
 * `src/constants.js` re-exports `SECTIONS` from here so existing imports keep
 * working. This module is deliberately dependency-free so the import parser can
 * use it without pulling in the rest of the app.
 *
 * The backend enforces the same list in `backend/src/utils/adminValidation.ts`; that
 * copy is authoritative, and this one only decides what a form will offer.
 */
export const ALLOWED_SECTIONS = ['A', 'B', 'C', 'D']

/** Upper-cases and trims, so `a` and ` A ` both mean section A. */
export function normalizeSection(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
}

export function isAllowedSection(value) {
  return ALLOWED_SECTIONS.includes(normalizeSection(value))
}

export function validateSection(value) {
  const section = normalizeSection(value)
  if (!section) return 'Section is required'
  if (!ALLOWED_SECTIONS.includes(section)) {
    return `Section must be one of ${ALLOWED_SECTIONS.join(', ')}`
  }
  return null
}

/**
 * Whether a staff row claims to be a class advisor.
 *
 * The `staff.class_advisor` column is historical and the same meaning has been
 * written several ways: 'Y' by the admin API, '1' by an older migration, and NULL
 * or blank for "no". Every one of those has to read as false, and `true`/`1`/`yes`
 * has to read as true, otherwise a real advisor is hidden or a lecturer is promoted.
 *
 * A missing value is false rather than an error: most staff teach without holding a
 * class, so the column being absent must not force three more onto every row.
 */
export function isAdvisorFlag(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  const normalized = String(value).trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes' || normalized === 'true' || normalized === '1'
}
