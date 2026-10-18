/*
 * Turning a From Date / To Date pair into the individual days an OD request covers.
 *
 * The student picks a range; the record stores a list of days. That is deliberate --
 * `od_requests.od_dates` is a JSON array and every other part of the feature
 * (attendance eligibility, the approval mail, the student history) reads that array.
 * This module is the one place that turns the first into the second, and it is pure,
 * so the form and the tests get the same answer without a Worker.
 *
 * The range is counted the way the wording implies: both ends are included, so the 18th
 * to the 20th is the 18th, the 19th and the 20th -- three days, not two.
 *
 * ## Why the arithmetic is done on UTC day-numbers
 *
 * The obvious ways to walk a range are both wrong in a way that is easy to miss.
 *
 * `new Date("2026-10-18")` parses as UTC midnight and is then *read back* in the
 * browser's own zone, so in any timezone west of Greenwich it prints the 17th: the
 * range quietly loses its first date. And stepping with `setDate(getDate() + 1)` walks
 * a *local* calendar, which loses a whole day whenever a daylight-saving boundary falls
 * inside the range -- a student in Chennai asking for the 29th to the 31st of March
 * would be granted two days.
 *
 * A UTC midnight timestamp plus 86_400_000 milliseconds has neither problem. Every UTC
 * day is exactly 86_400_000 milliseconds long, with no leap seconds and no offset
 * changes, so the step is exact in every timezone on earth.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** One day, in milliseconds. Exact for UTC days, which have no offset changes. */
const MS_PER_DAY = 86_400_000

/** The separator in a collapsed run. Written as an escape so the file stays ASCII. */
const RANGE_DASH = '\u2013'

/**
 * Whether a value is a `YYYY-MM-DD` string naming a day that exists.
 *
 * The regex alone is not enough: `2026-02-31` matches the shape and is not a day. The
 * round-trip through `Date` is what rejects it, because a date the constructor had to
 * roll over comes back as a different month.
 */
export function isIsoDateString(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Days since the epoch for a `YYYY-MM-DD`, or `null` if it is not a real date.
 *
 * `Date.parse` of an explicit `Z` is exact, and every UTC midnight is a whole number of
 * days from the epoch, so the division is an integer -- no rounding to reason about.
 */
function dayNumber(iso) {
  if (!isIsoDateString(iso)) return null
  return Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY
}

/** Whether `next` is the calendar day immediately after `previous`. */
function isNextDay(previous, next) {
  const a = dayNumber(previous)
  const b = dayNumber(next)
  return a !== null && b !== null && b === a + 1
}

/**
 * How many calendar days the range covers, or `null` if it covers none.
 *
 * `null` covers three separate refusals -- an end missing, an end that is not a real
 * date, and a To Date that is before the From Date -- because all three are "pick a
 * range that means something" and the caller cannot say anything useful about the size
 * of any of them.
 */
export function countDaysInclusive(from, to) {
  if (!isIsoDateString(from) || !isIsoDateString(to)) return null
  const span = dayNumber(to) - dayNumber(from) + 1
  return span >= 1 ? span : null
}

/**
 * Every day from `from` to `to`, both ends included, in ascending order.
 *
 * These are the strings that go into `od_dates`. Empty when the range covers none,
 * for the same reason `countDaysInclusive` answers `null`.
 */
export function expandDateRange(from, to) {
  const count = countDaysInclusive(from, to)
  if (count === null) return []
  const start = dayNumber(from)
  return Array.from({ length: count }, (_, index) =>
    new Date((start + index) * MS_PER_DAY).toISOString().slice(0, 10)
  )
}

/**
 * A request's days as one readable line.
 *
 * A fortnight of OD is fifteen separate entries, and
 * `2026-10-18, 2026-10-19, 2026-10-20, ...` is both unreadable on an approval screen
 * and easy to misread as an off-by-one. A run of consecutive days is therefore written
 * as its two ends, which says the same thing in five characters instead of two hundred.
 *
 * A genuinely non-contiguous request is still listed day by day, exactly as before --
 * that shape is what records filed before the range picker existed look like, and it
 * must keep reading the way it always has.
 */
export function formatOdDates(dates) {
  if (!Array.isArray(dates) || dates.length === 0) return ''

  const runs = []
  let run = [dates[0]]
  for (let index = 1; index < dates.length; index += 1) {
    if (isNextDay(dates[index - 1], dates[index])) {
      run.push(dates[index])
    } else {
      runs.push(run)
      run = [dates[index]]
    }
  }
  runs.push(run)

  return runs
    .map((days) =>
      days.length === 1 ? days[0] : `${days[0]} ${RANGE_DASH} ${days[days.length - 1]}`
    )
    .join(', ')
}
