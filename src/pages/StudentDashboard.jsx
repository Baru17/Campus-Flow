import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatChip from '../components/StatChip'
import DropdownField from '../components/DropdownField'
import OTPInput from '../components/OTPInput'
import LoadingButton from '../components/LoadingButton'
import StatusMessage from '../components/StatusMessage'
import { verifyAttendanceOTP } from '../api/attendanceApi'
import { BACKEND_CONFIGURED } from '../api/supabase'
import { DEPARTMENTS, YEARS, SECTIONS } from '../constants'
import { formatClassName, formatDate } from '../utils/format'
import { isValidOTP, isValidStudentId, normalizeStudentId } from '../utils/validation'
import { verifyOtpErrorMessage, notConfiguredMessage } from '../utils/messages'
import { useClock } from '../hooks/useClock'
import {
  CheckIcon,
  KeyIcon,
  StudentIcon,
  BookIcon,
  CalendarIcon,
  FingerprintIcon,
  ClockIcon,
  SparklesIcon,
} from '../components/Icons'

export default function StudentDashboard() {
  const clock = useClock()
  const navigate = useNavigate()

  const [department, setDepartment] = useState('')
  const [year, setYear] = useState('')
  const [section, setSection] = useState('')

  const [studentId, setStudentId] = useState('')
  const [otp, setOtp] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [formError, setFormError] = useState(null)
  const [verifyError, setVerifyError] = useState(null)
  const [locked, setLocked] = useState(false)
  const [result, setResult] = useState(null)
  const [marks, setMarks] = useState([])

  const classSelected = Boolean(department && year && section)

  const handleSubmit = async () => {
    const id = normalizeStudentId(studentId)

    if (!isValidStudentId(id)) {
      setFormError('Please enter a valid student ID.')
      return
    }
    if (!isValidOTP(otp)) {
      setFormError('Please enter the complete 6-digit OTP.')
      return
    }

    setFormError(null)
    setVerifyError(null)
    setVerifying(true)
    try {
      const data = await verifyAttendanceOTP({ student_id: id, otp })
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

  const resetForAnother = () => {
    setResult(null)
    setLocked(false)
    setOtp('')
    setStudentId('')
    setFormError(null)
    setVerifyError(null)
  }

  const inputDisabled = verifying || locked || Boolean(result)

  const selectedClass = classSelected ? formatClassName(department, year, section) : '—'
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

        <div className="grid grid-cols-12 justify-center">
          <div className="col-span-12 lg:col-span-8 xl:col-span-7">
            <div className="cf-card cf-card-hover p-3 md:p-4">
              <div className="cf-card-header">
                <div>
                  <h2 className="section-title">Select Your Class</h2>
                  <p className="text-muted-2 text-sm mb-0">Choose your department, year and section.</p>
                </div>
                <span className="cf-icon-badge violet">
                  <BookIcon size={22} />
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <DropdownField
                    label="Department"
                    name="department"
                    value={department}
                    onChange={setDepartment}
                    options={DEPARTMENTS}
                    placeholder="Select department"
                    disabled={Boolean(result)}
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
                    disabled={Boolean(result)}
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
                    disabled={Boolean(result)}
                  />
                </div>
              </div>
            </div>

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
                      <div className="value">{result.student?.department}</div>
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
                  <LoadingButton variant="outline" onClick={resetForAnother}>
                    Mark Another Student
                  </LoadingButton>
                </div>
              </div>
            ) : (
              classSelected && (
                <div className="cf-card p-3 md:p-4 mt-4 page-enter reveal reveal-1">
                  <div className="class-badge mb-3">
                    <FingerprintIcon size={15} />
                    {formatClassName(department, year, section)}
                  </div>

                  <h2 className="section-title mb-1">Mark Attendance</h2>
                  <p className="text-muted-2 text-sm mb-4">Enter your student ID and the 6-digit OTP.</p>

                  <div className="mb-3">
                    <label htmlFor="studentId" className="cf-form-label">
                      <KeyIcon size={15} className="text-muted-2" />
                      Student ID
                    </label>
                    <div className="cf-input-group-custom">
                      <span className="cf-input-icon" aria-hidden="true">
                        <KeyIcon size={16} />
                      </span>
                      <input
                        id="studentId"
                        className="cf-input"
                        value={studentId}
                        onChange={(e) => {
                          setStudentId(e.target.value)
                          setFormError(null)
                          setVerifyError(null)
                        }}
                        placeholder="e.g. 2K24IT001"
                        disabled={inputDisabled}
                        autoComplete="off"
                        inputMode="text"
                      />
                    </div>
                  </div>

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
              )
            )}

            {!classSelected && !result && (
              <div className="cf-empty mt-4">
                <span className="cf-empty-icon">
                  <SparklesIcon size={30} />
                </span>
                <h3 className="section-title mb-0">Pick your class to begin</h3>
                <p className="text-muted-2 mb-0">Marking attendance only takes a few seconds.</p>
                <div className="steps">
                  <div className="step">
                    <span className="step-num">1</span>
                    <div className="step-text">
                      <b>Select your class</b>
                      <span>Department, year and section.</span>
                    </div>
                  </div>
                  <div className="step">
                    <span className="step-num">2</span>
                    <div className="step-text">
                      <b>Ask staff for the OTP</b>
                      <span>Your staff generates a 6-digit OTP for the session.</span>
                    </div>
                  </div>
                  <div className="step">
                    <span className="step-num">3</span>
                    <div className="step-text">
                      <b>Enter ID &amp; OTP</b>
                      <span>Submit within 15 seconds to be marked PRESENT.</span>
                    </div>
                  </div>
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
                          {item.student?.register_no} · {item.student?.department} ·{' '}
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