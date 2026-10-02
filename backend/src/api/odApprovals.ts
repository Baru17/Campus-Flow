/**
 * The approver half of the OD workflow, mounted at `/api/od`.
 *
 * Every decision passes through `applyDecision`, which decides authority from the
 * request's own status and the approver's real position in the college. Nothing in this
 * file decides who may act -- it reads the session, reads the body, and hands
 * over. That is deliberate: authorisation spread across four route handlers is
 * authorisation that eventually disagrees with itself, and the thing it has to agree
 * with is a four-stage chain.
 *
 * ## One way to be an approver, one way to decide
 *
 * An approver's identity reaches `applyDecision` as an address, and the only thing that
 * supplies one is a signed-in session -- for a mentor, a class advisor, a Contest
 * Coordinator or an HOD, all four of whom are permanent authenticated users of the same
 * `auth_users` / `auth_sessions` architecture as a student or a lecturer.
 *
 * The address is a claim and is not trusted: `verifyApprover` checks it against the
 * directory for this request's department and stage on every decision.
 *
 * There used to be a second way in. An emailed approval link carried a signed,
 * time-limited bearer token for a Contest Coordinator or an HOD, on the grounds that they
 * had no account to sign in with. They do now, so the token, its 72-hour expiry, the
 * `GET /email-approval/:token` route it needed and the `?token=` branch of the decision
 * route are all gone. What that removes is the only path in the OD workflow that could
 * act *without* a session: an approver's mail is now a notification that names a dashboard,
 * and following it still requires signing in and being the right person for that
 * department.
 */

import { Hono, type Context } from "hono";
import { requireAuth, type AuthUser } from "../middleware/auth";
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";
import { resolveAppOrigin } from "../utils/appUrl";
import {
  applyDecision,
  listApprovedForStage,
  listRequestsForStage,
  toRequestView,
  verifyApprover,
  type OdWorkflowEnv,
} from "../utils/odService";
import { isApproverRole, resolveApproverIdentity } from "../utils/approverDirectory";
import { OD_DECISION, STAGES, type OdDecision, type OdStage } from "../utils/odWorkflow";

const app = new Hono<{ Bindings: { DB: D1Database } & OdWorkflowEnv }>();

/** A stage requested by the client, matched against the fixed chain. */
function stageFromKey(key: string | undefined): OdStage | null {
  const wanted = String(key ?? "").trim().toUpperCase();
  return STAGES.find((stage) => stage.key === wanted) ?? null;
}

/**
 * Puts the signed-in approver's own address on the context.
 *
 * `requireAuth` resolves the session from `auth_users` but its projection is the
 * identity columns only -- id, user name, role -- and deliberately not the email. Every
 * role in this workflow authorises by address, though: a coordinator is matched on
 * `contest_coordinators.email`, an HOD on `hods.email`, an advisor on `staff.email`, and
 * a mentor on the address snapshotted onto the request.
 *
 * So the address is read back from `auth_users` by the id the session already
 * established. One indexed lookup per request, and the value is the account's own --
 * there is no path by which a client can nominate a different approver.
 *
 * A no-op when there is no session, which is the emailed-approval path. That path takes
 * the approver's address from the token instead, and deliberately does not fall back to
 * whatever cookie happens to be present: a link and a signed-in coordinator are two
 * different authorisations, and mixing them would let a stale browser session act as an
 * approver the link was never issued to.
 *
 * Runs after `requireAuth`, which is what puts the user on the context it reads.
 */
async function withApproverEmail(c: Context<{ Bindings: { DB: D1Database } }>, next: () => Promise<void>): Promise<void> {
  const authUser = (c as any).get("authUser") as AuthUser | undefined;
  if (!authUser) {
    await next();
    return;
  }
  const row = await c.env.DB
    .prepare("SELECT email FROM auth_users WHERE auth_user_id = ?")
    .bind(authUser.auth_user_id)
    .first<{ email: string | null }>();
  (c as any).set("approverEmail", (row?.email ?? "").trim().toLowerCase());
  await next();
}

/** The approver's own address, lower-cased. Never taken from the request body. */
function approverEmail(c: any): string {
  return (((c as any).get("approverEmail") as string | undefined) ?? "").trim().toLowerCase();
}

/**
 * A class advisor is a staff member, so their cohort -- department, batch, year,
 * section -- comes from the advisor columns on their own `staff` row.
 *
 * This is the same mapping the attendance routes use, and it is read live rather than
 * from a request body, because an advisor's inbox is defined by the class they are
 * mapped to and a client cannot be allowed to widen it.
 */
async function advisorCohort(
  db: D1Database,
  authUserId: string
): Promise<{ department: string; batch: string; year: number; section: string } | null> {
  const row = await db
    .prepare(
      `SELECT department, advisor_batch, advisor_year, advisor_section
       FROM staff
       WHERE auth_user_id = ? AND class_advisor = 'Y'
         AND advisor_batch IS NOT NULL AND advisor_year IS NOT NULL AND advisor_section IS NOT NULL
       LIMIT 1`
    )
    .bind(authUserId)
    .first<{ department: string; advisor_batch: string; advisor_year: number; advisor_section: string }>();
  if (!row) return null;

  return {
    department: row.department,
    batch: row.advisor_batch,
    year: row.advisor_year,
    section: row.advisor_section,
  };
}

/* --------------------------------------------------------------- inbox */

/**
 * Requests waiting on one stage, for the signed-in approver, and the ones they have
 * already decided.
 *
 * `?stage=` names the role's place in the chain and is matched against `STAGES`, so an
 * unknown value is refused rather than treated as some default. A class advisor's list
 * is additionally narrowed to their own cohort on the server.
 *
 * `?view=` picks between the two lists and defaults to `pending`.
 *
 *   - `pending` -- what is waiting on this approver right now. Only ever requests whose
 *     status is this stage's pending status, because the stage's status is bound into the
 *     query; there is no status parameter to widen it.
 *   - `approved` -- what this approver has already signed off at their stage.
 *
 * The second exists because the two questions need different columns and the pending one
 * cannot answer the second. By the time an approver looks, the request has left their
 * pending queue -- `status` has moved past their stage — so the only record that they were
 * the one who approved it is their own `*_decided_by`, which is what the approved view
 * filters on. Filtering on `APPROVED` instead would show every request that reached the
 * end, including ones this approver refused and ones they never saw.
 *
 * Anything else is refused rather than defaulted, so a typo cannot silently show an
 * approver somebody else's list.
 */
app.get("/requests", requireAuth, withApproverEmail, async (c) => {
  try {
    const authUser = (c as any).get("authUser") as AuthUser;
    const stage = stageFromKey(c.req.query("stage"));
    if (!stage) {
      return c.json(
        { success: false, error: "Unknown approval stage", code: "od-unknown-stage" },
        400
      );
    }

    const requestedView = (c.req.query("view") ?? "pending").trim().toLowerCase();
    if (requestedView !== "pending" && requestedView !== "approved") {
      return c.json(
        { success: false, error: "Unknown approval view", code: "od-unknown-view" },
        400
      );
    }

    const email = approverEmail(c);
    const isAdvisor = stage.key === "CLASS_ADVISOR";

    /*
     * A class advisor is scoped by their cohort, which is a property of their own staff
     * row. Everyone else is scoped by the directory check inside the listing itself --
     * a mentor by the address on the request, a coordinator or an HOD by the department
     * on their directory row.
     */
    // Named `cohortScope` rather than `advisorCohort`, which would shadow the function
    // of the same name and make the call below unresolvable.
    let cohortScope: {
      department: string;
      batch: string;
      year: number;
      section: string;
    } | null = null;
    if (isAdvisor) {
      const cohort = await advisorCohort(c.env.DB, authUser.auth_user_id);
      if (!cohort) {
        return c.json(
          {
            success: false,
            error: "Your account is not mapped to a class. Ask your administrator to set your advisor class.",
            code: "advisor-unmapped",
          },
          403
        );
      }
      cohortScope = cohort;
    }

    const requests =
      requestedView === "approved"
        ? await listApprovedForStage(c.env.DB, stage, email, cohortScope)
        : await listRequestsForStage(c.env.DB, stage, email, cohortScope);

    return c.json({
      success: true,
      stage: stage.key,
      stage_label: stage.label,
      view: requestedView,
      requests,
    });
  } catch (error) {
    console.error("od_inbox_failed", getErrorMessageForLog(error));
    const transient = isTransientD1Error(error);
    return c.json(
      {
        success: false,
        error: transient ? "The service is temporarily busy. Please retry." : "Could not load approval requests",
        code: transient ? "database-busy" : "od-inbox-failed",
      },
      transient ? 503 : 500
    );
  }
});

/* ------------------------------------------------------------- decision */

/**
 * Records an approve or reject on one request.
 *
 * The body is exactly two fields: `decision` and an optional `comment`. There is no
 * field for the new status, for the approver, for the student, or for the stage's
 * outcome -- `applyDecision` derives all of those, because anything a client can send
 * is something a client can lie about. That includes the approver: the browser supplies
 * nothing about who is deciding, and `applyDecision` verifies the session's own address
 * against the directory for this request's department and stage.
 *
 * There is no alternative credential on this route. It used to accept `?token=`, an
 * emailed bearer link that let a Contest Coordinator or an HOD decide without a session.
 * Both are permanent authenticated users now, so the session *is* the credential and this
 * is `requireAuth` and nothing else. Removing that branch is what stops a forwarded mail
 * from ever being able to approve anything.
 *
 * The response reports `notification_sent` so the UI can say "saved, but the email
 * did not go" rather than pretending everything worked. The decision itself is stored
 * either way.
 */
app.post("/requests/:requestId/decision", requireAuth, withApproverEmail, async (c) => {
  try {
    const requestId = c.req.param("requestId") ?? "";
    if (!requestId) {
      return c.json({ success: false, error: "No OD request was named", code: "od-not-found" }, 404);
    }

    const stage = stageFromKey(c.req.query("stage"));
    if (!stage) {
      return c.json({ success: false, error: "Unknown approval stage", code: "od-unknown-stage" }, 400);
    }
    // The signed-in approver's own address, read from `auth_users` by the id the session
    // established. Never from the query string and never from the body.
    const identity = approverEmail(c);

    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ success: false, error: "Expected a JSON object", code: "invalid-body" }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ success: false, error: "Invalid JSON body", code: "invalid-json" }, 400);
    }

    const decision = String(body.decision ?? "").trim().toUpperCase();
    if (decision !== OD_DECISION.APPROVED && decision !== OD_DECISION.REJECTED) {
      return c.json(
        { success: false, error: "Decision must be APPROVED or REJECTED", code: "od-invalid-decision" },
        400
      );
    }

    const result = await applyDecision(
      c.env.DB,
      c.env,
      requestId,
      stage,
      decision as OdDecision,
      identity,
      body.comment,
      // Resolved through the shared allow-list, never from the browser, so the link in
      // the next approver's mail can only ever point at this application.
      resolveAppOrigin(c.req.header("Origin"))
    );

    if (!result.ok) {
      /*
       * Three different refusals, and they are not interchangeable:
       *
       *   - 403: the request is fine and this caller may not action it. Either they do
       *     not hold the role it is waiting on, or they are the role but for another
       *     department, batch or section. Both are a permission failure.
       *   - 400: the decision itself was malformed -- not APPROVED or REJECTED, or a
       *     rejection with no reason.
       *   - 409: the request is in a state that cannot be decided again. Already
       *     approved, already rejected, or moved on since it was loaded.
       *
       * Mapping them by code rather than by "it failed" is what lets a client tell
       * "you cannot do this" from "this is over" and react differently.
       */
      const FORBIDDEN = new Set([
        "od-not-your-request",
        "od-wrong-stage",
      ]);
      const BAD_REQUEST = new Set([
        "od-invalid-comment",
        "od-invalid-decision",
      ]);
      const NOT_FOUND = new Set(["od-not-found"]);

      // A literal union rather than `number`, because Hono types the status argument.
      let status: 400 | 403 | 404 | 409 = 409;
      if (FORBIDDEN.has(String(result.code))) status = 403;
      else if (BAD_REQUEST.has(String(result.code))) status = 400;
      else if (NOT_FOUND.has(String(result.code))) status = 404;

      return c.json({ success: false, error: result.reason, code: result.code }, status);
    }

    return c.json({
      success: true,
      request: result.request,
      status: result.status,
      next_stage: result.nextStage ?? null,
      notification_sent: result.notified,
      ...(result.notified
        ? {}
        : {
            warning:
              "Your decision was saved, but the notification email could not be sent.",
          }),
    });
  } catch (error) {
    console.error("od_decision_failed", getErrorMessageForLog(error));
    const transient = isTransientD1Error(error);
    return c.json(
      {
        success: false,
        error: transient ? "The service is temporarily busy. Please retry." : "Could not record that decision",
        code: transient ? "database-busy" : "od-decision-failed",
      },
      transient ? 503 : 500
    );
  }
});

/**
 * Whether the signed-in approver may action a given request, without acting on it.
 *
 * The approver screens call this to decide whether to show the Approve and Reject
 * buttons at all. It is a convenience, not the control: `applyDecision` runs the same
 * check again, so hiding a button is never what stops an unauthorised decision.
 */
app.get("/requests/:requestId/permission", requireAuth, withApproverEmail, async (c) => {
  try {
    const requestId = c.req.param("requestId");
    const stage = stageFromKey(c.req.query("stage"));
    if (!stage) {
      return c.json({ success: false, error: "Unknown approval stage", code: "od-unknown-stage" }, 400);
    }

    const row = await c.env.DB
      .prepare("SELECT * FROM od_requests WHERE od_request_id = ?")
      .bind(requestId)
      .first<Parameters<typeof verifyApprover>[1]>();
    if (!row) {
      return c.json({ success: false, error: "OD request not found", code: "od-not-found" }, 404);
    }

    const check = await verifyApprover(c.env.DB, row, stage, approverEmail(c));
    return c.json({
      success: true,
      can_act: check.ok,
      ...(check.ok ? {} : { reason: check.reason, code: check.code }),
    });
  } catch (error) {
    console.error("od_permission_failed", getErrorMessageForLog(error));
    return c.json(
      { success: false, error: "Could not check your permission", code: "od-permission-failed" },
      500
    );
  }
});

/**
 * Who the signed-in approver is, for the dashboard header.
 *
 * A mentor and a class advisor already have `/auth/staff/resolve` and the staff context,
 * so this exists for the two roles that do not: a Contest Coordinator and an HOD have no
 * staff record and no other screen that would tell the browser their name or department.
 * Their dashboard needs both to render anything like a header.
 *
 * Everything is read from the session's own account and the directory row that role is
 * defined by. Nothing is accepted from the client, so this cannot be used to ask about
 * somebody else's queue -- it only ever describes the caller.
 *
 * Resolution goes through `resolveApproverIdentity` rather than a role-to-table map, and
 * that is the point: a coordinator's account role is `staff` because they reuse their
 * staff login, so a map keyed on the role would describe them as a member of staff and
 * route them to the wrong dashboard. Directory membership is what decides, and it is the
 * same answer `/api/auth/od-approver/login` gives, so the two cannot disagree.
 *
 * Declining to include an approver whose directory row is missing is deliberate: there is
 * no department to scope to, and their queue would be empty anyway. Saying so plainly
 * beats a dashboard that loads and silently shows nothing.
 */
app.get("/approver/me", requireAuth, withApproverEmail, async (c) => {
  try {
    const authUser = (c as any).get("authUser") as AuthUser;

    // The account still has to be an approver account at all. Checked on the stored role
    // rather than on the resolved directory, so a student or an admin cannot read this
    // even if a directory row somehow carries their `auth_user_id`.
    if (!isApproverRole(authUser.role)) {
      return c.json({ success: false, error: "This account is not an OD approver", code: "od-not-an-approver" }, 403);
    }

    const identity = await resolveApproverIdentity(c.env.DB, authUser.auth_user_id);
    if (!identity) {
      return c.json(
        {
          success: false,
          error:
            "Your account is not linked to an approver record. Contact the administrator.",
          code: "unlinked-approver",
        },
        403
      );
    }

    return c.json({
      success: true,
      approver: {
        role: identity.role,
        name: identity.name,
        department: identity.department,
        email: approverEmail(c),
      },
    });
  } catch (error) {
    console.error("od_approver_me_failed", getErrorMessageForLog(error));
    return c.json(
      { success: false, error: "Could not load your approver profile", code: "od-approver-me-failed" },
      500
    );
  }
});

export default app;
