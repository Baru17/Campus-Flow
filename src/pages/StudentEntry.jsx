import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import { fetchStudentMe } from '../api/odApi'
import { useAuth } from '../hooks/useAuth'
import { useClock } from '../hooks/useClock'
import { formatClassName } from '../utils/format'
import {
  CheckIcon,
  ChevronRightIcon,
  FingerprintIcon,
  SparklesIcon,
  StudentIcon,
  UsersIcon,
} from '../components/Icons'

/*
 * Where a student lands after signing in.
 *
 * This screen replaced going straight to the OTP page. The three actions below are the
 * whole of the student side, and each one goes somewhere that already works or is
 * built for that single job:
 *
 *   - Mark Attendance opens the existing OTP page, unchanged. OTP generation,
 *     verification, expiry, finalisation and the attendance tables are all untouched;
 *     only the navigation to reach them is new.
 *   - Allocate Mentor opens the mentor page.
 *   - OD Form opens the OD form.
 *
 * Everything on screen is read from `/api/student/me`, which derives the student from
 * the session. Nothing here is assembled from dropdowns or an email address, so the
 * department shown is the one the student is actually registered in.
 */

/** The three actions, in the order they are offered. */
const ACTIONS = [
  {
    key: 'attendance',
    title: 'Mark Attendance',
    description: 'Enter the OTP your staff shared to be marked present for the period.',
    icon: <CheckIcon size={22} />,
    tone: 'blue',
    to: '/student',
  },
  {
    key: 'mentor',
    title: 'Allocate Mentor',
    description: 'Choose the staff member who will review your on-duty requests.',
    icon: <UsersIcon size={22} />,
    tone: 'violet',
    to: '/student/mentor',
  },
  {
    key: 'od',
    title: 'OD Form',
    description: 'Request on-duty leave and track it through the approval chain.',
    icon: <SparklesIcon size={22} />,
    tone: 'blue',
    to: '/student/od',
  },
]

export default function StudentEntry() {
  const navigate = useNavigate()
  const clock = useClock()
  const { logout, student: authStudent, loading: authLoading } = useAuth()

  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setMe(await fetchStudentMe())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  /*
   * Wait for the session to settle before asking who this is.
   *
   * `AuthProvider` restores the session on mount, and this page used to issue
   * `/api/student/me` at the same time rather than after it. That is the pattern every
   * other dashboard in the app already follows -- `AdvisorDashboard` gates its first
   * authenticated call on `if (!staff) return` -- and this page was the one place that
   * did not, so on a cold load it fired a second, redundant request whose failure surfaced
   * as an error banner before the first one had finished.
   *
   * Gating on `authLoading` also stops the request firing at all for somebody who is
   * genuinely signed out: the redirect below takes them to role selection first, which is
   * the honest answer, rather than asking an authenticated endpoint and rendering whatever
   * it refused with.
   *
   * Nothing on the server changed. `/api/student/me` still requires a session *and* the
   * student role; this only stops asking before we know who is asking.
   */
  useEffect(() => {
    if (authLoading) return
    if (!authStudent) {
      navigate('/role-selection', { replace: true })
      return
    }
    load()
  }, [authLoading, authStudent, load, navigate])

  const handleLogout = async () => {
    await logout()
    navigate('/role-selection', { replace: true })
  }

  // The provider's own answer is enough to render the shell, so a session that has
  // resolved does not sit behind a spinner while the duplicate fetch repeats it.
  const student = me?.student ?? authStudent
  const hasMentor = Boolean(student?.mentor_email)
  const busy = authLoading || loading

  return (
    <div className="app-shell">
      <Navbar title="Student" subtitle="Campus-Flow" onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5">
        <DashboardHero
          icon={<StudentIcon size={26} />}
          title={student ? `Hello, ${student.student_name}` : 'Student'}
          subtitle={`${clock.greeting} — what would you like to do today?`}
          right={
            <div className="live-clock">
              <div className="time">{clock.time}</div>
              <div className="date">{clock.date}</div>
            </div>
          }
        />

        {error && <StatusMessage variant="danger">{error}</StatusMessage>}

        {busy && (
          <div className="cf-empty">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">
              {authLoading ? 'Checking your session…' : 'Loading your details…'}
            </p>
          </div>
        )}

        {!busy && !error && student && (
          <div className="page-enter">
            {/*
              Who the session belongs to, read from the server.

              The class is shown as one badge rather than three dropdowns precisely
              because it is not the student's to choose: it is what the database holds
              for them, and offering a picker here would imply otherwise.
            */}
            <div className="cf-card cf-card-hover p-3 md:p-4">
              <div className="cf-card-header">
                <div>
                  <h2 className="section-title">Your record</h2>
                  <p className="text-muted-2 text-sm mb-0">
                    Taken from your student account. Only your administrator can change these.
                  </p>
                </div>
                <span className="cf-icon-badge violet">
                  <FingerprintIcon size={22} />
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="class-badge">
                  <FingerprintIcon size={15} />
                  {formatClassName(student.department, student.year, student.section)}
                </span>
                <span className="cf-status-pill active">
                  <span className="dot" aria-hidden="true" /> {student.student_id}
                </span>
                {hasMentor ? (
                  <span className="cf-status-pill active">
                    <span className="dot" aria-hidden="true" /> Mentor allocated
                  </span>
                ) : (
                  <span className="cf-status-pill">
                    <span className="dot" aria-hidden="true" /> No mentor yet
                  </span>
                )}
                <span className="cf-status-pill active">
                  <span className="dot" aria-hidden="true" /> {me.od_days_gained || 0} OD gained
                </span>
              </div>
            </div>

            {/* The three actions. */}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {ACTIONS.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => navigate(action.to)}
                  className="admin-option-card group text-left"
                >
                  <div className={`admin-option-icon admin-option-icon-${action.tone}`}>
                    {action.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-extrabold tracking-tight text-slate-900 group-hover:text-blue-700">
                      {action.title}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">{action.description}</p>
                  </div>
                  <ChevronRightIcon
                    size={20}
                    className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-blue-500"
                  />
                </button>
              ))}
            </div>

            {!hasMentor && (
              <p className="mt-3 text-xs text-slate-400">
                You have not allocated a mentor yet. An OD request needs one before it can be
                submitted.
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}