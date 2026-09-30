/**
 * Batch label validation, mirroring `backend/src/utils/batchValidation.ts`.
 *
 * The rules are duplicated deliberately rather than fetched: the server is the
 * authority and re-validates every value, but a form that discovers a bad label
 * only after a round trip and a 400 gives poor feedback. This copy exists so the
 * message appears next to the field as it is typed.
 *
 * The two must be kept in step. The shapes here match the backend exactly:
 * four digits, a separator, four digits, plausible years, and a four-year
 * programme. A frontend that accepted something the server rejects would let the
 * admin fill in a batch and only then be told it was invalid.
 *
 * Loose input is normalised the same way on both sides: "2027 - 2031", "2027-2031"
 * and "2027_2031" are the same cohort.
 */

/** The separator and four-digit shape the stored key uses. */
const BATCH_SHAPE = /^(\d{4})_(\d{4})$/

/** Every cohort in this application is a four-year programme. */
export const BATCH_DURATION_YEARS = 4

const MIN_YEAR = 2000
const MAX_YEAR = 2100

export const BATCH_MESSAGES = {
  required: 'Enter a batch label.',
  format: 'Enter a batch in the form YYYY_YYYY, for example 2024_2028.',
  range: 'Enter a batch with real years, for example 2024_2028.',
  duration: 'The end year must be the start year plus 4, for example 2024_2028.',
}

/** Trims, upper-cases, and treats a space or dash as the separator. */
export function normalizeBatchInput(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '_')
}

/**
 * Returns `{ valid: true, batch }` or `{ valid: false, message }`.
 *
 * `message` is null for a valid batch and for empty input, so a field can be
 * required without showing an error before anything has been typed.
 */
export function validateBatchInput(raw) {
  const batch = normalizeBatchInput(raw)
  if (!batch) return { valid: false, message: BATCH_MESSAGES.required }

  const match = BATCH_SHAPE.exec(batch)
  if (!match) return { valid: false, message: BATCH_MESSAGES.format }

  const startYear = Number(match[1])
  const endYear = Number(match[2])
  if (startYear < MIN_YEAR || endYear < MIN_YEAR || startYear > MAX_YEAR || endYear > MAX_YEAR) {
    return { valid: false, message: BATCH_MESSAGES.range }
  }
  if (endYear !== startYear + BATCH_DURATION_YEARS) {
    return { valid: false, message: BATCH_MESSAGES.duration }
  }

  return { valid: true, batch }
}

/** Presentation only: `2024_2028` reads as `2024–2028`. */
export function formatBatchLabel(batch) {
  return String(batch || '').replace('_', '–')
}
