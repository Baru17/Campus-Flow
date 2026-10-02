import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { approverLogin } from '../api/odApi'
import { useStaffAuth } from '../hooks/useStaffAuth'
import {
  AlertIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  StaffIcon,
} from '../components/Icons'

/**
 * Sign-in for the four OD approver roles.
 *
 * This is its own page rather than another option on the role-selection screen,
 * because none of these roles sign in anywhere else. A mentor and a class advisor are
 * staff and already have `/staff/login`, but a Contest Coordinator and an HOD are not staff
 * and have no account at `/staff/login` -- so one door for all four keeps the
 * coordinators and HODs reachable without changing how anybody else signs in.
 *
 * The stage is chosen *after* signing in rather than before. The role is on the
 * account, so asking which stage someone is would be asking them to claim a position
 * and then checking it anyway; signing in first means the role comes from the database
 * and the screen it opens is the one that role is actually allowed to see.
 */

/**
 * Where each role lands once signed in.
 *
 * Nobody lands on a generic inbox. A mentor and a class advisor already have a dashboard,
 * so their approval queue is a section of it -- the same one they get by signing in the way
 * they always have, which is the point: approving an OD request is not a separate job that
 * needs a separate door. A Contest Coordinator and an HOD have no dashboard anyone reaches
 * from the role-selection screen, deliberately, so they get the two dedicated ones.
 *
 * The value is a path, not a stage. Sending a role to a stage would mean a mentor's whole
 * approval journey lived under `/approver/od/MENTOR` while the same mentor, signing in at
 * `/staff/login`, saw nothing -- two homes for one queue.
 *
 * The key is `result.approver.role`, which is the role the *server* resolved from the
 * caller's directory row -- not `auth_users.role`. That distinction is what puts a
 * coordinator on the coordinator dashboard: their account role is `staff`, because they
 * were appointed out of the staff roster and reuse that login, so routing on the account
 * role would send them to the staff dashboard and away from the queue they exist for.
 */
const HOME_BY_ROLE = {
  staff: '/staff',
  class_advisor: '/advisor',
  contest_coordinator: '/coordinator',
  hod: '/hod',
}

export default function ApproverLogin() {
  const navigate = useNavigate()
  const { refresh } = useStaffAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!email.trim() || !password) {
      setError('Enter your email address and password.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const result = await approverLogin(email.trim(), password)

      /*
       * The role comes from the directory the server resolved, not from anything chosen on
       * this page and not from the account role.
       *
       * A mentor or a class advisor goes to the dashboard they already use. That provider
       * mounted before this page did and has already settled on "signed out", so it is
       * asked to re-read the session first -- `od-approver/login` issues the same session
       * and the same cookie as every other role, and without this refresh they would land
       * on a dashboard that immediately signs them back out.
       *
       * A coordinator is the case this exists for. Their account role is `staff`, so
       * refreshing the staff context is what keeps their *staff* dashboard working -- it is
       * simply not where their coordinator queue is. An HOD has no staff context to
       * refresh; their dashboard reads the approver session itself.
       */
      const role = result.approver?.role
      const home = HOME_BY_ROLE[role]

      if (role === 'staff' || role === 'class_advisor' || role === 'contest_coordinator') {
        await refresh()
      }

      navigate(home || '/role-selection', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app-shell">
      <Navbar title="OD Approvals" subtitle="Campus-Flow" />
      <main className="container-cf py-4 lg:py-5">
        <button
          type="button"
          onClick={() => navigate('/role-selection')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          Back to role selection
        </button>

        <div className="page-enter grid grid-cols-12 justify-center">
          <div className="col-span-12 lg:col-span-7 xl:col-span-6">
            <div className="cf-card cf-card-hover p-4 md:p-6">
              <div className="cf-card-header">
                <div>
                  <h2 className="section-title">Approver sign-in</h2>
                  <p className="text-muted-2 text-sm mb-0">
                    For mentors, class advisors, contest coordinators and heads of department.
                  </p>
                </div>
                <span className="cf-icon-badge violet">
                  <StaffIcon size={22} />
                </span>
              </div>

              <form onSubmit={handleSubmit} className="mt-5 space-y-4" noValidate>
                <div>
                  <label htmlFor="approverEmail" className="cf-form-label">
                    <StaffIcon size={14} className="text-muted-2" />
                    Email address
                  </label>
                  <div className="cf-input-group-custom">
                    <span className="cf-input-icon" aria-hidden="true">
                      <StaffIcon size={16} />
                    </span>
                    <input
                      id="approverEmail"
                      className="cf-input pl-10"
                      type="email"
                      inputMode="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value)
                        setError(null)
                      }}
                      placeholder="name@kiot.ac.in"
                      autoComplete="username"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="approverPassword" className="cf-form-label">
                    <LockIcon size={14} className="text-muted-2" />
                    Password
                  </label>
                  <div className="cf-input-group-custom">
                    <span className="cf-input-icon" aria-hidden="true">
                      <LockIcon size={16} />
                    </span>
                    <input
                      id="approverPassword"
                      className={`cf-input pl-10 ${showPassword ? '' : 'pr-12'}`}
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value)
                        setError(null)
                      }}
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
                    className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
                  >
                    <AlertIcon size={16} className="mt-0.5 shrink-0" />
                    {error}
                  </div>
                )}

                <button type="submit" disabled={loading} className="btn-cf-primary w-full">
                  {loading ? (
                    <>
                      <span className="cf-spinner" role="status" aria-hidden="true" />
                      Signing in…
                    </>
                  ) : (
                    <>
                      Sign in
                      <ChevronRightIcon size={18} />
                    </>
                  )}
                </button>
              </form>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
