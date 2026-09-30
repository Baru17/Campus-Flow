/**
 * Batch validation, kept apart from tableResolver on purpose.
 *
 * `tableResolver` answers "which tables does this provisioned pair use?" and its
 * inputs are assumed to already be normalised. This module answers the separate
 * question "is this string a well-formed batch label an administrator may create
 *?", which is the check that stands between a text field and a table name.
 *
 * Nothing here is imported by tableResolver, so the resolver keeps no dependency
 * on the shape of a user-facing form.
 */

/** Matches the documented label format: four digits, underscore, four digits. */
const BATCH_SHAPE = /^(\d{4})_(\d{4})$/;

/** Every cohort label in this application is a four-year programme. */
export const BATCH_DURATION_YEARS = 4;

export type BatchValidation =
  | { valid: true; batch: string; startYear: number; endYear: number }
  | { valid: false; code: BatchValidationCode; message: string };

export type BatchValidationCode =
  | "batch-required"
  | "batch-invalid-format"
  | "batch-invalid-range"
  | "batch-invalid-duration";

const MESSAGES: Record<BatchValidationCode, string> = {
  "batch-required": "Enter a batch label.",
  "batch-invalid-format": "Enter a batch in the form YYYY_YYYY, for example 2024_2028.",
  "batch-invalid-range": "Enter a batch with real years, for example 2024_2028.",
  "batch-invalid-duration":
    "The end year must be the start year plus 4, for example 2024_2028.",
};

/**
 * Accepts loose input the way the rest of the application does: trimmed and
 * upper-cased, with a space or dash treated as the separator. "2027 - 2031" and
 * "2027_2031" are the same batch, because the form and the stored key are allowed
 * to be typed differently without becoming different cohorts.
 */
export function normalizeBatchInput(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "_");
}

/**
 * Validates a batch label, returning the normalised form and its years on
 * success. Every rejection is a distinct code so the API can answer with a
 * specific message and the form can put it next to the field.
 */
export function validateBatchInput(raw: unknown): BatchValidation {
  const batch = normalizeBatchInput(raw);
  if (!batch) {
    return { valid: false, code: "batch-required", message: MESSAGES["batch-required"] };
  }

  const match = BATCH_SHAPE.exec(batch);
  if (!match) {
    return { valid: false, code: "batch-invalid-format", message: MESSAGES["batch-invalid-format"] };
  }

  const startYear = Number(match[1]);
  const endYear = Number(match[2]);

  // A label like 0000_0004 satisfies the shape, so the years are range-checked
  // separately. Anything outside a plausible admission window is refused rather
  // than provisioned as a table called `CSE_Students_0000_0004`.
  const MIN_YEAR = 2000;
  const MAX_YEAR = 2100;
  if (startYear < MIN_YEAR || endYear < MIN_YEAR || startYear > MAX_YEAR || endYear > MAX_YEAR) {
    return { valid: false, code: "batch-invalid-range", message: MESSAGES["batch-invalid-range"] };
  }

  if (endYear !== startYear + BATCH_DURATION_YEARS) {
    return { valid: false, code: "batch-invalid-duration", message: MESSAGES["batch-invalid-duration"] };
  }

  return { valid: true, batch, startYear, endYear };
}

/** Presentation only: `2024_2028` reads as `2024–2028`. */
export function formatBatchLabel(batch: string): string {
  return batch.replace("_", "–");
}
