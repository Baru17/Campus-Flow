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
 * ## Two ways to be an approver, one way to decide
 *
 * The approver's identity reaches `applyDecision` as an address, and there are two things
 * that can supply one:
 *
 *   - a signed-in session, for a mentor, a class advisor, a coordinator or an HOD who has
 *     signed in at `/approver/login` or through their own dashboard;
 *   - an emailed approval link, for a Contest Coordinator or an HOD acting on the request
 *     their mail names.
 *
 * Both are claims, and neither is trusted: `verifyApprover` checks the address against the
 * directory for this request's department and stage on every decision, whichever route
 * delivered it. The emailed link decides nothing the session route does not also decide --
 * it only removes the sign-in step in front of the same checks.
 *
 * ## Why there is no second decision endpoint
 *
 * `POST /requests/:requestId/decision` accepts the token as an alternative to the session,
 * rather than a `/email-approval/:token/decision` existing beside it. Two decision routes
 * would be two places to keep the validation in step, and the failure mode of them drifting
 * is an approval that one of them permits and the other does not.
 */

import { Hono, type Context } from "hono";
import { requireAuth, type AuthUser } from "../middleware/auth";
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";
import { resolveAppOrigin } from "../utils/appUrl";
import {
  applyDecision,
  findOdRequest,
  listApprovedForStage,
  listRequestsForStage,
  toRequestView,
  verifyApprover,
  type OdWorkflowEnv,
} from "../utils/odService";
import { verifyApprovalToken, type OdApprovalToken } from "../utils/odApprovalToken";
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

/* -------------------------------------------------- emailed approval link */

/**
 * The one message every unusable approval link gets.
 *
 * A token can be unusable for six different reasons -- forged, malformed, expired, already
 * spent, pointing at a request that has moved on, or naming an approver who is no longer
 * the right one for this department. They are deliberately indistinguishable. Telling
 * them apart would turn this endpoint into an oracle that reports how far into the chain a
 * request has got and whether a given approver is still in post, to anyone holding a
 * token, which is exactly the information a bearer credential must not leak.
 */
const INVALID_APPROVAL_LINK = "Approval link is invalid or has expired.";

function invalidApprovalLink(c: any) {
  return c.json({ success: false, error: INVALID_APPROVAL_LINK, code: "od-invalid-approval-link" }, 400);
}

/**
 * Reads an approval token off a request, without ever logging it.
 *
 * Only the query string is consulted. The token is the credential, so it is never read
 * from a header that a proxy or an access log would record differently from the path, and
 * never from the body.
 */
function readApprovalToken(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  // Bounds the work `verifyApprovalToken` has to do on hostile input.
  return trimmed.length > 4096 ? "" : trimmed;
}

/**
 * Resolves an emailed approval token to everything the approval page needs.
 *
 * Deliberately *not* authenticated: the token is the authorisation, and this is the route
 * that decides whether it is any good. It re-checks, independently of the signature:
 *
 *   - the signature, and the expiry, and the version -- `verifyApprovalToken`;
 *   - that the request still exists;
 *   - that the request is still waiting on exactly the stage the token names, which is
 *     what makes a spent link dead: after the decision the status has moved on;
 *   - that the named approver is still the directory holder for this request's department
 *     at that stage -- `verifyApprover`, the same call a decision goes through.
 *
 * Nothing about the database is returned beyond what an approver is entitled to see: the
 * request's public view (no `auth_user_id`, no student address), the approver's name, role
 * and department, and whether a decision is still possible. A password hash, a session
 * token, another student's data and the token itself are all absent, and there is no field
 * a client could use to make the next call do more than this one allowed.
 */
app.get("/email-approval/:token", async (c) => {
  const raw = readApprovalToken(c.req.param("token"));

  // An approval page holds a live credential in its URL. Nothing may cache it.
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");

  try {
    const resolved = await resolveApprovalToken(c.env, raw);
    if (!resolved) return invalidApprovalLink(c);

    const { token, request } = resolved;
    return c.json({
      success: true,
      // A lower-cased stage key, matching the `?stage=` the decision route takes, so the
      // page cannot accidentally be handed a stage from somewhere else.
      stage: token.stage.key.toLowerCase(),
      stage_label: token.stage.label,
      can_decide: true,
      expires_at: new Date(token.expiresAt).toISOString(),
      approver: {
        name: resolved.approverName,
        role: token.stage.label,
        department: request.department,
      },
      // The public view: the same shape every other OD screen renders, and the same one
      // `toRequestView` drops `auth_user_id` from.
      request: toRequestView(request),
    });
  } catch (error) {
    console.error("od_email_approval_resolve_failed", getErrorMessageForLog(error));
    const transient = isTransientD1Error(error);
    return c.json(
      {
        success: false,
        error: transient ? "The service is temporarily busy. Please retry." : INVALID_APPROVAL_LINK,
        code: transient ? "database-busy" : "od-email-approval-failed",
      },
      transient ? 503 : 400
    );
  }
});

interface ResolvedApproval {
  token: OdApprovalToken;
  request: Awaited<ReturnType<typeof findOdRequest>> & object;
  approverName: string | null;
}

/**
 * Turns a raw token into the request it names, or null.
 *
 * Null means "this link cannot be used" and covers every cause, for the reason given on
 * `INVALID_APPROVAL_LINK`. The check order is cheapest-first, and nothing here logs the
 * token or any part of it.
 */
async function resolveApprovalToken(
  env: { DB: D1Database } & OdWorkflowEnv,
  raw: string
): Promise<ResolvedApproval | null> {
  const token = await verifyApprovalToken(env, raw);
  if (!token) return null;

  const request = await findOdRequest(env.DB, token.odRequestId);
  if (!request) return null;

  /*
   * The stage check is what makes a link single-use. `checkTransition` refuses anything
   * terminal or waiting on a different stage, and `verifyApprover` refuses when the token's
   * approver is not the directory holder for this request's department -- so a link spent
   * on a decision, a link for a request that has since been decided by somebody else, and
   * a link whose approver has changed department all stop working here, with no separate
   * "used" flag to keep in step with the workflow.
   */
  const authority = await verifyApprover(env.DB, request, token.stage, token.approverEmail);
  if (!authority.ok) return null;

  return { token, request, approverName: authority.approverName ?? null };
}

/**
 * `requireAuth`, unless an approval token is being presented instead.
 *
 * This is what keeps the decision route singular. The middleware chain cannot be
 * conditional per-handler in Hono, so it is made conditional here: a request carrying a
 * non-empty `token` skips the session gate and is resolved by the handler, and everything
 * else must present a cookie as before. No session is weakened, because the token path
 * still ends in `applyDecision` and `verifyApprover`.
 */
async function sessionUnlessToken(
  c: Context<{ Bindings: { DB: D1Database } & OdWorkflowEnv }>,
  next: () => Promise<void>
): Promise<Response | void> {
  if (readApprovalToken(c.req.query("token"))) {
    await next();
    return;
  }
  return requireAuth(c, next);
}

/* ------------------------------------------------------------- decision */

/**
 * Records an approve or reject on one request.
 *
 * The body is exactly two fields: `decision` and an optional `comment`. There is no
 * field for the new status, for the approver, for the student, or for the stage's
 * outcome -- `applyDecision` derives all of those, because anything a client can send
 * is something a client can lie about. That includes the approver: an emailed link
 * supplies the address, and the browser supplies nothing about who is deciding.
 *
 * The response reports `notification_sent` so the UI can say "saved, but the email
 * did not go" rather than pretending everything worked. The decision itself is stored
 * either way.
 */
app.post("/requests/:requestId/decision", sessionUnlessToken, withApproverEmail, async (c) => {
  try {
    const requestId = c.req.param("requestId") ?? "";
    if (!requestId) {
      return c.json({ success: false, error: "No OD request was named", code: "od-not-found" }, 404);
    }

    const token = readApprovalToken(c.req.query("token"));

    let stage: OdStage | null;
    let identity: string;
    if (token) {
      /*
       * The token's own claims, re-verified here and not taken from the browser. Three
       * things must hold before this path continues:
       *
       *   - the link still works at all (`resolveApprovalToken`);
       *   - it is for *this* request. A coordinator's link replayed against somebody
       *     else's request is refused rather than quietly deciding the one it names;
       *   - if the caller also named a `stage`, it is the stage the token was issued for.
       *     The stage is taken from the token either way, so a mismatch cannot downgrade
       *     a coordinator's link into an HOD one -- the refusal exists to make the attempt
       *     visible, not to change the outcome.
       *
       * 403 rather than the link's own 400, because unlike a bare bad token the caller
       * here has presented a genuine credential and asked for something outside it.
       */
      const resolved = await resolveApprovalToken(c.env, token);
      if (!resolved) return invalidApprovalLink(c);

      if (resolved.token.odRequestId !== requestId) {
        return c.json(
          {
            success: false,
            error: "This approval link is for a different OD request.",
            code: "od-approval-link-mismatch",
          },
          403
        );
      }

      const claimed = stageFromKey(c.req.query("stage"));
      if (c.req.query("stage") && claimed && claimed.key !== resolved.token.stage.key) {
        return c.json(
          {
            success: false,
            error: "This approval link is not for that approval stage.",
            code: "od-approval-link-stage-mismatch",
          },
          403
        );
      }

      stage = resolved.token.stage;
      identity = resolved.token.approverEmail;
    } else {
      stage = stageFromKey(c.req.query("stage"));
      if (!stage) {
        return c.json({ success: false, error: "Unknown approval stage", code: "od-unknown-stage" }, 400);
      }
      identity = approverEmail(c);
    }

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
        "od-approval-link-mismatch",
        "od-approval-link-stage-mismatch",
      ]);
      const BAD_REQUEST = new Set([
        "od-invalid-comment",
        "od-invalid-decision",
        "od-invalid-approval-link",
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