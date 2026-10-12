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
 *   - `GET /active-students` returns one aggregate number and is gated on staff.
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
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";

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

export default app;
