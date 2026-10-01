import { useCallback, useEffect, useState } from 'react'
import StatusMessage from '../StatusMessage'
import { fetchPendingApprovals, submitApprovalDecision } from '../../api/odApi'
import { CheckIcon, ClockIcon, XIcon } from '../Icons'

/**
 * The OD requests waiting on one approver, with the two buttons.
 *
 * One component serves all four stages, and the only difference between a mentor's
 * section and an HOD's dashboard is the `stage` it is told it is -- the request's own
 * position in the chain. That is deliberate: the four approvers are deciding the same
 * kind of thing, so they should see the same shape of thing, and a change to how a
 * request is displayed should land in one file rather than four.
 *
 * ## Where it lives
 *
 * This is a *panel*, not a page. A mentor's lives inside the Staff Dashboard and a class
 * advisor's inside the Advisor Dashboard, because those people already have a dashboard
 * and an OD queue is one more thing on it. A Contest Coordinator and an HOD have no
 * dashboard anyone reaches from the normal role selection -- they exist to action OD
 * requests -- so for them it is the whole page.
 *
 * ## What the buttons are not
 *
 * Hiding Approve and Reject is a convenience, not a control. `submitApprovalDecision`
 * re-checks on the server that this address holds this stage of this request, so a
 * student, another mentor, a coordinator from another department or an advisor of a
 * different section is refused there exactly as they would be here. Nothing about
 * authorisation depends on this component rendering or not rendering a button.
 *
 * No email is sent from here. The decision is recorded by the Worker, which then sends
 * the student's notification and the next approver's request itself.
 */
export default function OdApprovalPanel({
  stage,
  title,
  subtitle,
  emptyText = 'Nothing is waiting on you. Requests appear here as soon as the previous stage approves them.',
}) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  // Which request the rejection dialog is open for, and what has been typed into it.
  const [rejecting, setRejecting] = useState(null)
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(null)
  const [decisionError, setDecisionError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchPendingApprovals(stage)
      setRequests(data.requests || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [stage])

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
              {loading ? 'Loading requests…' : subtitle || `${requests.length} waiting`}
            </p>
          </div>
        </div>

        {loading ? (
          <div className="cf-empty">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Loading requests…</p>
          </div>
        ) : requests.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">{emptyText}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {requests.map((request) => (
              <li key={request.od_request_id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-extrabold tracking-tight text-slate-900">
                      {request.student_name}
                    </h3>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {request.student_id} · {request.department} · {request.batch} · Year{' '}
                      {request.year} · Section {request.section}
                    </p>
                  </div>
                  <span className="cf-status-pill active">
                    <span className="dot" aria-hidden="true" />
                    {request.od_days_requested} day{request.od_days_requested === 1 ? '' : 's'}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      OD dates
                    </dt>
                    <dd className="mt-0.5 font-semibold text-slate-700">
                      {request.od_dates.join(', ')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Mentor
                    </dt>
                    <dd className="mt-0.5 text-slate-700">
                      {request.mentor_email || '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      OD already gained
                    </dt>
                    <dd className="mt-0.5 text-slate-700">
                      {request.od_days_gained_before} day
                      {request.od_days_gained_before === 1 ? '' : 's'} before this request
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Submitted
                    </dt>
                    <dd className="mt-0.5 text-slate-700">{request.submitted_date}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Reason
                    </dt>
                    <dd className="mt-0.5 text-slate-700">{request.reason}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Request ID
                    </dt>
                    <dd className="mt-0.5 font-mono text-xs text-slate-500">
                      {request.od_request_id}
                    </dd>
                  </div>
                </dl>

                {/* Which stages have already said yes, so an approver is not asked to
                    decide blind about a request three people have already seen. */}
                <ProgressTrail request={request} />

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

                {rejecting === request.od_request_id && (
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
                      The student is emailed this. A rejection stops the request here, so nothing
                      further is sent.
                    </p>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setRejecting(null)}
                        className="btn-cf-outline px-3 py-1.5 text-sm"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(request.od_request_id, 'REJECTED', reason)}
                        disabled={!reason.trim() || working === request.od_request_id}
                        className="btn-cf-primary inline-flex items-center gap-2 px-3 py-1.5 text-sm"
                      >
                        {working === request.od_request_id && (
                          <span className="cf-spinner" role="status" aria-hidden="true" />
                        )}
                        Confirm rejection
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 flex items-center gap-2 text-xs text-slate-400">
        <ClockIcon size={13} />
        Approving hands the request to the next stage. Rejecting stops it and emails the student.
      </p>
    </div>
  )
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
  { key: 'contest_coordinator', label: 'Coordinator', pending: 'PENDING_CONTEST_COORDINATOR' },
  { key: 'class_advisor', label: 'Class Advisor', pending: 'PENDING_CLASS_ADVISOR' },
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