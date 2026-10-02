/*
 * The OD form's limits, mirrored from the server.
 *
 * `backend/src/utils/odValidation.ts` holds the rules that decide whether a request
 * exists. This file holds the two numbers the form needs to draw itself: the cap on
 * the day count and the floor on the reason length.
 *
 * They are duplicated rather than fetched, and deliberately. They are product
 * decisions -- a fortnight is the most OD a single request may claim, and a reason has
 * to be a sentence rather than a word -- so they do not change with the database. A
 * form that had to ask the server what its own limit was would render its "too many
 * days" message only after a failed submit, which is exactly the experience this is
 * meant to avoid.
 *
 * The duplication is safe in the one direction that matters: the server re-checks
 * both, so a stale value here produces a form that offers the wrong input and then
 * has its request refused. It cannot produce a request that violates a rule. The
 * `odValidation.spec.ts` unit suite asserts the two files agree, so drift fails the
 * build rather than being discovered by a student.
 */

/** The most OD days one request may claim. */
export const MAX_OD_DAYS = 15

/** The shortest a reason may be, in characters, once trimmed. */
export const MIN_REASON_LENGTH = 10

/**
 * The four workflow statuses a student might see as in-progress, plus the two
 * terminal ones. Only used to turn a status into words; the server owns the model.
 */
export const OD_STATUS_LABELS = {
  PENDING_MENTOR: 'Waiting for your mentor',
  PENDING_CONTEST_COORDINATOR: 'With the Contest Coordinator',
  PENDING_CLASS_ADVISOR: 'With your Class Advisor',
  PENDING_HOD: 'With the HOD',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
}