import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AttendanceSuccess from '../components/AttendanceSuccess'
import BrandPanel from '../components/BrandPanel'
import { ChevronLeftIcon, FingerprintIcon, LogoIcon } from '../components/Icons'
import OtpInput from '../components/OtpInput'
import RoleSelection from '../components/RoleSelection'
import StaffLogin from '../components/StaffLogin'
import StatusMessage from '../components/StatusMessage'
import StudentLogin from '../components/StudentLogin'
import { verifyAttendanceOTP } from '../api/attendanceApi'
import { OTP_LENGTH } from '../constants'
import { isValidOTP } from '../utils/validation'
import { verifyOtpErrorMessage } from '../utils/messages'

export default function AuthPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState('roles')
  const [studentId, setStudentId] = useState('')
  const [otp, setOtp] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const goRoles = () => {
    setError(null)
    setStep('roles')
  }

  const handleStaffLogin = () => {
    navigate('/staff')
  }

  const handleStudentContinue = (id) => {
    setStudentId(id)
    setOtp('')
    setError(null)
    setStep('otp')
  }

  const handleSubmitOtp = async () => {
    if (!isValidOTP(otp)) {
      setError({ variant: 'danger', text: 'Please enter the complete 6-digit OTP.' })
      return
    }
    setError(null)
    setVerifying(true)
    try {
      const data = await verifyAttendanceOTP({ student_id: studentId, otp })
      setResult(data)
      setStep('success')
    } catch (err) {
      setError(verifyOtpErrorMessage(err))
      setOtp('')
    } finally {
      setVerifying(false)
    }
  }

  const handleAnother = () => {
    setResult(null)
    setOtp('')
    setStudentId('')
    setError(null)
    setStep('student-id')
  }

  const canSubmitOtp = otp.length === OTP_LENGTH && !verifying

  const renderStage = () => {
    switch (step) {
      case 'staff-login':
        return <StaffLogin key="staff" onBack={goRoles} onLogin={handleStaffLogin} />
      case 'student-id':
        return <StudentLogin key="sid" onBack={goRoles} onContinue={handleStudentContinue} />
      case 'otp':
        return (
          <div key="otp" className="stage-enter flex flex-col">
            <button
              type="button"
              onClick={() => setStep('student-id')}
              className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
            >
              <ChevronLeftIcon size={16} />
              Back to student ID
            </button>

            <div className="mt-6 flex items-center gap-3">
              <span className="auth-step-icon">
                <FingerprintIcon size={22} />
              </span>
              <div>
                <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
                  Enter Attendance OTP
                </h1>
                <p className="mt-0.5 text-sm text-slate-500">
                  Enter the 6-digit OTP displayed by your staff.
                </p>
              </div>
            </div>

            <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50/60 p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Student
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-700">
                  {studentId}
                </span>
              </div>

              <OtpInput
                value={otp}
                onChange={(value) => {
                  setOtp(value)
                  setError(null)
                }}
                disabled={verifying}
                error={Boolean(error)}
              />

              <p className="mt-3 text-center text-xs text-slate-400">
                The OTP is valid for a short time — enter it promptly.
              </p>
            </div>

            {error && (
              <div className="mt-4">
                <StatusMessage variant={error.variant}>{error.text}</StatusMessage>
              </div>
            )}

            <div className="mt-6">
              <button
                type="button"
                onClick={handleSubmitOtp}
                disabled={!canSubmitOtp}
                className="auth-btn-primary w-full"
              >
                {verifying ? (
                  <>
                    <span className="cf-spinner" role="status" aria-hidden="true" />
                    Verifying…
                  </>
                ) : (
                  <>
                    <FingerprintIcon size={17} />
                    Submit OTP
                  </>
                )}
              </button>
            </div>
          </div>
        )
      default:
        return (
          <AttendanceSuccess
            key="success"
            result={result}
            onDone={goRoles}
            onAnother={handleAnother}
          />
        )
    }
  }

  return (
    <div className="page-enter flex min-h-screen items-center justify-center px-4 py-8 lg:py-10">
      <div className="grid w-full max-w-[1100px] grid-cols-1 overflow-hidden rounded-[32px] border border-slate-200/60 bg-white shadow-[0_32px_90px_rgba(2,6,23,0.16)] lg:h-[88vh] lg:max-h-[860px] lg:min-h-[640px] lg:grid-cols-2">
        <section className="relative flex flex-col overflow-y-auto p-6 sm:p-9 lg:p-12">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={goRoles}
              className="group flex items-center gap-2.5"
              aria-label="Campus-Flow home"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-linear-to-br from-blue-600 to-violet-600 text-white shadow-lg shadow-blue-600/25 transition-shadow group-hover:shadow-blue-600/40">
                <LogoIcon size={20} />
              </span>
              <span className="text-lg font-extrabold tracking-tight text-slate-900">
                Campus-
                <span className="bg-linear-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
                  Flow
                </span>
              </span>
            </button>
            <span className="hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-bold text-emerald-700 sm:inline-flex">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
              Secure • OTP Verified
            </span>
          </div>

          <div className="flex flex-1 flex-col justify-center py-8">
            {step === 'roles' ? (
              <RoleSelection
                key="roles"
                onStaff={() => setStep('staff-login')}
                onStudent={() => setStep('student-id')}
              />
            ) : (
              renderStage()
            )}
          </div>

          <p className="text-center text-xs text-slate-400">
            {new Date().getFullYear()} © Campus-Flow · Secure OTP-based attendance management
          </p>
        </section>

        <BrandPanel />
      </div>
    </div>
  )
}