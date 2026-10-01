/**
 * The student's own OD and mentor routes, mounted at `/api/student`.
 *
 * Every route here is behind `requireAuth` + `requireStudent`, and none of them
 * accepts a student identity. The browser cannot say who it is: the student, their
 * department, their cohort, their year and section all come from the session's
 * `auth_user_id` resolved through `resolveAuthenticatedStudent`, which finds the row
 * in whichever physical table the registry says they belong to.
 *
 * That is the reason this file has no "student_id" parameter anywhere. The fields a
 * client *is* allowed to send are exactly three -- how many OD days they want, which
 * dates, and why -- and everything else in a response is a snapshot of what the
 * database already held.
 */

import { Hono } from "hono";
import { requireAuth, requireStudent, type AuthUser } from "../middleware/auth";
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";
import { resolveAppOrigin } from "../utils/appUrl";
import { resolveAuthenticatedStudent, type AuthenticatedStudent } from "../utils/studentIdentity";
import {
  OdConflictError,
  countApprovedOdDays,
  createOdRequest,
  findEligibleMentor,
  listEligibleMentors,
  listStudentOdRequests,
  notifyMentorOfAssignment,
  writeMentorEmail,
} from "../utils/odService";
import { todayIso, validateOdRequest } from "../utils/odValidation";

const app = new Hono<{ Bindings: { DB: D1Database; BREVO_API_KEY?: string } }>();

function fail(c: any, status: number, error: string, code: string, details?: unknown) {
  return c.json({ success: false, error, code, ...(details ? { details } : {}) }, status);
}

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
 * The student behind the session, or the reason there isn't one.
 *
 * Kept in one place because every route needs it and because the three outcomes are
 * genuinely different: no session at all (the middleware already answered 401), a
 * session that is not a student, and a student account whose cohort tables hold no
 * row for it. Only the last two deserve different wording, and neither is the
 * caller's fault.
 */
async function currentStudent(
  c: any
): Promise<{ student: AuthenticatedStudent } | { response: Response }> {
  const authUser = (c as any).get("authUser") as AuthUser;
  const student = await resolveAuthenticatedStudent(c.env.DB, authUser.auth_user_id);
  if (!student) {
    return {
      response: fail(
        c,
        403,
        "Your account is not linked to a student record. Contact the administrator.",
        "unlinked-student"
      ),
    };
  }
  return { student };
}

async function readBody(c: any): Promise<Record<string, unknown> | Response> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail(c, 400, "Expected a JSON object", "invalid-body");
    }
    return body as Record<string, unknown>;
  } catch {
    return fail(c, 400, "Invalid JSON body", "invalid-json");
  }
}

/* ---------------------------------------------------------------- whoami */

/**
 * Everything the student's own screens need about them, in one call.
 *
 * This is what removes the browser from the identity business: the entry screen, the
 * mentor page and the OD form all read this rather than assembling a student out of
 * dropdowns, so none of them can disagree with the database about which department
 * someone is in.
 *
 * `od_days_gained` is computed here rather than stored on the student, because it is
 * a function of the request history rather than a property of the student.
 */
app.get("/me", requireAuth, requireStudent, async (c) => {
  try {
    const current = await currentStudent(c);
    if ("response" in current) return current.response;
    const { student } = current;

    const odDaysGained = await countApprovedOdDays(c.env.DB, student);

    return c.json({
      success: true,
      student: {
        student_id: student.student.student_id,
        student_name: student.student.student_name,
        email: student.student.email,
        department: student.department,
        batch: student.batch,
        year: student.student.year,
        section: student.student.section,
        mentor_email: student.student.mentor_email,
      },
      od_days_gained: odDaysGained,
    });
  } catch (error) {
    return serverError(c, error, "Could not load your details", "student-me-failed");
  }
});

/* ----------------------------------------------------------------- mentor */

/**
 * Staff this student may choose as a mentor: their own department, and nothing else.
 *
 * The department comes from the resolved student, not from a query parameter, so a
 * student cannot widen the list by asking for another department's staff.
 *
 * The projection is an explicit column list. `pwd_hash` and `auth_user_id` are never
 * selected, so no future change to this route can start returning them.
 */
app.get("/mentors", requireAuth, requireStudent, async (c) => {
  try {
    const current = await currentStudent(c);
    if ("response" in current) return current.response;

    const mentors = await listEligibleMentors(c.env.DB, current.student);
    return c.json({
      success: true,
      department: current.student.department,
      mentors,
      current_mentor_email: current.student.student.mentor_email,
    });
  } catch (error) {
    return serverError(c, error, "Could not load mentors", "mentor-list-failed");
  }
});

/**
 * Allocates or replaces the student's mentor.
 *
 * Two rules are enforced here rather than in the browser:
 *
 *   - the mentor must exist **in the student's own department**, resolved by id, so
 *     neither a cross-department id nor an arbitrary address can be stored;
 *   - replacing an existing mentor needs `confirm_change`, so a silent overwrite is
 *     impossible. A student who already has a mentor and does not confirm gets a
 *     specific error rather than having it replaced.
 *
 * The stored value is the mentor's address *from the staff table*, never one from the
 * body, so the mentor who is notified is the mentor who exists.
 */
app.post("/mentor", requireAuth, requireStudent, async (c) => {
  try {
    const body = await readBody(c);
    if (body instanceof Response) return body;

    const current = await currentStudent(c);
    if ("response" in current) return current.response;
    const { student } = current;

    const staffId = typeof body.staff_id === "string" ? body.staff_id.trim() : "";
    if (!staffId) {
      return fail(c, 400, "Choose a mentor", "mentor-required");
    }

    const mentor = await findEligibleMentor(c.env.DB, student, staffId);
    if (!mentor) {
      /*
       * One message for "no such staff id" and "not in your department". Telling them
       * apart would let a student enumerate which staff ids exist elsewhere, which
       * is not information they need in order to pick their own mentor.
       */
      return fail(
        c,
        404,
        "That staff member is not available as a mentor. You can only choose a mentor from your own department.",
        "mentor-not-eligible"
      );
    }

    /*
     * A student cannot be their own mentor. Their email is the login handle on the
     * `staff` row when a student is also staff, and more practically a self-approval
     * would let a request skip its own first stage.
     */
    if (mentor.email.toLowerCase() === student.student.email.toLowerCase()) {
      return fail(c, 400, "You cannot choose yourself as your mentor.", "mentor-is-self");
    }

    const existing = (student.student.mentor_email ?? "").trim().toLowerCase();
    const confirmed = body.confirm_change === true || body.confirm_change === "true";
    if (existing && existing !== mentor.email.toLowerCase() && !confirmed) {
      return fail(
        c,
        409,
        "You already have a mentor. Confirm to change them.",
        "mentor-change-unconfirmed",
        { current_mentor_email: student.student.mentor_email }
      );
    }

    const stored = await writeMentorEmail(c.env.DB, student, mentor.email);
    if (!stored) {
      /*
       * The cohort's table has nowhere to record a mentor. Refused with an explanation
       * rather than a SQL error, because "ask your administrator" is actionable and
       * "unexpected server error" is not.
       */
      return fail(
        c,
        409,
        "Mentors cannot be recorded for your class yet. Please contact your administrator.",
        "mentor-unsupported-for-cohort"
      );
    }

    /*
     * The assignment is stored first. The mail is a courtesy on top of a fact that is
     * already true, so a provider failure must not undo it or fail the request -- the
     * student gets their mentor and a warning that the mentor has not been told yet.
     */
    const notified = await notifyMentorOfAssignment(
      c.env,
      {
        studentName: student.student.student_name,
        studentId: student.student.student_id,
        department: student.department,
        year: student.student.year,
        section: student.student.section,
      },
      mentor.email
    );

    return c.json({
      success: true,
      mentor: { staff_id: mentor.staff_id, staff_name: mentor.staff_name, email: mentor.email },
      mentor_email: mentor.email,
      changed: existing !== "" && existing !== mentor.email.toLowerCase(),
      notification_sent: notified,
      ...(notified
        ? {}
        : {
            warning:
              "Mentor assigned successfully, but the mentor notification could not be sent.",
          }),
    });
  } catch (error) {
    return serverError(c, error, "Could not assign that mentor", "mentor-assign-failed");
  }
});

/* --------------------------------------------------------------------- OD */

/**
 * Files an OD request.
 *
 * The body is validated, then everything identifying is taken from the session. The
 * submission date is the server's: a body that names one is ignored, because a date a
 * student chooses is a date they can back-date.
 */
app.post("/od", requireAuth, requireStudent, async (c) => {
  try {
    const body = await readBody(c);
    if (body instanceof Response) return body;

    const current = await currentStudent(c);
    if ("response" in current) return current.response;
    const { student } = current;

    const submittedDate = todayIso();
    const validated = validateOdRequest(body, submittedDate);
    if (!validated.ok) {
      return fail(c, 400, validated.errors[0].message, "od-validation-failed", {
        errors: validated.errors,
      });
    }

    try {
            const created = await createOdRequest(c.env.DB, c.env, student, resolveAppOrigin(c.req.header("Origin")), {
        ...validated.value,
        submittedDate,
      });
      return c.json({
        success: true,
        request: created.request,
        ...(created.notified ? {} : { warning: "Your request was submitted, but the mentor notification could not be sent." }),
      });
    } catch (error) {
      if (error instanceof OdConflictError) {
        return fail(c, 409, error.message, error.code);
      }
      throw error;
    }
  } catch (error) {
    return serverError(c, error, "Could not submit your OD request", "od-create-failed");
  }
});

/**
 * The student's own OD history, newest first.
 *
 * Scoped by cohort and student id, both derived here. The projection is the public
 * view from `toRequestView`, which drops `auth_user_id`, so nothing about the auth
 * internals reaches the student even though the row carries it.
 */
app.get("/od", requireAuth, requireStudent, async (c) => {
  try {
    const current = await currentStudent(c);
    if ("response" in current) return current.response;

    const requests = await listStudentOdRequests(c.env.DB, current.student);
    const odDaysGained = await countApprovedOdDays(c.env.DB, current.student);

    return c.json({ success: true, od_days_gained: odDaysGained, requests });
  } catch (error) {
    return serverError(c, error, "Could not load your OD requests", "od-list-failed");
  }
});

export default app;