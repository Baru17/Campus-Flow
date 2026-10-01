-- ============================================
-- OD requests: the student on-duty approval workflow
-- ============================================
--
-- NOT APPLIED TO PRODUCTION.
--
-- This file is the reviewed artefact for the OD feature and has deliberately not
-- been run against `campus-flow-db`. Applying it is a separate, explicit step for
-- a human to take after review; the integration suite applies it itself, into an
-- isolated local D1, so nothing here has ever touched a production table.
--
-- Why a new table rather than a column somewhere else
-- ============================================
--
-- An OD request is not a property of a student: it is an event with a lifecycle,
-- an ordered set of decisions by four different approvers, and a history that has
-- to stay readable after the student changes department, mentor, or mentor's mind.
-- The per-cohort student tables hold who a student *is*, and there is one per
-- (department, batch) pair, so an OD request stored there would be scattered across
-- whichever table happened to be current when it was filed. A single table keyed by
-- a request id is what makes "every request awaiting my approval" one query.
--
-- Everything identifying the student is SNAPSHOTED
-- ============================================
--
-- student_name, department, batch, year, section, mentor_email and
-- od_days_gained_before are copied at submission and never re-read. This is the
-- whole reason the table is denormalised:
--
--   * A student may change mentor later. A request filed under mentor A must keep
--     pointing at mentor A forever, or a mentor who already approved it would
--     appear to have approved nothing, and a request they never saw would appear
--     approved.
--   * A student may be promoted, change section, or sit a cohort that is later
--     edited. The approvers' decision has to stay attached to the facts they
--     actually saw.
--
-- student_table is recorded for the same reason: it names the physical table the
-- student was found in, which is how "my OD requests" is answered without
-- re-walking the registry. It is a snapshot for history, never an authority for
-- authorization -- authorization is re-derived from the live tables on every
-- decision.
--
-- Status
-- ============================================
--
-- One column, one of six values, enumerated in `odWorkflow.ts`. A request starts at
-- PENDING_MENTOR and advances to PENDING_CONTEST_COORDINATOR, then
-- PENDING_CLASS_ADVISOR, then PENDING_HOD, then APPROVED. Any rejection ends at
-- REJECTED. The order is fixed and enforced server-side; there is no path that
-- skips a stage, and no path out of APPROVED or REJECTED.
--
-- Decisions
-- ============================================
--
-- One column group per stage rather than a separate table, because the workflow has
-- exactly four fixed stages. Each group holds the verdict, who made it (by the
-- address they sign in with), when, and an optional comment. `*_decided_by` stores
-- an email because every one of these roles authenticates by address, and matching
-- it against the mentor snapshot is how the mentor's authority is checked.
--
-- Rejection
-- ============================================
--
-- rejected_at_stage says WHICH stage stopped the workflow, which is not
-- derivable from the decision columns alone once more than one of them is filled
-- in. rejection_reason and rejected_at complete it.
--
-- od_dates is a JSON array of `YYYY-MM-DD` strings
-- ============================================
--
-- D1 has no array type, and a join table would make "count the days on this
-- request" three queries. A JSON array keeps a request readable in one row and is
-- validated on the way in and out, so nothing depends on the client's ordering.
--

CREATE TABLE IF NOT EXISTS od_requests (
  -- Identity of the request itself.
  od_request_id TEXT PRIMARY KEY,

  -- The authenticated student, and their record as it stood at submission.
  auth_user_id TEXT NOT NULL,
  student_table TEXT NOT NULL,
  student_id TEXT NOT NULL,
  student_name TEXT NOT NULL,
  student_email TEXT NOT NULL,
  department TEXT NOT NULL,
  batch TEXT NOT NULL,
  year INTEGER NOT NULL,
  section TEXT NOT NULL,

  -- The mentor as they stood at submission. Never re-read; see the header.
  mentor_email TEXT,

  -- Approved OD days the student had already banked when this was filed, kept for
  -- audit so a later count cannot silently disagree with what the student was told.
  od_days_gained_before INTEGER NOT NULL DEFAULT 0,

  -- What was asked for.
  submitted_date TEXT NOT NULL,
  od_days_requested INTEGER NOT NULL,
  od_dates TEXT NOT NULL,
  reason TEXT NOT NULL,

  -- Where the request is.
  status TEXT NOT NULL,

  -- The four decisions. `*_decided_by` is the approver's sign-in address.
  mentor_decision TEXT,
  mentor_decided_by TEXT,
  mentor_decided_at TEXT,
  mentor_comment TEXT,

  coordinator_decision TEXT,
  coordinator_decided_by TEXT,
  coordinator_decided_at TEXT,
  coordinator_comment TEXT,

  advisor_decision TEXT,
  advisor_decided_by TEXT,
  advisor_decided_at TEXT,
  advisor_comment TEXT,

  hod_decision TEXT,
  hod_decided_by TEXT,
  hod_decided_at TEXT,
  hod_comment TEXT,

  -- Terminal rejection detail.
  rejected_at_stage TEXT,
  rejection_reason TEXT,
  rejected_at TEXT,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- "What is waiting for me?" is the query every approver screen makes, so it is
-- indexed rather than left as a full scan that grows with the archive.
CREATE INDEX IF NOT EXISTS idx_od_requests_status ON od_requests(status);

-- One student's own history. `student_table` is part of the key because a student
-- id is only unique within its cohort.
CREATE INDEX IF NOT EXISTS idx_od_requests_student
  ON od_requests(student_table, student_id);

-- The mentor's inbox: everything filed against one address. Partial on the mentor
-- column alone, since it is nullable and most rows that match are pending.
CREATE INDEX IF NOT EXISTS idx_od_requests_mentor ON od_requests(mentor_email);

-- Double-submit guard, at the database rather than in the browser.
--
-- A partial UNIQUE index over (student, cohort, exact set of dates) restricted to
-- the pending statuses. This is what makes a double-click or a network retry
-- harmless: the second INSERT hits the constraint and is refused, so there is never
-- a second identical request for the approvers to reconcile.
--
-- It is partial on purpose. Restricting it to `status LIKE 'PENDING_%'` means a
-- student whose request was rejected, or whose earlier one was approved, may file
-- for the same dates again -- which they are entitled to do. An unconditional unique
-- index would forbid that and quietly turn a legitimate second attempt into an error
-- the student cannot explain.
CREATE UNIQUE INDEX IF NOT EXISTS idx_od_requests_pending_unique
  ON od_requests(student_table, student_id, od_dates)
  WHERE status LIKE 'PENDING_%';