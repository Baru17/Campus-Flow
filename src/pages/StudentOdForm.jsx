import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import { fetchMyOdRequests, fetchStudentMe, submitOdRequest } from '../api/odApi'
import { useAuth } from '../hooks/useAuth'
import { MAX_OD_DAYS, MIN_REASON_LENGTH } from '../utils/odValidation'
import {
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ClockIcon,
  InfoIcon,
  SparklesIcon,
} from '../components/Icons'

/*
 * The OD request form, and the student's own request history beneath it.
 *
 * Five of the ten fields on the paper form are not inputs here, and that is the whole
 * design. The date, the name, the department, the year, the section and the number of
 * OD days already gained are read from the server and shown read-only, because they are
 * either facts about the request (`date`) or facts about the student (`the rest`). A
 * field a student can edit is a field a student can be wrong about, and the OD days
 * already banked is the one that feeds the people deciding the request.
 *
 * What the student does supply is three things: how many days they want, which dates,
 * and why. Those are the only three sent.
 *
 * Validation runs here *and* on the server. That is not belt and braces for its own
 * sake: the browser's copy is what decides whether the button is live, and the
 * server's is what decides whether the request exists. A form that disabled Submit on
 * a good-looking value and let the server refuse the rest would be a worse experience,
 * and a form that trusted the browser would be a security hole.
 *
 * The date count is validated against the day count as the student types, because those
 * are two separate inputs and the mismatch is the mistake people actually make.
 */

/** `YYYY-MM-DD`, today, in the browser's own timezone. */
function today() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

/** The status a student sees, which is the workflow's status spelled out. */
const STATUS_COPY = {
  PENDING_MENTOR: 'Waiting for your mentor',
  PENDING_CONTEST_COORDINATOR: 'With the Contest Coordinator',
  PENDING_CLASS_ADVISOR: 'With your Class Advisor',
  PENDING_HOD: 'With the HOD',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
}

export default function StudentOdForm() {
  const navigate = useNavigate()
  const { logout } = useAuth()

  const [me, setMe] = useState(null)
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [days, setDays] = useState('')
  const [dates, setDates] = useState([])
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [meData, history] = await Promise.all([fetchStudentMe(), fetchMyOdRequests()])
      setMe(meData)
      setRequests(history.requests || [])
    } catch (err) {
      setLoadError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const student = me?.student
  const hasMentor = Boolean(student?.mentor_email)
  const submissionDate = today()

  /*
   * The day count is parsed rather than compared as a string, so "2.5", "-1", "0" and
   * "abc" are all rejected here rather than making a round trip to be rejected there.
   */
  const daysNumber = useMemo(() => {
    const trimmed = String(days).trim()
    if (!trimmed) return null
    if (!/^\d+$/.test(trimmed)) return NaN
    return Number(trimmed)
  }, [days])

  const validation = useMemo(() => {
    const errors = {}
    let valid = true

    if (days.trim() === '') {
      errors.od_days_requested = 'Enter how many OD days you need'
      valid = false
    } else if (Number.isNaN(daysNumber)) {
      errors.od_days_requested = 'Enter a whole number, with no decimal point or sign'
      valid = false
    } else if (daysNumber <= 0) {
      errors.od_days_requested = 'Enter a number greater than 0'
      valid = false
    } else if (daysNumber > MAX_OD_DAYS) {
      errors.od_days_requested = `Enter ${MAX_OD_DAYS} or fewer`
      valid = false
    }

    if (dates.length === 0) {
      errors.od_dates = 'Select at least one OD date'
      valid = false
    } else if (Number.isFinite(daysNumber) && daysNumber > 0 && dates.length !== daysNumber) {
      errors.od_dates = `You asked for ${daysNumber} OD ${
        daysNumber === 1 ? 'day' : 'days'
      } but selected ${dates.length} ${dates.length === 1 ? 'date' : 'dates'}`
      valid = false
    }

    const trimmedReason = reason.trim()
    if (!trimmedReason) {
      errors.reason = 'Give a reason for the OD'
      valid = false
    } else if (trimmedReason.length < MIN_REASON_LENGTH) {
      errors.reason = `Give a reason of at least ${MIN_REASON_LENGTH} characters`
      valid = false
    }

    return { errors, valid: valid && hasMentor }
  }, [days, dates, daysNumber, reason, hasMentor])

  const addDate = (value) => {
    if (!value) return
    setSubmitError(null)
    setDates((current) =>
      current.includes(value) ? current : [...current, value].sort()
    )
  }

  const removeDate = (value) => {
    setDates((current) => current.filter((entry) => entry !== value))
  }

  const handleSubmit = async () => {
    if (!validation.valid || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    setFieldErrors({})
    try {
      const result = await submitOdRequest({
        odDaysRequested: daysNumber,
        odDates: dates,
        reason: reason.trim(),
      })
      setNotice(
        result.warning
          ? `Your OD request was submitted (${result.request.od_request_id}). ${result.warning}`
          : `Your OD request was submitted and sent to your mentor. Reference ${result.request.od_request_id}.`
      )
      setDays('')
      setDates([])
      setReason('')
      await load()
    } catch (err) {
      setSubmitError(err)
      /*
       * Field-level messages from the server are attached to their inputs, so a
       * refusal the browser did not anticipate still lands next to the right box
       * rather than only in the banner.
       */
      const details = err?.details?.errors
      if (Array.isArray(details)) {
        setFieldErrors(Object.fromEntries(details.map((e) => [e.field, e.message])))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleLogout = async () => {
    await logout()
    navigate('/role-selection', { replace: true })
  }

  return (
    <div className="app-shell">
      <Navbar title="On-Duty Request" subtitle="Campus-Flow" onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5">
        <button
          type="button"
          onClick={() => navigate('/student/entry')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          <ChevronLeftIcon size={16} />
          Back
        </button>

        <DashboardHero
          icon={<SparklesIcon size={26} />}
          title="OD Form"
          subtitle="Request on-duty leave. It is reviewed by your mentor, the Contest Coordinator, your Class Advisor and the HOD."
        />

        {loadError && <StatusMessage variant="danger">{loadError}</StatusMessage>}

        {notice && (
          <StatusMessage variant="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </StatusMessage>
        )}

        {/* Centred the same way as the mentor page: `justify-items` centres the card within
            the twelve columns, where `justify-content` had no free space to move it. */}
        <div className="page-enter mt-4 grid grid-cols-12 justify-items-center">
          <div className="col-span-12 lg:col-span-8 xl:col-span-7 w-full">
            {!loading && student && (
              <form
                className="cf-card cf-card-hover p-3 md:p-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  handleSubmit()
                }}
              >
                <div className="cf-card-header">
                  <div>
                    <h2 className="section-title">Your request</h2>
                    <p className="text-muted-2 text-sm mb-0">
                      The shaded fields are filled in for you and cannot be changed here.
                    </p>
                  </div>
                  <span className="cf-icon-badge violet">
                    <CalendarIcon size={22} />
                  </span>
                </div>

                {/* ---------------------------------------------------- read-only */}
                <div className="mt-4">
                  <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">
                    Filled in for you
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {[
                      { label: 'Date', value: submissionDate },
                      { label: 'Name', value: student.student_name },
                      { label: 'Department', value: student.department },
                      { label: 'Year', value: String(student.year) },
                      { label: 'Section', value: student.section },
                      {
                        label: 'Number of OD already gained',
                        value: String(me.od_days_gained || 0),
                      },
                    ].map((field) => (
                      <div key={field.label}>
                        <label className="cf-form-label">{field.label}</label>
                        {/* Read-only rather than disabled: a disabled control is not
                            focusable, so a screen reader user could not read the value
                            at all. */}
                        <input
                          className="cf-input bg-slate-100 text-slate-500"
                          value={field.value}
                          readOnly
                          tabIndex={0}
                          aria-label={`${field.label}, filled in for you`}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {!hasMentor && (
                  <div
                    role="alert"
                    className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
                  >
                    <InfoIcon size={16} className="mt-0.5 shrink-0" />
                    <div>
                      <p className="font-bold">You need a mentor first.</p>
                      <p className="mt-1">
                        An OD request is reviewed by your mentor before anything else, so
                        allocate one before submitting.
                      </p>
                      <button
                        type="button"
                        onClick={() => navigate('/student/mentor')}
                        className="btn-cf-outline mt-2 px-3 py-1.5 text-sm"
                      >
                        Allocate a mentor
                      </button>
                    </div>
                  </div>
                )}

                {/* ------------------------------------------------------ inputs */}
                <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="odDays" className="cf-form-label">
                      Number of OD days required{' '}
                      <span className="text-red-500" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <input
                      id="odDays"
                      className="cf-input"
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max={MAX_OD_DAYS}
                      step="1"
                      value={days}
                      onChange={(e) => {
                        setDays(e.target.value)
                        setFieldErrors((current) => ({ ...current, od_days_requested: undefined }))
                      }}
                      placeholder="e.g. 2"
                      disabled={!hasMentor}
                      aria-describedby="odDaysHelp"
                    />
                    <p id="odDaysHelp" className="mt-1 text-xs text-slate-500">
                      A whole number from 1 to {MAX_OD_DAYS}.
                    </p>
                    {validation.errors.od_days_requested && (
                      <p role="alert" className="mt-1 text-xs font-semibold text-red-600">
                        {validation.errors.od_days_requested}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="odReason" className="cf-form-label">
                      Reason for OD{' '}
                      <span className="text-red-500" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <textarea
                      id="odReason"
                      className="cf-input"
                      rows={3}
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value)
                        setFieldErrors((current) => ({ ...current, reason: undefined }))
                      }}
                      placeholder="Attending an inter-college technical event…"
                      disabled={!hasMentor}
                      aria-describedby="odReasonHelp"
                    />
                    <p id="odReasonHelp" className="mt-1 text-xs text-slate-500">
                      At least {MIN_REASON_LENGTH} characters. This is what your approvers read
                      first.
                    </p>
                    {validation.errors.reason && (
                      <p role="alert" className="mt-1 text-xs font-semibold text-red-600">
                        {validation.errors.reason}
                      </p>
                    )}
                  </div>
                </div>

                {/* --------------------------------------------------- OD dates */}
                <div className="mt-5">
                  <label htmlFor="odDate" className="cf-form-label">
                    OD date{dates.length === 1 ? '' : 's'}{' '}
                    <span className="text-red-500" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="odDate"
                      type="date"
                      className="cf-input w-full max-w-[200px]"
                      min={submissionDate}
                      value=""
                      onChange={(e) => {
                        addDate(e.target.value)
                        setFieldErrors((current) => ({ ...current, od_dates: undefined }))
                      }}
                      disabled={!hasMentor}
                      aria-describedby="odDatesHelp"
                    />
                    <span className="text-xs text-slate-400">
                      Add one date per day requested.
                    </span>
                  </div>

                  {dates.length > 0 && (
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {dates.map((value) => (
                        <li
                          key={value}
                          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700"
                        >
                          {value}
                          <button
                            type="button"
                            onClick={() => removeDate(value)}
                            disabled={!hasMentor}
                            className="text-slate-400 transition-colors hover:text-red-600"
                            aria-label={`Remove ${value}`}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <p id="odDatesHelp" className="mt-1 text-xs text-slate-500">
                    {Number.isFinite(daysNumber) && daysNumber > 0
                      ? `You have selected ${dates.length} of ${daysNumber} requested ${
                          daysNumber === 1 ? 'day' : 'days'
                        }.`
                      : 'Enter how many days you need, then add that many dates.'}
                  </p>
                  {validation.errors.od_dates && (
                    <p role="alert" className="mt-1 text-xs font-semibold text-red-600">
                      {validation.errors.od_dates}
                    </p>
                  )}
                </div>

                {fieldErrors.reason && (
                  <p role="alert" className="mt-2 text-xs font-semibold text-red-600">
                    {fieldErrors.reason}
                  </p>
                )}

                {submitError && (
                  <div className="mt-4">
                    <StatusMessage variant="danger">{submitError.message}</StatusMessage>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!validation.valid || submitting}
                  className="btn-cf-primary mt-5 inline-flex w-full items-center justify-center gap-2 px-4 py-2 text-sm"
                >
                  {submitting && <span className="cf-spinner" role="status" aria-hidden="true" />}
                  {submitting ? 'Submitting…' : 'Submit OD request'}
                </button>
                {!validation.valid && hasMentor && (
                  <p className="mt-2 text-center text-xs text-slate-400">
                    Complete every required field to enable Submit.
                  </p>
                )}
              </form>
            )}

            {/* ------------------------------------------------------- history */}
            <div className="cf-list-card mt-4">
              <div className="cf-card-header px-3 pt-3 pb-2 mb-0">
                <div>
                  <h3 className="section-title">My OD requests</h3>
                  <p className="text-muted-2 text-sm mb-0">
                    Every request you have submitted, and where it has got to
                  </p>
                </div>
                <span className="cf-status-pill active">
                  <span className="dot" aria-hidden="true" /> {me?.od_days_gained || 0} gained
                </span>
              </div>

              {requests.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-slate-500">
                  You have not submitted an OD request yet.
                </p>
              ) : (
                <div>
                  {requests.map((request) => (
                    <div className="cf-list-item" key={request.od_request_id}>
                      <span
                        className={`cf-list-icon ${
                          request.status === 'APPROVED'
                            ? 'green'
                            : request.status === 'REJECTED'
                              ? 'red'
                              : 'blue'
                        }`}
                      >
                        {request.status === 'APPROVED' ? (
                          <CheckIcon size={17} />
                        ) : (
                          <ClockIcon size={17} />
                        )}
                      </span>
                      <div className="cf-list-meta">
                        <div className="title">{request.od_dates.join(', ')}</div>
                        <div className="sub">
                          {request.od_days_requested} day
                          {request.od_days_requested === 1 ? '' : 's'} · submitted{' '}
                          {request.submitted_date} · {request.od_request_id}
                        </div>
                        {request.status === 'REJECTED' && request.rejection_reason && (
                          <div className="sub">
                            Rejected at {request.rejected_at_stage}: {request.rejection_reason}
                          </div>
                        )}
                      </div>
                      <div className="text-right">
                        <div
                          className={`text-sm font-bold uppercase ${
                            request.status === 'APPROVED'
                              ? 'text-success'
                              : request.status === 'REJECTED'
                                ? 'text-red-600'
                                : 'text-slate-600'
                          }`}
                        >
                          {STATUS_COPY[request.status] || request.status}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
