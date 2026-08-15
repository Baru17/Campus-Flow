import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import BrandPanel from '../components/BrandPanel'
import { CheckIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, KeyIcon, LockIcon, LogoIcon } from '../components/Icons'
import StatusMessage from '../components/StatusMessage'
import { ApiError } from '../api/attendanceApi'
import { getCurrentSession, onAuthStateChange } from '../api/authApi'
import { MIN_PASSWORD_LENGTH } from '../constants'
import { useAuth } from '../hooks/useAuth'

const CHECKING_DELAY_MS = 2500

export default function ResetPassword() {
  const navigate = useNavigate()
  const { changePassword } = useAuth()

  const [sessionReady, setSessionReady] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    let active = true

    const checkSession = () => {
      getCurrentSession().then((session) => {
        if (active) setSessionReady(Boolean(session))
      })
    }

    const unsubscribe = onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') checkSession()
    })

    checkSession()
    const fallback = setTimeout(() => {
      if (active) setSessionReady((ready) => ready ?? false)
    }, CHECKING_DELAY_MS)

    return () => {
      active = false
      clearTimeout(fallback)
      unsubscribe()
    }
  }, [])

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError(null)
    if (!newPassword) {
      setError('Please enter a new password.')
      return
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Your password must be at least ${MIN_PASSWORD_LENGTH} characters long.`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    try {
      await changePassword(newPassword)
      setSuccess(true)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Password reset could not be completed. Please try again.'
      )
    } finally {
      setLoading(false)
    }
  }

  const goHome = () => navigate('/role-selection')

  return (
    <div className="page-enter flex min-h-screen items-center justify-center px-4 py-8 lg:py-10">
      <div className="grid w-full max-w-[1100px] grid-cols-1 overflow-hidden rounded-[32px] border border-slate-200/60 bg-white shadow-[0_32px_90px_rgba(2,6,23,0.16)] lg:h-[88vh] lg:max-h-[860px] lg:min-h-[640px] lg:grid-cols-2">
        <section className="relative flex flex-col overflow-y-auto p-6 sm:p-9 lg:p-12">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={goHome}
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
          </div>

          <div className="flex flex-1 flex-col justify-center py-8">
            <div className="stage-enter flex flex-col">
              <div className="flex items-center gap-3">
                <span className="auth-step-icon">
                  <KeyIcon size={22} />
                </span>
                <div>
                  <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
                    Reset Password
                  </h1>
                  <p className="mt-0.5 text-sm text-slate-500">
                    {success
                      ? 'Your password has been changed.'
                      : 'Create a new password for your student account.'}
                  </p>
                </div>
              </div>

              {success ? (
                <div className="mt-8 flex flex-col items-center text-center">
                  <div className="success-wrap">
                    <span className="success-ring" aria-hidden="true" />
                    <div className="success-check success-check-draw" aria-hidden="true">
                      <CheckIcon size={42} />
                    </div>
                  </div>
                  <p className="mt-4 text-slate-500">
                    Your password has been updated successfully. You can now log in with your new
                    password.
                  </p>
                  <div className="mt-7 w-full max-w-sm">
                    <button type="button" onClick={goHome} className="auth-btn-primary w-full">
                      Return to Login
                    </button>
                  </div>
                </div>
              ) : sessionReady === false ? (
                <div className="mt-8">
                  <StatusMessage variant="danger">
                    Your password reset link is invalid or has expired. Please request a new one
                    from the student login screen.
                  </StatusMessage>
                  <div className="mt-7 w-full max-w-sm">
                    <button type="button" onClick={goHome} className="auth-btn-primary w-full">
                      Go to Login
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
                  <div>
                    <label htmlFor="newPassword" className="cf-form-label">
                      <LockIcon size={14} className="text-muted-2" />
                      New Password
                    </label>
                    <div className="relative">
                      <span className="auth-input-icon" aria-hidden="true">
                        <LockIcon size={16} />
                      </span>
                      <input
                        id="newPassword"
                        type={showPassword ? 'text' : 'password'}
                        value={newPassword}
                        onChange={(e) => {
                          setNewPassword(e.target.value)
                          setError(null)
                        }}
                        placeholder="Enter your new password"
                        className="auth-input pr-12"
                        autoComplete="new-password"
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

                  <div>
                    <label htmlFor="confirmPassword" className="cf-form-label">
                      <LockIcon size={14} className="text-muted-2" />
                      Confirm Password
                    </label>
                    <div className="relative">
                      <span className="auth-input-icon" aria-hidden="true">
                        <LockIcon size={16} />
                      </span>
                      <input
                        id="confirmPassword"
                        type={showPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => {
                          setConfirmPassword(e.target.value)
                          setError(null)
                        }}
                        placeholder="Re-enter your new password"
                        className="auth-input pr-12"
                        autoComplete="new-password"
                      />
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
                        Updating password…
                      </>
                    ) : (
                      <>
                        Update Password
                        <ChevronRightIcon size={18} />
                      </>
                    )}
                  </button>
                </form>
              )}
            </div>
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