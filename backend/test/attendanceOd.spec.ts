import { describe, expect, it } from "vitest";
import {
  OD_ELIGIBLE_STATUS,
  isIsoDate,
  odCoversDate,
  parseOdDateList,
  studentsCoveredByApprovedOd,
} from "../src/utils/odEligibility";
import {
  buildAttendanceReport,
  classifyAttendanceMark,
} from "../src/utils/attendance";
import { OD_STATUS } from "../src/utils/odWorkflow";
import { expandDateRange } from "../src/utils/odValidation";

/*
 * Day-based OD, as pure logic: which approved request grants credit for which
 * date, and what a saved mark turns into in the report.
 *
 * Nothing here touches a database. The finalizer is the only caller in the
 * product, and it asks exactly these questions, so pinning the answers here is
 * what keeps "did this student get OD on the 14th?" from being answered twice.
 */

describe("OD day eligibility", () => {
  describe("the granting status", () => {
    it("is the final approved status and no other", () => {
      expect(OD_ELIGIBLE_STATUS).toBe(OD_STATUS.APPROVED);
      expect(OD_ELIGIBLE_STATUS).toBe("APPROVED");
    });
  });

  describe("parsing od_dates", () => {
    it("reads the JSON array the column stores", () => {
      expect(parseOdDateList('["2026-10-12","2026-10-14"]')).toEqual([
        "2026-10-12",
        "2026-10-14",
      ]);
    });

    it("accepts an already-parsed array so callers need not re-stringify", () => {
      expect(parseOdDateList(["2026-10-12"])).toEqual(["2026-10-12"]);
    });

    it("drops entries that are not YYYY-MM-DD", () => {
      expect(parseOdDateList('["2026-10-12","12-10-2026","","banana",42,null]')).toEqual([
        "2026-10-12",
      ]);
    });

    it("returns nothing for malformed or non-array JSON", () => {
      expect(parseOdDateList("{ not json")).toEqual([]);
      expect(parseOdDateList('{"start":"2026-10-12"}')).toEqual([]);
      expect(parseOdDateList("null")).toEqual([]);
      expect(parseOdDateList(undefined)).toEqual([]);
      expect(parseOdDateList(7)).toEqual([]);
    });
  });

  describe("covering a date", () => {
    it("matches only the exact days that were granted", () => {
      const dates = parseOdDateList('["2026-10-12","2026-10-14"]');
      expect(odCoversDate(dates, "2026-10-12")).toBe(true);
      expect(odCoversDate(dates, "2026-10-14")).toBe(true);
      expect(odCoversDate(dates, "2026-10-13")).toBe(false);
      expect(odCoversDate(dates, "2026-10-15")).toBe(false);
    });

    it("never fills the gap between two granted days", () => {
      // The stored shape is a list of days, not a start/end range, so a request
      // for the 12th and the 14th must not cover the 13th.
      expect(odCoversDate(["2026-10-12", "2026-10-14"], "2026-10-13")).toBe(false);
    });

    it("grants nothing when the session date is missing or malformed", () => {
      expect(odCoversDate(["2026-10-12"], "")).toBe(false);
      expect(odCoversDate(["2026-10-12"], "12-10-2026")).toBe(false);
      expect(odCoversDate(["2026-10-12"], "2026-10-12T00:00:00Z")).toBe(false);
    });

    it("grants nothing when the request has no usable dates", () => {
      expect(odCoversDate([], "2026-10-12")).toBe(false);
      expect(odCoversDate(["", "soon"], "2026-10-12")).toBe(false);
    });

    it("validates the ISO shape", () => {
      expect(isIsoDate("2026-10-12")).toBe(true);
      expect(isIsoDate("2026-1-2")).toBe(false);
      expect(isIsoDate(20261012)).toBe(false);
    });
  });

  /*
   * A request may now be filed as a From/To range. It is stored as the list of days it
   * covers, so nothing in this file had to change -- and these are the tests that say
   * so. Every day inside a range is granted, and a range is not the same thing as "the
   * first and last day only", which is the mistake that would quietly shorten every
   * multi-day OD a student is granted.
   */
  describe("a request filed as a range", () => {
    /** What the column holds for a request filed as a range. */
    function storedRange(from: string, to: string): string[] {
      return parseOdDateList(JSON.stringify(expandDateRange(from, to)));
    }

    it("grants OD on every day the range covers, not just its two ends", () => {
      const stored = storedRange("2026-10-18", "2026-10-20");
      expect(stored).toEqual(["2026-10-18", "2026-10-19", "2026-10-20"]);

      expect(odCoversDate(stored, "2026-10-18")).toBe(true);
      expect(odCoversDate(stored, "2026-10-19")).toBe(true); // the interior day
      expect(odCoversDate(stored, "2026-10-20")).toBe(true);
    });

    it("grants nothing on either side of the range", () => {
      const stored = storedRange("2026-10-18", "2026-10-20");
      expect(odCoversDate(stored, "2026-10-17")).toBe(false);
      expect(odCoversDate(stored, "2026-10-21")).toBe(false);
    });

    it("covers the interior days across a month and year boundary", () => {
      const acrossYear = storedRange("2026-12-30", "2027-01-02");
      expect(odCoversDate(acrossYear, "2026-12-31")).toBe(true);
      expect(odCoversDate(acrossYear, "2027-01-01")).toBe(true);
    });

    it("covers a leap day", () => {
      expect(odCoversDate(storedRange("2028-02-28", "2028-03-01"), "2028-02-29")).toBe(true);
    });

    it("covers a one-day range on that day and no other", () => {
      const single = storedRange("2026-10-18", "2026-10-18");
      const periods = [{ studentId: "S1", odDates: single }];
      expect(studentsCoveredByApprovedOd(periods, "2026-10-18")).toEqual(new Set(["S1"]));
      expect(studentsCoveredByApprovedOd(periods, "2026-10-19")).toEqual(new Set());
    });

    it("collects the same student once on every day of an overlapping range", () => {
      // A set, not a count: the finalizer must never grant double credit, or write a
      // second attendance row, on a day two requests happen to cover.
      const periods = [
        { studentId: "S1", odDates: storedRange("2026-10-18", "2026-10-20") },
        { studentId: "S1", odDates: storedRange("2026-10-19", "2026-10-22") },
      ];
      for (const day of ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]) {
        expect(studentsCoveredByApprovedOd(periods, day)).toEqual(new Set(["S1"]));
      }
    });

    it("leaves a request that predates the range picker reading exactly as it did", () => {
      // Records already in the database hold the days a student picked one at a time,
      // and a gap in that list is still a gap. The picker changed what the form asks
      // for; it must not have changed what a stored list means.
      const legacy = parseOdDateList('["2026-10-12","2026-10-14"]');
      expect(odCoversDate(legacy, "2026-10-12")).toBe(true);
      expect(odCoversDate(legacy, "2026-10-13")).toBe(false);
      expect(odCoversDate(legacy, "2026-10-14")).toBe(true);
    });
  });

  describe("collecting the students covered by a day", () => {
    it("collects the student ids whose request covers the day", () => {
      const covered = studentsCoveredByApprovedOd(
        [
          { studentId: "S1", odDates: ["2026-10-12"] },
          { studentId: "S2", odDates: ["2026-10-12", "2026-10-14"] },
          { studentId: "S3", odDates: ["2026-10-14"] },
        ],
        "2026-10-12"
      );
      expect([...covered].sort()).toEqual(["S1", "S2"]);
    });

    it("collapses a student with two covering requests into one entry", () => {
      // One student, two approved requests for the same day, still one student:
      // this is what stops double credit and a second attendance row.
      const covered = studentsCoveredByApprovedOd(
        [
          { studentId: "S1", odDates: ["2026-10-12"] },
          { studentId: "S1", odDates: ["2026-10-12"] },
        ],
        "2026-10-12"
      );
      expect(covered.size).toBe(1);
      expect(covered.has("S1")).toBe(true);
    });

    it("ignores a row with no student id", () => {
      const covered = studentsCoveredByApprovedOd(
        [{ studentId: "", odDates: ["2026-10-12"] }],
        "2026-10-12"
      );
      expect(covered.size).toBe(0);
    });

    it("collects nothing for a malformed session date", () => {
      const covered = studentsCoveredByApprovedOd(
        [{ studentId: "S1", odDates: ["2026-10-12"] }],
        ""
      );
      expect(covered.size).toBe(0);
    });
  });
});

describe("classifying a saved attendance mark", () => {
  it("puts PRESENT first, so a verified scan is never double counted as OD", () => {
    expect(classifyAttendanceMark({ status: "PRESENT", od: "YES" })).toBe("PRESENT");
  });

  it("recognises the OD status the finalizer writes", () => {
    expect(classifyAttendanceMark({ status: "OD", od: "NO" })).toBe("OD");
  });

  it("still honours the legacy od column on rows written before OD was a status", () => {
    expect(classifyAttendanceMark({ status: "ABSENT", od: "YES" })).toBe("OD");
    expect(classifyAttendanceMark({ status: null, od: "YES" })).toBe("OD");
  });

  it("keeps ABSENT as ABSENT and a missing row as unmarked, never as absent", () => {
    expect(classifyAttendanceMark({ status: "ABSENT", od: "NO" })).toBe("ABSENT");
    expect(classifyAttendanceMark({ status: "ABSENT" })).toBe("ABSENT");
    expect(classifyAttendanceMark(undefined)).toBe("UNMARKED");
    expect(classifyAttendanceMark({})).toBe("UNMARKED");
    expect(classifyAttendanceMark({ status: null, od: null })).toBe("UNMARKED");
  });

  it("is case insensitive about the stored values", () => {
    expect(classifyAttendanceMark({ status: "present" })).toBe("PRESENT");
    expect(classifyAttendanceMark({ status: "od" })).toBe("OD");
    expect(classifyAttendanceMark({ od: "yes" })).toBe("OD");
  });
});

describe("the attendance report", () => {
  const roster = [
    { register_no: "71001", student_name: "Asha" },
    { register_no: "71002", student_name: "Bala" },
    { register_no: "71003", student_name: "Chitra" },
    { register_no: "71004", student_name: "Dev" },
  ];

  const base = {
    date: "2026-10-14",
    department: "IT",
    section: "A",
    subjectName: "System Software",
    students: roster,
  };

  it("splits every marked student into exactly one of PRESENT, OD and ABSENT", () => {
    const { report, presentCount, odCount, absentCount } = buildAttendanceReport({
      ...base,
      attendanceByRegister: {
        "71001": { status: "PRESENT" },
        "71002": { status: "OD" },
        "71003": { status: "ABSENT" },
        // 71004 has no row at all and must land in none of the three.
      },
    });

    expect(presentCount).toBe(1);
    expect(odCount).toBe(1);
    expect(absentCount).toBe(1);
    expect(presentCount + odCount + absentCount).toBe(3);
    expect(report).toContain("PRESENT (1)");
    expect(report).toContain("OD (1)");
    expect(report).toContain("ABSENT (1)");
  });

  it("credits OD as attendance and keeps it out of the absentees", () => {
    const { report, percentage, absentees, odStudents } = buildAttendanceReport({
      ...base,
      attendanceByRegister: {
        "71001": { status: "PRESENT" },
        "71002": { status: "OD" },
        "71003": { status: "OD" },
        "71004": { status: "ABSENT" },
      },
    });

    expect(percentage).toBe(75);
    expect(report).toContain("Attendance Percentage: 75%");
    expect(absentees.map((s) => s.register_no)).toEqual(["71004"]);
    expect(odStudents.map((s) => s.register_no).sort()).toEqual(["71002", "71003"]);
    expect(report).not.toMatch(/ABSENT \(2\)/);
  });

  it("lists names and register numbers in every section", () => {
    const { report } = buildAttendanceReport({
      ...base,
      attendanceByRegister: {
        "71001": { status: "PRESENT" },
        "71002": { status: "OD" },
        "71003": { status: "ABSENT" },
      },
    });

    expect(report).toContain("1. ASHA (71001)");
    expect(report).toContain("1. BALA (71002)");
    expect(report).toContain("1. CHITRA (71003)");
  });

  it("counts an OD student as marked, so the percentages agree with the roster", () => {
    const { report, presentCount, odCount, absentCount, totalStrength } =
      buildAttendanceReport({
        ...base,
        attendanceByRegister: {
          "71001": { status: "OD" },
          "71002": { status: "OD" },
          "71003": { status: "OD" },
          "71004": { status: "OD" },
        },
      });

    expect(totalStrength).toBe(4);
    expect(presentCount).toBe(0);
    expect(odCount).toBe(4);
    expect(absentCount).toBe(0);
    expect(percentageOf(presentCount, odCount, totalStrength)).toBe(100);
    expect(report).toContain("Attendance Percentage: 100%");
  });

  it("still recognises rows the legacy od column marked", () => {
    const { odCount, absentCount } = buildAttendanceReport({
      ...base,
      attendanceByRegister: {
        "71001": { status: "ABSENT", od: "YES" },
      },
    });
    expect(odCount).toBe(1);
    expect(absentCount).toBe(0);
  });

  it("prints Nil rather than an empty section when nobody is on duty", () => {
    const { report, odCount } = buildAttendanceReport({
      ...base,
      attendanceByRegister: {
        "71001": { status: "PRESENT" },
        "71002": { status: "ABSENT" },
      },
    });
    expect(odCount).toBe(0);
    expect(report).toContain("OD (0)\n\nNil");
  });

  it("reports zero percent, not a division by zero, for an empty roster", () => {
    const { report, percentage, totalStrength } = buildAttendanceReport({
      ...base,
      students: [],
      attendanceByRegister: {},
    });
    expect(totalStrength).toBe(0);
    expect(percentage).toBe(0);
    expect(report).toContain("Attendance Percentage: 0%");
  });

  it("rounds the OD-inclusive percentage to a whole number", () => {
    const three = roster.slice(0, 3);
    const { percentage } = buildAttendanceReport({
      ...base,
      students: three,
      attendanceByRegister: {
        "71001": { status: "PRESENT" },
        "71002": { status: "OD" },
        "71003": { status: "ABSENT" },
      },
    });
    expect(percentage).toBe(67);
  });

  it("dates the report from the session date in DD.MM.YYYY", () => {
    const { report } = buildAttendanceReport({
      ...base,
      attendanceByRegister: {},
    });
    expect(report).toContain("Date: 14.10.2026");
    expect(report).toContain("B. Tech - IT - A");
    expect(report).toContain("Hour: System Software");
    expect(report).toContain("Total Strength: 4");
  });
});

function percentageOf(present: number, od: number, total: number): number {
  return total ? Math.round(((present + od) / total) * 100) : 0;
}
