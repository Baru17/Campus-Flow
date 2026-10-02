/**
 * The OD approval workflow: statuses, the fixed stage order, and the transitions.
 *
 * This module is the single place that knows what an OD request's status *means*.
 * The routes ask it two questions -- "may this approver act on this request?" and
 * "what happens next?" -- and neither of them is answered anywhere else. That is
 * deliberate: the workflow is a chain, and a rule that exists in two places is a
 * rule that eventually disagrees with itself.
 *
 * Two properties are load-bearing and are why the order is data rather than a
 * series of `if` statements in a handler:
 *
 *   1. **The order is fixed.** Mentor, then Contest Coordinator, then Class
 *      Advisor, then HOD. A stage cannot be skipped, run out of order, or run twice,
 *      because a stage is only reachable from the status the previous stage leaves
 *      behind. `STAGES` is therefore the definition of the chain and the route
 *      handlers walk it rather than naming the next status themselves.
 *   2. **A decision belongs to one stage.** Which status is waiting tells you which
 *      approver may act, so authority is a function of the request's own state
 *      rather than anything the caller sends. A student, or a mentor trying to
 *      answer a request that has already moved past them, is refused by the same
 *      lookup.
 *
 * Nothing here talks to the database or to a request object; it is pure rules, so
 * the tests can drive every transition without a database at all.
 */

/** Every status an OD request may hold. */
export const OD_STATUS = {
  PENDING_MENTOR: "PENDING_MENTOR",
  PENDING_CONTEST_COORDINATOR: "PENDING_CONTEST_COORDINATOR",
  PENDING_CLASS_ADVISOR: "PENDING_CLASS_ADVISOR",
  PENDING_HOD: "PENDING_HOD",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const;

export type OdStatus = (typeof OD_STATUS)[keyof typeof OD_STATUS];

export const OD_STATUSES: readonly OdStatus[] = Object.values(OD_STATUS);

/** A verdict an approver can record. */
export const OD_DECISION = { APPROVED: "APPROVED", REJECTED: "REJECTED" } as const;
export type OdDecision = (typeof OD_DECISION)[keyof typeof OD_DECISION];

export function isOdStatus(value: unknown): value is OdStatus {
  return typeof value === "string" && (OD_STATUSES as readonly string[]).includes(value);
}

/**
 * The four stages, in the order they must run.
 *
 * `status` is what a request holds while this stage is waiting, and `next` is what
 * it becomes once this stage approves. A stage is "current" for a request whose
 * status equals its `status`, which is the whole authorisation rule: a request can
 * only ever be waiting on one stage, and only that stage's approver may act.
 *
 * `table` and `emailColumn` say where this stage's approver is recorded, so the
 * routes can check an address against the right directory without a chain of
 * role-specific conditionals:
 *
 *   - mentor: no directory. The mentor is whichever staff member the student chose,
 *     so authority is the snapshot on the request and nothing else.
 *   - contest_coordinator / hod: one row per department in their own table.
 *   - class_advisor: a `staff` row with the advisor columns set, matched on all
 *     four of department, batch, year and section -- the mapping the attendance
 *     routes already use.
 */
export interface OdStage {
  /** Stable key, also the `rejected_at_stage` value. */
  key: string;
  /** Human label used in emails and in the UI. */
  label: string;
  /**
   * Prefix for this stage's four columns on `od_requests`.
   *
   * Not the same as `key`, and deliberately spelled out rather than derived: the
   * coordinator stage is keyed `CONTEST_COORDINATOR` but its columns are
   * `coordinator_*`. Deriving one from the other gave
   * `contest_coordinator_decision`, which does not exist -- a mismatch that would only
   * have surfaced as a SQL error on the first coordinator decision.
   */
  columnPrefix: string;
  /** The status a request holds while this stage is waiting. */
  status: OdStatus;
  /** The status this stage's approval moves the request to. */
  next: OdStatus;
  /** Directory the approver is found in, or null when the request names them. */
  table: "staff" | "contest_coordinators" | "hods" | null;
  /** Column holding the approver's address in that table. */
  emailColumn: string | null;
  /** Column holding the approver's display name in that table. */
  nameColumn: string | null;
}

export const STAGES: readonly OdStage[] = [
  {
    key: "MENTOR",
    label: "Mentor",
    columnPrefix: "mentor",
    status: OD_STATUS.PENDING_MENTOR,
    next: OD_STATUS.PENDING_CONTEST_COORDINATOR,
    table: null,
    emailColumn: null,
    nameColumn: null,
  },
  {
    key: "CONTEST_COORDINATOR",
    label: "Contest Coordinator",
    columnPrefix: "coordinator",
    status: OD_STATUS.PENDING_CONTEST_COORDINATOR,
    next: OD_STATUS.PENDING_CLASS_ADVISOR,
    table: "contest_coordinators",
    emailColumn: "email",
    nameColumn: "coordinator_name",
  },
  {
    key: "CLASS_ADVISOR",
    label: "Class Advisor",
    columnPrefix: "advisor",
    status: OD_STATUS.PENDING_CLASS_ADVISOR,
    next: OD_STATUS.PENDING_HOD,
    table: "staff",
    emailColumn: "email",
    nameColumn: "staff_name",
  },
  {
    key: "HOD",
    label: "HOD",
    columnPrefix: "hod",
    status: OD_STATUS.PENDING_HOD,
    next: OD_STATUS.APPROVED,
    table: "hods",
    emailColumn: "email",
    nameColumn: "hod_name",
  },
];

/** The stage a request in this status is waiting on, or null if it is terminal. */
export function stageForStatus(status: string): OdStage | null {
  return STAGES.find((stage) => stage.status === status) ?? null;
}

/**
 * The per-stage decision columns on `od_requests`.
 *
 * Derived from `STAGES` rather than written out, so a stage cannot exist in the
 * chain without somewhere to record its verdict. The key prefix is lower-cased,
 * which is why `MENTOR` maps to `mentor_decision`.
 */
export interface DecisionColumns {
  decision: string;
  decidedBy: string;
  decidedAt: string;
  comment: string;
}

export function decisionColumns(stage: OdStage): DecisionColumns {
  return {
    decision: `${stage.columnPrefix}_decision`,
    decidedBy: `${stage.columnPrefix}_decided_by`,
    decidedAt: `${stage.columnPrefix}_decided_at`,
    comment: `${stage.columnPrefix}_comment`,
  };
}

/** The decision columns, as a plain object for a SQL SET list. */
export type DecisionPatch = Record<string, string | number | null>;

export interface TransitionCheck {
  allowed: boolean;
  /** Set when `allowed` is false: why, and which code the route should answer with. */
  reason?: string;
  code?: string;
  /** The stage that may act on this request right now, when one exists. */
  stage?: OdStage;
}

/**
 * Whether `stage` may record a decision on a request currently in `status`.
 *
 * This is the only gate in front of every decision, and it answers two questions
 * with one lookup: is the request still open, and is this the stage it is waiting
 * on? Because the stage is derived from the status rather than passed in, a caller
 * cannot nominate a stage to act -- it can only be *the* stage the request names.
 *
 * The refusals are separated because they mean different things to the caller and
 * need different wording:
 *
 *   - a terminal request is a state conflict (409): it happened, and cannot be
 *     undone. Re-deciding an approved request is a bug or a replay.
 *   - the wrong stage is a permission failure (403): the request is live and this
 *     approver is simply not the one holding it up right now.
 */
export function checkTransition(status: string, stage: OdStage): TransitionCheck {
  if (!isOdStatus(status)) {
    return {
      allowed: false,
      reason: "This OD request has an unrecognised status.",
      code: "od-invalid-status",
    };
  }

  if (status === OD_STATUS.APPROVED) {
    return {
      allowed: false,
      reason: "This OD request has already been fully approved.",
      code: "od-already-approved",
    };
  }

  if (status === OD_STATUS.REJECTED) {
    return {
      allowed: false,
      reason: "This OD request was already rejected.",
      code: "od-already-rejected",
    };
  }

  if (status !== stage.status) {
    return {
      allowed: false,
      reason: `This OD request is not waiting on the ${stage.label} stage.`,
      code: "od-wrong-stage",
    };
  }

  return { allowed: true, stage };
}

/**
 * The status a request moves to when `stage` records `decision`.
 *
 * Approval walks the chain. Rejection always lands on REJECTED, from any stage,
 * because a rejection ends the workflow wherever it happens.
 */
export function statusAfterDecision(stage: OdStage, decision: OdDecision): OdStatus {
  return decision === OD_DECISION.REJECTED ? OD_STATUS.REJECTED : stage.next;
}

/**
 * OD days a student has banked.
 *
 * The rule that matters is which statuses count: only APPROVED. A pending request is
 * an intention and a rejected one is a refusal, so counting either would let a
 * student inflate the number the moment they submitted, and would make the figure
 * move under them as their own requests came back.
 *
 * `od_days_gained_before` on each request is what a submission is measured against,
 * so the total is computed once, by the same function, at submission time.
 */
export function isGainingStatus(status: string): boolean {
  return status === OD_STATUS.APPROVED;
}