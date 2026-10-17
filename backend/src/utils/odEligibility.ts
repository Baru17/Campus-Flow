/**
 * Day-based OD eligibility: which approved On Duty requests grant attendance
 * credit for a given attendance session.
 *
 * This module is deliberately pure. It holds no database handle and reads no
 * request, so the attendance finalizer and the tests can drive the same rule
 * without a Worker: given a set of approved OD periods and a session date, which
 * students are on duty that day?
 *
 * ## Why a set membership test and not a range comparison
 *
 * The master description of the feature talks about a "start date and end date",
 * but the shipped schema does not store a range. `od_requests.od_dates` is a JSON
 * array of `YYYY-MM-DD` strings -- the exact, individually chosen days the
 * approvers granted. See `migrations/0017_od_requests.sql`. A student may ask for
 * the 12th and the 14th and *not* the 13th, and that is a legitimate request. So
 * eligibility is `sessionDate ∈ od_dates`, not `start <= date <= end`. Building a
 * range out of `[min, max]` would silently grant the 13th as well, which is why
 * nothing here does that.
 *
 * ## Why `APPROVED` and nothing else
 *
 * Only the final HOD approval sets `status = 'APPROVED'`; the four pending states
 * and `REJECTED` are all non-granting. Importing `OD_STATUS` rather than writing
 * the literal keeps this agreeing with `odWorkflow.ts`, which is the one place
 * that defines the chain. There is no `CANCELLED` status in the workflow: a request
 * that is not `APPROVED` (pending or rejected) simply does not qualify.
 */

import { OD_STATUS } from "./odWorkflow";

/** The only status that grants OD attendance credit. */
export const OD_ELIGIBLE_STATUS = OD_STATUS.APPROVED;

/** `YYYY-MM-DD`, the shape both `od_dates` entries and session dates take. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a value is a well-formed `YYYY-MM-DD` date string. */
export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value);
}

/**
 * Parses `od_dates`, keeping only well-formed `YYYY-MM-DD` entries.
 *
 * The stored value is JSON text, but a raw array is also accepted so callers that
 * have already parsed the column are not forced to re-stringify it. Anything that
 * is not a valid date is dropped rather than trusted: a request with missing or
 * malformed dates therefore matches nothing, which is the "grant no OD when the
 * dates are missing or invalid" rule.
 */
export function parseOdDateList(stored: unknown): string[] {
  if (Array.isArray(stored)) {
    return stored.filter(isIsoDate);
  }
  if (typeof stored !== "string") return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter(isIsoDate) : [];
  } catch {
    return [];
  }
}

/** Whether one approved period covers the session date. Missing dates never match. */
export function odCoversDate(odDates: readonly string[], sessionDate: string): boolean {
  if (!isIsoDate(sessionDate)) return false;
  return odDates.includes(sessionDate);
}

/** One approved request, reduced to the two fields eligibility needs. */
export interface ApprovedOdPeriod {
  /** `od_requests.student_id`, unique only within `student_table`. */
  studentId: string;
  /** The individually granted days. */
  odDates: readonly string[];
}

/**
 * The set of student ids with at least one approved OD day covering `sessionDate`.
 *
 * A set, not a count: a student with two approved requests that both cover the day
 * appears once, so the caller can never grant double credit and can never create a
 * second attendance row. Matching is scoped by the caller, which passes the rows for
 * one `student_table` only -- a student id is unique within its cohort, not globally.
 */
export function studentsCoveredByApprovedOd(
  periods: readonly ApprovedOdPeriod[],
  sessionDate: string
): Set<string> {
  const covered = new Set<string>();
  if (!isIsoDate(sessionDate)) return covered;
  for (const period of periods) {
    if (!period.studentId) continue;
    if (odCoversDate(period.odDates, sessionDate)) covered.add(period.studentId);
  }
  return covered;
}
