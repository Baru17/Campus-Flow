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
 *   - `GET /class-active-students` describes one class -- how many of its students are
 *     signed in, how many it has, and which of them are not -- and is gated on staff
 *     exactly as the global count is.
 *
 * ## The two count routes are not the same shape
 *
 * `GET /active-students` is a campus-wide number and stays one number. It is read by
 * nothing that needs a denominator and nothing that needs a name, and widening it
 * would put every student in the college behind one integer on the dashboard.
 *
 * The class route is the opposite: a staff member looking at IT Year 3 Section A is
 * being asked "who from this class is here", and an answer of "42" cannot be acted
 * on. It therefore returns the count, the denominator it is a fraction of, and the
 * roster of the remainder -- and the remainder is exactly the set of students whose
 * absence a staff member can do something about.
 *
 * ## What "active" means
 *
 * An account is counted when it holds a **valid, unexpired login session that was
 * created within the last five minutes**, and its roster row sits in the class being
 * asked about.
 *
 * Both halves matter, and neither is a substitute for the other:
 *
 *   - *Unexpired* is the session still being a session. A logout or a passed `expires_at`
 *     disqualifies it, and that is the same comparison `resolveAuthUser` makes on every
 *     authenticated request.
 *   - *Recently created* is what separates "signed in and here" from "signed in". Without
 *     it, a class whose students all signed in during last week's timetable reads as a
 *     full class on a dashboard whose entire job is to say who is in the room right now.
 *
 * The window is measured from `auth_sessions.created_at` -- the moment the session was
 * minted -- and never from `expires_at`, which only says how long the session will last.
 * A seven-day session created ten minutes ago is a real, valid session that every
 * protected route still honours; it simply is not a student who is here now.
 *
 * Logging in again mints a new row, so a student who signs back in becomes active again
 * immediately, without anything expiring.
 *
 * `student_activity` and its heartbeat are **not** read by either count. `POST /ping`
 * still writes that table and is still used by the client, but nothing in the counting
 * path depends on it, and no heartbeat -- recent, stale or absent -- can add an account
 * to or remove one from a count.
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
 * Nothing in this module can lengthen or shorten a session's life. Both count handlers
 * read `auth_sessions` and compare `expires_at` against the current time -- the same
 * comparison `resolveAuthUser` makes on every authenticated request -- and neither
 * writes to the table. The five-minute window is a filter over what is read; it does
 * not revoke anything, does not delete any row, and cannot end a session that the
 * authentication middleware would still accept.
 *
 * The heartbeat does not touch `auth_sessions` at all: it creates no session, extends
 * no expiry, and revokes nothing.
 *
 * An account leaves a count when its sessions stop qualifying -- because they were
 * logged out, because they expired, or because they aged past the window -- and
 * reappears when a fresh session is minted. No activity signal, and nothing in this
 * module, can end a real session early or keep one alive past its expiry.
 *
 * ## What leaves the class route, and what does not
 *
 * `GET /active-students` returns one integer and nothing else. The class route returns
 * names, so it is held to a narrower standard, and the projection is named column by
 * column for the same reason `studentIdentity.ts` names its own: so that a column
 * added to a roster table later cannot be picked up by a forgotten `SELECT *`.
 *
 * What it returns for a missing student is exactly `register_no` and `student_name`:
 * the two fields a staff member needs to recognise somebody across a room. What it
 * never returns is `email` (the login identifier, and not needed to recognise a face),
 * `auth_user_id` (an internal account key nothing in the dashboard acts on), the
 * numeric `id`, `created_at`, `mentor_email`, or `student_id`. A roster row is matched
 * by its account, and the account never travels with the answer.
 *
 * It is also the only place in the application where a student's name is returned to a
 * staff session in bulk, so it is worth being precise about who may ask. The gate is
 * the existing `requireStaff` -- staff and class advisor -- which is unchanged. A
 * student session, an admin session and an unauthenticated request are all refused,
 * exactly as they are for the global count.
 */

import { Hono } from "hono";
import { requireAuth, requireStaff, requireStudent, type AuthUser } from "../middleware/auth";
import { validateDepartment, validateSection, validateYear } from "../utils/adminValidation";
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";
import { assertAllowedStudentTable, listBatchesForDepartment, resolveTables } from "../utils/tableResolver";

const app = new Hono<{ Bindings: { DB: D1Database } }>();

/**
 * How many missing-student rows one response will carry.
 *
 * A section roster is tens of students, so this is a ceiling rather than a budget, and
 * it exists so that a class large enough to matter cannot turn a one-second poll into
 * an unbounded download. The count in the response is always the true one; only the
 * list is capped, and `missing_truncated` says so.
 */
const MISSING_STUDENT_LIMIT = 500;

/**
 * How recent a login session must be to make an account count as active.
 *
 * This is a *reporting* window and nothing else. It does not shorten, extend, refresh
 * or otherwise touch a session: a student who signed in an hour ago keeps a valid
 * seven-day session and every protected route treats them as signed in exactly as
 * before. What the window changes is only whether the staff dashboard counts them, and
 * it exists because "holds a session" and "is here" are different questions -- a class
 * of sixty students who all signed in last week is not a class of sixty students in the
 * room, and the dashboard is the thing answering the second question.
 *
 * Five minutes is chosen to be longer than a sign-in flow and shorter than a lesson
 * period, so a student who opened the app at the start of a class is still counted
 * while that class is being taken.
 */
const RECENT_SESSION_WINDOW_MINUTES = 5;

/*
 * The same window as a SQLite date modifier, so it is bound as a parameter rather than
 * pasted into the statement. Nothing from the request reaches this expression, but
 * keeping the number in exactly one place is what stops the two copies drifting.
 */
const RECENT_SESSION_WINDOW_MODIFIER = `-${RECENT_SESSION_WINDOW_MINUTES} minutes`;

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
 * "Signed in" is decided by the session table alone and by nothing else:
 *
 *   1. the account holds at least one `auth_sessions` row whose `expires_at` is still in
 *      the future;
 *   2. that session was created within the recent-session window, so an account that
 *      signed in last week is signed in, but is not "here now";
 *   3. the account's role is a student, so a staff, advisor, HOD, coordinator or admin
 *      session is never counted even though it sits in the same table.
 *
 * This is the same rule the class route applies, and it has to be. The two are read side
 * by side, and a campus-wide number and a per-class number that answered "who is here"
 * differently would leave the dashboard contradicting itself with no way for a reader to
 * tell which one to believe.
 *
 * `student_activity` is deliberately not consulted. Recent activity used to be the
 * signal, and it made the number mean "touched the screen in the last minute" rather
 * than "is signed in": a student reading the OTP page without tapping dropped out,
 * and a phone left face-up on a desk dropped out with it. This counts sessions.
 *
 * Because the definition is the session and not the browser, an account leaves the count
 * when its sessions stop qualifying -- logged out, expired, or aged past the window --
 * and an expired session is excluded by the `expires_at` comparison whether or not the
 * purging cron has got to it yet. Nothing here revokes anything and nothing here can
 * extend a session.
 *
 * `COUNT(DISTINCT ...)` is what makes this an account count rather than a device or
 * tab count: one student signed in on three phones is three rows in `auth_sessions`
 * and one number here.
 *
 * The query starts from `auth_sessions` rather than from the roster so the role join and
 * both session filters are done once, by index, rather than as a correlated probe per
 * student.
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
       WHERE s.expires_at > ?
         AND datetime(s.created_at) >= datetime('now', ?)`
    )
      .bind(nowIso, RECENT_SESSION_WINDOW_MODIFIER)
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
 * The live activity of one class: who is signed in, how many there are, and who is not.
 *
 * Three numbers' worth of answer from one request:
 *
 *   - `active_students`  -- distinct student accounts holding an unexpired session,
 *     whose roster row sits in the selected department, year and section;
 *   - `total_students`   -- every roster row in that class, signed in or not;
 *   - `missing`          -- the difference, as `{ register_no, student_name }`.
 *
 * `active_students` is the same session-based definition as the global route, narrowed
 * by the class. The active/total pair is what lets a staff member read the difference
 * between "the class is empty" and "the counter is broken", and `missing` is what turns
 * that difference into a name they can act on.
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
 * substituted for it anywhere below.
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
 * the branches are `UNION ALL`-ed into a single statement. That is what makes the
 * result a count of *accounts* across all of them: summing per-table counts would
 * double-count any account linked into two rosters, which should not happen but is
 * exactly the kind of thing a monitoring number must not quietly inflate.
 *
 * ## One statement answers all three questions
 *
 * The branch selects every roster row of the class once, tagged with whether it holds
 * a live session. The outer query then reads three different aggregates off that one
 * row set:
 *
 *   - `COUNT(DISTINCT CASE WHEN has_session AND is_student THEN auth_user_id END)` is
 *     the active count;
 *   - `COUNT(*)` is the total, because a roster row is a student whether or not they
 *     can currently sign in -- and because that is precisely why a student with no
 *     account must still be in the total even though they can never be in the count;
 *   - `SUM(CASE WHEN NOT has_session ...)` is the size of the missing list.
 *
 * Doing it in one pass matters more here than it did for the count alone: the three
 * figures have to agree with each other on screen, and three separate statements are
 * three separate moments in time at which the class was different.
 *
 * `student_activity` is not read: no heartbeat, and no activity cutoff, has any say in
 * whether an account appears here.
 *
 * ## The two timestamp columns are not in the same format
 *
 * `auth_sessions` holds two timestamps written by two different systems:
 *
 *   - `expires_at` is written by the Worker as `Date#toISOString()` -- `2026-10-13T16:00:00.000Z`,
 *     with a `T` and a `Z`, and compared as a bound parameter of the same shape;
 *   - `created_at` is **never written by any code at all**. Every insert in
 *     `auth.ts` names only `(token_hash, auth_user_id, expires_at)`, so the value is
 *     SQLite's `CURRENT_TIMESTAMP` default -- `2026-10-13 16:00:00`, space separated, no
 *     zone, second resolution, UTC.
 *
 * Those two forms do not order against each other as text. Comparing the stored
 * `created_at` to an ISO-8601 threshold as plain strings looks at the tenth character
 * and finds `' '` against `'T'`; `' '` sorts first, so **every** session -- including
 * one created a second ago -- sorts as older than any same-day ISO string and the count
 * is permanently zero. That is not a hypothetical: it is what a naive
 * `created_at >= ?` does here, and it fails silently rather than loudly.
 *
 * `datetime()` is what makes the comparison well defined. It parses both shapes --
 * space separated and `T`/`Z` separated, with or without fractional seconds -- and
 * returns a single normalised form, and `datetime('now', ...)` is UTC for the same
 * reason `CURRENT_TIMESTAMP` is, so the two sides of the comparison agree without
 * either being converted in JavaScript. A `NULL` or unparseable `created_at` becomes
 * `NULL`, which fails the comparison, so a malformed row disqualifies itself instead of
 * throwing or counting.
 *
 * ## The `is_class_student` test, and why it excludes non-students from the total
 *
 * A roster row is a member of this class when `auth_user_id IS NULL` -- a student
 * imported without an account is still a student of the class, and the staff member is
 * still waiting for them -- or when the account it points at has the `student` role.
 *
 * A row pointing at a *non*-student account is neither half of anything, and this is
 * the one case where the obvious definition of "total" is the wrong one. Counting it
 * would put a staff member's row in the denominator of a student class, and would
 * break the identity the card is built on: `active + missing` reconstructs `total`
 * exactly, for every class, at every poll. If a planted staff account could appear in
 * the total but in neither half, the arithmetic on screen would be quietly wrong, and a
 * roster row is the only place a staff account could be planted at all.
 *
 * The test is one definition applied in all three places, which is what makes the three
 * figures agree. Authorization is unchanged from the global route: same `requireStaff`,
 * so no role gains access it did not have.
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
     *
     * All three figures are returned in the same shape a populated class would use.
     * A client that read `missing.length` here would get a different answer depending
     * on the department, which is a bug waiting for the first cohort to be created.
     */
    if (studentTables.length === 0) {
      return c.json({
        success: true,
        active_students: 0,
        total_students: 0,
        missing: [],
        missing_truncated: false,
        updated_at: nowIso,
      });
    }

    const branches: string[] = [];
    const bindings: Array<string | number> = [];

    /*
     * One pass over the class, read three ways.
     *
     * The branch tags each roster row with `is_active`, which is the whole counting
     * rule in one expression: an unexpired session that was minted inside the recent
     * window. Both statements below read that same tag, which is what makes the count
     * and the list describe one class at one moment.
     */
    for (const studentTable of studentTables) {
      branches.push(
        `SELECT st.auth_user_id AS auth_user_id,
                st.register_no AS register_no,
                st.student_name AS student_name,
                CASE WHEN EXISTS (
                  SELECT 1 FROM auth_sessions s
                  WHERE s.auth_user_id = st.auth_user_id
                    AND s.expires_at > ?
                    AND datetime(s.created_at) >= datetime('now', ?)
                ) THEN 1 ELSE 0 END AS is_active,
                CASE WHEN st.auth_user_id IS NULL OR EXISTS (
                  SELECT 1 FROM auth_users au
                  WHERE au.auth_user_id = st.auth_user_id AND LOWER(au.role) = 'student'
                ) THEN 1 ELSE 0 END AS is_class_student
         FROM ${studentTable} st
         WHERE st.year = ? AND st.section = ?`
      );
      bindings.push(nowIso, RECENT_SESSION_WINDOW_MODIFIER, year, section);
    }

    /*
     * The class roster, read once, twice.
     *
     * Both statements are the same `UNION ALL` branch list and they are sent as one
     * `DB.batch()`, which D1 runs inside a single transaction. That is what makes the
     * "the figures agree" claim structural rather than hopeful: a student who signs in
     * between two separate awaits cannot appear as counted in `active_students` and
     * still be sitting in `missing`, because both statements read the same snapshot.
     *
     * One batch is also one round trip, which is what keeps a poll from costing two.
     *
     * `active_students` is a `COUNT(DISTINCT ...)` over `auth_user_id`, so an account
     * signed in on three phones is one number and not three, and three qualifying
     * sessions belonging to one student still add up to one student.
     *
     * `total_students` is a `SUM` over the class-student rows rather than `COUNT(*)`
     * over every row, which is the same `is_class_student` definition the list uses --
     * see the note on the route about why a row linked to a non-student account is in
     * neither half.
     *
     * The second `SUM` is the missing count, and the second statement materialises the
     * same rows: `active_students + missing_count` is `total_students` by construction,
     * and the rows in `missing` are exactly the rows that made up `missing_count`.
     *
     * No N+1: the roster is walked once per cohort inside a single statement, and the
     * session and role checks are `EXISTS` subqueries that resolve through
     * `idx_auth_sessions_auth_user_id` rather than a query per student.
     */
    const [summaryResult, missingResult] = await c.env.DB.batch([
      c.env.DB
        .prepare(
          `SELECT
             COUNT(DISTINCT CASE WHEN is_active = 1 AND is_class_student = 1 THEN auth_user_id END) AS active_students,
             SUM(CASE WHEN is_class_student = 1 THEN 1 ELSE 0 END) AS total_students,
             SUM(CASE WHEN is_active = 0 AND is_class_student = 1 THEN 1 ELSE 0 END) AS missing_count
           FROM (${branches.join(" UNION ALL ")})`
        )
        .bind(...bindings),
      c.env.DB
        .prepare(
          `SELECT register_no, student_name
           FROM (${branches.join(" UNION ALL ")}) AS class_rows
           WHERE is_active = 0 AND is_class_student = 1
           ORDER BY register_no
           LIMIT ${MISSING_STUDENT_LIMIT}`
        )
        .bind(...bindings),
    ]);

    const summary = summaryResult?.results?.[0] as
      | { active_students: number; total_students: number; missing_count: number | null }
      | undefined;

    const missingRows = (missingResult?.results ?? []) as { register_no: string; student_name: string }[];

    const activeStudents = Number(summary?.active_students ?? 0);
    const totalStudents = Number(summary?.total_students ?? 0);
    /*
     * `SUM` over no rows is NULL rather than 0, so the fallback is load-bearing: an
     * empty class must read as zero missing, never as a missing count of null.
     */
    const missingCount = Number(summary?.missing_count ?? 0);

    /*
     * The list is capped so a pathological class cannot make the dashboard download an
     * unbounded roster once a second. `register_no` is UNIQUE within a cohort table,
     * and the `ORDER BY` is stable, so truncating is a prefix of the same list rather
     * than an arbitrary sample -- the staff member sees the first N by register
     * number and is told the list is incomplete rather than left to assume it is whole.
     *
     * A real section is tens of students, so this is insurance and not a limit anyone
     * should meet. The count above is the true one either way, and it is the count the
     * UI shows.
     *
     * Both fields are copied out explicitly rather than spread, so a column added to a
     * roster table later cannot ride along into a staff-facing response.
     */
    const missing = missingRows.map((row) => ({
      register_no: row.register_no,
      student_name: row.student_name,
    }));

    return c.json({
      success: true,
      active_students: Number.isFinite(activeStudents) ? activeStudents : 0,
      total_students: Number.isFinite(totalStudents) ? totalStudents : 0,
      missing,
      missing_truncated: missingCount > missing.length,
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
