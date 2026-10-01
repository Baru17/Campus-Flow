/**
 * Validation for an OD request.
 *
 * The rules live here rather than in a route handler so the browser, the API and
 * the tests all hold a student to one standard, and so a bulk or repeated
 * submission reports every problem at once instead of failing on the first.
 *
 * The shape follows `adminValidation.ts`: every function returns a discriminated
 * result rather than throwing, and errors are addressed by field name so the
 * dashboard can put the message next to the input it belongs to.
 *
 * Two rules are stronger than the others and are worth stating up front, because
 * both exist to stop a student inflating their own request:
 *
 *   - **The number of OD days already gained is not accepted from the client at
 *     all.** It is counted from the student's approved request history and is not
 *     part of this module's input. A field a student can set is a field a student
 *     can lie about, and it feeds the staff who approve.
 *   - **The submission date is the server's, not the client's.** The form shows the
 *     current date read-only; a body that names a different one is ignored rather
 *     than honoured, so a request cannot be back-dated into a previous term.
 *
 * Everything else here is what the client is legitimately allowed to send: how
 * many days they want, which dates, and why.
 */

import { MIN_YEAR, MAX_YEAR } from "./adminValidation";

export interface FieldError {
  field: string;
  message: string;
}

export type OdValidationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

/**
 * The most OD days one request may ask for.
 *
 * A bound rather than a hope: without one, "1e9 days" is a value the database
 * would happily accept and an approver would have to notice. A fortnight is well
 * past any single on-duty application a student would make.
 */
export const MAX_OD_DAYS = 15;

/** The shortest a reason may be, in characters, once trimmed. */
export const MIN_REASON_LENGTH = 10;

/** The longest a reason may be. Keeps one request from becoming a mail body. */
export const MAX_REASON_LENGTH = 1000;

/** `YYYY-MM-DD`, and a real calendar date rather than one that only looks right. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Whether a string is a real `YYYY-MM-DD` date.
 *
 * Regex alone is not enough: `2026-02-31` matches the shape and is not a day. The
 * round-trip through `Date` is what rejects it, because `toISOString` of a date that
 * was silently rolled over by the Date constructor comes back as a different month.
 */
export function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** Today, as `YYYY-MM-DD` in UTC. The server's date is the submission date. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * How many OD days a student wants.
 *
 * A positive whole number, no decimals, no negatives, no zero, and within
 * `MAX_OD_DAYS`. The type check is explicit rather than relying on coercion,
 * because `Number("3")` and `Number(3)` are both 3 while `Number("")` and
 * `Number(null)` are both 0 -- so "absent" and "zero" would otherwise be
 * indistinguishable.
 */
export function validateOdDaysRequested(value: unknown): OdValidationResult<number> {
  if (value === undefined || value === null || value === "") {
    return { ok: false, errors: [{ field: "od_days_requested", message: "Number of OD days required is required" }] };
  }

  const asNumber = typeof value === "number" ? value : Number(text(value));
  if (!Number.isFinite(asNumber)) {
    return {
      ok: false,
      errors: [{ field: "od_days_requested", message: "Number of OD days must be a whole number" }],
    };
  }
  if (!Number.isInteger(asNumber)) {
    return {
      ok: false,
      errors: [
        { field: "od_days_requested", message: "Number of OD days must be a whole number, not a decimal" },
      ],
    };
  }
  if (asNumber <= 0) {
    return {
      ok: false,
      errors: [{ field: "od_days_requested", message: "Number of OD days must be greater than 0" }],
    };
  }
  if (asNumber > MAX_OD_DAYS) {
    return {
      ok: false,
      errors: [
        {
          field: "od_days_requested",
          message: `Number of OD days must be ${MAX_OD_DAYS} or fewer`,
        },
      ],
    };
  }

  return { ok: true, value: asNumber };
}

/**
 * The dates the OD covers.
 *
 * Normalises whatever shape the client used -- a comma-separated string from a text
 * box, or an array from the date picker -- into sorted, de-duplicated `YYYY-MM-DD`
 * strings, and then checks the three things that can go wrong independently:
 *
 *   - every entry is a real date;
 *   - none are in the past, because an on-duty day is one that has not happened;
 *   - the number of dates matches the number of days asked for.
 *
 * The count check is the one the browser is most likely to get wrong, since the two
 * numbers are separate inputs. It is enforced here because the request the approvers
 * read is built from these dates, and a request asking for three days that lists
 * two is not something they can act on.
 */
export function validateOdDates(
  value: unknown,
  daysRequested: number,
  today: string = todayIso()
): OdValidationResult<string[]> {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : text(value)
      .split(/[,\s]+/)
      .filter(Boolean);

  if (raw.length === 0) {
    return { ok: false, errors: [{ field: "od_dates", message: "Select at least one OD date" }] };
  }

  const errors: FieldError[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const candidate = text(entry);
    if (!isRealIsoDate(candidate)) {
      errors.push({ field: "od_dates", message: `"${candidate}" is not a valid date` });
      continue;
    }
    if (candidate < today) {
      errors.push({ field: "od_dates", message: `${candidate} is in the past` });
      continue;
    }
    if (seen.has(candidate)) {
      errors.push({ field: "od_dates", message: `${candidate} is listed more than once` });
      continue;
    }
    seen.add(candidate);
  }

  // A negative count means "not known yet" -- the day count is itself being validated.
  // Comparing against it would produce a nonsense message, so only the agreement check
  // is skipped; a real date is still required.
  if (daysRequested >= 0 && seen.size !== daysRequested) {
    errors.push({
      field: "od_dates",
      message: `You asked for ${daysRequested} OD day${
        daysRequested === 1 ? "" : "s"
      } but selected ${seen.size} date${seen.size === 1 ? "" : "s"}`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: [...seen].sort() };
}

/**
 * The reason for the OD.
 *
 * Trimmed, then length-checked, so a field of nothing but spaces is rejected as
 * empty rather than accepted as a three-character reason.
 */
export function validateOdReason(value: unknown): OdValidationResult<string> {
  const reason = text(value);
  if (!reason) {
    return { ok: false, errors: [{ field: "reason", message: "A reason for the OD is required" }] };
  }
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      errors: [
        {
          field: "reason",
          message: `Please give a reason of at least ${MIN_REASON_LENGTH} characters`,
        },
      ],
    };
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      errors: [
        { field: "reason", message: `Reason must be ${MAX_REASON_LENGTH} characters or fewer` },
      ],
    };
  }
  return { ok: true, value: reason };
}

/** The decision a mentor's comment carries, if one was given. */
export function validateDecisionComment(value: unknown): OdValidationResult<string> {
  const comment = text(value);
  if (comment.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      errors: [
        { field: "comment", message: `Comment must be ${MAX_REASON_LENGTH} characters or fewer` },
      ],
    };
  }
  return { ok: true, value: comment };
}

/**
 * A rejection must say why.
 *
 * The other stages may approve or reject on a blank comment -- an approval needs no
 * justification -- but a rejection stops someone's request dead, and a bare "no"
 * leaves the student with nothing to act on. So a rejection reason is required while
 * an approval comment is not.
 */
export function validateRejectionReason(value: unknown): OdValidationResult<string> {
  const reason = text(value);
  if (!reason) {
    return {
      ok: false,
      errors: [{ field: "rejection_reason", message: "Please give a reason for rejecting this request" }],
    };
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      errors: [
        { field: "rejection_reason", message: `Reason must be ${MAX_REASON_LENGTH} characters or fewer` },
      ],
    };
  }
  return { ok: true, value: reason };
}

/**
 * A whole OD request, validated as one unit.
 *
 * The days are validated first because the dates are checked against them: "you
 * selected the wrong number of dates" is only a meaningful message once there is a
 * number to compare against, and `od_days_requested` is the error an admin most
 * needs to see first.
 *
 * What is deliberately *not* an input: the student, their department, year, section,
 * the mentor, the submission date, and the OD already gained. Those are all derived
 * by the caller from the session and from history, and accepting any of them here
 * would create a field that looks authoritative and is not.
 */
export function validateOdRequest(
  body: unknown,
  today: string = todayIso()
): OdValidationResult<{ od_days_requested: number; od_dates: string[]; reason: string }> {
  const source = (body ?? {}) as Record<string, unknown>;

  /*
   * All three fields are checked, and every problem is collected rather than
   * returning on the first.
   *
   * That matters because the dates are validated *against* the day count, and the day
   * count is one of the things being validated. Short-circuiting on a bad count would
   * mean a student who typed "0" and selected nothing was told only about the "0" and
   * had to fix it before hearing that the reason was empty too. The date check is still
   * run for shape, past dates and duplicates when the count is unusable; only the
   * count-agreement check is skipped, since there is nothing to agree with.
   */
  const days = validateOdDaysRequested(source.od_days_requested);
  const usableDays = days.ok ? days.value : null;
  const dates = validateOdDates(source.od_dates, usableDays ?? -1, today);
  const reason = validateOdReason(source.reason);

  const errors = [
    ...(days.ok ? [] : days.errors),
    ...(dates.ok ? [] : dates.errors),
    ...(reason.ok ? [] : reason.errors),
  ];
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      od_days_requested: (days as { ok: true; value: number }).value,
      od_dates: (dates as { ok: true; value: string[] }).value,
      reason: (reason as { ok: true; value: string }).value,
    },
  };
}

/** Re-exported so a route can sanity-check a year without importing adminValidation. */
export { MIN_YEAR, MAX_YEAR };