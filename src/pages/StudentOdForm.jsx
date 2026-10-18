import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import { fetchMyOdRequests, fetchStudentMe, submitOdRequest } from '../api/odApi'
import { useAuth } from '../hooks/useAuth'
import { MAX_OD_DAYS, MIN_REASON_LENGTH } from '../utils/odValidation'
import { countDaysInclusive, expandDateRange, formatOdDates } from '../utils/odDateRange'
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
 * What the student does supply is two things: the range of dates they need, and why.
 * Those are the only two things they decide. How many days that is turns out to be a
 * consequence of the range rather than a separate question -- asking for the 18th to
 * the 20th and then typing "2" into a box beside it is a second chance to be wrong
 * about a thing that was already fully specified, so the count is worked out here,
 * shown to them, and not asked of them.
 *
 * Validation runs here *and* on the server. That is not belt and braces for its own
 * sake: the browser's copy is what decides whether the button is live, and the
 * server's is what decides whether the request exists. A form that disabled Submit on
 * a good-looking value and let the server refuse the rest would be a worse experience,
 * and a form that trusted the browser would be a security hole.
 *
 * The range is stored, as it always was, as the list of individual days it covers --
 * `od_dates` is an array and every part of the feature that reads a request reads that
 * array. `utils/odDateRange` is the one place the two are converted between.
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
  const { logout, student: authStudent, loading: authLoading } = useAuth()

  const [me, setMe] = useState(null)
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
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

  /*
   * Same gate as `StudentEntry`, and for the same reason: the session is restored by
   * `AuthProvider` on mount, and both `/api/student/me` and `/api/student/od` need it.
   * Firing them at the same time as the restore meant a redundant pair of requests whose
   * failure showed as an error banner on a cold load. `AdvisorDashboard` already gates its
   * first authenticated call on the context having resolved; this now does the same.
   *
   * No server behaviour changes. The student role is still required and still checked.
   */
  useEffect(() => {
    if (authLoading) return
    if (!authStudent) {
      navigate('/role-selection', { replace: true })
      return
    }
    load()
  }, [authLoading, authStudent, load, navigate])

  const student = me?.student ?? authStudent
  const hasMentor = Boolean(student?.mentor_email)
  const busy = authLoading || loading
  const submissionDate = today()

  /*
   * The range, worked out from the two dates.
   *
   * `rangeDays` is `null` while the range does not yet mean anything -- an end not
   * chosen, or a To Date before the From Date -- which is what the two pickers, the
   * day count and the submit button all read, so they cannot disagree with each other
   * about whether the range is usable.
   */
  const rangeDays = useMemo(
    () => countDaysInclusive(fromDate, toDate),
    [fromDate, toDate]
  )

  /*
   * The individual days the range covers. These are what `od_dates` has always held and
   * what every reader of a request -- attendance finalization included -- still reads,
   * so nothing downstream has to learn what a range is.
   */
  const rangeDates = useMemo(
    () => (rangeDays === null ? [] : expandDateRange(fromDate, toDate)),
    [fromDate, toDate, rangeDays]
  )

  const validation = useMemo(() => {
    const errors = {}
    let valid = true

    if (!fromDate) {
      errors.od_from_date = 'Choose the date your OD starts'
      valid = false
    } else if (fromDate < submissionDate) {
      errors.od_from_date = 'From Date cannot be in the past'
      valid = false
    }

    if (!toDate) {
      errors.od_to_date = 'Choose the date your OD ends'
      valid = false
    } else if (fromDate && toDate < fromDate) {
      /*
       * Both ends come out of a `type="date"` input, so they are `YYYY-MM-DD` or
       * nothing, and ISO dates compare correctly as plain strings -- no parsing and no
       * timezone to get wrong. The earlier Date is caught before it reaches the count,
       * which would otherwise be a negative number.
       */
      errors.od_to_date = 'To Date cannot be earlier than From Date'
      valid = false
    } else if (rangeDays !== null && rangeDays > MAX_OD_DAYS) {
      errors.od_to_date = `An OD request may cover ${MAX_OD_DAYS} days or fewer`
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
  }, [fromDate, toDate, rangeDays, reason, submissionDate, hasMentor])

  const handleSubmit = async () => {
    if (!validation.valid || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    setFieldErrors({})
    try {
      const result = await submitOdRequest({
        odFromDate: fromDate,
        odToDate: toDate,
        odDaysRequested: rangeDates.length,
        odDates: rangeDates,
        reason: reason.trim(),
      })
      setNotice(
        result.warning
          ? `Your OD request was submitted (${result.request.od_request_id}). ${result.warning}`
          : `Your OD request was submitted and sent to your mentor. Reference ${result.request.od_request_id}.`
      )
      setFromDate('')
      setToDate('')
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
          subtitle="Request on-duty leave. It is reviewed by your mentor, your Class Advisor, the Contest Coordinator and the HOD."
        />

        {loadError && <StatusMessage variant="danger">{loadError}</StatusMessage>}

        {notice && (
          <StatusMessage variant="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </StatusMessage>
        )}

        {/* Centred the same way as the mentor page, and for the same reason: `justify-items` acts
            within the grid area of a `col-span-8` item, which is columns 1-8, so the card
            sat against the left edge. The wrapper centres itself with `mx-auto`. */}
        <div className="page-enter mt-4 mx-auto w-full max-w-2xl">
          {busy && (
            <div className="cf-empty">
              <span className="cf-spinner" role="status" aria-hidden="true" />
              <p className="text-sm text-slate-500">
                {authLoading ? 'Checking your session…' : 'Loading your details…'}
              </p>
            </div>
          )}

          {!busy && student && (
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
                {/*
                  * Read-only, because the range below already answers it. Asking for
                  * the 18th to the 20th and then for a number beside it is two chances
                  * to disagree with one another, and the count the request is filed
                  * with has to be the one the range implies.
                  */}
                <div>
                  <label htmlFor="odDayCount" className="cf-form-label">
                    Number of OD days required
                  </label>
                  <input
                    id="odDayCount"
                    className="cf-input bg-slate-100 text-slate-500"
                    value={
                      rangeDays === null
                        ? ''
                        : String(rangeDays)
                    }
                    readOnly
                    tabIndex={0}
                    aria-label="Number of OD days required, counted from your date range"
                    aria-describedby="odDayCountHelp"
                  />
                  <p id="odDayCountHelp" className="mt-1 text-xs text-slate-500">
                    {rangeDays === null
                      ? 'Counted from the dates below, both ends included.'
                      : `${rangeDays} calendar ${rangeDays === 1 ? 'day' : 'days'}, from ${fromDate} to ${toDate}. Up to ${MAX_OD_DAYS}.`}
                  </p>
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

              {/* ------------------------------------------------- OD date range */}
              <div className="mt-5">
                <p className="cf-form-label">
                  OD dates <span className="text-red-500" aria-hidden="true">*</span>
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="odFromDate" className="cf-form-label">
                      From Date{' '}
                      <span className="text-red-500" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <input
                      id="odFromDate"
                      type="date"
                      className="cf-input w-full"
                      min={submissionDate}
                      value={fromDate}
                      onChange={(e) => {
                        setSubmitError(null)
                        setFromDate(e.target.value)
                        /*
                         * Moving the start past the end leaves a range nobody meant, so
                         * the end follows it rather than being left behind to fail.
                         */
                        if (e.target.value && toDate && e.target.value > toDate) {
                          setToDate(e.target.value)
                        }
                        setFieldErrors((current) => ({
                          ...current,
                          od_from_date: undefined,
                          od_to_date: undefined,
                        }))
                      }}
                      disabled={!hasMentor}
                      aria-describedby="odDatesHelp"
                    />
                    {validation.errors.od_from_date && (
                      <p role="alert" className="mt-1 text-xs font-semibold text-red-600">
                        {validation.errors.od_from_date}
                      </p>
                    )}
                    {/* A refusal the browser did not anticipate still lands next to
                        the box it belongs to, rather than only in the banner. */}
                    {fieldErrors.od_from_date && (
                      <p role="alert" className="mt-1 text-xs font-semibold text-red-600">
                        {fieldErrors.od_from_date}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="odToDate" className="cf-form-label">
                      To Date{' '}
                      <span className="text-red-500" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <input
                      id="odToDate"
                      type="date"
                      className="cf-input w-full"
                      min={fromDate || submissionDate}
                      value={toDate}
                      onChange={(e) => {
                        setSubmitError(null)
                        setToDate(e.target.value)
                        setFieldErrors((current) => ({
                          ...current,
                          od_to_date: undefined,
                        }))
                      }}
                      disabled={!hasMentor}
                      aria-describedby="odDatesHelp"
                    />
                    {validation.errors.od_to_date && (
                      <p role="alert" className="mt-1 text-xs font-semibold text-red-600">
                        {validation.errors.od_to_date}
                      </p>
                    )}
                    {fieldErrors.od_to_date && (
                      <p role="alert" className="mt-1 text-xs font-semibold text-red-600">
                        {fieldErrors.od_to_date}
                      </p>
                    )}
                  </div>
                </div>

                {/*
                  * What the range will actually be stored as. `od_dates` is a list of
                  * days and always has been, so this is the request as it exists, not
                  * a summary of something else -- showing it is what stops "both ends
                  * included" from being a thing the student has to take on trust.
                  */}
                {rangeDates.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {rangeDates.map((value) => (
                      <li
                        key={value}
                        className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700"
                      >
                        {value}
                      </li>
                    ))}
                  </ul>
                )}

                <p id="odDatesHelp" className="mt-1 text-xs text-slate-500">
                  {rangeDays === null
                    ? `Pick the first and last day of your OD. Every day in between is included, up to ${MAX_OD_DAYS}.`
                    : `${rangeDays} ${rangeDays === 1 ? 'day' : 'days'} selected: ${formatOdDates(rangeDates)}.`}
                </p>
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
                      <div className="title">{formatOdDates(request.od_dates)}</div>
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
      </main>
    </div>
  )
}