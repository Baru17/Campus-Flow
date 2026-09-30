/**
 * Guard: no academic batch value is hardcoded in the batch flow.
 *
 * The batch registry is meant to be the only source of cohorts, with
 * `academic_batches` plus the physical tables deciding what exists. Two hardcoded
 * lists broke that in production. A cohort provisioned through the admin
 * dashboard never reached the staff selector because the frontend mirrored a
 * stale list, and a cohort that was deleted from the database kept being offered
 * because the backend merged a hardcoded floor into a registry it only ever added
 * to.
 *
 * Both failures were invisible to every other test, because a hardcoded list
 * behaves identically to a correct one right up until the database disagrees with
 * it. This file is what makes the disagreement fail the build instead.
 *
 * The sources are read with `?raw` rather than `node:fs`, because this suite runs
 * in the workerd pool where the filesystem is virtual and a real read would fail.
 *
 * Comments and docstrings are excluded, and so are the two validation-message
 * modules: their "for example 2024_2028" strings illustrate the *format* shown to
 * whoever is typing a new batch, and they select nothing. Every other occurrence
 * is a failure, which is the point - a batch-shaped literal in executable code is
 * either a phantom cohort or a second source of truth.
 */

import { describe, expect, it } from "vitest";

import frontendConstants from "../../src/constants.js?raw";
import frontendBatchesApi from "../../src/api/batchesApi.js?raw";
import frontendStaffDashboard from "../../src/pages/StaffDashboard.jsx?raw";
import frontendBatchValidation from "../../src/utils/batchValidation.js?raw";

import tableResolver from "../src/utils/tableResolver.ts?raw";
import provisioning from "../src/utils/provisioning.ts?raw";
import adminApi from "../src/api/admin.ts?raw";
import index from "../src/index.ts?raw";
import attendanceApi from "../src/api/attendance.ts?raw";
import backendBatchValidation from "../src/utils/batchValidation.ts?raw";

/** `2024_2028` and similar: an admission cohort label, not a year or a count. */
const BATCH_LITERAL = /\b\d{4}_\d{4}\b/;

/**
 * Files that may contain a batch label, and why.
 *
 * Adding to this list should be a deliberate act: it asserts that a real cohort
 * label is being shown as an illustration and that no selection logic reads it.
 */
const EXEMPT: { path: string; reason: string }[] = [
  {
    path: "src/utils/batchValidation.js",
    reason: "validation hint shown while typing a new batch; selects nothing",
  },
  {
    path: "backend/src/utils/batchValidation.ts",
    reason: "validation hint shown while creating a batch; selects nothing",
  },
];

/**
 * Blanks out comments while leaving string literals intact, so a batch label in
 * prose is ignored but one in code is not.
 *
 * Block comments are removed wholesale. Line comments are cut at `//`, except
 * where the `//` sits inside a quoted string, which is why quotes are tracked
 * rather than splitting on the first `//` seen.
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      out += " ";
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/** The batch-selection and provisioning sources that must stay cohort-free. */
const GUARDED: { path: string; source: string }[] = [
  { path: "src/constants.js", source: frontendConstants },
  { path: "src/api/batchesApi.js", source: frontendBatchesApi },
  { path: "src/pages/StaffDashboard.jsx", source: frontendStaffDashboard },
  { path: "backend/src/utils/tableResolver.ts", source: tableResolver },
  { path: "backend/src/utils/provisioning.ts", source: provisioning },
  { path: "backend/src/api/admin.ts", source: adminApi },
  { path: "backend/src/index.ts", source: index },
  { path: "backend/src/api/attendance.ts", source: attendanceApi },
];

function offendingLines(source: string): string[] {
  return stripComments(source)
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => BATCH_LITERAL.test(line))
    .map(({ line, number }) => `${number}: ${line.trim()}`);
}

describe("no hardcoded academic batch values", () => {
  it("guards every source that selects or provisions a batch", () => {
    // A vacuous guard would make the assertions below meaningless, so the set of
    // watched files is itself asserted.
    expect(GUARDED.length).toBeGreaterThanOrEqual(8);
    for (const { path, source } of GUARDED) {
      expect(source.length, `${path} was not read`).toBeGreaterThan(200);
    }
  });

  it("has no batch label in the batch-selection and provisioning code", () => {
    const failures: string[] = [];
    for (const { path, source } of GUARDED) {
      if (EXEMPT.some((entry) => path === entry.path)) continue;
      const hits = offendingLines(source);
      if (hits.length > 0) failures.push(`${path}\n    ${hits.join("\n    ")}`);
    }
    expect(failures.join("\n")).toBe("");
  });

  it("holds no batch list in the frontend constants", () => {
    // The module that used to mirror the backend's cohorts. It may name
    // departments, which are a format gate rather than a cohort list, but not a
    // single batch.
    expect(stripComments(frontendConstants)).not.toMatch(BATCH_LITERAL);
  });

  it("holds no batch list in the backend resolver", () => {
    // Where the hardcoded floor used to be. Nothing here may name a cohort.
    expect(stripComments(tableResolver)).not.toMatch(BATCH_LITERAL);
  });

  it("lets the staff dashboard name no cohort at all", () => {
    // The dashboard may only pass through what the backend returned, so it is not
    // permitted to contain a batch label even in a string.
    expect(frontendStaffDashboard).not.toMatch(BATCH_LITERAL);
  });

  it("keeps every exemption narrow and justified", () => {
    // An exemption that quietly covers a whole feature is how a hardcoded list
    // comes back, so each one must state its reason.
    for (const entry of EXEMPT) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("confirms the exempted modules really only carry format examples", () => {
    // The exemptions are load-bearing, so verify the shape of what they cover:
    // every remaining occurrence must sit in a message or a comment, never in a
    // comparison or a lookup key.
    for (const source of [frontendBatchValidation, backendBatchValidation]) {
      for (const line of offendingLines(source)) {
        expect(line).toMatch(/for example|admission|same (batch|cohort)|satisfies the shape|reads as|re-/i);
      }
    }
  });
});
