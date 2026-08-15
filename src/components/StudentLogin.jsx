import { useState } from 'react'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  KeyIcon,
  LockIcon,
  StudentIcon,
} from './Icons'
import { ApiError } from '../api/attendanceApi'
import { useAuth } from '../hooks/useAuth'
import { isValidStudentId, normalizeStudentId } from '../utils/validation'

export default function StudentLogin({ onBack, onContinue }) {
  const { login, resetPassword } = useAuth()
  const [studentId, setStudentId] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const [forgotMode, setForgotMode] = useState(false)
  const [forgotId, setForgotId] = useState('')
  const [forgotMessage, setForgotMessage] = useState(null)
  const [forgotError, setForgotError] = useState(null)
  const [forgotLoading, setForgotLoading] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    const id = normalizeStudentId(studentId)
    if (!isValidStudentId(id)) {
      setError('Please enter a valid student ID.')
      return
    }
    if (!password) {
      setError('Please enter your password.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const student = await login(id, password)
      onContinue(student.student_id)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Unable to log in right now. Please try again.'
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
    const id = normalizeStudentId(forgotId)
    if (!isValidStudentId(id)) {
      setForgotError('Please enter a valid student ID.')
      return
    }
    setForgotError(null)
    setForgotLoading(true)
    try {
      const message = await resetPassword(id)
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
          <StudentIcon size={22} />
        </span>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
            Student Login
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {forgotMode
              ? 'Enter your student ID to receive a reset link.'
              : 'Sign in with your student ID and password to mark attendance.'}
          </p>
        </div>
      </div>

      {forgotMode ? (
        <form onSubmit={handleForgotSubmit} className="mt-8 space-y-5" noValidate>
          <div>
            <label htmlFor="forgotStudentId" className="cf-form-label">
              <KeyIcon size={14} className="text-muted-2" />
              Student ID
            </label>
            <div className="relative">
              <span className="auth-input-icon" aria-hidden="true">
                <StudentIcon size={16} />
              </span>
              <input
                id="forgotStudentId"
                type="text"
                value={forgotId}
                onChange={(e) => {
                  setForgotId(e.target.value)
                  setForgotError(null)
                }}
                placeholder="e.g. 2K24IT001"
                className="auth-input"
                autoComplete="off"
                inputMode="text"
              />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              A password reset link will be sent to your college email.
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
            <label htmlFor="studentId" className="cf-form-label">
              <StudentIcon size={14} className="text-muted-2" />
              Student ID
            </label>
            <div className="relative">
              <span className="auth-input-icon" aria-hidden="true">
                <StudentIcon size={16} />
              </span>
              <input
                id="studentId"
                type="text"
                value={studentId}
                onChange={(e) => {
                  setStudentId(e.target.value)
                  setError(null)
                }}
                placeholder="e.g. 2K24IT001"
                className="auth-input"
                autoComplete="off"
                inputMode="text"
              />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Format: 2K24IT001 — ask your staff if you need help finding your ID.
            </p>
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
        </form>
      )}
    </div>
  )
}