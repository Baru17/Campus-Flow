import { describe, expect, it } from "vitest";
import {
  OD_STATUS,
  STAGES,
  checkTransition,
  stageForStatus,
  statusAfterDecision,
  decisionColumns,
  isGainingStatus,
} from "../src/utils/odWorkflow";
import {
  MAX_OD_DAYS,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  OD_RANGE_FROM_FIELD,
  OD_RANGE_TO_FIELD,
  countDaysInclusive,
  expandDateRange,
  hasOdDateRange,
  isRealIsoDate,
  todayIso,
  validateOdDateRange,
  validateOdDates,
  validateOdDaysRequested,
  validateOdReason,
  validateOdRequest,
} from "../src/utils/odValidation";
import frontendOdValidation from "../../src/utils/odValidation.js?raw";
import backendOdValidation from "../src/utils/odValidation.ts?raw";

/*
 * The OD workflow's rules, with no database.
 *
 * The chain is the thing worth testing here, because it is the part that has to be
 * right for the workflow to mean anything: four stages in a fixed order, each one
 * reachable only from the status the one before leaves behind. That is pure logic, so
 * it is tested as pure logic rather than through HTTP -- the routes just ask it the
 * same questions.
 *
 * The validation tests cover the inputs a student controls, and the ones they do not.
 * The last test in the file is the one that keeps this module and the browser's copy of
 * two numbers from drifting apart.
 */

describe("OD workflow", () => {
  describe("the chain", () => {
    it("has exactly four stages, in the required order", () => {
      expect(STAGES.map((stage) => stage.key)).toEqual([
        "MENTOR",
        "CLASS_ADVISOR",
        "CONTEST_COORDINATOR",
        "HOD",
      ]);
    });

    it("walks Mentor -> Class Advisor -> Contest Coordinator -> HOD -> APPROVED", () => {
      // Each stage's `next` must be the following stage's `status`, and the last
      // stage's must be APPROVED. This is the single assertion that a stage cannot be
      // reordered, inserted or skipped without the suite noticing.
      for (let index = 0; index < STAGES.length - 1; index += 1) {
        expect(STAGES[index].next).toBe(STAGES[index + 1].status);
      }
      expect(STAGES[STAGES.length - 1].next).toBe(OD_STATUS.APPROVED);
    });

    it("starts every request at PENDING_MENTOR", () => {
      expect(STAGES[0].status).toBe(OD_STATUS.PENDING_MENTOR);
    });

    it("maps every pending status back to exactly one stage", () => {
      for (const stage of STAGES) {
        expect(stageForStatus(stage.status)?.key).toBe(stage.key);
      }
    });

    it("treats APPROVED and REJECTED as having no stage", () => {
      expect(stageForStatus(OD_STATUS.APPROVED)).toBeNull();
      expect(stageForStatus(OD_STATUS.REJECTED)).toBeNull();
      expect(stageForStatus("PENDING_PRINTER")).toBeNull();
    });
  });

  describe("checkTransition", () => {
    const mentor = STAGES[0];
    const classAdvisor = STAGES[1];
    const coordinator = STAGES[2];
    const hod = STAGES[3];

    it("allows the stage a request is actually waiting on", () => {
      for (const stage of STAGES) {
        expect(checkTransition(stage.status, stage).allowed).toBe(true);
      }
    });

    it("refuses a stage that is not the one holding the request up", () => {
      // The mentor cannot answer a request that has reached the class advisor.
      const check = checkTransition(classAdvisor.status, mentor);
      expect(check.allowed).toBe(false);
      expect(check.code).toBe("od-wrong-stage");
    });

    it("refuses every stage once the request is approved", () => {
      for (const stage of STAGES) {
        const check = checkTransition(OD_STATUS.APPROVED, stage);
        expect(check.allowed, stage.key).toBe(false);
        expect(check.code).toBe("od-already-approved");
      }
    });

    it("refuses every stage once the request is rejected", () => {
      for (const stage of STAGES) {
        const check = checkTransition(OD_STATUS.REJECTED, stage);
        expect(check.allowed, stage.key).toBe(false);
        expect(check.code).toBe("od-already-rejected");
      }
    });

    it("refuses a status it does not recognise", () => {
      expect(checkTransition("MAYBE", mentor).code).toBe("od-invalid-status");
      expect(checkTransition("", mentor).code).toBe("od-invalid-status");
    });

    it("cannot be skipped: no stage is reachable from the one before its predecessor", () => {
      // HOD may only act on PENDING_HOD. If a stage were removed or reordered, one of
      // these would start allowing a jump.
      expect(checkTransition(OD_STATUS.PENDING_MENTOR, hod).allowed).toBe(false);
      expect(checkTransition(OD_STATUS.PENDING_MENTOR, coordinator).allowed).toBe(false);
      expect(checkTransition(OD_STATUS.PENDING_MENTOR, classAdvisor).allowed).toBe(false);
      // The class advisor comes before the coordinator, so a coordinator cannot act while
      // the request is still with the advisor.
      expect(checkTransition(OD_STATUS.PENDING_CLASS_ADVISOR, coordinator).allowed).toBe(false);
    });
  });

  describe("statusAfterDecision", () => {
    it("advances on approval", () => {
      expect(statusAfterDecision(STAGES[0], "APPROVED")).toBe(OD_STATUS.PENDING_CLASS_ADVISOR);
      expect(statusAfterDecision(STAGES[1], "APPROVED")).toBe(OD_STATUS.PENDING_CONTEST_COORDINATOR);
      expect(statusAfterDecision(STAGES[2], "APPROVED")).toBe(OD_STATUS.PENDING_HOD);
      expect(statusAfterDecision(STAGES[3], "APPROVED")).toBe(OD_STATUS.APPROVED);
    });

    it("ends at REJECTED from any stage", () => {
      for (const stage of STAGES) {
        expect(statusAfterDecision(stage, "REJECTED")).toBe(OD_STATUS.REJECTED);
      }
    });
  });

  describe("decision columns", () => {
    it("gives every stage somewhere to record its verdict", () => {
      expect(decisionColumns(STAGES[0])).toEqual({
        decision: "mentor_decision",
        decidedBy: "mentor_decided_by",
        decidedAt: "mentor_decided_at",
        comment: "mentor_comment",
      });
      expect(decisionColumns(STAGES[1]).decision).toBe("advisor_decision");
      expect(decisionColumns(STAGES[2]).decision).toBe("coordinator_decision");
      expect(decisionColumns(STAGES[3]).decision).toBe("hod_decision");
    });
  });

  describe("which requests count towards OD gained", () => {
    it("counts approved only", () => {
      expect(isGainingStatus(OD_STATUS.APPROVED)).toBe(true);
      // Pending is an intention and rejected is a refusal. Counting either would let a
      // student raise the figure by submitting, or make it move under them.
      for (const status of [
        OD_STATUS.PENDING_MENTOR,
        OD_STATUS.PENDING_CONTEST_COORDINATOR,
        OD_STATUS.PENDING_CLASS_ADVISOR,
        OD_STATUS.PENDING_HOD,
        OD_STATUS.REJECTED,
      ]) {
        expect(isGainingStatus(status), status).toBe(false);
      }
    });
  });
});

describe("OD validation", () => {
  describe("day count", () => {
    it("accepts a positive whole number within the cap", () => {
      expect(validateOdDaysRequested(1)).toEqual({ ok: true, value: 1 });
      expect(validateOdDaysRequested(3)).toEqual({ ok: true, value: 3 });
      expect(validateOdDaysRequested(MAX_OD_DAYS)).toEqual({ ok: true, value: MAX_OD_DAYS });
    });

    it("rejects zero, negatives and decimals", () => {
      for (const bad of [0, -1, -5, 1.5, 0.1, "1.5", "-2"]) {
        expect(validateOdDaysRequested(bad).ok, String(bad)).toBe(false);
      }
    });

    it("rejects an empty or missing value rather than reading it as zero", () => {
      // `Number("")` and `Number(null)` are both 0, so without an explicit presence
      // check an empty box would be indistinguishable from a deliberate zero.
      for (const bad of ["", "   ", null, undefined]) {
        expect(validateOdDaysRequested(bad).ok).toBe(false);
      }
    });

    it("rejects anything above the cap", () => {
      expect(validateOdDaysRequested(MAX_OD_DAYS + 1).ok).toBe(false);
      expect(validateOdDaysRequested("1e9").ok).toBe(false);
    });

    it("rejects text", () => {
      for (const bad of ["abc", "two", "3 days", true]) {
        expect(validateOdDaysRequested(bad).ok, String(bad)).toBe(false);
      }
    });
  });

  describe("dates", () => {
    const today = "2026-10-01";

    it("accepts a matching set of future dates and sorts them", () => {
      const result = validateOdDates(["2026-10-03", "2026-10-02"], 2, today);
      expect(result).toEqual({ ok: true, value: ["2026-10-02", "2026-10-03"] });
    });

    it("accepts a comma-separated string as well as an array", () => {
      const result = validateOdDates("2026-10-02, 2026-10-03", 2, today);
      expect(result.ok).toBe(true);
    });

    it("rejects an empty set", () => {
      expect(validateOdDates([], 1, today).ok).toBe(false);
      expect(validateOdDates("", 1, today).ok).toBe(false);
    });

    it("rejects a date that only looks like one", () => {
      // The shape matches but the day does not exist, so a regex alone would let it
      // through and SQLite would store it as text that never means a date.
      expect(isRealIsoDate("2026-02-31")).toBe(false);
      expect(isRealIsoDate("2026-13-01")).toBe(false);
      expect(isRealIsoDate("2026-00-10")).toBe(false);
      expect(isRealIsoDate("01-10-2026")).toBe(false);
      expect(isRealIsoDate("2026/10/01")).toBe(false);
    });

    it("accepts a real date, including a leap day", () => {
      expect(isRealIsoDate("2026-10-01")).toBe(true);
      expect(isRealIsoDate("2028-02-29")).toBe(true);
    });

    it("rejects a past date", () => {
      const result = validateOdDates(["2026-09-30"], 1, today);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain("in the past");
    });

    it("rejects the same date twice", () => {
      const result = validateOdDates(["2026-10-02", "2026-10-02"], 2, today);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain("more than once");
    });

    it("rejects a date count that disagrees with the day count", () => {
      // The mistake people actually make: two boxes, filled in independently.
      const fewer = validateOdDates(["2026-10-02"], 3, today);
      expect(fewer.ok).toBe(false);
      expect(JSON.stringify(fewer)).toContain("asked for 3 OD days but selected 1 date");

      const more = validateOdDates(
        ["2026-10-02", "2026-10-03", "2026-10-04"],
        2,
        today
      );
      expect(more.ok).toBe(false);
    });

    it("agrees with the exported date predicate", () => {
      expect(isRealIsoDate("2026-10-01")).toBe(true);
    });
  });

  describe("reason", () => {
    it("accepts and trims a reasonable reason", () => {
      expect(validateOdReason("  Attending a technical fest  ")).toEqual({
        ok: true,
        value: "Attending a technical fest",
      });
    });

    it("rejects an empty reason", () => {
      expect(validateOdReason("").ok).toBe(false);
      expect(validateOdReason(null).ok).toBe(false);
      expect(validateOdReason(undefined).ok).toBe(false);
    });

    it("rejects a whitespace-only reason rather than accepting it as short", () => {
      // Trimmed first, so this is empty rather than a reason of nine spaces.
      expect(validateOdReason("      ").ok).toBe(false);
    });

    it("enforces both ends of the length", () => {
      expect(validateOdReason("a".repeat(MIN_REASON_LENGTH - 1)).ok).toBe(false);
      expect(validateOdReason("a".repeat(MIN_REASON_LENGTH)).ok).toBe(true);
      expect(validateOdReason("a".repeat(MAX_REASON_LENGTH)).ok).toBe(true);
      expect(validateOdReason("a".repeat(MAX_REASON_LENGTH + 1)).ok).toBe(false);
    });
  });

  describe("the whole request", () => {
    const today = "2026-10-01";
    const valid = {
      od_days_requested: 2,
      od_dates: ["2026-10-02", "2026-10-03"],
      reason: "Attending an inter-college technical event",
    };

    it("accepts a complete request", () => {
      const result = validateOdRequest(valid, today);
      expect(result.ok).toBe(true);
      expect((result as { value: { od_dates: string[] } }).value.od_dates).toEqual([
        "2026-10-02",
        "2026-10-03",
      ]);
    });

    it("reports every problem at once", () => {
      // A bulk of errors in one response is what lets the form highlight all three
      // inputs rather than one per round trip.
      const result = validateOdRequest(
        { od_days_requested: 0, od_dates: [], reason: "" },
        today
      );
      expect(result.ok).toBe(false);
      const fields = (result as { errors: { field: string }[] }).errors.map((e) => e.field);
      expect(fields).toContain("od_days_requested");
      expect(fields).toContain("od_dates");
      expect(fields).toContain("reason");
    });

    it("reports the day count before the date mismatch", () => {
      // "You selected the wrong number of dates" is only meaningful once there is a
      // number to compare against, and a wrong day count is the more useful error.
      const result = validateOdRequest(
        { od_days_requested: 0, od_dates: [], reason: "a valid reason here" },
        today
      );
      expect((result as { errors: { field: string }[] }).errors[0].field).toBe(
        "od_days_requested"
      );
    });

    it("takes no identity fields at all", () => {
      /*
       * The important negative: nothing here is an input. A body that tried to name a
       * student, a department, a mentor or a banked total would be ignored by the
       * route rather than honoured, because the route has no parameter for it.
       */
      expect(Object.keys(valid).sort()).toEqual([
        "od_dates",
        "od_days_requested",
        "reason",
      ]);
    });
  });

  describe("todayIso", () => {
    it("returns a YYYY-MM-DD string", () => {
      expect(todayIso(new Date("2026-10-01T12:34:56Z"))).toBe("2026-10-01");
    });
  });
});

/*
 * The From Date / To Date form of a request.
 *
 * The student picks a range; the record stores a list of days. That is the shape the
 * schema already had and the shape every reader of a request -- the approval screens,
 * the mails, attendance finalization -- already reads, so nothing downstream has to
 * learn what a range is. What these tests hold down is that the conversion between the
 * two is right at its edges, and that the count stored alongside the days is derived
 * rather than believed.
 */
describe("OD date range", () => {
  const today = "2026-10-01";

  describe("counting the days", () => {
    it("counts a single day as one", () => {
      // From and To the same day is the degenerate range. Counting it as zero would
      // make a one-day OD impossible to file at all.
      expect(countDaysInclusive("2026-10-18", "2026-10-18")).toBe(1);
    });

    it("counts both ends of a multi-day range", () => {
      // The wording the whole feature rests on: the 18th to the 20th is the 18th, the
      // 19th and the 20th -- three days, not two.
      expect(countDaysInclusive("2026-10-18", "2026-10-19")).toBe(2);
      expect(countDaysInclusive("2026-10-18", "2026-10-20")).toBe(3);
    });

    it("crosses a month boundary", () => {
      expect(countDaysInclusive("2026-10-30", "2026-11-02")).toBe(4);
    });

    it("crosses a year boundary", () => {
      expect(countDaysInclusive("2026-12-30", "2027-01-02")).toBe(4);
    });

    it("crosses a leap day", () => {
      // 2028 is a leap year, so the 29th is a day the count has to include.
      expect(countDaysInclusive("2028-02-28", "2028-03-01")).toBe(3);
      expect(expandDateRange("2028-02-28", "2028-03-01")).toContain("2028-02-29");
    });

    it("answers null for a reversed range", () => {
      expect(countDaysInclusive("2026-10-20", "2026-10-18")).toBeNull();
      expect(countDaysInclusive("2026-10-19", "2026-10-18")).toBeNull();
    });

    it("answers null for a missing or malformed end", () => {
      expect(countDaysInclusive("", "2026-10-18")).toBeNull();
      expect(countDaysInclusive("2026-10-18", "")).toBeNull();
      expect(countDaysInclusive("2026-10-18", "soon")).toBeNull();
      expect(countDaysInclusive(undefined, undefined)).toBeNull();
    });
  });

  describe("expanding into the days that get stored", () => {
    it("returns the single day for a single-day range", () => {
      expect(expandDateRange("2026-10-18", "2026-10-18")).toEqual(["2026-10-18"]);
    });

    it("returns every day of a multi-day range, both ends included", () => {
      expect(expandDateRange("2026-10-18", "2026-10-20")).toEqual([
        "2026-10-18",
        "2026-10-19",
        "2026-10-20",
      ]);
    });

    it("crosses a month boundary without skipping or repeating a day", () => {
      expect(expandDateRange("2026-10-30", "2026-11-02")).toEqual([
        "2026-10-30",
        "2026-10-31",
        "2026-11-01",
        "2026-11-02",
      ]);
    });

    it("crosses a year boundary without skipping or repeating a day", () => {
      expect(expandDateRange("2026-12-30", "2027-01-02")).toEqual([
        "2026-12-30",
        "2026-12-31",
        "2027-01-01",
        "2027-01-02",
      ]);
    });

    it("includes a leap day in the right place", () => {
      expect(expandDateRange("2028-02-28", "2028-03-01")).toEqual([
        "2028-02-28",
        "2028-02-29",
        "2028-03-01",
      ]);
      // 2026 is not a leap year, so the same window is one day shorter.
      expect(expandDateRange("2026-02-28", "2026-03-01")).toEqual(["2026-02-28", "2026-03-01"]);
    });

    it("agrees with the count it reported", () => {
      // The invariant the stored row rests on: `od_days_requested` is
      // `od_dates.length`, derived from the same range, never counted twice.
      for (const [from, to] of [
        ["2026-10-18", "2026-10-18"],
        ["2026-10-18", "2026-10-20"],
        ["2026-10-30", "2026-11-04"],
        ["2026-12-29", "2027-01-04"],
        ["2028-02-26", "2028-03-02"],
      ]) {
        expect(expandDateRange(from, to)).toHaveLength(countDaysInclusive(from, to));
      }
    });

    it("returns nothing for a range that covers nothing", () => {
      expect(expandDateRange("2026-10-20", "2026-10-18")).toEqual([]);
      expect(expandDateRange("2026-10-18", "")).toEqual([]);
    });

    it("serialises every day as a YYYY-MM-DD string", () => {
      /*
       * Load-bearing: `od_dates` is compared as a string by the approval screens and
       * matched against the session date by attendance eligibility, so a `Date` object
       * or a localised date here would silently stop matching.
       */
      for (const value of expandDateRange("2026-12-28", "2027-01-04")) {
        expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(isRealIsoDate(value)).toBe(true);
      }
    });
  });

  describe("validating a range", () => {
    it("accepts a range and derives both the days and the count", () => {
      expect(
        validateOdDateRange({ [OD_RANGE_FROM_FIELD]: "2026-10-18", [OD_RANGE_TO_FIELD]: "2026-10-20" }, today)
      ).toEqual({
        ok: true,
        value: { od_days_requested: 3, od_dates: ["2026-10-18", "2026-10-19", "2026-10-20"] },
      });
    });

    it("accepts a single-day range", () => {
      expect(
        validateOdDateRange({ [OD_RANGE_FROM_FIELD]: "2026-10-18", [OD_RANGE_TO_FIELD]: "2026-10-18" }, today)
      ).toEqual({ ok: true, value: { od_days_requested: 1, od_dates: ["2026-10-18"] } });
    });

    it("requires both ends to be present", () => {
      const onlyFrom = validateOdDateRange({ [OD_RANGE_FROM_FIELD]: "2026-10-18" }, today);
      expect(onlyFrom.ok).toBe(false);
      expect(JSON.stringify(onlyFrom)).toContain(OD_RANGE_TO_FIELD);

      const onlyTo = validateOdDateRange({ [OD_RANGE_TO_FIELD]: "2026-10-20" }, today);
      expect(onlyTo.ok).toBe(false);
      expect(JSON.stringify(onlyTo)).toContain(OD_RANGE_FROM_FIELD);
    });

    it("rejects an end that is not a real date", () => {
      const result = validateOdDateRange(
        { [OD_RANGE_FROM_FIELD]: "2026-10-18", [OD_RANGE_TO_FIELD]: "2026-02-31" },
        today
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain("is not a valid date");
    });

    it("rejects a reversed range", () => {
      const result = validateOdDateRange(
        { [OD_RANGE_FROM_FIELD]: "2026-10-20", [OD_RANGE_TO_FIELD]: "2026-10-18" },
        today
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain("To Date cannot be earlier than From Date");
    });

    it("rejects an end in the past, because an on-duty day has not happened yet", () => {
      const from = validateOdDateRange(
        { [OD_RANGE_FROM_FIELD]: "2026-09-30", [OD_RANGE_TO_FIELD]: "2026-10-20" },
        today
      );
      expect(from.ok).toBe(false);
      expect(JSON.stringify(from)).toContain("in the past");

      const to = validateOdDateRange(
        { [OD_RANGE_FROM_FIELD]: "2026-10-05", [OD_RANGE_TO_FIELD]: "2026-09-30" },
        today
      );
      expect(to.ok).toBe(false);
      expect(JSON.stringify(to)).toContain("in the past");
    });

    it("accepts a range of exactly the day cap", () => {
      const result = validateOdDateRange(
        { [OD_RANGE_FROM_FIELD]: "2026-10-18", [OD_RANGE_TO_FIELD]: "2026-11-01" },
        today
      );
      expect(result.ok).toBe(true);
      expect((result as { value: { od_dates: string[] } }).value.od_dates).toHaveLength(MAX_OD_DAYS);
    });

    it("refuses a range longer than the day cap", () => {
      /*
       * The same bound an explicit day list was always held to, applied by arithmetic.
       * A year-long range is refused here rather than being handed to an approver to
       * notice.
       */
      const result = validateOdDateRange(
        { [OD_RANGE_FROM_FIELD]: "2026-10-18", [OD_RANGE_TO_FIELD]: "2026-11-02" },
        today
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain(`${MAX_OD_DAYS} days or fewer`);

      const wholeYear = validateOdDateRange(
        { [OD_RANGE_FROM_FIELD]: "2026-10-01", [OD_RANGE_TO_FIELD]: "2027-09-30" },
        today
      );
      expect(wholeYear.ok).toBe(false);
    });

    it("reports every problem at once", () => {
      const result = validateOdDateRange(
        { [OD_RANGE_FROM_FIELD]: "2026-09-01", [OD_RANGE_TO_FIELD]: "2026-08-01" },
        today
      );
      expect(result.ok).toBe(false);
      const fields = (result as { errors: { field: string }[] }).errors.map((e) => e.field);
      expect(fields).toContain(OD_RANGE_FROM_FIELD);
      expect(fields).toContain(OD_RANGE_TO_FIELD);
    });
  });

  describe("telling a range from a day list", () => {
    it("treats either endpoint as a range", () => {
      // A half-sent range is a range the student needs telling about, not a request
      // that quietly falls back to a day list they did not mean.
      expect(hasOdDateRange({ [OD_RANGE_FROM_FIELD]: "2026-10-18" })).toBe(true);
      expect(hasOdDateRange({ [OD_RANGE_TO_FIELD]: "2026-10-20" })).toBe(true);
    });

    it("treats a body with no endpoints as a day list", () => {
      expect(hasOdDateRange({})).toBe(false);
      expect(hasOdDateRange({ od_dates: ["2026-10-18"], od_days_requested: 1 })).toBe(false);
    });

    it("treats blank endpoints as no range at all", () => {
      expect(hasOdDateRange({ [OD_RANGE_FROM_FIELD]: "", [OD_RANGE_TO_FIELD]: "   " })).toBe(false);
    });
  });

  describe("a whole request", () => {
    const reason = "Attending an inter-college technical event";

    it("accepts a range and derives the days and the count from it", () => {
      const result = validateOdRequest(
        { [OD_RANGE_FROM_FIELD]: "2026-10-18", [OD_RANGE_TO_FIELD]: "2026-10-20", reason },
        today
      );
      expect(result.ok).toBe(true);
      expect((result as { value: { od_days_requested: number; od_dates: string[] } }).value).toEqual({
        od_days_requested: 3,
        od_dates: ["2026-10-18", "2026-10-19", "2026-10-20"],
        reason,
      });
    });

    it("does not believe a day count or a day list sent alongside a range", () => {
      /*
       * The important negative. The form sends the request whole, so both a range and a
       * derived list are in the body; a client that sends a short range and a longer
       * list gets the range. The count a request is filed with is therefore no longer
       * something a student can type.
       */
      const inflated = validateOdRequest(
        {
          [OD_RANGE_FROM_FIELD]: "2026-10-18",
          [OD_RANGE_TO_FIELD]: "2026-10-19",
          od_days_requested: MAX_OD_DAYS,
          od_dates: Array.from({ length: MAX_OD_DAYS }, (_, i) => `2026-11-${String(i + 10).padStart(2, "0")}`),
          reason,
        },
        today
      );
      expect(inflated.ok).toBe(true);
      const value = (inflated as { value: { od_days_requested: number; od_dates: string[] } }).value;
      expect(value.od_days_requested).toBe(2);
      expect(value.od_dates).toEqual(["2026-10-18", "2026-10-19"]);

      // And the other way round: a long list cannot outrun a short range either.
      const deflated = validateOdRequest(
        {
          [OD_RANGE_FROM_FIELD]: "2026-10-18",
          [OD_RANGE_TO_FIELD]: "2026-10-20",
          od_days_requested: 1,
          od_dates: ["2026-10-18"],
          reason,
        },
        today
      );
      expect((deflated as { value: { od_days_requested: number } }).value.od_days_requested).toBe(3);
    });

    it("reports the range and the reason together", () => {
      const result = validateOdRequest(
        { [OD_RANGE_FROM_FIELD]: "2026-10-20", [OD_RANGE_TO_FIELD]: "2026-10-18", reason: "" },
        today
      );
      expect(result.ok).toBe(false);
      const fields = (result as { errors: { field: string }[] }).errors.map((e) => e.field);
      expect(fields).toContain(OD_RANGE_TO_FIELD);
      expect(fields).toContain("reason");
    });

    it("still accepts a legacy explicit date list", () => {
      // Backward compatibility: every request already in the database is in this shape,
      // and a client built before the range picker existed would send it too.
      const result = validateOdRequest(
        { od_days_requested: 2, od_dates: ["2026-10-18", "2026-10-20"], reason },
        today
      );
      expect(result.ok).toBe(true);
      expect((result as { value: { od_days_requested: number; od_dates: string[] } }).value).toEqual({
        od_days_requested: 2,
        od_dates: ["2026-10-18", "2026-10-20"],
        reason,
      });
    });

    it("still refuses a legacy date list that disagrees with its own count", () => {
      // The old cross-check, unchanged: a range did not replace it, it was added
      // alongside it.
      const result = validateOdRequest(
        { od_days_requested: 3, od_dates: ["2026-10-18", "2026-10-19"], reason },
        today
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain("asked for 3 OD days but selected 2 dates");
    });

    it("takes no identity fields at all", () => {
      const result = validateOdRequest(
        {
          [OD_RANGE_FROM_FIELD]: "2026-10-18",
          [OD_RANGE_TO_FIELD]: "2026-10-20",
          reason,
          student_id: "2K99CS999",
          department: "CSE",
          mentor_email: "attacker@evil.test",
          od_days_gained_before: 99,
          submitted_date: "2000-01-01",
          status: "APPROVED",
        },
        today
      );
      expect(result.ok).toBe(true);
      // The route has no parameter for any of those, but the derived value must not
      // have grown one either.
      expect(Object.keys((result as { value: object }).value).sort()).toEqual([
        "od_dates",
        "od_days_requested",
        "reason",
      ]);
    });
  });
});

/*
 * The browser and the server have to agree on two numbers, or the form will accept
 * something the server refuses. The duplication is deliberate -- see
 * `src/utils/odValidation.js` -- so this asserts the two copies still match rather
 * than trusting a comment that says they do.
 */
describe("frontend and backend OD limits agree", () => {
  it("declares the same day cap", () => {
    expect(frontendOdValidation).toContain(`MAX_OD_DAYS = ${MAX_OD_DAYS}`);
    expect(backendOdValidation).toContain(`MAX_OD_DAYS = ${MAX_OD_DAYS}`);
  });

  it("declares the same reason floor", () => {
    expect(frontendOdValidation).toContain(`MIN_REASON_LENGTH = ${MIN_REASON_LENGTH}`);
    expect(backendOdValidation).toContain(`MIN_REASON_LENGTH = ${MIN_REASON_LENGTH}`);
  });
});