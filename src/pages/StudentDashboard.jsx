import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatChip from '../components/StatChip'
import OTPInput from '../components/OTPInput'
import LoadingButton from '../components/LoadingButton'
import StatusMessage from '../components/StatusMessage'
import { verifyAttendanceOTP } from '../api/attendanceApi'
import { formatClassName, formatDate } from '../utils/format'
import { resolveDepartment } from '../utils/department'
import { isValidOTP } from '../utils/validation'
import { verifyOtpErrorMessage, notConfiguredMessage } from '../utils/messages'
import { useAuth } from '../hooks/useAuth'
import { useClock } from '../hooks/useClock'
import {
  CheckIcon,
  StudentIcon,
  BookIcon,
  CalendarIcon,
  FingerprintIcon,
  ClockIcon,
} from '../components/Icons'

/*
 * Marking attendance: the OTP box, and nothing before it.
 *
 * This page used to open with a "Select Your Class" card -- three dropdowns for
 * department, year and section -- and only revealed the OTP form once they were filled
 * in. That asked a signed-in student to state facts the server already knew, and the
 * answers were not trusted anyway:
 *
 *   - the department, year and section were only used to decide whether to *show* the
 *     form. They were never sent;
 *   - `verifyOtp` posts `{ otp }` and nothing else, so the student ID collected here was
 *     dropped in the API client and never reached the Worker;
 *   - `/api/attendance/verify` reads only `otp` from the body and resolves the student
 *     from the session, then checks that student's *own* year and section against the
 *     attendance session's.
 *
 * So every control on this page other than the OTP was decorative. They are gone rather
 * than hidden: there is no longer a step, so there is nothing to get past, and no way
 * for the page to look broken by rendering an empty class selector.
 *
 * Nothing about the backend changed. OTP generation, expiry, verification, the
 * attendance-session lookup, the class match, PRESENT marking, duplicate prevention and
 * the finalising cron are all exactly as they were, and none of them ever read a
 * department or section from the browser.
 */

export default function StudentDashboard() {
  const BACKEND_CONFIGURED = Boolean(import.meta.env.VITE_API_BASE_URL)
  const clock = useClock()
  const navigate = useNavigate()
  const { student } = useAuth()

  const [otp, setOtp] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [formError, setFormError] = useState(null)
  const [verifyError, setVerifyError] = useState(null)
  const [locked, setLocked] = useState(false)
  const [result, setResult] = useState(null)
  const [marks, setMarks] = useState([])

  const handleSubmit = async () => {
    if (!isValidOTP(otp)) {
      setFormError('Please enter the complete 6-digit OTP.')
      return
    }

    setFormError(null)
    setVerifyError(null)
    setVerifying(true)
    try {
      const data = await verifyAttendanceOTP({ otp })
      setResult(data)
      setLocked(true)
      setMarks((prev) => [
        ...prev,
        {
          student: data.student,
          attendance: data.attendance,
          markedAt: new Date(),
        },
      ])
    } catch (err) {
      const mapped = verifyOtpErrorMessage(err)
      setVerifyError(mapped)
      if (err.message === 'Attendance already marked' || err.message === 'No active attendance session') {
        setLocked(true)
      }
      setOtp('')
    } finally {
      setVerifying(false)
    }
  }

  const inputDisabled = verifying || locked || Boolean(result)

  /*
   * The class is shown rather than chosen, and it comes from the session the same way
   * the server gets it. With no dropdowns to fall back on, an unauthenticated visitor
   * sees "unknown" instead of being offered a menu of classes that would not have been
   * believed.
   */
  const selectedClass = student
    ? formatClassName(student.department, student.year, student.section)
    : '—'
  const status = result ? 'Marked' : locked ? 'Locked' : 'Ready'
  const statusTone = result ? 'green' : locked ? 'amber' : 'primary'

  return (
    <div className="app-shell">
      <Navbar title="Student Dashboard" subtitle="Mark your attendance using OTP" />
      <main className="container-cf py-4 lg:py-5 page-enter">
        {!BACKEND_CONFIGURED && (
          <div className="mb-4">
            <StatusMessage variant={notConfiguredMessage().variant}>
              {notConfiguredMessage().text}
            </StatusMessage>
          </div>
        )}

        <DashboardHero
          icon={<StudentIcon size={26} />}
          title="Student Dashboard"
          subtitle={`${clock.greeting} — mark your attendance with the OTP shared by your staff.`}
          right={
            <div className="live-clock">
              <div className="time">{clock.time}</div>
              <div className="date">{clock.date}</div>
            </div>
          }
        />

        <div className="stat-strip stagger">
          <StatChip
            icon={<BookIcon size={18} />}
            label="Class"
            value={selectedClass}
            tone="violet"
          />
          <StatChip
            icon={<CheckIcon size={18} />}
            label="Marks today"
            value={marks.length}
            tone="green"
          />
          <StatChip
            icon={<FingerprintIcon size={18} />}
            label="Status"
            value={status}
            tone={statusTone}
          />
        </div>

        {/*
          Centred for the same reason as the mentor and OD pages: the card is a fixed
          number of columns inside a twelve-column grid, and `justify-items` is what
          centres it within the row. `justify-content` had no free space to move it,
          because twelve equal tracks already fill the row.
        */}
        <div className="grid grid-cols-12 justify-items-center">
          <div className="col-span-12 lg:col-span-8 xl:col-span-7 w-full">
            {result ? (
              <div className="cf-card p-4 md:p-5 text-center mt-4 page-enter">
                <div className="success-wrap">
                  <span className="success-ring" aria-hidden="true" />
                  <div className="success-check" aria-hidden="true">
                    <CheckIcon size={42} />
                  </div>
                </div>
                <div className="success-badge mb-2">Attendance Marked</div>
                <h3 className="text-2xl font-bold mb-1">You&rsquo;re marked PRESENT</h3>
                <p className="text-muted-2 mb-4">Your attendance has been recorded successfully.</p>

                <div className="result-grid text-left mb-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2">
                    <div className="result-cell">
                      <div className="label">Student</div>
                      <div className="value">{result.student?.student_name}</div>
                    </div>
                    <div className="result-cell">
                      <div className="label">Department</div>
                      <div className="value">{resolveDepartment(result.student)}</div>
                    </div>
                    <div className="result-cell">
                      <div className="label">
                        <CalendarIcon size={13} className="me-1" />
                        Date
                      </div>
                      <div className="value">{formatDate(result.attendance?.attendance_date)}</div>
                    </div>
                    <div className="result-cell">
                      <div className="label">Status</div>
                      <div className="value text-success">PRESENT</div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-2 justify-center">
                  <LoadingButton variant="primary" onClick={() => navigate('/role-selection')}>
                    Done
                  </LoadingButton>
                </div>
              </div>
            ) : (
              <div className="cf-card p-3 md:p-4 page-enter reveal reveal-1">
                <div className="class-badge mb-3">
                  <FingerprintIcon size={15} />
                  {selectedClass}
                </div>

                <h2 className="section-title mb-1">Mark Attendance</h2>
                <p className="text-muted-2 text-sm mb-4">
                  Enter the 6-digit OTP your staff shared for this period.
                </p>

                {/*
                  No student ID field.

                  `verifyOtp` posts `{ otp }` and nothing else, so the value this input
                  used to collect was discarded in the API client and never reached the
                  Worker. The Worker identifies the student from the session cookie and
                  matches their own year and section against the attendance session's, so
                  there was never a security value here -- only a field that asked a
                  signed-in student to retype something the request already carried.
                */}
                <div className="mb-2">
                  <label className="cf-form-label">OTP</label>
                  <OTPInput
                    value={otp}
                    onChange={(value) => {
                      setOtp(value)
                      setFormError(null)
                      setVerifyError(null)
                    }}
                    disabled={inputDisabled}
                  />
                </div>

                {formError && (
                  <div className="mt-3">
                    <StatusMessage variant="danger">{formError}</StatusMessage>
                  </div>
                )}
                {verifyError && (
                  <div className="mt-3">
                    <StatusMessage variant={verifyError.variant}>{verifyError.text}</StatusMessage>
                  </div>
                )}

                <div className="mt-4">
                  <LoadingButton
                    variant="primary"
                    onClick={handleSubmit}
                    loading={verifying}
                    loadingText="Verifying…"
                    disabled={inputDisabled}
                    className="w-full inline-flex items-center justify-center gap-2"
                  >
                    <CheckIcon size={17} />
                    Submit OTP
                  </LoadingButton>
                </div>
              </div>
            )}

            {marks.length > 0 && (
              <div className="cf-list-card mt-4 reveal reveal-2">
                <div className="cf-card-header px-3 pt-3 pb-2 mb-0">
                  <div>
                    <h3 className="section-title">Marks recorded today</h3>
                    <p className="text-muted-2 text-sm mb-0">Your verified attendance entries</p>
                  </div>
                  <span className="cf-status-pill active">
                    <span className="dot" aria-hidden="true" /> {marks.length}
                  </span>
                </div>
                <div>
                  {marks.map((item, index) => (
                    <div className="cf-list-item" key={`${item.attendance?.attendance_id ?? index}`}>
                      <span className="cf-list-icon green">
                        <CheckIcon size={17} />
                      </span>
                      <div className="cf-list-meta">
                        <div className="title">{item.student?.student_name}</div>
                        <div className="sub">
                          {item.student?.register_no} · {resolveDepartment(item.student)} ·{' '}
                          {formatDate(item.attendance?.attendance_date)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-success uppercase text-sm">Present</div>
                        <div className="text-muted-2 text-sm">Period {item.attendance?.period}</div>
                      </div>
                      <ClockIcon size={15} className="text-muted-2" />
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