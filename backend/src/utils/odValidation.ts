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
 * Everything else here is what the client is legitimately allowed to send: the range of
 * dates they need, and why.
 *
 * ## A range, or a list of days
 *
 * A request may describe its dates two ways, and both are accepted:
 *
 *   - `od_from_date` / `od_to_date` -- what the form asks for. The days and the day
 *     count are *derived* from the pair here, never taken from the client, so the count
 *     a request is filed with is the count the range implies.
 *   - `od_dates` / `od_days_requested` -- the explicit list. This is the shape the
 *     schema has always held and the shape every record already in the database is in,
 *     so it stays valid input; it is also what a client built before the range picker
 *     existed would send.
 *
 * Which one arrived is decided by whether either endpoint was sent, and no third shape
 * exists. A range, once present, is the whole answer: a client that sends both a range
 * and a longer date list does not get to choose between them.
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

/** The body fields that describe an OD as a range rather than as a list of days. */
export const OD_RANGE_FROM_FIELD = "od_from_date";
export const OD_RANGE_TO_FIELD = "od_to_date";

/**
 * One day in milliseconds.
 *
 * Every UTC day is exactly this long -- no offset changes, no leap seconds -- which is
 * the whole reason the range is walked in UTC rather than in the Worker's local zone.
 */
const MS_PER_DAY = 86_400_000;

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
 * Days since the epoch for a `YYYY-MM-DD`, or `null` if it is not a real date.
 *
 * Parsing the explicit `Z` keeps this UTC, so the division is a whole number and the
 * value does not move with the Worker's clock settings. Stepping by `MS_PER_DAY` from
 * here is exact; stepping a *local* `Date` is not, because a daylight-saving boundary
 * inside the range would drop a day from the middle of it.
 */
function dayNumber(iso: string): number | null {
  if (!isRealIsoDate(iso)) return null;
  return Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY;
}

/**
 * Days from `from` to `to` counting both ends, `null` if either is not a real date.
 *
 * Negative when the range is reversed. Ordering is a *rule* rather than an arithmetic
 * accident here -- "To Date cannot be earlier than From Date" is the thing being
 * enforced -- so this private helper reports the raw difference and leaves that decision
 * to `validateOdDateRange`, while the public `countDaysInclusive` answers the question a
 * display actually asks.
 */
function daysBetweenInclusive(from: unknown, to: unknown): number | null {
  const a = text(from);
  const b = text(to);
  if (!isRealIsoDate(a) || !isRealIsoDate(b)) return null;
  return (dayNumber(b) as number) - (dayNumber(a) as number) + 1;
}

/**
 * How many calendar days a range covers, both ends included, or `null` if it covers none.
 *
 * `null` is the answer for all three ways a range can fail to mean anything: an end not
 * chosen, an end that is not a real date, and a To Date before the From Date. None of
 * them has a size worth displaying, so none of them gets one.
 */
export function countDaysInclusive(from: unknown, to: unknown): number | null {
  const span = daysBetweenInclusive(from, to);
  return span !== null && span >= 1 ? span : null;
}

/**
 * Every day from `from` to `to`, both ends included, ascending.
 *
 * This is what `od_dates` stores, and it is the shape every reader of a request already
 * expects: attendance eligibility still asks "is this session date in the list", and it
 * must not have to learn what a range is.
 */
export function expandDateRange(from: unknown, to: unknown): string[] {
  const span = daysBetweenInclusive(from, to);
  if (span === null || span < 1) return [];
  const start = dayNumber(text(from)) as number;
  return Array.from({ length: span }, (_, index) =>
    new Date((start + index) * MS_PER_DAY).toISOString().slice(0, 10)
  );
}

/**
 * A From Date / To Date pair, validated and expanded into the days it covers.
 *
 * Four things can go wrong, and each is reported against the field the student can
 * actually fix:
 *
 *   - an endpoint missing;
 *   - an endpoint that is not a real date;
 *   - an endpoint in the past, because an on-duty day is one that has not happened;
 *   - the end before the start;
 *
 * plus the one rule that is about the size of the range rather than its shape: it may
 * not run for more than `MAX_OD_DAYS` days, the same cap an explicit list was already
 * held to. `2026-01-01` to `2026-12-31` is refused by arithmetic rather than by an
 * approver noticing.
 */
export function validateOdDateRange(
  body: Record<string, unknown>,
  today: string = todayIso()
): OdValidationResult<{ od_days_requested: number; od_dates: string[] }> {
  const errors: FieldError[] = [];
  const from = text(body[OD_RANGE_FROM_FIELD]);
  const to = text(body[OD_RANGE_TO_FIELD]);

  const endpoints: [string, string, string][] = [
    [OD_RANGE_FROM_FIELD, from, "From Date"],
    [OD_RANGE_TO_FIELD, to, "To Date"],
  ];

  for (const [field, value, label] of endpoints) {
    if (!value) {
      errors.push({ field, message: `${label} is required` });
    } else if (!isRealIsoDate(value)) {
      errors.push({ field, message: `"${value}" is not a valid date` });
    } else if (value < today) {
      errors.push({ field, message: `${value} is in the past` });
    }
  }

  const span = daysBetweenInclusive(from, to);
  if (span !== null && span < 1) {
    errors.push({ field: OD_RANGE_TO_FIELD, message: "To Date cannot be earlier than From Date" });
  } else if (span !== null && span > MAX_OD_DAYS) {
    errors.push({
      field: OD_RANGE_TO_FIELD,
      message: `An OD request may cover ${MAX_OD_DAYS} days or fewer`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { od_days_requested: span as number, od_dates: expandDateRange(from, to) },
  };
}

/**
 * Whether a body describes its dates as a range.
 *
 * Either endpoint being present is enough. A half-sent range is a range the student
 * needs to be told about -- "To Date is required" -- rather than a request quietly
 * falling back to a day list they did not mean.
 */
export function hasOdDateRange(body: Record<string, unknown>): boolean {
  return Boolean(text(body[OD_RANGE_FROM_FIELD]) || text(body[OD_RANGE_TO_FIELD]));
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
 * A range, when one was sent, decides the dates and the day count on its own, and the
 * reason is validated beside it. Otherwise the days are validated first because the
 * dates are checked against them: "you selected the wrong number of dates" is only a
 * meaningful message once there is a number to compare against, and `od_days_requested`
 * is the error an admin most needs to see first.
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
  const reason = validateOdReason(source.reason);

  /*
   * A range is the whole answer when one is present.
   *
   * `od_days_requested` and `od_dates` may also be in the body, because the form sends
   * the request whole -- but they are *not* consulted. A client that sends a range of
   * three days alongside a list of fifteen gets three, and the pair it sent is
   * inconsistent rather than authoritative. Deriving is what makes the count safe: it
   * is no longer something a student can type.
   */
  if (hasOdDateRange(source)) {
    const range = validateOdDateRange(source, today);
    const rangeErrors = [...(range.ok ? [] : range.errors), ...(reason.ok ? [] : reason.errors)];
    if (rangeErrors.length > 0) return { ok: false, errors: rangeErrors };

    const derived = (range as { ok: true; value: { od_days_requested: number; od_dates: string[] } }).value;
    return {
      ok: true,
      value: {
        od_days_requested: derived.od_days_requested,
        od_dates: derived.od_dates,
        reason: (reason as { ok: true; value: string }).value,
      },
    };
  }

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