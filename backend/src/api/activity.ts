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
 * ## What "active" means
 *
 * An account is counted when it holds a valid, unexpired login session, and it is
 * counted for as long as that session exists -- whether the student is tapping the
 * screen or has put the phone down and walked away. An earlier version counted a
 * heartbeat instead, which meant an idle student and a backgrounded tab silently
 * disappeared from the number and a reader of the dashboard could not tell "nobody is
 * here" from "nobody is touching their phone". The session is the thing that was
 * actually asked about, so the session is what is counted.
 *
 * `student_activity` and its 60-second window are therefore **not** read by either
 * count. `POST /ping` still writes that table and is still used by the client, but
 * nothing in the counting path depends on it, and no heartbeat -- recent, stale or
 * absent -- can add an account to or remove one from a count.
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
 * Nothing in this module can lengthen a session's life. Both count handlers read
 * `auth_sessions` and compare `expires_at` against the current time -- the same
 * comparison `resolveAuthUser` makes on every authenticated request -- and neither
 * writes to the table. The heartbeat does not touch `auth_sessions` at all: it creates
 * no session, extends no expiry, and revokes nothing.
 *
 * An account leaves a count only the way a session ends: `POST /api/auth/logout`
 * deletes that session's row, or the row passes `expires_at`. No activity signal, and
 * nothing in this module, can end a session early or keep one alive past its expiry.
 */

import { Hono } from "hono";
import { requireAuth, requireStaff, requireStudent, type AuthUser } from "../middleware/auth";
import { validateDepartment, validateSection, validateYear } from "../utils/adminValidation";
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";
import { assertAllowedStudentTable, listBatchesForDepartment, resolveTables } from "../utils/tableResolver";

const app = new Hono<{ Bindings: { DB: D1Database } }>();

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
* How many distinct student accounts are signed in right now.
 *
 * "Signed in" is decided by the session table alone -- the same definition
 * `resolveAuthUser` applies to every authenticated request -- and by nothing else:
 *
 *   1. the account holds at least one `auth_sessions` row whose `expires_at` is
 *      still in the future;
 *   2. the account's role is a student, so a staff, advisor, HOD, coordinator or
 *      admin session is never counted even though it sits in the same table.
 *
 * `student_activity` is deliberately not consulted. Recent activity used to be the
 * signal, and it made the number mean "touched the screen in the last minute" rather
 * than "is signed in": a student reading the OTP page without tapping dropped out,
 * and a phone left face-up on a desk dropped out with it. This counts sessions.
 *
 * Because the definition is the session and not the browser, an account leaves the
 * count exactly when it stops being signed in: logging out deletes that session row,
 * and an expired session is excluded by the `expires_at` comparison whether or not
 * the purging cron has got to it yet. Nothing else can end a session early, and
 * nothing here can extend one.
 *
 * `COUNT(DISTINCT ...)` is what makes this an account count rather than a device or
 * tab count: one student signed in on three phones is three rows in `auth_sessions`
 * and one number here.
 *
 * The query starts from `auth_sessions` rather than from the roster so the role join
 * and the expiry filter are done once, by index, rather than as a correlated probe
 * per student.
 *
 * The response is the number and a server timestamp. No name, register number, email,
 * internal id, token or per-student row leaves this handler.
 */
app.get("/active-students", requireAuth, requireStaff, async (c) => {
  try {
    const nowIso = new Date().toISOString();

    const row = await c.env.DB.prepare(
      `SELECT COUNT(DISTINCT s.auth_user_id) AS active_students
       FROM auth_sessions s
       JOIN auth_users au
         ON au.auth_user_id = s.auth_user_id
        AND LOWER(au.role) = 'student'
       WHERE s.expires_at > ?`
    )
      .bind(nowIso)
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
 * How many distinct student accounts are signed in to one class.
 *
 * The same session-based definition as the global route, narrowed by the class:
 * a student is counted when they hold an unexpired session *and* their roster row
 * sits in the selected department, year and section.
 *
 * ## The relationship this filters on
 *
 * There is exactly one link between an authenticated account and its roster row, and
 * it is `auth_user_id`:
 *
 *   auth_sessions.auth_user_id  ==  auth_users.auth_user_id  ==  <roster>.auth_user_id
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
 * The `EXISTS` on `auth_sessions` is what makes this a session count rather than a
 * session *row* count, so a student signed in on three phones is one number and not
 * three, and so logging out of one device does not remove them while another session
 * is live. `student_activity` is not read: no heartbeat, and no activity cutoff, has
 * any say in whether an account appears here.
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

    const nowIso = new Date().toISOString();

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
             SELECT 1 FROM auth_sessions s
             WHERE s.auth_user_id = st.auth_user_id
               AND s.expires_at > ?
           )
           AND EXISTS (
             SELECT 1 FROM auth_users au
             WHERE au.auth_user_id = st.auth_user_id AND LOWER(au.role) = 'student'
           )`
      );
      bindings.push(year, section, nowIso);
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
