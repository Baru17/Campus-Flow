import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatChip from '../components/StatChip'
import DropdownField from '../components/DropdownField'
import LoadingButton from '../components/LoadingButton'
import StatusMessage from '../components/StatusMessage'
import SearchableSelect from '../components/SearchableSelect'
import OTPDisplay from '../components/OTPDisplay'
import { finalizeAttendanceSession, generateOtp } from '../api/attendanceApi'
import { getSubjects } from '../api/subjectsApi'
import { DEPARTMENTS, YEARS, SECTIONS, PERIODS, batchOptionsForDepartment } from '../constants'
import { formatClassName } from '../utils/format'
import { generateOtpErrorMessage, notConfiguredMessage, batchListErrorMessage } from '../utils/messages'
import { useClock } from '../hooks/useClock'
import { useStaffAuth } from '../hooks/useStaffAuth'
import { fetchBatches } from '../api/batchesApi'
import {
  SparklesIcon,
  ShieldIcon,
  ClockIcon,
  FingerprintIcon,
  CalendarIcon,
  StaffIcon,
  KeyIcon,
  CompassIcon,
  ChevronRightIcon,
} from '../components/Icons'

const BACKEND_CONFIGURED = Boolean(import.meta.env.VITE_API_BASE_URL)

export default function StaffDashboard() {
  const clock = useClock()
  const navigate = useNavigate()
  const { staff, loading, logout } = useStaffAuth()

  const [year, setYear] = useState('')
  const [department, setDepartment] = useState('IT')
  const [batch, setBatch] = useState('')
const [section, setSection] = useState('')
  const [period, setPeriod] = useState('')
  const [subjectsLoading, setSubjectsLoading] = useState(false)
  const [subjectsError, setSubjectsError] = useState(null)
  const [selectedSubject, setSelectedSubject] = useState(null)
  const [allSubjects, setAllSubjects] = useState([])

  /*
   * Departments and their cohorts, from `GET /api/batches`.
   *
   * This is the complete registry the backend serves: the built-in cohorts plus
   * every batch an administrator has provisioned, which is why a batch created in
   * the admin dashboard becomes selectable here without a rebuild. `batches` is
   * keyed by department and each entry is `{ key, label }`.
   *
   * `null` means "not loaded yet", and is what keeps the selector populated from
   * `constants.js` until the response lands. Once it holds a value it is the sole
   * source, so a cohort that exists in the database but not in `constants.js` is
   * still shown, and the hardcoded list can never hide a real batch.
   */
  const [batchesByDepartment, setBatchesByDepartment] = useState(null)
  const [batchesError, setBatchesError] = useState(null)

  const [session, setSession] = useState(null)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState(null)
  const [finalizeError, setFinalizeError] = useState(null)
  const [recentSessions, setRecentSessions] = useState([])

  useEffect(() => {
    if (!loading && !staff) {
      navigate('/role-selection', { replace: true })
    }
  }, [loading, staff, navigate])

  /*
   * Fetched once per mount rather than per department change: the response is
   * keyed by department, so one request fills every department the selector can
   * offer and switching department is then a local lookup.
   */
  useEffect(() => {
    if (!BACKEND_CONFIGURED) return
    let cancelled = false
    fetchBatches()
      .then((batches) => {
        if (!cancelled) setBatchesByDepartment(batches)
      })
      .catch((error) => {
        if (!cancelled) setBatchesError(error)
      })
    return () => { cancelled = true }
  }, [])

  const handleLogout = async () => {
    await logout()
    navigate('/role-selection', { replace: true })
  }

  const sessionInProgress = session && !sessionExpired

  /*
   * Any configured department can be attended by any signed-in staff member, so
   * the department field is a real choice rather than a readout of the staff
   * record. The staff member's own department seeds the initial value, since it
   * is the likeliest class for them, but it is applied once and never re-applied
   * afterwards - choosing another department sticks.
   *
   * Which departments are actually usable is decided by the batch allow-list
   * below: a department with no configured batch offers no batch, and the backend
   * rejects the request. The list is not narrowed by staff.department.
   */

  const staffDepartment = staff?.department ? String(staff.department).trim().toUpperCase() : ''
  const seededDepartment = useRef(false)

  useEffect(() => {
    if (seededDepartment.current || !staffDepartment) return
    seededDepartment.current = true
    setDepartment(staffDepartment)
  }, [staffDepartment])

  const departmentOptions = DEPARTMENTS.map((d) => ({ value: d, label: d }))

  /*
   * Batch is the source of truth: it is what selects the student and attendance
   * tables, on the backend as well as here. The options come from the batch
   * registry the backend serves, so every cohort the application can actually
   * serve is offered, including one provisioned after this build shipped.
   *
   * `batchOptionsForDepartment` supplies the built-in cohorts until that response
   * arrives, which keeps the pre-existing behaviour intact on first paint and if
   * the request fails. Once the response has landed it is the only source, so the
   * hardcoded list can never hide a batch that exists in the database. The option
   * value is the backend key ("2024_2028") and the label is presentation only.
   */
  const batchOptions = useMemo(() => {
    if (batchesByDepartment) {
      const available = batchesByDepartment[department] || []
      return available.map(({ key: value, label }) => ({ value, label }))
    }
    return batchOptionsForDepartment(department)
  }, [batchesByDepartment, department])

  const batchConfigured = batchOptions.length > 0

  /*
   * A department change invalidates the batch, so fall back to its only option.
   * The year and section are part of the class inside the batch, so they are
   * cleared too rather than left pointing at a batch that no longer exists.
   */
  useEffect(() => {
    setBatch((current) =>
      batchOptions.some((option) => option.value === current) ? current : batchOptions[0]?.value || ''
    )
    setYear('')
    setSection('')
    setSelectedSubject(null)
  }, [batchOptions])

  /*
   * Switching batch invalidates the class too. The set of years a batch runs is
   * a backend fact, so rather than hardcoding which years belong to which batch
   * the year and section are cleared and re-picked. This is deliberately not a
   * batch -> year mapping.
   */
  const handleBatchChange = (nextBatch) => {
    setBatch(nextBatch)
    setYear('')
    setSection('')
    setSelectedSubject(null)
  }

  const canGenerate =
    year && department && batch && section && period && selectedSubject && !generating && !sessionInProgress

  const classSelected = Boolean(year && department && batch && section)
  // The subject step is only reachable once the whole slot is known, period
  // included, so the catalog is not fetched for a class that cannot be marked yet.
  const subjectSearchReady = Boolean(classSelected && period)

  useEffect(() => {
    const allFields = department && batch && year && section && period
    if (!allFields) {
      setAllSubjects([])
      setSelectedSubject(null)
      setSubjectsLoading(false)
      setSubjectsError(null)
      return undefined
    }
    let cancelled = false
    setAllSubjects([])
    setSelectedSubject(null)
    setSubjectsLoading(true)
    setSubjectsError(null)
    getSubjects()
      .then((rows) => {
        if (!cancelled) setAllSubjects(rows)
      })
      .catch((err) => {
        if (!cancelled) setSubjectsError(err)
      })
      .finally(() => {
        if (!cancelled) setSubjectsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [department, batch, year, section, period])

  /*
   * The catalog is global, so the same list backs every department and year. The
   * option value is the subject code, which is what gets sent to the backend and
   * what the attendance record is keyed on; the label is the "CODE - Name" form
   * shown both in the open list and on the closed control. The original row is
   * carried along on `subject` so selecting still yields the same object the
   * rest of the page already expects.
   *
   * Filtering is not done here. SearchableSelect matches on value and label, so
   * typing matches the code or the name case-insensitively, and it holds the
   * typed term inside the open control where it belongs.
   */
  const subjectOptions = useMemo(
    () =>
      allSubjects.map((s) => ({
        value: s.subject_code,
        label: `${s.subject_code} - ${s.subject_name}`,
        subject: s,
      })),
    [allSubjects]
  )

  const handleGenerate = async () => {
    if (!canGenerate) return
    setGenerateError(null)
    setFinalizeError(null)
    setSession(null)
    setSessionExpired(false)
    setGenerating(true)
    try {
      /*
       * `batch` is the source of truth and selects the tables. `year` is sent
       * only because the backend narrows the subject and the student roster to
       * (year, section) inside that already-resolved batch. Nothing here maps
       * one to the other.
       */
      const data = await generateOtp({
        department,
        batch,
        year: Number(year),
        section,
        period: Number(period),
        subject_code: selectedSubject.subject_code,
        subject_name: selectedSubject.subject_name,
      })
      const sessionData = { ...data.session, department, batch }
      const sessionLabel = `${sessionData.subject_code} - ${sessionData.subject_name}`
      setSession(sessionData)
      setRecentSessions((prev) => [
        {
          key: sessionData.session_id,
          label: sessionLabel,
          className: formatClassName(department, year, section, batch),
          period: Number(period),
          generatedAt: new Date(),
          expired: false,
        },
        ...prev.map((item) => ({ ...item, expired: true })),
      ])
    } catch (err) {
      if (err?.status === 401) {
        // The session died server-side. Signing out is the only way out;
        // leaving the dashboard rendered would just re-401 on every retry.
        setGenerateError({ variant: 'warning', text: 'Your staff session has expired. Please sign in again.' })
        await logout().catch(() => {})
        navigate('/role-selection', { replace: true })
        return
      }
      setGenerateError(generateOtpErrorMessage(err))
    } finally {
      setGenerating(false)
    }
  }

  const handleExpire = async () => {
    setSessionExpired(true)
    setRecentSessions((prev) => prev.map((item, index) => (index === 0 ? { ...item, expired: true } : item)))
    setFinalizeError(null)
    try {
      await finalizeAttendanceSession(session.session_id)
    } catch (error) {
      setFinalizeError(error?.message || 'Unable to finalize the attendance session.')
    }
  }

  const selectedClass = classSelected ? `${formatClassName(department, year, section, batch)}` : '—'
  const sessionStatus = session && !sessionExpired ? 'Active' : session ? 'Expired' : 'Idle'
  const sessionTone = session && !sessionExpired ? 'green' : session ? 'amber' : 'primary'

  if (loading) {
    return (
      <div className="app-shell">
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Checking your session…</p>
          </div>
        </div>
      </div>
    )
  }

  if (!staff) return null

  const staffLabel = `${staff.staff_name} · ${staff.department}`

  return (
    <div className="app-shell">
      <Navbar
        title="Staff Dashboard"
        subtitle={staffLabel}
        onLogout={handleLogout}
      />
      <main className="container-cf py-4 lg:py-5 page-enter">
        {!BACKEND_CONFIGURED && (
          <div className="mb-4">
            <StatusMessage variant={notConfiguredMessage().variant} dismissible={false}>
              {notConfiguredMessage().text}
            </StatusMessage>
          </div>
        )}

        <DashboardHero
          icon={<StaffIcon size={26} />}
          title="Staff Dashboard"
          subtitle={`${clock.greeting}, ${staff.staff_name} — manage attendance sessions for your ${staff.department} classes.`}
          right={
            <div className="live-clock">
              <div className="time">{clock.time}</div>
              <div className="date">{clock.date}</div>
            </div>
          }
        />

        <div className="stat-strip stagger">
          <StatChip
            icon={<SparklesIcon size={18} />}
            label="Sessions generated"
            value={recentSessions.length}
          />
          <StatChip
            icon={<FingerprintIcon size={18} />}
            label="Session status"
            value={sessionStatus}
            tone={sessionTone}
          />
          <StatChip
            icon={<CompassIcon size={18} />}
            label="Selected class"
            value={selectedClass}
            tone="violet"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7">
            <div className="cf-card cf-card-hover p-3 md:p-4">
              <div className="cf-card-header">
                <div>
                  <h2 className="section-title">New Attendance Session</h2>
                  <p className="text-muted-2 text-sm mb-0">
                    Pick a batch, then the class and subject to generate an OTP.
                  </p>
                </div>
                <span className="cf-icon-badge">
                  <StaffIcon size={22} />
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <DropdownField
                    label="Department"
                    name="department"
                    value={department}
                    onChange={setDepartment}
                    options={departmentOptions}
                    placeholder="Select department"
                    disabled={sessionInProgress}
                  />
                </div>
                <div>
                  <DropdownField
                    label="Batch"
                    name="batch"
                    value={batch}
                    onChange={handleBatchChange}
                    options={batchOptions}
                    placeholder="Select batch"
                    disabled={sessionInProgress || !department || !batchConfigured}
                  />
                  {!batchConfigured && (
                    <StatusMessage variant="info">
                      Attendance is not configured for {department} yet.
                    </StatusMessage>
                  )}
                  {batchesError && (
                    <StatusMessage variant={batchListErrorMessage(batchesError).variant}>
                      {batchListErrorMessage(batchesError).text}
                    </StatusMessage>
                  )}
                </div>
                <div>
                  <DropdownField
                    label="Year"
                    name="year"
                    value={year}
                    onChange={setYear}
                    options={YEARS.map((y) => ({ value: y, label: `Year ${y}` }))}
                    placeholder="Select year"
                    disabled={sessionInProgress || !batch}
                  />
                </div>
                <div>
                  <DropdownField
                    label="Section"
                    name="section"
                    value={section}
                    onChange={setSection}
                    options={SECTIONS.map((s) => ({ value: s, label: s }))}
                    placeholder="Select section"
                    disabled={sessionInProgress || !year || !department || !batch}
                  />
                </div>
                <div>
                  <DropdownField
                    label="Period"
                    name="period"
                    value={period}
                    onChange={setPeriod}
                    options={PERIODS.map((p) => ({ value: p, label: `Period ${p}` }))}
                    placeholder="Select period"
                    disabled={sessionInProgress || !year || !department || !batch || !section}
                    icon={<ClockIcon size={15} />}
                  />
                </div>
                <div className="sm:col-span-2">
                  <SearchableSelect
                    name="subject"
                    label="Subject"
                    icon={<KeyIcon size={15} />}
                    value={selectedSubject?.subject_code ?? ''}
                    options={subjectOptions}
                    onChange={(option) => setSelectedSubject(option.subject)}
                    placeholder="Select subject"
                    searchPlaceholder="Search subject by code or name"
                    loading={subjectsLoading}
                    loadingText="Loading subjects…"
                    disabled={!subjectSearchReady || sessionInProgress}
                    emptyText="No subjects match your search."
                    error={
                      subjectsError ? (
                        <StatusMessage variant="danger">{subjectsError.message}</StatusMessage>
                      ) : null
                    }
                  />
                </div>
              </div>

              <div className="mt-4">
                <LoadingButton
                  variant="primary"
                  onClick={handleGenerate}
                  loading={generating}
                  loadingText="Generating OTP…"
                  disabled={!canGenerate}
                  className="w-full inline-flex items-center justify-center gap-2"
                >
                  <SparklesIcon size={18} />
                  Generate OTP
                </LoadingButton>
              </div>

              {generateError && (
                <div className="mt-3">
                  <StatusMessage variant={generateError.variant}>{generateError.text}</StatusMessage>
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-5">
            {session && (
              <>
                <OTPDisplay
                  key={session.session_id}
                  otp={session.otp}
                  expiresAt={session.expire_at}
                  running={!sessionExpired}
                  onExpire={handleExpire}
                />

                <div className="cf-card p-3 md:p-4 mt-4 reveal reveal-2">
                  <div className="cf-card-header">
                    <div>
                      <h3 className="section-title">Session Summary</h3>
                      <p className="text-muted-2 text-sm mb-0">
                        {formatClassName(session.department, session.year, session.section, session.batch)}
                        {' · '}
                        Period {session.period}
                      </p>
                    </div>
                    {session && !sessionExpired ? (
                      <span className="cf-status-pill active">
                        <span className="dot" aria-hidden="true" /> Active
                      </span>
                    ) : (
                      <span className="cf-status-pill expired">
                        <span className="dot" aria-hidden="true" /> Expired
                      </span>
                    )}
                  </div>

                  <div className="cf-detail-row">
                    <span className="cf-detail-label">
                      <CalendarIcon size={15} /> Class
                    </span>
                    <span className="cf-detail-value">
                      {formatClassName(session.department, session.year, session.section, session.batch)}
                    </span>
                  </div>
                  <div className="cf-detail-row">
                    <span className="cf-detail-label">
                      <ClockIcon size={15} /> Period
                    </span>
                    <span className="cf-detail-value">{session.period}</span>
                  </div>
                  <div className="cf-detail-row">
                    <span className="cf-detail-label">
                      <FingerprintIcon size={15} /> Expires
                    </span>
                    <span className="cf-detail-value">
                      {new Date(session.expire_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="cf-detail-row">
                    <span className="cf-detail-label">
                      <KeyIcon size={15} /> Subject
                    </span>
                    <span className="cf-detail-value">
                      {session.subject_code} - {session.subject_name}
                    </span>
                  </div>

                  {sessionExpired && (
                    <div className="mt-3">
                      <StatusMessage variant="info">
                        OTP expired. The session is being finalized automatically by the system.
                      </StatusMessage>
                    </div>
                  )}
                  {finalizeError && (
                    <div className="mt-3">
                      <StatusMessage variant="danger">{finalizeError}</StatusMessage>
                    </div>
                  )}
                </div>
              </>
            )}

            {!session && !generateError && (
              <div className="cf-empty h-full">
                <span className="cf-empty-icon">
                  <ShieldIcon size={30} />
                </span>
                <h3 className="section-title mb-0">No active session</h3>
                <p className="text-muted-2 mb-0">Generate an OTP to start a new attendance session.</p>
                <div className="steps">
                  <div className="step">
                    <span className="step-num">1</span>
                    <div className="step-text">
                      <b>Pick batch, class &amp; subject</b>
                      <span>Department, batch, year, section, period and subject.</span>
                    </div>
                  </div>
                  <div className="step">
                    <span className="step-num">2</span>
                    <div className="step-text">
                      <b>Generate OTP</b>
                      <span>A 6-digit OTP valid for 20 seconds is created.</span>
                    </div>
                  </div>
                  <div className="step">
                    <span className="step-num">3</span>
                    <div className="step-text">
                      <b>Share with students</b>
                      <span>Students enter the OTP to be marked PRESENT.</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {recentSessions.length > 1 && (
              <div className="cf-list-card mt-4 reveal reveal-3">
                <div className="cf-card-header px-3 pt-3 pb-2 mb-0">
                  <div>
                    <h3 className="section-title">Recent sessions</h3>
                    <p className="text-muted-2 text-sm mb-0">Generated in this visit</p>
                  </div>
                  <span className="cf-status-pill active">
                    <span className="dot" aria-hidden="true" /> {recentSessions.length}
                  </span>
                </div>
                <div>
                  {recentSessions.map((item) => (
                    <div className="cf-list-item" key={item.key}>
                      <span className="cf-list-icon">
                        <CalendarIcon size={17} />
                      </span>
                      <div className="cf-list-meta">
                        <div className="title">
                          {item.className} · Period {item.period}
                        </div>
                        <div className="sub">
                          {item.label} ·{' '}
                          {item.generatedAt.toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      </div>
                      {item.expired ? (
                        <span className="cf-status-pill expired">
                          <span className="dot" aria-hidden="true" /> Expired
                        </span>
                      ) : (
                        <span className="cf-status-pill active">
                          <span className="dot" aria-hidden="true" /> Active
                        </span>
                      )}
                      <ChevronRightIcon size={16} className="text-muted-2" />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
