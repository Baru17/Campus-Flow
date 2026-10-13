/**
 * How the class-activity card presents a response.
 *
 * The card may only claim what the counts support. `0 / 0` and "everyone is signed in"
 * are both literally true for an empty class and both are actively misleading: the
 * first cannot be told apart from a roster that failed to load, and the second is a
 * reassurance about a class that does not exist.
 *
 * These live in their own module precisely so they can be tested here. There is no DOM
 * runner in this project, and asserting on the component's source text would pass on a
 * string that happened to sit somewhere unreachable while failing on a correct
 * refactor -- a test that watches the implementation rather than the decision.
 *
 * Imported from the frontend as a real module, not with `?raw`: this is logic, and it
 * should be executed.
 */

import { describe, expect, it } from "vitest";

import { describeClassActivity, missingToggleLabel } from "../../src/utils/classActivity.js";

/** A well-formed response, with the fields the card reads. */
function response(overrides: Record<string, unknown> = {}) {
	return {
		activeStudents: 0,
		totalStudents: 0,
		missing: [],
		missingTruncated: false,
		...overrides,
	};
}

const student = (registerNo: string) => ({ register_no: registerNo, student_name: `Student ${registerNo}` });

describe("before the server has answered", () => {
	it("shows nothing at all rather than zeros", () => {
		const view = describeClassActivity(null);

		expect(view.hasActivity).toBe(false);
		// The card's loading branch is driven off `hasActivity`, and this must not be
		// mistaken for an answer.
		expect(view.ratio).toBeNull();
		expect(view.isEmptyClass).toBe(false);
		expect(view.allPresent).toBe(false);
		expect(view.showMissingControl).toBe(false);
	});
});

describe("an empty class", () => {
	const empty = describeClassActivity(response({ activeStudents: 0, totalStudents: 0, missing: [] }));

	it("is recognised as empty", () => {
		expect(empty.hasActivity).toBe(true);
		expect(empty.isEmptyClass).toBe(true);
	});

	it("never renders 0 / 0", () => {
		/*
		 * The specific regression. `ratio` is null rather than the string "0 / 0", so
		 * there is no path by which the card can print a zero pair for a class it has
		 * not accounted for.
		 */
		expect(empty.ratio).toBeNull();
		expect(String(empty.ratio)).not.toContain("0 / 0");
	});

	it("never claims everyone is signed in", () => {
		expect(empty.allPresent).toBe(false);
		expect(missingToggleLabel({ isEmptyClass: empty.isEmptyClass, allPresent: empty.allPresent, missingCount: 0 })).toBeNull();
	});

	it("offers no missing-student control", () => {
		/*
		 * There is nobody to be missing, and a control that opened onto an empty panel
		 * would read as a successful all-clear rather than as "nothing to report".
		 */
		expect(empty.showMissingControl).toBe(false);
	});
});

describe("a class with students", () => {
	const populated = describeClassActivity(
		response({
			activeStudents: 2,
			totalStudents: 4,
			missing: [student("A1"), student("A2")],
		}),
	);

	it("is not treated as empty", () => {
		expect(populated.isEmptyClass).toBe(false);
		expect(populated.showMissingControl).toBe(true);
	});

	it("renders the count against the denominator", () => {
		expect(populated.ratio).toBe("2 / 4");
	});

	it("counts the missing rows and names them in the toggle", () => {
		expect(populated.missingCount).toBe(2);
		expect(
			missingToggleLabel({
				isEmptyClass: populated.isEmptyClass,
				allPresent: populated.allPresent,
				missingCount: populated.missingCount,
			}),
		).toBe("Missing Students (2)");
	});
});

describe("the everyone-is-signed-in condition", () => {
	it("is met when the whole class holds a session", () => {
		const full = describeClassActivity(response({ activeStudents: 4, totalStudents: 4, missing: [] }));

		expect(full.allPresent).toBe(true);
		expect(full.isEmptyClass).toBe(false);
		expect(
			missingToggleLabel({ isEmptyClass: full.isEmptyClass, allPresent: full.allPresent, missingCount: 0 }),
		).toBe("Everyone is signed in");
	});

	it("is not met on an empty list alone when the counts disagree", () => {
		/*
		 * The server guarantees `active + missing === total`, so this cannot arrive from
		 * a well-formed response. It is asserted anyway because the sentence is the one
		 * a staff member acts on: if a future change ever broke that guarantee, the
		 * failure has to be silence rather than a false all-clear.
		 */
		const inconsistent = describeClassActivity(
			response({ activeStudents: 1, totalStudents: 9, missing: [] }),
		);

		expect(inconsistent.missing.length).toBe(0);
		expect(inconsistent.allPresent).toBe(false);
		expect(
			missingToggleLabel({
				isEmptyClass: inconsistent.isEmptyClass,
				allPresent: inconsistent.allPresent,
				missingCount: inconsistent.missingCount,
			}),
		).toBe("Missing Students (0)");
	});

	it("is not met when anybody is actually missing", () => {
		const partial = describeClassActivity(
			response({ activeStudents: 3, totalStudents: 4, missing: [student("A4")] }),
		);

		expect(partial.allPresent).toBe(false);
	});
});

describe("defensive handling of an unexpected payload", () => {
	it("treats a non-array missing list as empty rather than throwing", () => {
		const view = describeClassActivity(response({ activeStudents: 3, totalStudents: 3, missing: null }));

		expect(view.missing).toEqual([]);
		expect(view.allPresent).toBe(true);
	});

	it("treats a nonsense total as empty rather than as a real class", () => {
		/*
		 * The server validates these before sending, so neither can occur. The point is
		 * the direction of the failure: a malformed total must not produce a statistic,
		 * and must certainly not produce a claim that a class is fully present.
		 */
		for (const totalStudents of [Number.NaN, -3, undefined, null]) {
			const view = describeClassActivity(response({ activeStudents: 5, totalStudents, missing: [] }));

			expect(view.isEmptyClass, String(totalStudents)).toBe(true);
			expect(view.ratio, String(totalStudents)).toBeNull();
			expect(view.allPresent, String(totalStudents)).toBe(false);
			expect(view.showMissingControl, String(totalStudents)).toBe(false);
		}
	});
});