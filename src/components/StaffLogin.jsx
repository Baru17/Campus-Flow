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

export default function StaffLogin({ onBack, onLogin }) {
  const [staffId, setStaffId] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = (event) => {
    event.preventDefault()
    if (!staffId.trim()) {
      setError('Please enter your staff ID.')
      return
    }
    if (!password) {
      setError('Please enter your password.')
      return
    }
    setError(null)
    setLoading(true)
    setTimeout(() => onLogin(staffId.trim()), 600)
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
            Staff Login
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Generate attendance sessions and manage classroom attendance.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
        <div>
          <label htmlFor="staffId" className="cf-form-label">
            <KeyIcon size={14} className="text-muted-2" />
            Staff ID
          </label>
          <div className="relative">
            <span className="auth-input-icon" aria-hidden="true">
              <KeyIcon size={16} />
            </span>
            <input
              id="staffId"
              type="text"
              value={staffId}
              onChange={(e) => {
                setStaffId(e.target.value)
                setError(null)
              }}
              placeholder="Enter your staff ID"
              className="auth-input"
              autoComplete="off"
            />
          </div>
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

        <p className="text-center text-xs text-slate-400">
          Access is restricted to authorized staff members.
        </p>
      </form>
    </div>
  )
}