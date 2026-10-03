import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AttendanceSuccess from '../components/AttendanceSuccess'
import BrandPanel from '../components/BrandPanel'
import { ChevronLeftIcon, FingerprintIcon, LogoIcon } from '../components/Icons'
import OTPInput from '../components/OTPInput'
import RoleSelection from '../components/RoleSelection'
import StaffLogin from '../components/StaffLogin'
import StatusMessage from '../components/StatusMessage'
import StudentLogin from '../components/StudentLogin'
import { verifyAttendanceOTP } from '../api/attendanceApi'
import { getAdvisorAssignment } from '../api/classAdvisorApi'
import { getCurrentStudent, getCurrentUser } from '../api/authApi'
import { approverLogin } from '../api/odApi'
import { OTP_LENGTH } from '../constants'
import { useAuth } from '../hooks/useAuth'
import { useStaffAuth } from '../hooks/useStaffAuth'
import { isValidOTP } from '../utils/validation'
import { verifyOtpErrorMessage } from '../utils/messages'

export default function AuthPage() {
  const navigate = useNavigate()
  const { student: authenticatedStudent } = useAuth()
  const { refresh: refreshStaffSession } = useStaffAuth()
  const [step, setStep] = useState('roles')
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

  const handleAdvisorLogin = async (staff) => {
    const assignment = await getAdvisorAssignment(staff.staff_id)
    if (!assignment) {
      throw new Error('This account is not assigned as a Class Advisor. Please contact the administrator.')
    }
    navigate('/advisor')
  }

  /*
   * A contest coordinator and a head of department authenticate through the existing
   * approver endpoint rather than the staff one.
   *
   * `/api/auth/staff/login` would accept a coordinator -- their account role *is* `staff`,
   * because they are appointed out of the staff roster and reuse that login -- but it
   * refuses an HOD, whose role is `hod` and who has no staff record at all. Rather than
   * special-case one of the two, both go through `/api/auth/od-approver/login`, which is the
   * endpoint `/approver/login` already uses, issues the same session cookie as every other
   * login, and checks the caller's directory row on the server. This is a change of which
   * existing door they knock on, not a new authentication mechanism.
   */
  const authenticateAsApprover = (identifier, password) => approverLogin(identifier, password)

  /*
   * Where each of the two lands, and the check that decides it.
   *
   * The role comes from `result.approver.role`, which is the role the *server* resolved from
   * the caller's directory row -- not the button that was pressed and not `auth_users.role`.
   * That distinction is what puts a coordinator on the coordinator dashboard: their account
   * role is `staff`, so routing on the account role would send them to the staff dashboard
   * and away from the queue they exist for.
   *
   * So an HOD who signs in on the coordinator form is refused here, with a sentence saying
   * why, rather than being carried to a screen that would tell them it is not theirs. The
   * server already refuses anything that is not a coordinator at all; this closes the gap
   * between "some approver" and "this approver".
   */
  const handleApproverLogin = (expectedRole, home, expectedLabel) => async (result) => {
    const role = result?.approver?.role
    if (role !== expectedRole) {
      throw new Error(`This account is not a ${expectedLabel}. Please contact the administrator.`)
    }

    /*
     * A coordinator is on the staff roster as well, so their staff dashboard has to keep
     * working -- they keep the `staff` account and the staff login it goes with. That
     * provider mounted before this page and has already settled on "signed out", so it is
     * asked to re-read the session first; without this they would land on a dashboard that
     * signs them straight back out. An HOD has no staff context to refresh: their dashboard
     * reads the approver session itself.
     */
    if (expectedRole === 'contest_coordinator') {
      await refreshStaffSession()
    }

    navigate(home)
  }

  /*
   * A successful student login goes to the entry screen, not to an OTP box.
   *
   * The OTP page is still reachable -- it is the "Mark Attendance" option from there --
   * but it is no longer the next thing a signed-in student sees, because attendance is
   * one of three things they might want and it was being presented as the only one.
   *
   * The session already exists by this point: `StudentLogin` calls `/api/auth/login`
   * before calling `onContinue`, so navigating is safe and the entry screen can read
   * the student's own record straight away.
   *
   * The inline `otp` and `success` stages below are left in place. Nothing in this flow
   * reaches them now, but they are the same OTP path the entry screen links to, and
   * removing working code to tidy a navigation decision is not a trade worth making.
   */
  const handleStudentContinue = () => {
    navigate('/student/entry')
  }

  const handleSubmitOtp = async () => {
    if (!isValidOTP(otp)) {
      setError({ variant: 'danger', text: 'Please enter the complete 6-digit OTP.' })
      return
    }
    setError(null)
    setVerifying(true)
    try {
      const currentUser = await getCurrentUser()
      if (!currentUser) {
        setError({
          variant: 'warning',
          text: 'The server did not receive a valid student session. Sign in again; if this persists, check that your browser allows this site to store cookies.',
        })
        return
      }
      const currentStudent = currentUser?.role === 'student'
        ? await getCurrentStudent(currentUser.id)
        : null

      if (!currentStudent) {
        setError({
          variant: currentUser.role === 'student' ? 'danger' : 'warning',
          text: currentUser.role === 'student'
            ? 'Your signed-in account has no linked student record. Contact the administrator.'
            : 'Sign in with a student account before submitting this OTP.',
        })
        return
      }

      const expectedStudentId = authenticatedStudent?.student_id || ''
      if (currentStudent.student_id.toUpperCase() !== expectedStudentId.toUpperCase()) {
        setError({
          variant: 'warning',
          text: `This tab is signed in as ${currentStudent.student_id}, not ${expectedStudentId}. Sign in as the displayed student again before submitting.`,
        })
        return
      }

      const data = await verifyAttendanceOTP({ student_id: currentStudent.student_id, otp })
      setResult(data)
      setStep('success')
    } catch (err) {
      setError(verifyOtpErrorMessage(err))
      setOtp('')
    } finally {
      setVerifying(false)
    }
  }

  const canSubmitOtp = otp.length === OTP_LENGTH && !verifying

  const renderStage = () => {
    switch (step) {
      case 'staff-login':
        return <StaffLogin key="staff" onBack={goRoles} onLogin={handleStaffLogin} />
      case 'advisor-login':
        return (
          <StaffLogin
            key="advisor"
            title="Class Advisor Login"
            subtitle="Sign in to view and manage your class attendance and reports."
            onBack={goRoles}
            onLogin={handleAdvisorLogin}
          />
        )
      case 'student-login':
        return <StudentLogin key="sid" onBack={goRoles} onContinue={handleStudentContinue} />
      case 'coordinator-login':
        return (
          <StaffLogin
            key="coordinator"
            title="Contest Coordinator Login"
            subtitle="Sign in to review the OD requests waiting on your department."
            authenticate={authenticateAsApprover}
            identifier={{
              label: 'Email address',
              placeholder: 'e.g. vinothkumar@kiot.ac.in',
              hint: 'Sign in with the staff email you were appointed on.',
              requiredMessage: 'Please enter your email address.',
            }}
            onBack={goRoles}
            onLogin={handleApproverLogin('contest_coordinator', '/coordinator', 'Contest Coordinator')}
          />
        )
      case 'hod-login':
        return (
          <StaffLogin
            key="hod"
            title="HOD Login"
            subtitle="Sign in to give the final approval on your department's OD requests."
            authenticate={authenticateAsApprover}
            identifier={{
              label: 'Email address',
              placeholder: 'e.g. hod.name@kiot.ac.in',
              hint: 'Sign in with the email address your administrator registered for this role.',
              requiredMessage: 'Please enter your email address.',
            }}
            onBack={goRoles}
            onLogin={handleApproverLogin('hod', '/hod', 'Head of Department')}
          />
        )
      case 'otp':
        return (
          <div key="otp" className="stage-enter flex flex-col">
            <button
              type="button"
              onClick={() => setStep('student-login')}
              className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
            >
              <ChevronLeftIcon size={16} />
              Back to student login
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
                  {authenticatedStudent?.student_id || ''}
                </span>
              </div>

              <OTPInput
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
                onStudent={() => setStep('student-login')}
                onAdvisor={() => setStep('advisor-login')}
                onCoordinator={() => setStep('coordinator-login')}
                onHod={() => setStep('hod-login')}
                onAdmin={() => navigate('/admin')}
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