import { useState } from 'react'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  KeyIcon,
  LockIcon,
  ShieldIcon,
} from './Icons'
import { ApiError } from '../api/attendanceApi'
import { useStaffAuth } from '../hooks/useStaffAuth'

/**
 * The email-or-ID + password sign-in form, used by every role that signs in on this screen.
 *
 * Four roles use it now: a member of staff, a class advisor, a contest coordinator and a
 * head of department. The first two have always used it; the second two are added with
 * `authenticate` and `identifier` below, and both are optional with the original values as
 * their defaults -- so the staff and class-advisor flows are byte-for-byte the same code
 * path as before, and the two new roles reuse this form's layout, spacing, fields,
 * validation and visual design rather than getting a second one.
 *
 * ## `authenticate`
 *
 * The function that actually checks the credentials, `(identifier, password) => Promise`.
 * It defaults to the staff login in the staff context, which is the only thing that needs
 * to change for a coordinator or an HOD:
 *
 *   - a coordinator's account role *is* `staff` -- they are appointed out of the staff
 *     roster and reuse that login -- so `/api/auth/staff/login` would accept them.
 *   - a head of department's account role is `hod`, which that route refuses.
 *
 * Rather than special-case that, both go through the existing approver endpoint,
 * `/api/auth/od-approver/login`, which issues the same session cookie as every other login
 * and checks the caller's directory row on the server. This is the same authentication
 * `/approver/login` already uses, so there is no second mechanism.
 *
 * Whatever it returns is passed to `onLogin`, which is how the caller knows who signed in:
 * the staff flow gets a staff record, and the approver flow gets the server's own answer
 * about the role -- the caller must read the role from there and not assume the button that
 * was pressed decided anything.
 */
export default function StaffLogin({
  onBack,
  onLogin,
  title = 'Staff Login',
  subtitle,
  authenticate,
  identifier,
}) {
  const { login, resetPassword } = useStaffAuth()
  const [staffEmail, setStaffEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const [forgotMode, setForgotMode] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotMessage, setForgotMessage] = useState(null)
  const [forgotError, setForgotError] = useState(null)
  const [forgotLoading, setForgotLoading] = useState(false)

  /*
   * The label, placeholder and wording of the first field.
   *
   * Every one of these defaults to the staff wording, because for a member of staff that
   * wording is correct and must not change. A contest coordinator signs in with the same
   * staff address they already use, so they keep the same label. A head of department has
   * no staff record at all, so theirs is named for what it actually is.
   */
  const identifierLabel = identifier?.label ?? 'Staff Email or Staff ID'
  const identifierPlaceholder = identifier?.placeholder ?? 'e.g. arun.kumar@kiot.ac.in'
  const identifierHint =
    identifier?.hint ??
    'Sign in with your staff email. Staff ID login is only available when your ID can be resolved securely.'
  const identifierRequiredMessage =
    identifier?.requiredMessage ?? 'Please enter your staff email or staff ID.'

  // The staff login unless this role authenticates somewhere else.
  const submitCredentials = authenticate || login

  const handleSubmit = async (event) => {
    event.preventDefault()
    const entered = staffEmail.trim()
    if (!entered) {
      setError(identifierRequiredMessage)
      return
    }
    if (!password) {
      setError('Please enter your password.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const account = await submitCredentials(entered, password)
      await onLogin(account)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err?.message || 'Unable to log in right now. Please try again.'
      )
    } finally {
      setLoading(false)
    }
  }

  const openForgot = () => {
    setForgotMode(true)
    setForgotMessage(null)
    setForgotError(null)
    setError(null)
  }

  const closeForgot = () => {
    setForgotMode(false)
    setForgotMessage(null)
    setForgotError(null)
  }

  const handleForgotSubmit = async (event) => {
    event.preventDefault()
    const email = forgotEmail.trim()
    if (!email || !email.includes('@')) {
      setForgotError('Please enter a valid staff email.')
      return
    }
    setForgotError(null)
    setForgotLoading(true)
    try {
      const message = await resetPassword(email)
      setForgotMessage(message)
    } catch (err) {
      setForgotError(
        err instanceof ApiError
          ? err.message
          : 'Password reset could not be completed. Please try again.'
      )
    } finally {
      setForgotLoading(false)
    }
  }

  return (
    <div className="stage-enter flex flex-col">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
      >
        <ChevronLeftIcon size={16} />
        Back to role selection
      </button>

      <div className="mt-6 flex items-center gap-3">
        <span className="auth-step-icon">
          <ShieldIcon size={22} />
        </span>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
            {title}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {forgotMode
              ? 'Enter your staff email to receive a reset link.'
              : subtitle ||
                'Sign in to generate attendance sessions and manage classroom attendance.'}
          </p>
        </div>
      </div>

      {forgotMode ? (
        <form onSubmit={handleForgotSubmit} className="mt-8 space-y-5" noValidate>
          <div>
            <label htmlFor="forgotStaffEmail" className="cf-form-label">
              <KeyIcon size={14} className="text-muted-2" />
              Staff Email
            </label>
            <div className="relative">
              <span className="auth-input-icon" aria-hidden="true">
                <KeyIcon size={16} />
              </span>
              <input
                id="forgotStaffEmail"
                type="email"
                value={forgotEmail}
                onChange={(e) => {
                  setForgotEmail(e.target.value)
                  setForgotError(null)
                }}
                placeholder="e.g. arun.kumar@kiot.ac.in"
                className="auth-input"
                autoComplete="email"
                inputMode="email"
              />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              A password reset link will be sent to your staff email.
            </p>
          </div>

          {forgotMessage && (
            <div
              role="status"
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700"
            >
              {forgotMessage}
            </div>
          )}

          {forgotError && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              {forgotError}
            </div>
          )}

          <button type="submit" disabled={forgotLoading} className="auth-btn-primary w-full">
            {forgotLoading ? (
              <>
                <span className="cf-spinner" role="status" aria-hidden="true" />
                Sending link…
              </>
            ) : (
              <>
                Send Reset Link
                <ChevronRightIcon size={18} />
              </>
            )}
          </button>

          <button
            type="button"
            onClick={closeForgot}
            className="mx-auto block text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
          >
            Back to login
          </button>
        </form>
      ) : (
        <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
          <div>
            <label htmlFor="staffEmail" className="cf-form-label">
              <KeyIcon size={14} className="text-muted-2" />
              {identifierLabel}
            </label>
            <div className="relative">
              <span className="auth-input-icon" aria-hidden="true">
                <KeyIcon size={16} />
              </span>
              <input
                id="staffEmail"
                type="text"
                value={staffEmail}
                onChange={(e) => {
                  setStaffEmail(e.target.value)
                  setError(null)
                }}
                placeholder={identifierPlaceholder}
                className="auth-input"
                autoComplete="username"
                inputMode="email"
              />
            </div>
            <p className="mt-2 text-xs text-slate-400">{identifierHint}</p>
          </div>

          <div>
            <label htmlFor="password" className="cf-form-label">
              <LockIcon size={14} className="text-muted-2" />
              Password
            </label>
            <div className="relative">
              <span className="auth-input-icon" aria-hidden="true">
                <LockIcon size={16} />
              </span>
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setError(null)
                }}
                placeholder="Enter your password"
                className="auth-input pr-12"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                className="auth-eye"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
              </button>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} className="auth-btn-primary w-full">
            {loading ? (
              <>
                <span className="cf-spinner" role="status" aria-hidden="true" />
                Signing in…
              </>
            ) : (
              <>
                Login
                <ChevronRightIcon size={18} />
              </>
            )}
          </button>

          <button
            type="button"
            onClick={openForgot}
            className="mx-auto block text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
          >
            Forgot password?
          </button>

          <p className="text-center text-xs text-slate-400">
            Access is restricted to authorized staff members.
          </p>
        </form>
      )}
    </div>
  )
}