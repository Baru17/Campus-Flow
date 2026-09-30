/**
 * Bound-parameter-aware chunking for D1 queries.
 *
 * D1 caps a single query at 100 bound parameters
 * (https://developers.cloudflare.com/d1/platform/limits/), and the cap applies to
 * each statement inside a `db.batch()` as well. The failure is a hard error, not a
 * truncation:
 *
 *     D1_ERROR: too many SQL variables ... SQLITE_ERROR
 *
 * It bites any query whose `IN (...)` list is built from request data, because the
 * list grows with the upload. A 66-row student import produced two such queries:
 * a three-way `IN` over the roster (3 x 66 = 198 parameters) and a two-way `IN`
 * over `auth_users` (2 x 66 = 132). A hand-sized test file never reaches the
 * threshold, so the bug only appears in production on a real cohort.
 *
 * The fix is to split the *lookup* into batches small enough to stay under the cap.
 * Lookups are the only place the count is unbounded: the row inserts bind a fixed
 * handful of values each, and they all travel in a single `db.batch()` so that a
 * failure anywhere rolls the whole import back.
 */

/** D1's documented hard cap on bound parameters for one query. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * Headroom below the hard cap.
 *
 * The margin exists so that a statement built here cannot sit exactly on the limit
 * and fail only in production, and so a future statement that binds a few extra
 * parameters still fits. It is a whole number of rows either way, because chunk
 * sizes are rounded down.
 */
export const BIND_PARAMETER_MARGIN = 20;

/** The number of bound parameters a chunked statement is allowed to bind. */
export const SAFE_BOUND_PARAMETERS = D1_MAX_BOUND_PARAMETERS - BIND_PARAMETER_MARGIN;

/**
 * How many rows fit in one chunk, given how many parameters each row contributes.
 *
 * Rounded down, so a chunk never exceeds the safe budget. A row that on its own
 * needs more parameters than the whole budget cannot be chunked, and the caller is
 * told rather than being handed an empty chunk that would silently drop rows.
 */
export function chunkSizeForParameters(
  parametersPerRow: number,
  maxBoundParameters: number = SAFE_BOUND_PARAMETERS
): number {
  if (!Number.isInteger(parametersPerRow) || parametersPerRow < 1) {
    throw new Error(`parametersPerRow must be a positive integer, got ${parametersPerRow}`);
  }
  if (parametersPerRow > maxBoundParameters) {
    throw new Error(
      `A single row binds ${parametersPerRow} parameters, which exceeds the safe budget of ` +
        `${maxBoundParameters}. This statement cannot be chunked; reduce the parameters per row.`
    );
  }
  return Math.max(1, Math.floor(maxBoundParameters / parametersPerRow));
}

/** Splits a list into fixed-size chunks, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be at least 1, got ${size}`);
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export interface ChunkedSelectOptions<TIn, TOut> {
  /**
   * Builds the SQL for one chunk. It must bind exactly `parametersPerRow` values
   * for each row in the chunk, and must not contain any literal user data.
   */
  buildSql: (rows: TIn[]) => string;
  /** The values bound for one chunk, in the same order as `buildSql` expects. */
  bindValues: (rows: TIn[]) => unknown[];
  /** How many bound parameters each row contributes. */
  parametersPerRow: number;
  /** Override for tests; defaults to the safe budget. */
  maxBoundParameters?: number;
}

/**
 * Runs one `SELECT` across a large set of values, split into chunks that each stay
 * under D1's bound-parameter cap, and returns the union of the results.
 *
 * The input rows and the result rows are separate types because they are different
 * shapes: a lookup keyed by `{ student_id, register_no, email }` returns whatever
 * columns the `SELECT` names.
 *
 * Duplicates are removed before chunking. That is safe for a lookup whose results
 * are turned into a set, which is every caller here, and it avoids spending the
 * parameter budget re-asking for a value that is already known.
 *
 * The chunks run sequentially rather than concurrently. D1 processes queries for a
 * single database one at a time, so parallel chunks would queue behind each other
 * anyway while multiplying peak memory.
 */
export async function selectInChunks<TIn, TOut = TIn>(
  db: D1Database,
  options: ChunkedSelectOptions<TIn, TOut>,
  rows: readonly TIn[]
): Promise<TOut[]> {
  const { buildSql, bindValues, parametersPerRow, maxBoundParameters = SAFE_BOUND_PARAMETERS } = options;

  if (rows.length === 0) return [];

  const size = chunkSizeForParameters(parametersPerRow, maxBoundParameters);
  const seen = new Set<TIn>();
  const unique: TIn[] = [];
  for (const row of rows) {
    if (seen.has(row)) continue;
    seen.add(row);
    unique.push(row);
  }

  const results: TOut[] = [];
  for (const part of chunk(unique, size)) {
    const statement = db.prepare(buildSql(part)).bind(...bindValues(part));
    const page = await statement.all<TOut>();
    for (const row of page?.results ?? []) {
      results.push(row);
    }
  }
  return results;
}
