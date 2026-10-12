/**
 * Live "active students" monitoring, mounted at `/api/activity`.
 *
 * This is a read-only monitoring surface for the staff dashboard. It is deliberately
 * its own route family rather than a fold-in to attendance, OTPs, OD or H1, because
 * it participates in none of them: nothing here reads or writes an attendance record,
 * an OTP, an OD request, an H1 form or a workdone entry, and nothing here can mark,
 * unmark or infer attendance of any kind. If the counter stops working, every
 * existing workflow is unaffected.
 *
 * Two routes, with opposite audiences:
 *
 *   - `POST /ping` is written by every signed-in student's browser and is gated on the
 *     student role.
 *   - `GET /active-students` returns one aggregate number across every cohort and is
 *     gated on staff.
 *   - `GET /class-active-students` is the same number narrowed to one class, and is
 *     gated on staff exactly as the global one is.
 *
 * ## Identity always comes from the session
 *
 * Neither route accepts a user id, a role, or anything else identifying in its body,
 * headers or query. `requireAuth` resolves the session cookie exactly as it does for
 * every other protected route, `requireStudent` / `requireStaff` read the role off the
 * user that `requireAuth` put on the context, and the only value written or filtered
 * on is `auth_users.auth_user_id` from that resolved user. A browser cannot claim to
 * be somebody else, and cannot opt a row in on another account's behalf.
 *
 * ## Session safety
 *
 * The heartbeat does not touch `auth_sessions` at all: it creates no session, extends
 * no expiry, and revokes nothing. A ping is therefore incapable of keeping an expired
 * or revoked session alive. Session validity for the count is established by the same
 * `expires_at` comparison `resolveAuthUser` performs, read-only, below.
 */

import { Hono } from "hono";
import { requireAuth, requireStaff, requireStudent, type AuthUser } from "../middleware/auth";
import { validateDepartment, validateSection, validateYear } from "../utils/adminValidation";
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";
import { assertAllowedStudentTable, listBatchesForDepartment, resolveTables } from "../utils/tableResolver";

const app = new Hono<{ Bindings: { DB: D1Database } }>();

/**
 * How long a heartbeat keeps an account inside the count.
 *
 * The browser beats every 20s, so this tolerates two and a bit consecutive beats
 * being dropped by a flaky mobile network or a throttled background tab without the
 * student flickering out of the number. It is also why the browser only beats while
 * it is actually being used: past this window nothing is sent, and the row ages out
 * on its own.
 */
export const ACTIVE_WINDOW_MS = 60_000;

function serverError(c: any, error: unknown, message: string, code: string) {
  console.error(message, getErrorMessageForLog(error));
  const transient = isTransientD1Error(error);
  return c.json(
    {
      success: false,
      error: transient ? "The service is temporarily busy. Please retry." : message,
      code: transient ? "database-busy" : code,
    },
    transient ? 503 : 500
  );
}

/**
 * Record that this student account was just seen.
 *
 * Idempotent by construction: the upsert keys on `auth_user_id`, so repeated beats,
 * extra tabs and extra devices all collapse onto the one row for the account and
 * only the timestamp moves. That is what makes the aggregate count a count of
 * accounts rather than a count of open tabs.
 *
 * The response is deliberately empty of anything derived from the caller: no user id,
 * no name, no register number, no token, not even the stored timestamp.
 */
app.post("/ping", requireAuth, requireStudent, async (c) => {
  const authUser = (c as any).get("authUser") as AuthUser;
  try {
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO student_activity (auth_user_id, last_active_at)
       VALUES (?, ?)
       ON CONFLICT(auth_user_id) DO UPDATE SET last_active_at = excluded.last_active_at`
    )
      .bind(authUser.auth_user_id, now)
      .run();

    return c.json({ success: true });
  } catch (error) {
    return serverError(c, error, "Could not record student activity", "activity_ping_failed");
  }
});

/**
 * How many distinct student accounts are active right now.
 *
 * Three conditions have to hold for an account to be counted, and all three are
 * decided server-side:
 *
 *   1. it has a heartbeat inside the last `ACTIVE_WINDOW_MS`;
 *   2. its account role is a student, so a staff, advisor, HOD, coordinator or admin
 *      row that somehow reached the table is still not counted;
 *   3. it still has a live `auth_sessions` row -- the same `expires_at > now` test
 *      `resolveAuthUser` applies on every authenticated request. Logging out deletes
 *      that row and the account leaves the count on the next read; a session that has
 *      expired does the same, so a stale heartbeat alone can never revive or qualify
 *      an expired session.
 *
 * `COUNT(DISTINCT ...)` is belt and braces on top of the primary key: one account is
 * one row regardless of how many sessions or devices it has.
 *
 * The response is the number and a server timestamp. No name, register number, email,
 * internal id, token or per-student row leaves this handler.
 */
app.get("/active-students", requireAuth, requireStaff, async (c) => {
  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffIso = new Date(nowMs - ACTIVE_WINDOW_MS).toISOString();

    const row = await c.env.DB.prepare(
      `SELECT COUNT(DISTINCT sa.auth_user_id) AS active_students
       FROM student_activity sa
       JOIN auth_users au
         ON au.auth_user_id = sa.auth_user_id
        AND LOWER(au.role) = 'student'
       WHERE sa.last_active_at > ?
         AND EXISTS (
           SELECT 1
           FROM auth_sessions s
           WHERE s.auth_user_id = sa.auth_user_id
             AND s.expires_at > ?
         )`
    )
      .bind(cutoffIso, nowIso)
      .first<{ active_students: number }>();

    const activeStudents = Number(row?.active_students ?? 0);

    return c.json({
      success: true,
      active_students: Number.isFinite(activeStudents) ? activeStudents : 0,
      updated_at: nowIso,
    });
  } catch (error) {
    return serverError(c, error, "Could not read the active student count", "active_students_failed");
  }
});

/**
 * How many distinct student accounts are active in one class.
 *
 * ## The relationship this filters on
 *
 * There is exactly one link between an authenticated account and its roster row, and
 * it is `auth_user_id`:
 *
 *   student_activity.auth_user_id  ==  auth_users.auth_user_id  ==  <roster>.auth_user_id
 *
 * `auth_user_id` is the only one of these that is interchangeable. It is not the
 * register number, not the `student_id`, and not the email, and none of those is
 * substituted for it anywhere below. The roster column is nullable and indexed, so a
 * student who has no account never matches and can never be counted.
 *
 * **Department is not a column on the roster.** A student belongs to a department
 * because of which physical table their row sits in: `IT_Students_2024_2028` is an IT
 * student, `CSE_Students_2026_2030` is a CSE one. So a department cannot be filtered
 * with `WHERE department = ?` -- it is filtered by *only reading that department's
 * tables*, which is why the table list below comes from the batch registry rather than
 * from the request.
 *
 * **Year and section are columns on that same roster row**, and are the rest of the
 * class definition. A batch is not: `tableResolver` deliberately keeps the admission
 * batch out of this lookup, because year of study advances with the cohort while the
 * batch stays fixed. A class here is therefore (department, year, section) across
 * every cohort registered to that department -- the three selectors the staff
 * dashboard already has.
 *
 * ## Why the table names are safe here
 *
 * `listBatchesForDepartment` and `resolveTables` return literals derived from
 * `buildTableNames` off a validated department and a strictly formatted batch, and
 * every one of them is put back through `assertAllowedStudentTable` before it can
 * reach SQL. Nothing from the query string is ever interpolated into a statement --
 * year and section are bound parameters. The department reaches SQL only as a lookup
 * key into that resolver.
 *
 * ## Why one statement rather than one per cohort
 *
 * A department has a handful of cohorts, and each is a separate physical table, so
 * the branches are `UNION ALL`-ed into a single `COUNT(DISTINCT ...)`. That is what
 * makes the result a count of *accounts* across all of them: summing per-table counts
 * would double-count any account linked into two rosters, which should not happen but
 * is exactly the kind of thing a monitoring number must not quietly inflate.
 *
 * Authorization is unchanged from the global route: same `requireStaff`, so no role
 * gains access it did not have.
 */
app.get("/class-active-students", requireAuth, requireStaff, async (c) => {
  const departmentResult = validateDepartment(c.req.query("department"));
  const yearResult = validateYear(c.req.query("year"));
  const sectionResult = validateSection(c.req.query("section"));

  if (!departmentResult.ok || !yearResult.ok || !sectionResult.ok) {
    return c.json(
      {
        success: false,
        error: "A department, a year from 1 to 4, and a valid section are all required",
        code: "invalid-class",
      },
      400
    );
  }

  const department = departmentResult.value;
  const year = yearResult.value;
  const section = sectionResult.value;

  try {
    /*
     * Every cohort registered to this department whose tables actually exist. The
     * registry is hydrated by the `/api/*` middleware before this runs, so a cohort
     * created through the admin dashboard is counted immediately rather than after a
     * Worker restart.
     */
    const studentTables = listBatchesForDepartment(department)
      .map((batch) => resolveTables(department, batch))
      .filter((tables): tables is NonNullable<typeof tables> => tables !== null)
      .map((tables) => assertAllowedStudentTable(tables.studentTable));

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffIso = new Date(nowMs - ACTIVE_WINDOW_MS).toISOString();

    /*
     * No registered cohort for this department means there is no roster to count, so
     * the honest answer is zero rather than an error. This is an empty class, not a
     * failed request: the department list on the dashboard is built from this same
     * registry, so a staff member cannot normally reach it.
     */
    if (studentTables.length === 0) {
      return c.json({ success: true, active_students: 0, updated_at: nowIso });
    }

    const branches: string[] = [];
    const bindings: Array<string | number> = [];

    for (const studentTable of studentTables) {
      branches.push(
        `SELECT st.auth_user_id AS auth_user_id
         FROM ${studentTable} st
         WHERE st.year = ? AND st.section = ?
           AND EXISTS (
             SELECT 1 FROM student_activity sa
             WHERE sa.auth_user_id = st.auth_user_id AND sa.last_active_at > ?
           )
           AND EXISTS (
             SELECT 1 FROM auth_sessions s
             WHERE s.auth_user_id = st.auth_user_id AND s.expires_at > ?
           )
           AND EXISTS (
             SELECT 1 FROM auth_users au
             WHERE au.auth_user_id = st.auth_user_id AND LOWER(au.role) = 'student'
           )`
      );
      bindings.push(year, section, cutoffIso, nowIso);
    }

    const row = await c.env.DB
      .prepare(
        `SELECT COUNT(DISTINCT auth_user_id) AS active_students FROM (${branches.join(" UNION ALL ")})`
      )
      .bind(...bindings)
      .first<{ active_students: number }>();

    const activeStudents = Number(row?.active_students ?? 0);

    return c.json({
      success: true,
      active_students: Number.isFinite(activeStudents) ? activeStudents : 0,
      updated_at: nowIso,
    });
  } catch (error) {
    return serverError(
      c,
      error,
      "Could not read the active student count for this class",
      "class_active_students_failed"
    );
  }
});

export default app;
