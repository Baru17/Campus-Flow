import { useCallback, useEffect, useMemo, useState } from 'react'
import StatusMessage from '../StatusMessage'
import { fetchApprovedApprovals, fetchPendingApprovals, submitApprovalDecision } from '../../api/odApi'
import { CheckIcon, ChevronRightIcon, ClockIcon, SearchIcon, XIcon } from '../Icons'

/**
 * The OD requests waiting on one approver, with the two buttons.
 *
 * One component serves all four stages, and the only difference between a mentor's
 * section and an HOD's dashboard is the `stage` it is told it is -- the request's own
 * position in the chain. That is deliberate: the four approvers are deciding the same
 * kind of thing, so they should see the same shape of thing, and a change to how a
 * request is displayed should land in one file rather than four.
 *
 * ## Pending or approved
 *
 * `view` picks which of the two questions this panel is answering, and it is the same
 * component either way so the two lists are the same shape:
 *
 *   - `pending` (the default) -- what is waiting on this approver now. Read-only for
 *     anything but the two buttons, and the buttons are a convenience: the server
 *     re-checks authority on every decision.
 *   - `approved` -- what this approver has already signed off at their stage. There are
 *     no buttons at all here, and that is not a permission decision. A decided stage
 *     cannot be decided twice -- `applyDecision` writes with
 *     `WHERE status = <the status this stage was waiting on>`, so a second attempt matches
 *     no rows -- so a button here could only ever produce an error.
 *
 * The two need different queries and cannot share one. `status` is a single column that
 * moves on the moment an approver acts, so their own approvals are already out of the
 * pending list by the time they look. The approved view filters on their own
 * `*_decided_by` instead, which is the only record of *who* decided.
 *
 * ## Where it lives
 *
 * This is a *panel*, not a page. A mentor's lives inside the Staff Dashboard and a class
 * advisor's inside the Advisor Dashboard, because those people already have a dashboard
 * and an OD queue is one more thing on it. A Contest Coordinator and an HOD have no
 * dashboard anyone reaches from the normal role selection -- they exist to action OD
 * requests -- so for them it is the whole page.
 *
 * ## Collapsed or open
 *
 * `collapsible` decides whether a request opens its own details. It defaults to false,
 * which leaves every existing caller rendering exactly what it rendered before -- a
 * mentor's list stays open, an HOD's stays open. The class advisor turns it on because
 * that dashboard is primarily an attendance report, and a queue of requests with a full
 * set of fields each would bury the thing the advisor actually opened the page for.
 *
 * The contest coordinator and the head of department turn it on for the same reason, and
 * one step further: a coordinator whose queue is twenty requests long should see twenty
 * one-line rows, not one screen of fields. Collapsed, a request is its summary line --
 * who, which cohort, and where it has got to -- and nothing else. Nothing is expanded by
 * default, including the newest one: which request an approver opens is their decision,
 * and auto-opening the first one would make "expanded" mean "first" rather than "chosen".
 *
 * ## Searching
 *
 * `searchable` adds a box that narrows the list already in memory. It is deliberately not
 * a query parameter: the list behind it is the whole of this approver's queue, correctly
 * scoped to their department on the server, so filtering it in the browser is a view of
 * data that has already arrived rather than a second, wider question asked of the
 * database. A search box that issued its own request would be a second way to ask for
 * records, and this feature does not need one.
 *
 * It is off for the mentor and the class advisor, whose cohorts are small enough to scan.
 *
 * Nothing about authority changes between the two. The buttons are a convenience either
 * way: `submitApprovalDecision` re-checks on the server that this address holds this
 * stage of this request, so a student, another mentor, a coordinator from another
 * department or an advisor of a different section is refused there exactly as they would
 * be here. Whether a button is drawn, drawn inside a collapsed row, or not drawn at all
 * makes no difference to that.
 *
 * No email is sent from here. The decision is recorded by the Worker, which then sends
 * the student's notification and the next approver's request itself.
 */
export default function OdApprovalPanel({
  stage,
  title,
  subtitle,
  emptyText = 'Nothing is waiting on you. Requests appear here as soon as the previous stage approves them.',
  noResultsText = 'No ODs found',
  noResultsHint = 'Try a different student name or ID.',
  collapsible = false,
  view = 'pending',
  searchable = false,
}) {
  const isApprovedView = view === 'approved'

  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [query, setQuery] = useState('')

  /*
   * The search box's text, and what the list therefore shows.
   *
   * Held here rather than lifted into whichever dashboard embeds this panel, because the
   * Pending and Approved lists are two separate instances of this component and a shared
   * value would carry one tab's search into the other. It also resets for free: switching
   * tabs swaps the instance, so the next list starts unsearched.
   *
   * The counts in the header follow `visible` rather than `requests`, so the number is
   * never describing a list that is not the one on screen. With no search typed the two
   * are the same array and nothing looks different.
   */
  const visible = useMemo(() => filterRequests(requests, query), [requests, query])

  // Which request's details are open, in collapsible mode.
  const [expanded, setExpanded] = useState(null)

  // Which request the rejection dialog is open for, and what has been typed into it.
  const [rejecting, setRejecting] = useState(null)
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(null)
  const [decisionError, setDecisionError] = useState(null)

  /*
   * A decision empties the queue, so anything the approver had narrowed it by is no
   * longer narrowing anything. Clearing the box stops a stale search from hiding the
   * request they have just decided.
   */
  useEffect(() => {
    setQuery('')
  }, [requests])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = isApprovedView
        ? await fetchApprovedApprovals(stage)
        : await fetchPendingApprovals(stage)
      setRequests(data.requests || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [stage, isApprovedView])

  useEffect(() => {
    load()
  }, [load])

  const decide = async (requestId, decision, comment) => {
    setWorking(requestId)
    setDecisionError(null)
    try {
      const result = await submitApprovalDecision(requestId, stage, decision, comment)
      setRejecting(null)
      setReason('')
      // The row is gone from this queue now that it has been decided, so there is
      // nothing left to leave open.
      setExpanded(null)
      await load()
      setNotice(
        result.warning
          ? `Your decision was saved. ${result.warning}`
          : decision === 'APPROVED'
            ? `Approved.${
                result.next_stage ? ` Moved on to the ${result.next_stage}.` : ' The request is fully approved.'
              }`
            : 'Rejected. The student has been notified and the request has stopped.'
      )
    } catch (err) {
      setDecisionError(err)
    } finally {
      setWorking(null)
    }
  }

  return (
    <div>
      {error && <StatusMessage variant="danger">{error}</StatusMessage>}

      {notice && (
        <StatusMessage variant="success" dismissible onDismiss={() => setNotice(null)}>
          {notice}
        </StatusMessage>
      )}

      {decisionError && <StatusMessage variant="danger">{decisionError.message}</StatusMessage>}

      <div className="cf-card p-3 md:p-4">
        <div className="cf-card-header">
          <div>
            <h2 className="section-title">{title}</h2>
            <p className="text-muted-2 text-sm mb-0">
              {loading
                ? 'Loading requests…'
                : subtitle ||
                  (isApprovedView
                    ? `${visible.length} approved`
                    : `${visible.length} waiting`)}
            </p>
          </div>
          {!loading && visible.length > 0 && (
            <span className={isApprovedView ? 'cf-status-pill' : 'cf-status-pill active'}>
              {isApprovedView ? null : <span className="dot" aria-hidden="true" />}
              {isApprovedView
                ? `${visible.length} approved`
                : `${visible.length} waiting`}
            </span>
          )}
        </div>

        {searchable && (
          /*
           * The same input group the admin lists use, at the same width, so a search box
           * looks like one everywhere in this product. Placed in the card rather than above
           * the tabs because it narrows what is below it and nothing else -- switching tabs
           * swaps this component, so a search never leaks from Pending into Approved.
           *
           * It is shown even with nothing in the list: an empty queue still answers "is
           * there anything here", and a box that appears only once there are records makes
           * the page look like it changed shape as data arrived.
           */
          <div className="cf-input-group-custom mt-3 w-full sm:max-w-[260px]">
            <span className="cf-input-icon" aria-hidden="true">
              <SearchIcon size={16} />
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search student name or ID…"
              className="cf-input pl-10"
              aria-label={`Search ${isApprovedView ? 'approved' : 'pending'} OD requests`}
            />
          </div>
        )}

        {loading ? (
          <div className="cf-empty">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Loading requests…</p>
          </div>
        ) : requests.length === 0 ? (
          /*
           * Nothing at all in this view. `emptyText` says what would bring one here, which
           * is the useful thing to say when the queue is genuinely empty.
           */
          <p className="mt-3 text-sm text-slate-500">{emptyText}</p>
        ) : visible.length === 0 ? (
          /*
           * There *are* requests here, the search just does not match any of them. That is a
           * different situation from an empty queue and gets its own words: telling someone
           * with twelve pending requests that "no requests are waiting on you" would be
           * telling them the opposite of the truth.
           */
          <div className="cf-empty mt-3">
            <span className="cf-empty-icon">
              <SearchIcon size={24} />
            </span>
            <p className="mt-2 text-sm font-semibold text-slate-700">{noResultsText}</p>
            <p className="mt-1 text-sm text-slate-500">{noResultsHint}</p>
            <button
              type="button"
              onClick={() => setQuery('')}
              className="btn-cf-outline mt-3 px-3 py-1.5 text-sm"
            >
              Clear search
            </button>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {visible.map((request) => {
              const open = !collapsible || expanded === request.od_request_id
              return (
                <li
                  key={request.od_request_id}
                  className="rounded-xl border border-slate-200 bg-white p-4"
                >
                  <RequestSummary
                    request={request}
                    collapsible={collapsible}
                    open={open}
                    onToggle={() =>
                      setExpanded(expanded === request.od_request_id ? null : request.od_request_id)
                    }
                  />

                  {open && (
                    <div className={collapsible ? 'od-expand' : undefined}>
                      <RequestDetails request={request} />

                      {/* Which stages have already said yes, so an approver is not asked to
                          decide blind about a request three people have already seen. */}
                      <ProgressTrail request={request} />

                      <DecisionStamp request={request} stage={stage} />

                      {/* No buttons in the approved view: this stage is already decided, and
                          the workflow refuses a second decision on it. */}
                      {!isApprovedView && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => decide(request.od_request_id, 'APPROVED', '')}
                            disabled={working === request.od_request_id}
                            className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
                          >
                            <CheckIcon size={16} />
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRejecting(request.od_request_id)
                              setReason('')
                              setDecisionError(null)
                            }}
                            disabled={working === request.od_request_id}
                            className="btn-cf-outline inline-flex items-center gap-2 px-4 py-2 text-sm"
                          >
                            <XIcon size={16} />
                            Reject
                          </button>
                        </div>
                      )}

                      {!isApprovedView && rejecting === request.od_request_id && (
                        <RejectForm
                          request={request}
                          reason={reason}
                          setReason={setReason}
                          onCancel={() => setRejecting(null)}
                          onConfirm={() => decide(request.od_request_id, 'REJECTED', reason)}
                          busy={working === request.od_request_id}
                        />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {!isApprovedView && (
        <p className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <ClockIcon size={13} />
          Approving hands the request to the next stage. Rejecting stops it and emails the
          student.
        </p>
      )}
    </div>
  )
}

/**
 * Narrows a list of requests to those matching what somebody typed.
 *
 * Frontend-only and deliberately so. The list handed in is already the whole of this
 * approver's queue, scoped to their department on the server, so this is a view of records
 * that have arrived rather than a second question put to the database. Nothing here can
 * widen what a coordinator or an HOD can see, because it can only remove rows from what
 * they were already sent.
 *
 * ## What is searchable, and what is not
 *
 * The fields below are the ones the OD response carries as plain scalars and that somebody
 * plausibly knows a request by: the student's name, their ID, and the cohort they are in.
 * The department is one of them on purpose -- "IT" is how a lot of people look for their
 * own queue -- even though the queue is already department-scoped, where searching it is
 * simply a no-op rather than a leak.
 *
 * Register number is absent, and not by choice: `od_requests` snapshots the student id,
 * name, department, batch, year and section, and the register number is not among them.
 * There is nothing to search. See the same note on `RequestDetails`.
 *
 * Empty means "everything", so clearing the box is the same as never having typed one.
 * Matching is case-insensitive and substring-based, which is what makes "barani" find
 * "BARANIDHARAN S" and "2k24it" find "2K24IT008" without anybody having to type the whole
 * identifier.
 */
function filterRequests(requests, query) {
  const needle = query.trim().toLowerCase()
  if (!needle) return requests

  const searchableOn = (request) =>
    [
      request.student_name,
      request.student_id,
      request.department,
      request.batch,
      request.year,
      request.section,
    ]

  return requests.filter((request) =>
    searchableOn(request).some((value) => String(value ?? '').toLowerCase().includes(needle))
  )
}

/**
 * This approver's own verdict on this request, when there is one.
 *
 * Read from the request's own decision column group for *this* stage rather than
 * recomputed, so it cannot disagree with the record. Rendered in both views because the
 * pending view is exactly where it is absent -- the request is in the queue precisely
 * because this stage has not decided yet -- and the approved view is exactly where it is
 * the thing worth showing.
 */
function DecisionStamp({ request, stage }) {
  const mine = (request.decisions || {})[stage.toLowerCase()]
  if (!mine?.decided_at) return null

  return (
    <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
      You approved this on {new Date(mine.decided_at).toLocaleString()}
      {mine.decided_by ? ` as ${mine.decided_by}` : ''}
      {mine.comment ? ` — “${mine.comment}”` : ''}
    </p>
  )
}

/*
 * One request's heading: who it is from, how long for, and whether it opens.
 *
 * Rendered as a real button when it is collapsible so the row is reachable by keyboard
 * and announces its state; a plain div when it is not, because a row that does nothing
 * when clicked should not be dressed up as something that does.
 */
function RequestSummary({ request, collapsible, open, onToggle }) {
  const inner = (
    <>
      <div className="min-w-0">
        <h3 className="font-extrabold tracking-tight text-slate-900">{request.student_name}</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          {request.student_id} · {request.department} · {request.batch} · Year {request.year} · Section{' '}
          {request.section}
        </p>
        <p className="mt-1 text-xs font-semibold text-blue-700">{STATUS_LABEL[request.status] || request.status}</p>
      </div>

      <span className="cf-status-pill active">
        <span className="dot" aria-hidden="true" />
        {request.od_days_requested} day{request.od_days_requested === 1 ? '' : 's'}
      </span>

      {collapsible && (
        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-slate-500">
          {open ? 'Hide details' : 'View details'}
          <ChevronRightIcon
            size={18}
            className={`text-slate-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
        </span>
      )}
    </>
  )

  const layout = 'flex w-full flex-wrap items-start justify-between gap-3 text-left'

  if (!collapsible) return <div className={layout}>{inner}</div>

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={`od-detail-${request.od_request_id}`}
      className={`${layout} rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
    >
      {inner}
    </button>
  )
}

/**
 * Everything the existing OD response knows about one request.
 *
 * Register number is deliberately absent. `od_requests` snapshots the student id, name,
 * department, batch, year and section, and the register number is not among them -- so
 * there is nothing to show, and inventing one or adding a column for it is out of scope.
 * The student's own dashboard reads the register number live from their student table,
 * but this list is a snapshot and cannot.
 */
function RequestDetails({ request }) {
  return (
    <dl
      id={`od-detail-${request.od_request_id}`}
      className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2"
    >
      <Detail label="Student name" value={request.student_name} />
      <Detail label="Student ID" value={request.student_id} />
      <Detail label="Department" value={request.department} />
      <Detail label="Batch" value={request.batch} />
      <Detail label="Year" value={request.year} />
      <Detail label="Section" value={request.section} />
      <Detail label="Mentor" value={request.mentor_email || 'Not assigned'} />
      <Detail label="Number of OD days" value={request.od_days_requested} />
      <Detail label="OD dates" value={request.od_dates.join(', ')} wide />
      <Detail label="OD already gained" value={`${request.od_days_gained_before} day(s) before this request`} />
      <Detail label="Submitted" value={request.submitted_date} />
      <Detail label="Current stage" value={STAGE_LABEL[request.status] || request.status} />
      <Detail label="Reason" value={request.reason} wide />
      <Detail label="Request ID" value={request.od_request_id} mono wide />

      {request.rejected_at_stage && (
        <Detail
          label="Rejected at"
          value={`${STAGE_LABEL[request.rejected_at_stage] || request.rejected_at_stage}${
            request.rejected_at ? ` on ${request.rejected_at}` : ''
          }`}
          tone="danger"
          wide
        />
      )}
      {request.rejection_reason && (
        <Detail label="Rejection reason" value={request.rejection_reason} tone="danger" wide />
      )}
    </dl>
  )
}

function Detail({ label, value, mono, wide, tone }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd
        className={`mt-0.5 ${mono ? 'font-mono text-xs' : ''} ${
          tone === 'danger' ? 'text-red-700' : 'text-slate-700'
        }`}
      >
        {value}
      </dd>
    </div>
  )
}

/**
 * The rejection dialog.
 *
 * A reason is required before it will send, because a bare "no" leaves a student with
 * nothing to act on. The button is disabled until there is text, and the server validates
 * it again -- this is a courtesy, not the control.
 */
function RejectForm({ request, reason, setReason, onCancel, onConfirm, busy }) {
  return (
    <div
      className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm"
      role="alert"
    >
      <label htmlFor={`od-reason-${request.od_request_id}`} className="cf-form-label">
        Reason for rejecting{' '}
        <span className="text-red-500" aria-hidden="true">
          *
        </span>
      </label>
      <textarea
        id={`od-reason-${request.od_request_id}`}
        rows={2}
        className="cf-input"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Tell the student why this cannot be approved…"
      />
      <p className="mt-1 text-xs text-slate-600">
        The student is emailed this. A rejection stops the request here, so nothing further is
        sent.
      </p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-cf-outline px-3 py-1.5 text-sm">
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!reason.trim() || busy}
          className="btn-cf-primary inline-flex items-center gap-2 px-3 py-1.5 text-sm"
        >
          {busy && <span className="cf-spinner" role="status" aria-hidden="true" />}
          Confirm rejection
        </button>
      </div>
    </div>
  )
}

/* Read straight off the request, so these labels cannot drift from the state machine. */
const STATUS_LABEL = {
  PENDING_MENTOR: 'Awaiting mentor approval',
  PENDING_CONTEST_COORDINATOR: 'Awaiting contest coordinator approval',
  PENDING_CLASS_ADVISOR: 'Awaiting class advisor approval',
  PENDING_HOD: 'Awaiting HOD approval',
  APPROVED: 'Fully approved',
  REJECTED: 'Rejected',
}

const STAGE_LABEL = {
  PENDING_MENTOR: 'Mentor',
  PENDING_CONTEST_COORDINATOR: 'Contest Coordinator',
  PENDING_CLASS_ADVISOR: 'Class Advisor',
  PENDING_HOD: 'Head of Department',
  MENTOR: 'Mentor',
  CONTEST_COORDINATOR: 'Contest Coordinator',
  CLASS_ADVISOR: 'Class Advisor',
  HOD: 'Head of Department',
}

/*
 * The four stages, with the ones already decided marked and the one waiting on this
 * approver marked as such.
 *
 * Read from the request's own `decisions`, so it cannot disagree with the state machine
 * -- it is showing what was recorded, not recomputing anything.
 */
const STAGE_ORDER = [
  { key: 'mentor', label: 'Mentor', pending: 'PENDING_MENTOR' },
  { key: 'class_advisor', label: 'Class Advisor', pending: 'PENDING_CLASS_ADVISOR' },
  { key: 'contest_coordinator', label: 'Coordinator', pending: 'PENDING_CONTEST_COORDINATOR' },
  { key: 'hod', label: 'HOD', pending: 'PENDING_HOD' },
]

function ProgressTrail({ request }) {
  const decisions = request.decisions || {}
  return (
    <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {STAGE_ORDER.map((stage, index) => {
        const decision = decisions[stage.key]?.decision
        const rejected = decision === 'REJECTED'
        const done = decision === 'APPROVED'
        // The status string is the source of truth for *where* the request is; the
        // per-stage decision columns are the source of truth for *what happened*.
        const waiting = request.status === stage.pending
        return (
          <li key={stage.key} className="flex items-center gap-2">
            {index > 0 && (
              <span className="text-slate-300" aria-hidden="true">
                →
              </span>
            )}
            <span
              className={`rounded-full border px-2 py-0.5 font-semibold ${
                rejected
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : done
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : waiting
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-slate-50 text-slate-400'
              }`}
            >
              {stage.label}
              {rejected ? ' · rejected' : done ? ' · approved' : waiting ? ' · waiting' : ''}
            </span>
          </li>
        )
      })}
    </ol>
  )
}