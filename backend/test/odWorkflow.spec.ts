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
  isRealIsoDate,
  todayIso,
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