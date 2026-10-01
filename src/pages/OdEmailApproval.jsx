import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import { fetchEmailApproval, submitApprovalDecision } from '../api/odApi'
import { CheckIcon, ClockIcon, CompassIcon, ShieldIcon, XIcon } from '../components/Icons'

/**
 * The page an OD approval email opens.
 *
 * ## Why this exists
 *
 * A Contest Coordinator and an HOD are reached by mail and nothing else. They have no
 * dashboard anybody reaches from the role selection, so before this page their approval
 * mail pointed at `/approver/login` and asked them for an email and a password they
 * generally did not have an account for. The request was sitting behind a login form that
 * was not really about them.
 *
 * This page is the whole of the destination instead. The link carries a single-use,
 * expiring token, the token identifies one request at one stage for one approver, and the
 * server checks all of that again before it will show anything. There is no email field
 * here and no password field, and there is no way to render one if there were.
 *
 * ## What this page is not allowed to decide
 *
 * Loading the page decides nothing. It is a `GET` that renders; the only thing that
 * records a verdict is the `POST` from the Approve or Reject button, and that re-verifies
 * the token, the request, the stage, the department and the approver server-side. A
 * forged front end that skipped straight to the POST would be refused in exactly the same
 * place, because none of the authority here comes from the browser.
 *
 * The one thing worth being careful about is the outcome: after a decision the token is
 * spent, so reloading this page shows the "invalid or has expired" card rather than the
 * request. That is deliberate and is the single-use guarantee made visible -- the page
 * never quietly offers a second Approve on a request that has already been decided.
 */

/** Read straight off the request, so these cannot drift from the state machine. */
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

export default function OdEmailApproval() {
  const { token } = useParams()

  const [approval, setApproval] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(false)
  const [decisionError, setDecisionError] = useState(null)
  const [outcome, setOutcome] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await fetchEmailApproval(token)
      setApproval(data)
    } catch (err) {
      // One message for every unusable link, because the server gives one for every one.
      setLoadError(err.message)
      setApproval(null)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const decide = async (decision) => {
    if (!approval) return
    setWorking(true)
    setDecisionError(null)
    try {
      const result = await submitApprovalDecision(
        approval.request.od_request_id,
        approval.stage,
        decision,
        decision === 'REJECTED' ? reason : '',
        token
      )
      setRejecting(false)
      setReason('')
      setOutcome({
        decision,
        warning: result.warning || null,
        nextStage: result.next_stage || null,
      })
    } catch (err) {
      setDecisionError(err)
      // A refusal that means the link is spent is not worth retrying from here.
      if (err?.code === 'od-invalid-approval-link') {
        setApproval(null)
        setLoadError(err.message)
      }
    } finally {
      setWorking(false)
    }
  }

  if (loading) {
    return (
      <Frame>
        <div className="page-enter flex min-h-[40vh] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Opening your approval link…</p>
          </div>
        </div>
      </Frame>
    )
  }

  if (loadError) {
    return (
      <Frame>
        <div className="page-enter grid grid-cols-12 justify-center">
          <div className="col-span-12 lg:col-span-7 xl:col-span-6">
            <div className="cf-card p-4 md:p-6">
              <div className="cf-card-header">
                <div>
                  <h2 className="section-title">This approval link cannot be used</h2>
                  <p className="text-muted-2 text-sm mb-0">{loadError}</p>
                </div>
                <span className="cf-icon-badge">
                  <ShieldIcon size={22} />
                </span>
              </div>
              <div className="mt-4 space-y-3 text-sm text-slate-600">
                <p>
                  An OD approval link works once, for one request, and only for a short time
                  after it is emailed. This one has either already been used, or has expired,
                  or was never valid.
                </p>
                <p>
                  If the request has not been decided yet, ask the student to have it
                  resubmitted, or ask whoever holds the next stage to re-send their approval
                  email for a fresh link.
                </p>
              </div>
            </div>
          </div>
        </div>
      </Frame>
    )
  }

  if (outcome) {
    return (
      <Frame>
        <div className="page-enter grid grid-cols-12 justify-center">
          <div className="col-span-12 lg:col-span-7 xl:col-span-6">
            <div className="cf-card p-4 md:p-6">
              <div className="cf-card-header">
                <div>
                  <h2 className="section-title">
                    {outcome.decision === 'APPROVED' ? 'Request approved' : 'Request rejected'}
                  </h2>
                  <p className="text-muted-2 text-sm mb-0">
                    {outcome.decision === 'APPROVED'
                      ? outcome.nextStage
                        ? `The request has moved on to the ${outcome.nextStage}.`
                        : 'The request is now fully approved.'
                      : 'The request has stopped and the student has been told why.'}
                  </p>
                </div>
                <span className="cf-icon-badge">
                  {outcome.decision === 'APPROVED' ? <CheckIcon size={22} /> : <XIcon size={22} />}
                </span>
              </div>

              {outcome.warning && (
                <div className="mt-4">
                  <StatusMessage variant="warning">{outcome.warning}</StatusMessage>
                </div>
              )}

              <p className="mt-4 text-xs text-slate-400">
                This link has now been used and will not work again. Close this page — there
                is nothing else to action here.
              </p>
            </div>
          </div>
        </div>
      </Frame>
    )
  }

  const { request, approver, stage_label: stageLabel } = approval

  return (
    <Frame>
      <div className="page-enter grid grid-cols-12 justify-center">
        <div className="col-span-12 lg:col-span-8 xl:col-span-7">
          <DashboardHero
            icon={<CompassIcon size={26} />}
            title="OD approval"
            subtitle={`You are approving as the ${stageLabel}.`}
          />

          {decisionError && (
            <div className="mt-4">
              <StatusMessage variant="danger">{decisionError.message}</StatusMessage>
            </div>
          )}

          <div className="cf-card mt-4 p-3 md:p-4">
            <div className="cf-card-header">
              <div>
                <h2 className="section-title">{request.student_name}</h2>
                <p className="text-muted-2 text-sm mb-0">
                  {STAGE_LABEL[request.status] || request.status}
                </p>
              </div>
              <span className="cf-status-pill active">
                <span className="dot" aria-hidden="true" />
                {request.od_days_requested} day{request.od_days_requested === 1 ? '' : 's'}
              </span>
            </div>

            <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <Detail label="Student name" value={request.student_name} />
              <Detail label="Student ID" value={request.student_id} />
              <Detail label="Department" value={request.department} />
              <Detail label="Batch" value={request.batch} />
              <Detail label="Year" value={request.year} />
              <Detail label="Section" value={request.section} />
              <Detail label="Mentor" value={request.mentor_email || 'Not assigned'} />
              <Detail label="Number of OD days" value={request.od_days_requested} />
              <Detail label="OD dates" value={request.od_dates.join(', ')} wide />
              <Detail label="Submitted" value={request.submitted_date} />
              <Detail label="Current stage" value={stageLabel} />
              <Detail label="Your name" value={approver.name || 'Approver'} />
              <Detail label="Your role" value={approver.role} />
              <Detail label="Reason" value={request.reason} wide />
              <Detail label="Request ID" value={request.od_request_id} mono wide />
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => decide('APPROVED')}
                disabled={working}
                className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                {working ? (
                  <span className="cf-spinner" role="status" aria-hidden="true" />
                ) : (
                  <CheckIcon size={16} />
                )}
                Approve
              </button>
              <button
                type="button"
                onClick={() => {
                  setRejecting(true)
                  setReason('')
                  setDecisionError(null)
                }}
                disabled={working}
                className="btn-cf-outline inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                <XIcon size={16} />
                Reject
              </button>
            </div>

            {rejecting && (
              <div
                className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm"
                role="alert"
              >
                <label htmlFor="od-email-rejection-reason" className="cf-form-label">
                  Reason for rejecting{' '}
                  <span className="text-red-500" aria-hidden="true">
                    *
                  </span>
                </label>
                <textarea
                  id="od-email-rejection-reason"
                  rows={2}
                  className="cf-input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Tell the student why this cannot be approved…"
                />
                <p className="mt-1 text-xs text-slate-600">
                  The student is emailed this reason. A rejection stops the request here, so
                  nothing further is sent.
                </p>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRejecting(false)}
                    className="btn-cf-outline px-3 py-1.5 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => decide('REJECTED')}
                    disabled={!reason.trim() || working}
                    className="btn-cf-primary inline-flex items-center gap-2 px-3 py-1.5 text-sm"
                  >
                    {working && <span className="cf-spinner" role="status" aria-hidden="true" />}
                    Confirm rejection
                  </button>
                </div>
              </div>
            )}
          </div>

          <p className="mt-3 flex items-start gap-2 text-xs text-slate-400">
            <ClockIcon size={13} className="mt-0.5 shrink-0" />
            This link approves this one request only, and stops working as soon as you
            approve or reject it.
          </p>
        </div>
      </div>
    </Frame>
  )
}

function Frame({ children }) {
  return (
    <div className="app-shell">
      <Navbar title="OD Approval" subtitle="Campus-Flow" />
      <main className="container-cf py-4 lg:py-5">{children}</main>
    </div>
  )
}

function Detail({ label, value, mono, wide }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className={`mt-0.5 ${mono ? 'font-mono text-xs' : ''} text-slate-700`}>{value}</dd>
    </div>
  )
}