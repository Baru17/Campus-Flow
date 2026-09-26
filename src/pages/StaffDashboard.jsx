import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatChip from '../components/StatChip'
import DropdownField from '../components/DropdownField'
import LoadingButton from '../components/LoadingButton'
import StatusMessage from '../components/StatusMessage'
import OTPDisplay from '../components/OTPDisplay'
import { finalizeAttendanceSession, generateOtp } from '../api/attendanceApi'
import { getSubjectsByYear } from '../api/subjectsApi'
import { DEPARTMENTS, YEARS, SECTIONS, PERIODS } from '../constants'
import { formatClassName } from '../utils/format'
import { generateOtpErrorMessage, notConfiguredMessage } from '../utils/messages'
import { useClock } from '../hooks/useClock'
import { useStaffAuth } from '../hooks/useStaffAuth'
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
  const [section, setSection] = useState('')
  const [period, setPeriod] = useState('')
  const [subjects, setSubjects] = useState([])
  const [subjectsLoading, setSubjectsLoading] = useState(false)
  const [subjectsError, setSubjectsError] = useState(null)
  const [selectedSubject, setSelectedSubject] = useState(null)

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

  const handleLogout = async () => {
    await logout()
    navigate('/role-selection', { replace: true })
  }

  const sessionInProgress = session && !sessionExpired

  const canGenerate =
    year && department && section && period && selectedSubject && !generating && !sessionInProgress

  const classSelected = Boolean(year && department && section)

  useEffect(() => {
    if (!classSelected || !year) {
      setSubjects([])
      setSubjectsError(null)
      setSelectedSubject(null)
      return undefined
    }
    let cancelled = false
    setSubjectsLoading(true)
    setSubjectsError(null)
    setSelectedSubject(null)
    getSubjectsByYear(Number(year))
      .then((rows) => {
        if (!cancelled) setSubjects(rows)
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
  }, [classSelected, department, year, section])

  const handleGenerate = async () => {
    if (!canGenerate) return
    setGenerateError(null)
    setFinalizeError(null)
    setSession(null)
    setSessionExpired(false)
    setGenerating(true)
    try {
      const data = await generateOtp({
        year: Number(year),
        department,
        section,
        period: Number(period),
        subject_code: selectedSubject.subject_code,
        subject_name: selectedSubject.subject_name,
      })
      const sessionData = { ...data.session, department }
      const sessionLabel = `${sessionData.subject_code} - ${sessionData.subject_name}`
      setSession(sessionData)
      setRecentSessions((prev) => [
        {
          key: sessionData.session_id,
          label: sessionLabel,
          className: formatClassName(department, year, section),
          period: Number(period),
          generatedAt: new Date(),
          expired: false,
        },
        ...prev.map((item) => ({ ...item, expired: true })),
      ])
    } catch (err) {
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

  const selectedClass = classSelected ? `${formatClassName(department, year, section)}` : '—'
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
                  <p className="text-muted-2 text-sm mb-0">Select the class and subject to generate an OTP.</p>
                </div>
                <span className="cf-icon-badge">
                  <StaffIcon size={22} />
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <DropdownField
                    label="Year"
                    name="year"
                    value={year}
                    onChange={setYear}
                    options={YEARS.map((y) => ({ value: y, label: `Year ${y}` }))}
                    placeholder="Select year"
                    disabled={sessionInProgress}
                  />
                </div>
                <div>
                  <DropdownField
                    label="Department"
                    name="department"
                    value={department}
                    onChange={setDepartment}
                    options={DEPARTMENTS.map((d) => ({ value: d, label: d }))}
                    placeholder="Select department"
                    disabled={sessionInProgress}
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
                    disabled={sessionInProgress || !year || !department}
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
                    disabled={sessionInProgress || !year || !department || !section}
                    icon={<ClockIcon size={15} />}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="cf-form-label">
                    <span className="text-muted-2">
                      <KeyIcon size={15} />
                    </span>
                    Subject
                  </label>
                  {subjectsLoading && (
                    <div className="cf-loading-inline mt-1">
                      <span className="cf-spinner" role="status" aria-hidden="true" />
                      Loading subjects…
                    </div>
                  )}
                  {subjectsError && (
                    <StatusMessage variant="danger">{subjectsError.message}</StatusMessage>
                  )}
                  {!subjectsLoading && !subjectsError && subjects.length === 0 && classSelected && (
                    <StatusMessage variant="info">No subjects found for {formatClassName(department, year, section)}.</StatusMessage>
                  )}
                  {!subjectsLoading && !subjectsError && subjects.length > 0 && (
                    <select
                      className="cf-select mt-1 w-full"
                      value={selectedSubject?.subject_code ?? ''}
                      onChange={(e) => {
                        const subj = subjects.find((s) => s.subject_code === e.target.value)
                        if (subj) setSelectedSubject(subj)
                      }}
                      disabled={sessionInProgress || !classSelected || subjectsLoading}
                    >
                      <option value="" disabled>Select subject</option>
                      {subjects.map((subject) => (
                        <option key={subject.subject_code} value={subject.subject_code}>
                          {subject.subject_code} - {subject.subject_name}
                        </option>
                      ))}
                    </select>
                  )}
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
                        {formatClassName(session.department, session.year, session.section)}
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
                      {formatClassName(session.department, session.year, session.section)}
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
                      <b>Pick class &amp; subject</b>
                      <span>Year, department, section, period and subject.</span>
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
