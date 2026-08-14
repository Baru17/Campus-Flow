import { useEffect, useState } from 'react'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatChip from '../components/StatChip'
import DropdownField from '../components/DropdownField'
import LoadingButton from '../components/LoadingButton'
import StatusMessage from '../components/StatusMessage'
import OTPDisplay from '../components/OTPDisplay'
import { generateAttendanceOTP, getSubjects } from '../api/attendanceApi'
import { BACKEND_CONFIGURED } from '../api/supabase'
import { DEPARTMENTS, YEARS, SECTIONS, PERIODS, DEFAULT_STAFF_ID } from '../constants'
import { formatClassName } from '../utils/format'
import { generateOtpErrorMessage, notConfiguredMessage } from '../utils/messages'
import { useClock } from '../hooks/useClock'
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

const SUBJECT_PLACEHOLDER = 'Select subject'

export default function StaffDashboard() {
  const clock = useClock()

  const [department, setDepartment] = useState('')
  const [year, setYear] = useState('')
  const [section, setSection] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [period, setPeriod] = useState('')

  const [subjects, setSubjects] = useState([])
  const [subjectsLoading, setSubjectsLoading] = useState(false)
  const [subjectsError, setSubjectsError] = useState(null)

  const [session, setSession] = useState(null)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState(null)
  const [recentSessions, setRecentSessions] = useState([])

  const classSelected = Boolean(department && year && section)
  const sessionInProgress = Boolean(session && !sessionExpired)

  useEffect(() => {
    if (!classSelected) {
      setSubjects([])
      setSubjectsError(null)
      setSubjectId('')
      return undefined
    }
    let cancelled = false
    setSubjectsLoading(true)
    setSubjectsError(null)
    setSubjectId('')
    getSubjects(department, year, section)
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

  const canGenerate =
    classSelected && Boolean(subjectId) && Boolean(period) && !generating && !sessionInProgress

  const handleGenerate = async () => {
    setGenerateError(null)
    setSession(null)
    setSessionExpired(false)
    setGenerating(true)
    try {
      const data = await generateAttendanceOTP({
        staff_id: DEFAULT_STAFF_ID,
        department,
        year: Number(year),
        section,
        subject_id: Number(subjectId),
        period: Number(period),
      })
      const subject = subjects.find((s) => s.subject_id === Number(subjectId))
      const subjectLabel = subject
        ? `${subject.subject_code} ${subject.subject_name}`
        : `Subject ${subjectId}`
      setSession(data)
      setRecentSessions((prev) => [
        {
          key: data.session.session_id,
          label: subjectLabel,
          className: formatClassName(department, year, section),
          period: data.session.period,
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

  const handleExpire = () => {
    setSessionExpired(true)
    setRecentSessions((prev) => prev.map((item, index) => (index === 0 ? { ...item, expired: true } : item)))
  }

  const subjectOptions = subjects.map((subject) => ({
    value: subject.subject_id,
    label: `${subject.subject_code} - ${subject.subject_name}`,
  }))

  const selectedClass = classSelected ? formatClassName(department, year, section) : '—'
  const sessionStatus = sessionInProgress ? 'Active' : session ? 'Expired' : 'Idle'
  const sessionTone = sessionInProgress ? 'green' : session ? 'amber' : 'primary'

  return (
    <div className="app-shell">
      <Navbar title="Staff Dashboard" subtitle="Generate and manage attendance sessions" />
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
          subtitle={`${clock.greeting} — manage attendance sessions for your classes.`}
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
                    label="Department"
                    name="department"
                    value={department}
                    onChange={setDepartment}
                    options={DEPARTMENTS}
                    placeholder="Select department"
                    disabled={sessionInProgress}
                  />
                </div>
                <div>
                  <DropdownField
                    label="Year"
                    name="year"
                    value={year}
                    onChange={setYear}
                    options={YEARS}
                    placeholder="Select year"
                    disabled={sessionInProgress}
                  />
                </div>
                <div>
                  <DropdownField
                    label="Section"
                    name="section"
                    value={section}
                    onChange={setSection}
                    options={SECTIONS}
                    placeholder="Select section"
                    disabled={sessionInProgress}
                  />
                </div>
                <div>
                  <DropdownField
                    label="Period"
                    name="period"
                    value={period}
                    onChange={setPeriod}
                    options={PERIODS}
                    placeholder="Select period"
                    disabled={sessionInProgress}
                    icon={<ClockIcon size={15} />}
                  />
                </div>
                <div className="sm:col-span-2">
                  <DropdownField
                    label="Subject"
                    name="subject"
                    value={subjectsLoading ? '' : subjectId}
                    onChange={setSubjectId}
                    options={subjectOptions}
                    placeholder={subjectsLoading ? 'Loading subjects…' : SUBJECT_PLACEHOLDER}
                    disabled={sessionInProgress || !classSelected || subjectsLoading}
                    icon={<KeyIcon size={15} />}
                  />
                  {subjectsLoading && (
                    <div className="cf-loading-inline mt-1">
                      <span className="cf-spinner" role="status" aria-hidden="true" />
                      Loading subjects…
                    </div>
                  )}
                  {subjectsError && <StatusMessage variant="danger">{subjectsError.message}</StatusMessage>}
                  {classSelected && !subjectsLoading && !subjectsError && subjects.length === 0 && (
                    <StatusMessage variant="info">
                      No subjects found for {formatClassName(department, year, section)}.
                    </StatusMessage>
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
                  key={session.session.session_id}
                  otp={session.otp}
                  expiresAt={session.expires_at}
                  running={!sessionExpired}
                  onExpire={handleExpire}
                />

                <div className="cf-card p-3 md:p-4 mt-4 reveal reveal-2">
                  <div className="cf-card-header">
                    <div>
                      <h3 className="section-title">Session Summary</h3>
                      <p className="text-muted-2 text-sm mb-0">
                        {formatClassName(
                          session.session?.department,
                          session.session?.year,
                          session.session?.section,
                        )}
                        {' · '}
                        Period {session.session?.period}
                      </p>
                    </div>
                    {sessionInProgress ? (
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
                      {formatClassName(
                        session.session?.department,
                        session.session?.year,
                        session.session?.section,
                      )}
                    </span>
                  </div>
                  <div className="cf-detail-row">
                    <span className="cf-detail-label">
                      <ClockIcon size={15} /> Period
                    </span>
                    <span className="cf-detail-value">{session.session?.period}</span>
                  </div>
                  <div className="cf-detail-row">
                    <span className="cf-detail-label">
                      <FingerprintIcon size={15} /> Expires
                    </span>
                    <span className="cf-detail-value">
                      {new Date(session.expires_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  {sessionExpired && (
                    <div className="mt-3">
                      <StatusMessage variant="info">
                        OTP expired. The session is being finalized automatically by the system.
                      </StatusMessage>
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
                      <span>Department, year, section, period and subject.</span>
                    </div>
                  </div>
                  <div className="step">
                    <span className="step-num">2</span>
                    <div className="step-text">
                      <b>Generate OTP</b>
                      <span>A 6-digit OTP valid for 15 seconds is created.</span>
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