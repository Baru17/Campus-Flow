/**
 * The OD workflow's domain logic.
 *
 * The routes in `api/studentOd.ts` and `api/odApprovals.ts` are thin: they read the
 * session, read a body, and call into here. Everything that has to be true for an
 * OD request to exist, to move, or to be seen by the right person is in this file,
 * so those rules cannot drift between the two entry points.
 *
 * The load-bearing idea is that **the request's own status is the authority**. Not
 * the caller's role, not a department in the body, not an id in the URL: which
 * approver may act is a function of which stage the request is waiting on, and that
 * is stored on the row. `verifyApprover` is the only place that decides, and
 * `applyDecision` will not move a request except through it.
 *
 * Three consequences worth stating, because they are what the tests pin:
 *
 *   - **A student cannot approve anything.** There is no route from a student session
 *     to `applyDecision`, and `verifyApprover` matches on the approver's own address
 *     against the directory rather than against a role the client could claim.
 *   - **A stage cannot be skipped or run twice.** `applyDecision` re-reads the status
 *     inside the same batch that writes the decision, so two concurrent approvals of
 *     the same request cannot both land.
 *   - **Nothing is derived from the client's identity.** The student, their
 *     department, their cohort, the mentor and the days already banked all come from
 *     the session and the database.
 */

import { sendBrevoEmail, type EmailBindings } from "./email";
import { appUrl } from "./appUrl";
import {
  odApprovalRequestEmail,
  odDecisionEmail,
  odMentorAssignedEmail,
  OD_APPROVED_HEADLINES,
  OD_FULLY_APPROVED_HEADLINE,
  OD_REJECTED_HEADLINE,
  type OdRequestFacts,
} from "./odEmail";
import {
  OD_DECISION,
  OD_STATUS,
  STAGES,
  checkTransition,
  decisionColumns,
  stageForStatus,
  statusAfterDecision,
  type OdDecision,
  type OdStage,
} from "./odWorkflow";
import { validateDecisionComment, validateRejectionReason } from "./odValidation";
import { assertAllowedStudentTable } from "./tableResolver";
import type { AuthenticatedStudent } from "./studentIdentity";

/** A row of `od_requests`, as the routes read it. */
export interface OdRequestRow {
  od_request_id: string;
  auth_user_id: string;
  student_table: string;
  student_id: string;
  student_name: string;
  student_email: string;
  department: string;
  batch: string;
  year: number;
  section: string;
  mentor_email: string | null;
  od_days_gained_before: number;
  submitted_date: string;
  od_days_requested: number;
  od_dates: string;
  reason: string;
  status: string;
  mentor_decision: string | null;
  mentor_decided_by: string | null;
  mentor_decided_at: string | null;
  mentor_comment: string | null;
  coordinator_decision: string | null;
  coordinator_decided_by: string | null;
  coordinator_decided_at: string | null;
  coordinator_comment: string | null;
  advisor_decision: string | null;
  advisor_decided_by: string | null;
  advisor_decided_at: string | null;
  advisor_comment: string | null;
  hod_decision: string | null;
  hod_decided_by: string | null;
  hod_decided_at: string | null;
  hod_comment: string | null;
  rejected_at_stage: string | null;
  rejection_reason: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string | null;
}

/** A public view of a request. Never carries `auth_user_id`. */
export interface OdRequestView {
  od_request_id: string;
  student_id: string;
  student_name: string;
  department: string;
  batch: string;
  year: number;
  section: string;
  mentor_email: string | null;
  submitted_date: string;
  od_days_requested: number;
  od_dates: string[];
  reason: string;
  status: string;
  od_days_gained_before: number;
  rejected_at_stage: string | null;
  rejection_reason: string | null;
  rejected_at: string | null;
  decisions: {
    mentor: DecisionView;
    contest_coordinator: DecisionView;
    class_advisor: DecisionView;
    hod: DecisionView;
  };
  created_at: string;
  updated_at: string | null;
}

export interface DecisionView {
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
}

const PENDING_STATUSES = STAGES.map((stage) => stage.status);

/** `od_dates` is stored as a JSON array; everything that reads it goes through here. */
export function parseOdDates(stored: string): string[] {
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The shape a route returns.
 *
 * `auth_user_id` is dropped here rather than at each call site, because it is the one
 * column that links to the auth internals and there is no reason for a browser to
 * ever see it. Everything in the view is either what the student typed, a snapshot of
 * their own record, or the public progress of their own request.
 */
export function toRequestView(row: OdRequestRow): OdRequestView {
  const decision = (
    decisionValue: string | null,
    by: string | null,
    at: string | null,
    comment: string | null
  ): DecisionView => ({ decision: decisionValue, decided_by: by, decided_at: at, comment });

  return {
    od_request_id: row.od_request_id,
    student_id: row.student_id,
    student_name: row.student_name,
    department: row.department,
    batch: row.batch,
    year: row.year,
    section: row.section,
    mentor_email: row.mentor_email,
    submitted_date: row.submitted_date,
    od_days_requested: row.od_days_requested,
    od_dates: parseOdDates(row.od_dates),
    reason: row.reason,
    status: row.status,
    od_days_gained_before: row.od_days_gained_before,
    rejected_at_stage: row.rejected_at_stage,
    rejection_reason: row.rejection_reason,
    rejected_at: row.rejected_at,
    decisions: {
      mentor: decision(row.mentor_decision, row.mentor_decided_by, row.mentor_decided_at, row.mentor_comment),
      contest_coordinator: decision(
        row.coordinator_decision,
        row.coordinator_decided_by,
        row.coordinator_decided_at,
        row.coordinator_comment
      ),
      class_advisor: decision(row.advisor_decision, row.advisor_decided_by, row.advisor_decided_at, row.advisor_comment),
      hod: decision(row.hod_decision, row.hod_decided_by, row.hod_decided_at, row.hod_comment),
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The details every OD email about this request carries. */
export function toEmailFacts(row: OdRequestRow): OdRequestFacts {
  return {
    odRequestId: row.od_request_id,
    studentName: row.student_name,
    studentId: row.student_id,
    department: row.department,
    year: row.year,
    section: row.section,
    odDates: parseOdDates(row.od_dates),
    odDays: row.od_days_requested,
    reason: row.reason,
  };
}

/**
 * OD days a student has already banked.
 *
 * Counts APPROVED requests only. A pending request is an intention and a rejected
 * one is a refusal, so counting either would let a student raise the figure the
 * moment they submitted, and would make it move under them as their own requests
 * came back.
 *
 * Summed from `od_days_requested` rather than the length of `od_dates`: the two are
 * validated to agree at submission, and the stored integer is what the student was
 * shown, so summing it keeps the number they see equal to the number staff see.
 */
export async function countApprovedOdDays(
  db: D1Database,
  student: AuthenticatedStudent
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(od_days_requested), 0) AS total
       FROM od_requests
       WHERE student_table = ? AND student_id = ? AND status = ?`
    )
    .bind(student.studentTable, student.student.student_id, OD_STATUS.APPROVED)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Staff the student may choose as a mentor: their own department, nobody else. */
export async function listEligibleMentors(
  db: D1Database,
  student: AuthenticatedStudent
): Promise<{ staff_id: string; staff_name: string; email: string; department: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT staff_id, staff_name, email, department
       FROM staff
       WHERE department = ?
       ORDER BY staff_name`
    )
    .bind(student.department)
    .all<{ staff_id: string; staff_name: string; email: string; department: string }>();
  return results ?? [];
}

/**
 * A staff member to assign, resolved by id inside the student's own department.
 *
 * Both conditions are in the query rather than checked after it: a row fetched by
 * id alone would tell an IT student whether that id exists in CSE, and the answer
 * they get back is "not eligible" either way. The department filter is the point --
 * a mentor is chosen from the student's own department and nowhere else.
 */
export async function findEligibleMentor(
  db: D1Database,
  student: AuthenticatedStudent,
  staffId: string
): Promise<{ staff_id: string; staff_name: string; email: string; department: string } | null> {
  const mentor = await db
    .prepare(
      `SELECT staff_id, staff_name, email, department
       FROM staff
       WHERE staff_id = ? AND department = ?
       LIMIT 1`
    )
    .bind(staffId, student.department)
    .first<{ staff_id: string; staff_name: string; email: string; department: string }>();
  return mentor ?? null;
}

/**
 * Writes `mentor_email` onto the student's own cohort table.
 *
 * The address comes from the `staff` row resolved by `findEligibleMentor`, never from
 * the request body, so a student cannot appoint a mentor at an address of their
 * choosing -- which would be both a way to divert someone else's mail and a way to
 * put an address they control into a staff member's name.
 *
 * Returns false when the cohort's table has no `mentor_email` column to write to. That
 * is a setup problem rather than a validation failure, and saying so is better than
 * letting the UPDATE fail with a SQL error the student would read as "try again".
 * `provisioning.ts` puts the column on every table it creates, so this only happens for
 * a cohort created some other way.
 */
export async function writeMentorEmail(
  db: D1Database,
  student: AuthenticatedStudent,
  mentorEmail: string
): Promise<boolean> {
  const studentTable = assertAllowedStudentTable(student.studentTable);
  const column = await db
    .prepare("SELECT name FROM pragma_table_info(?) WHERE name = ?")
    .bind(studentTable, "mentor_email")
    .first<{ name: string }>();
  if (!column) return false;

  await db
    .prepare(`UPDATE ${studentTable} SET mentor_email = ? WHERE student_id = ?`)
    .bind(mentorEmail, student.student.student_id)
    .run();
  return true;
}

export interface CreateOdResult {
  request: OdRequestView;
  /** False when the request was created but its notification did not go out. */
  notified: boolean;
}

/**
 * Files a new OD request at the first stage.
 *
 * Everything about the student is copied off their record at this moment, and
 * `mentor_email` is snapshotted from it, so the request stays attached to the mentor
 * who held it on the day even after the student changes mentor.
 *
 * A request is refused while the student already has one in flight. That is both a
 * duplicate guard and the more useful rule: a student with an approved request
 * outstanding should not be able to file a second one to be approved by a different
 * mentor, who has no context for it.
 *
 * The unique index in the migration is the second line of defence for the exact
 * double-click case; this check catches the broader one.
 */
export async function createOdRequest(
  db: D1Database,
  env: EmailBindings,
  student: AuthenticatedStudent,
  appOrigin: string,
  input: { od_days_requested: number; od_dates: string[]; reason: string; submittedDate: string }
): Promise<CreateOdResult> {
  const odRequestId = crypto.randomUUID();
  const odDaysGained = await countApprovedOdDays(db, student);
  const odDatesJson = JSON.stringify(input.od_dates);

  const inFlight = await db
    .prepare(
      `SELECT od_request_id, status FROM od_requests
       WHERE student_table = ? AND student_id = ? AND status IN (${PENDING_STATUSES.map(() => "?").join(",")})
       LIMIT 1`
    )
    .bind(student.studentTable, student.student.student_id, ...PENDING_STATUSES)
    .first<{ od_request_id: string; status: string }>();
  if (inFlight) {
    throw new OdConflictError(
      "You already have an OD request awaiting approval. Wait for it to be decided before submitting another.",
      "od-request-in-flight"
    );
  }

  await db
    .prepare(
      `INSERT INTO od_requests
         (od_request_id, auth_user_id, student_table, student_id, student_name, student_email,
          department, batch, year, section, mentor_email, od_days_gained_before,
          submitted_date, od_days_requested, od_dates, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      odRequestId,
      student.authUserId,
      student.studentTable,
      student.student.student_id,
      student.student.student_name,
      student.student.email,
      student.department,
      student.batch,
      student.student.year,
      student.student.section,
      // The snapshot. A later change of mentor must not rewrite this.
      student.student.mentor_email,
      odDaysGained,
      input.submittedDate,
      input.od_days_requested,
      odDatesJson,
      input.reason,
      OD_STATUS.PENDING_MENTOR
    )
    .run();

  const row = await loadRequest(db, odRequestId);
  if (!row) throw new OdConflictError("The OD request could not be read back.", "od-request-unreadable");

  const notified = await notifyMentorOfRequest(db, env, row, appOrigin);
  return { request: toRequestView(row), notified };
}

/** Raised for a refusal the caller should answer with a specific code. */
export class OdConflictError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "OdConflictError";
    this.code = code;
  }
}

async function loadRequest(db: D1Database, odRequestId: string): Promise<OdRequestRow | null> {
  return db
    .prepare("SELECT * FROM od_requests WHERE od_request_id = ?")
    .bind(odRequestId)
    .first<OdRequestRow>();
}

/** A student's own requests, newest first. Scoped by cohort *and* id. */
export async function listStudentOdRequests(
  db: D1Database,
  student: AuthenticatedStudent
): Promise<OdRequestView[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM od_requests
       WHERE student_table = ? AND student_id = ?
       ORDER BY created_at DESC`
    )
    .bind(student.studentTable, student.student.student_id)
    .all<OdRequestRow>();
  return (results ?? []).map(toRequestView);
}

export interface ApproverCheck {
  ok: boolean;
  /** Present when the check failed: why, and the code to answer with. */
  reason?: string;
  code?: string;
  /** The stage this request is waiting on, when one is. */
  stage?: OdStage;
  /** The approver's display name, when it is worth having. */
  approverName?: string | null;
}

/**
 * Whether this address may action this request, at the stage it is waiting on.
 *
 * Each role is checked against the directory that actually defines it, not against a
 * claim in the body:
 *
 *   - mentor: the address on the request. Nothing else grants it, so a staff member
 *     who happens to be in the right department cannot act unless the student chose
 *     them.
 *   - contest coordinator / HOD: a row in their own table for the request's
 *     department, so the coordinator for another department is refused.
 *   - class advisor: a `staff` row matching all four of department, batch, year and
 *     section. All four, because the attendance routes resolve on all four and an
 *     advisor of a different section must not see this student's request.
 *
 * A request with no mentor cannot be actioned by anyone: there is nobody to action
 * it, and letting the first signed-in person through would be worse than leaving it
 * stuck.
 */
export async function verifyApprover(
  db: D1Database,
  request: OdRequestRow,
  stage: OdStage,
  approverEmail: string
): Promise<ApproverCheck> {
  const email = approverEmail.trim().toLowerCase();
  if (!email) {
    return { ok: false, reason: "No approver identity was supplied.", code: "approver-unidentified" };
  }

  const transition = checkTransition(request.status, stage);
  if (!transition.allowed) {
    return { ok: false, reason: transition.reason, code: transition.code };
  }

  if (stage.key === "MENTOR") {
    const mentor = (request.mentor_email ?? "").trim().toLowerCase();
    if (!mentor) {
      return {
        ok: false,
        reason: "This request has no mentor, so nobody can action it. The student should allocate a mentor first.",
        code: "od-no-mentor",
      };
    }
    if (mentor !== email) {
      return { ok: false, reason: "Only this student's mentor may action this request.", code: "od-not-your-request" };
    }
    const name = await db
      .prepare("SELECT staff_name FROM staff WHERE LOWER(email) = ? LIMIT 1")
      .bind(email)
      .first<{ staff_name: string }>();
    return { ok: true, stage, approverName: name?.staff_name ?? null };
  }

  if (stage.key === "CLASS_ADVISOR") {
    const advisor = await db
      .prepare(
        `SELECT staff_name FROM staff
         WHERE LOWER(email) = ?
           AND department = ?
           AND advisor_batch = ?
           AND advisor_year = ?
           AND advisor_section = ?
           AND class_advisor = 'Y'
         LIMIT 1`
      )
      .bind(email, request.department, request.batch, request.year, request.section)
      .first<{ staff_name: string }>();
    if (!advisor) {
      return {
        ok: false,
        reason: "Only the Class Advisor mapped to this student's department, batch, year and section may action this request.",
        code: "od-not-your-request",
      };
    }
    return { ok: true, stage, approverName: advisor.staff_name };
  }

  const table = stage.table;
  const nameColumn = stage.nameColumn;
  if (!table || !nameColumn || stage.emailColumn !== "email") {
    return { ok: false, reason: "This approver role is not configured.", code: "od-role-unconfigured" };
  }

  // `table`, `nameColumn` and `email` come from the STAGES table above, never from a
  // request, so there is no client-controlled value interpolated into this statement.
  const row = await db
    .prepare(
      `SELECT ${nameColumn} AS approver_name FROM ${table}
       WHERE LOWER(email) = ? AND department = ?
       LIMIT 1`
    )
    .bind(email, request.department)
    .first<{ approver_name: string }>();
  if (!row) {
    return {
      ok: false,
      reason: `Only the ${stage.label} for this student's department may action this request.`,
      code: "od-not-your-request",
    };
  }
  return { ok: true, stage, approverName: row.approver_name };
}

/**
 * The approver holding the next stage, for an email notification.
 *
 * Returns null rather than throwing when the directory has nobody for the role: a
 * missing coordinator is an administrative gap, not a reason to lose the approval
 * that has just been recorded. The caller sends what it can and reports the rest.
 */
export async function findNextApprover(
  db: D1Database,
  request: OdRequestRow,
  nextStage: OdStage
): Promise<{ email: string; name: string | null } | null> {
  if (nextStage.key === "MENTOR") {
    const email = (request.mentor_email ?? "").trim().toLowerCase();
    if (!email) return null;
    const name = await db
      .prepare("SELECT staff_name FROM staff WHERE LOWER(email) = ? LIMIT 1")
      .bind(email)
      .first<{ staff_name: string }>();
    return { email, name: name?.staff_name ?? null };
  }

  if (nextStage.key === "CLASS_ADVISOR") {
    const row = await db
      .prepare(
        `SELECT email, staff_name FROM staff
         WHERE department = ? AND advisor_batch = ? AND advisor_year = ? AND advisor_section = ?
           AND class_advisor = 'Y'
         ORDER BY staff_id LIMIT 1`
      )
      .bind(request.department, request.batch, request.year, request.section)
      .first<{ email: string; staff_name: string }>();
    return row ? { email: row.email.toLowerCase(), name: row.staff_name } : null;
  }

  const table = nextStage.table;
  const nameColumn = nextStage.nameColumn;
  if (!table || !nameColumn) return null;
  const row = await db
    .prepare(
      `SELECT email, ${nameColumn} AS approver_name FROM ${table} WHERE department = ? ORDER BY ${nameColumn} LIMIT 1`
    )
    .bind(request.department)
    .first<{ email: string; approver_name: string }>();
  return row ? { email: row.email.toLowerCase(), name: row.approver_name } : null;
}

export interface DecisionResult {
  ok: boolean;
  /** The request after the decision, when one was recorded. */
  request?: OdRequestView;
  status?: string;
  code?: string;
  reason?: string;
  /** True when the decision was stored but its notification did not go out. */
  notified?: boolean;
  /** The stage the request is now waiting on, when it moved on. */
  nextStage?: string;
}

/**
 * Records an approver's decision and moves the request on.
 *
 * The write is a single conditional UPDATE: the status the decision is allowed from
 * appears in the WHERE clause, so two approvers deciding the same request at the same
 * moment produce one update and one refusal rather than two decisions. That is why the
 * status is re-checked here rather than trusted from the read the caller did.
 *
 * Email ordering is fixed and is a property of this function, not of its callers:
 *
 *   1. the decision is stored;
 *   2. the student is told the outcome;
 *   3. if it was an approval, the next approver is asked.
 *
 * A failure in any mail is swallowed after being logged. The decision stands: the
 * workflow state is the record, and an approver who was told "saved" must be able to
 * rely on it. The caller is told with `notified: false` so the UI can say so.
 */
export async function applyDecision(
  db: D1Database,
  env: EmailBindings,
  requestId: string,
  stage: OdStage,
  decision: OdDecision,
  approverEmail: string,
  commentInput: unknown,
  appOrigin: string
): Promise<DecisionResult> {
  const request = await loadRequest(db, requestId);
  if (!request) {
    return { ok: false, code: "od-not-found", reason: "OD request not found." };
  }

  const authority = await verifyApprover(db, request, stage, approverEmail);
  if (!authority.ok) {
    return { ok: false, code: authority.code, reason: authority.reason };
  }

  // A rejection must say why; an approval may carry a comment but need not.
  if (decision === OD_DECISION.REJECTED) {
    const reason = validateRejectionReason(commentInput);
    if (!reason.ok) {
      return { ok: false, code: "od-invalid-comment", reason: reason.errors[0].message };
    }
  }
  const comment = validateDecisionComment(commentInput);
  if (!comment.ok) {
    return { ok: false, code: "od-invalid-comment", reason: comment.errors[0].message };
  }

  const now = new Date().toISOString();
  const nextStatus = statusAfterDecision(stage, decision);
  const columns = decisionColumns(stage);
  const rejecting = decision === OD_DECISION.REJECTED;

  /*
   * The status the decision is allowed from is part of the WHERE clause. This is the
   * concurrency guard: if another approver already moved the request on, this
   * statement matches no rows and `changes` is 0, and the caller is told the request
   * has moved rather than being told its decision was recorded.
   */
  const result = await db
    .prepare(
      `UPDATE od_requests
       SET ${columns.decision} = ?,
           ${columns.decidedBy} = ?,
           ${columns.decidedAt} = ?,
           ${columns.comment} = ?,
           status = ?,
           rejected_at_stage = CASE WHEN ? THEN ? ELSE rejected_at_stage END,
           rejection_reason = CASE WHEN ? THEN ? ELSE rejection_reason END,
           rejected_at = CASE WHEN ? THEN ? ELSE rejected_at END,
           updated_at = ?
       WHERE od_request_id = ? AND status = ?`
    )
    .bind(
      decision,
      approverEmail.trim().toLowerCase(),
      now,
      comment.value || null,
      nextStatus,
      rejecting ? 1 : 0,
      rejecting ? stage.key : null,
      rejecting ? 1 : 0,
      rejecting ? comment.value : null,
      rejecting ? 1 : 0,
      rejecting ? now : null,
      now,
      requestId,
      stage.status
    )
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    const current = await loadRequest(db, requestId);
    return {
      ok: false,
      code: "od-stage-already-decided",
      reason: "This request has already moved on since it was loaded.",
      status: current?.status,
    };
  }

  const updated = await loadRequest(db, requestId);
  if (!updated) {
    return { ok: false, code: "od-request-unreadable", reason: "The OD request could not be read back." };
  }

  const facts = toEmailFacts(updated);
  let notified = true;

  // 2. The student hears the outcome, whatever it was.
  notified = (await safeSend(env, updated.student_email, odDecisionEmail(
    facts,
    rejecting ? OD_REJECTED_HEADLINE : headlineForStage(stage),
    rejecting
      ? `Your OD request has been rejected at the ${stage.label} stage.`
      : stage.key === "HOD"
        ? "Every stage has approved your on-duty request."
        : `Your OD request has moved on to the next stage of approval.`,
    comment.value || undefined
  ), { event: "od_decision_email_failed", odRequestId: requestId, stage: stage.key })) && notified;

  // 3. An approval hands the request to the next approver. A rejection stops here.
  let nextStageName: string | undefined;
  if (!rejecting) {
    const nextStage = stageForStatus(nextStatus);
    if (nextStage) {
      nextStageName = nextStage.label;
      const approver = await findNextApprover(db, updated, nextStage);
      if (approver) {
        notified = (await safeSend(env, approver.email, odApprovalRequestEmail(facts, nextStage.label, stageActionUrl(appOrigin, nextStage)), {
          event: "od_next_stage_email_failed",
          odRequestId: requestId,
          stage: nextStage.key,
        })) && notified;
      } else {
        // No one holds the next role for this department. Recorded, logged, and the
        // approval still stands -- an administrative gap is not a reason to discard a
        // decision that has already been made.
        console.error(
          JSON.stringify({ event: "od_next_approver_missing", odRequestId: requestId, stage: nextStage.key })
        );
      }
    }
  }

  return {
    ok: true,
    request: toRequestView(updated),
    status: updated.status,
    notified,
    nextStage: nextStageName,
  };
}

function headlineForStage(stage: OdStage): string {
  return stage.key === "HOD" ? OD_FULLY_APPROVED_HEADLINE : OD_APPROVED_HEADLINES[stage.key] ?? "Your OD request has been approved";
}

/**
 * Sends a message and reports whether it went, without ever throwing.
 *
 * A mail failure must never undo a decision that is already stored, so this catches
 * everything the provider can throw and returns false instead. The log records the
 * event and the request id and nothing else -- no recipient, no API key, no provider
 * message, since all three can carry something that should not be written down.
 */
async function safeSend(
  env: EmailBindings,
  to: string,
  message: { subject: string; html: string; text: string },
  context: Record<string, unknown>
): Promise<boolean> {
  if (!to) return false;
  try {
    await sendBrevoEmail(env, { to, subject: message.subject, html: message.html, text: message.text });
    return true;
  } catch {
    console.error(JSON.stringify({ ...context, outcome: "email_not_sent" }));
    return false;
  }
}

/**
 * Where each stage's approver reviews its requests.
 *
 * A mentor is staff and already has a dashboard; a class advisor already has another.
 * Neither has to be told where to go, so the link goes straight to the thing they use.
 *
 * A Contest Coordinator and an HOD have no dashboard anyone reaches from the normal role
 * selection -- deliberately, since they exist only to action OD requests -- so their link
 * goes to the approver sign-in page. Arriving there requires signing in, and the
 * backend then checks the role, the department and the stage before anything can be
 * decided.
 */
const STAGE_DASHBOARD_PATH: Record<string, string> = {
  MENTOR: "/staff",
  CLASS_ADVISOR: "/advisor",
  CONTEST_COORDINATOR: "/approver/login",
  HOD: "/approver/login",
};

/** The link an approver of `stage` should follow, on a given app origin. */
function stageActionUrl(appOrigin: string, stage: OdStage): string {
  return appUrl(appOrigin, STAGE_DASHBOARD_PATH[stage.key] ?? "/approver/login");
}
export async function notifyMentorOfAssignment(
  env: EmailBindings,
  facts: { studentName: string; studentId: string; department: string; year: number; section: string },
  mentorEmail: string
): Promise<boolean> {
  return safeSend(env, mentorEmail, odMentorAssignedEmail(facts), {
    event: "mentor_assignment_email_failed",
  });
}

/** Tells a mentor a request is waiting on them. Never fails the submission. */
export async function notifyMentorOfRequest(
  db: D1Database,
  env: EmailBindings,
  request: OdRequestRow,
  appOrigin: string
): Promise<boolean> {
  const mentor = (request.mentor_email ?? "").trim().toLowerCase();
  if (!mentor) return false;
  return safeSend(
    env,
    mentor,
    odApprovalRequestEmail(toEmailFacts(request), "Mentor", stageActionUrl(appOrigin, STAGES[0])),
    {
      event: "od_submission_email_failed",
      odRequestId: request.od_request_id,
    }
  );
}

/**
 * The requests waiting on one approver, for their queue.
 *
 * Each role is scoped differently, and all three scopes come from the database rather
 * than from anything the caller sent:
 *
 *   - **mentor**: the address snapshotted onto the request. Nobody else can see these,
 *     which is why this needs no department at all.
 *   - **class advisor**: the advisor's own cohort, all four parts, taken from their
 *     `staff` row by the route.
 *   - **contest coordinator / HOD**: their own row in their own directory table.
 *
 * That last one used to be read from a *student* scope, which a coordinator or an HOD
 * never has, so the department bound was the empty string and these two queues were
 * permanently empty -- an approver signed in, saw nothing, and had no way to tell that
 * from having no requests. It now resolves the approver's department from the row that
 * makes them that approver.
 *
 * A coordinator or HOD with no directory row gets an empty queue rather than an error:
 * there is nobody for the requests to belong to.
 */
export async function listRequestsForStage(
  db: D1Database,
  stage: OdStage,
  approverEmail: string,
  advisorCohort: {
    department: string;
    batch: string;
    year: number;
    section: string;
  } | null
): Promise<OdRequestView[]> {
  const email = approverEmail.trim().toLowerCase();

  let rows: OdRequestRow[];

  if (stage.key === "MENTOR") {
    ({ results: rows = [] } = await db
      .prepare(
        "SELECT * FROM od_requests WHERE status = ? AND LOWER(mentor_email) = ? ORDER BY created_at DESC"
      )
      .bind(stage.status, email)
      .all<OdRequestRow>());
    return (rows ?? []).map(toRequestView);
  }

  if (stage.key === "CLASS_ADVISOR") {
    if (!advisorCohort) return [];
    ({ results: rows = [] } = await db
      .prepare(
        `SELECT * FROM od_requests
         WHERE status = ?
           AND department = ? AND batch = ? AND year = ? AND section = ?
         ORDER BY created_at DESC`
      )
      .bind(stage.status, advisorCohort.department, advisorCohort.batch, advisorCohort.year, advisorCohort.section)
      .all<OdRequestRow>());
    return (rows ?? []).map(toRequestView);
  }

  const approver = await findDirectoryApprover(db, stage, email);
  if (!approver) return [];

  ({ results: rows = [] } = await db
    .prepare(
      "SELECT * FROM od_requests WHERE status = ? AND department = ? ORDER BY created_at DESC"
    )
    .bind(stage.status, approver.department)
    .all<OdRequestRow>());
  return (rows ?? []).map(toRequestView);
}

/**
 * The department an approver holds a role in, read from the directory that defines it.
 *
 * Returns null for the mentor, who is scoped by the request rather than by a directory,
 * and for a role with no directory row -- an account whose role was set but whose record
 * was never created holds nothing.
 */
async function findDirectoryApprover(
  db: D1Database,
  stage: OdStage,
  approverEmail: string
): Promise<{ department: string } | null> {
  if (!stage.table || stage.emailColumn !== "email") return null;

  // `table` and `email` are literals from `STAGES`, never from a request, so neither
  // is a value a client can influence.
  const row = await db
    .prepare(`SELECT department FROM ${stage.table} WHERE LOWER(email) = ? LIMIT 1`)
    .bind(approverEmail)
    .first<{ department: string }>();
  return row ? { department: row.department } : null;
}