import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import { fetchPendingApprovals, submitApprovalDecision } from '../api/odApi'
import {
  CheckIcon,
  ClockIcon,
  XIcon,
} from '../components/Icons'

/*
 * The approver's queue: requests waiting on them, and the two buttons.
 *
 * One page serves all four stages. The only difference between a mentor's queue and an
 * HOD's is the `stage` this is told it is, which is the request's own position in the
 * chain -- so the screens cannot drift apart as the chain grows, and a mentor and an
 * HOD see the same shape of thing because they are deciding the same kind of thing.
 *
 * The buttons are a convenience, not the control. `canAct` comes from the server, but
 * so does the decision itself: `submitApprovalDecision` re-checks that this address
 * holds this stage of this request, and refuses a stage it should not. Hiding a button
 * is never what prevents an unauthorised approval.
 *
 * A rejection asks for a reason before it will send, because a bare "no" leaves a
 * student with nothing to act on. An approval does not: approving needs no
 * justification, and a comment box is there for one if the approver wants to add it.
 */

/** How this queue knows which stage of the chain it is looking at. */
const STAGE_LABELS = {
  MENTOR: 'Mentor',
  CONTEST_COORDINATOR: 'Contest Coordinator',
  CLASS_ADVISOR: 'Class Advisor',
  HOD: 'HOD',
}

export default function ApproverOdInbox({ stage }) {
  const navigate = useNavigate()

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
            ? `Approved. The request has moved on${
                result.next_stage ? ` to the ${result.next_stage}` : ''
              }.`
            : 'Rejected. The student has been notified and the request has stopped.'
      )
    } catch (err) {
      setDecisionError(err)
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="app-shell">
      <Navbar title="OD Approvals" subtitle="Campus-Flow" />
      <main className="container-cf py-4 lg:py-5">
        <button
          type="button"
          onClick={() => navigate('/role-selection')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          Back to role selection
        </button>

        <DashboardHero
          icon={<CheckIcon size={26} />}
          title={`${STAGE_LABELS[stage] || stage} approvals`}
          subtitle="Requests waiting on your decision, oldest first."
        />

        {error && <StatusMessage variant="danger">{error}</StatusMessage>}

        {notice && (
          <StatusMessage variant="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </StatusMessage>
        )}

        {decisionError && <StatusMessage variant="danger">{decisionError.message}</StatusMessage>}

        <div className="page-enter mt-4">
          <section className="cf-card p-3 md:p-4">
            <div className="cf-card-header">
              <div>
                <h2 className="section-title">Waiting on you</h2>
                <p className="text-muted-2 text-sm mb-0">
                  {loading
                    ? 'Loading requests…'
                    : `${requests.length} request${requests.length === 1 ? '' : 's'}`}
                </p>
              </div>
            </div>

            {loading ? (
              <div className="cf-empty">
                <span className="cf-spinner" role="status" aria-hidden="true" />
                <p className="text-sm text-slate-500">Loading requests…</p>
              </div>
            ) : requests.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                Nothing is waiting on you. Requests appear here as soon as the previous stage
                approves them.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {requests.map((request) => (
                  <li
                    key={request.od_request_id}
                    className="rounded-xl border border-slate-200 bg-white p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-extrabold tracking-tight text-slate-900">
                          {request.student_name}
                        </h3>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {request.student_id} · {request.department} · Year {request.year} ·
                          Section {request.section}
                        </p>
                      </div>
                      <span className="cf-status-pill active">
                        <span className="dot" aria-hidden="true" />
                        {request.od_days_requested} day
                        {request.od_days_requested === 1 ? '' : 's'}
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
                          Submitted
                        </dt>
                        <dd className="mt-0.5 text-slate-700">
                          {request.submitted_date}
                        </dd>
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
                        <label htmlFor={`reason-${request.od_request_id}`} className="cf-form-label">
                          Reason for rejecting{' '}
                          <span className="text-red-500" aria-hidden="true">
                            *
                          </span>
                        </label>
                        <textarea
                          id={`reason-${request.od_request_id}`}
                          rows={2}
                          className="cf-input"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Tell the student why this cannot be approved…"
                        />
                        <p className="mt-1 text-xs text-slate-600">
                          The student is emailed this. A rejection stops the request here, so
                          nothing further is sent.
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
          </section>

          <p className="mt-3 flex items-center gap-2 text-xs text-slate-400">
            <ClockIcon size={13} />
            Approving hands the request to the next stage. Rejecting stops it and emails the
            student.
          </p>
        </div>
      </main>
    </div>
  )
}
