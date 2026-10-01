import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import OdApprovalPanel from '../components/od/OdApprovalPanel'
import { useApproverMe } from '../hooks/useApproverMe'
import { ShieldIcon } from '../components/Icons'

/**
 * A Contest Coordinator's or an HOD's dashboard: their approval queue, and nothing else.
 *
 * These two roles exist to action OD requests and for nothing else, which is why they are
 * not on the role-selection screen and why they have no other screen to put a queue on.
 * One component serves both and is told which stage it is -- the same panel the Staff and
 * Class Advisor dashboards embed, so all four approvers are looking at the same code and
 * a change to how a request reads lands in one place.
 *
 * ## Why this is its own page rather than another tab somewhere
 *
 * A Contest Coordinator and an HOD are not staff: they have no staff record, they cannot
 * sign in at `/staff/login`, and adding them to the staff dashboard would mean widening
 * what "staff" means for every lecturer in the system. They get their own door
 * (`/approver/login`) and their own screen, and neither touches how anybody else signs in.
 *
 * ## What the screen does not do
 *
 * It does not decide anything itself. The stage is baked in by which route was opened,
 * the queue is scoped by the department on the approver's own directory row, and every
 * Approve and Reject is re-checked on the server against the signed-in address. Rendering
 * a button here is not what authorises the decision.
 */
export default function ApproverDashboard({
  stage,
  stageLabel,
  title,
  subtitle,
  emptyText,
  heroIcon,
}) {
  const navigate = useNavigate()
  const { approver, loading, error, expired, logout } = useApproverMe()

  const handleLogout = async () => {
    await logout()
    navigate('/approver/login', { replace: true })
  }

  if (loading) {
    return (
      <div className="app-shell">
        <Navbar title={title} subtitle="Campus-Flow" />
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Checking your session</p>
          </div>
        </div>
      </div>
    )
  }

  /*
   * Signed in, but not as an approver. Either the session is a student's or a lecturer's,
   * or the account holds a role with no directory row behind it. Both are the same thing
   * to this screen -- there is no queue to show -- so it says so instead of rendering an
   * empty list that would read as "no requests yet".
   *
   * An expired session is separated out, because it needs the opposite advice: sign in
   * again, rather than go and find an administrator.
   */
  if (error || !approver) {
    return (
      <div className="app-shell">
        <Navbar title={title} subtitle="Campus-Flow" />
        <main className="container-cf py-4 lg:py-5">
          <div className="cf-empty">
            <span className="cf-empty-icon">
              <ShieldIcon size={30} />
            </span>
            <h3 className="section-title mb-0">
              {expired ? 'Your session has expired' : 'No approver access'}
            </h3>
            <p className="text-muted-2 mb-0">
              {error || 'This account is not linked to an approver record. Contact the administrator.'}
            </p>
            <button
              type="button"
              onClick={() => navigate('/approver/login', { replace: true })}
              className="btn-cf-primary mt-4 px-4 py-2 text-sm"
            >
              {expired ? 'Sign in again' : 'Back to approver sign-in'}
            </button>
          </div>
        </main>
      </div>
    )
  }

  /*
   * The role on the account is not the one this screen is for. Reaching `/hod` as a
   * coordinator is only possible by typing the URL, and the queue would be empty rather
   * than wrong -- but a heading that names the wrong role is confusing enough to be worth
   * refusing outright.
   */
  const roleStage = { contest_coordinator: 'CONTEST_COORDINATOR', hod: 'HOD' }[approver.role]
  if (roleStage !== stage) {
    return (
      <div className="app-shell">
        <Navbar title={title} subtitle="Campus-Flow" onLogout={handleLogout} />
        <main className="container-cf py-4 lg:py-5">
          <div className="cf-empty">
            <span className="cf-empty-icon">
              <ShieldIcon size={30} />
            </span>
            <h3 className="section-title mb-0">That is not your dashboard</h3>
            <p className="text-muted-2 mb-0">
              You are signed in as {approver.role.replace(/_/g, ' ')}, and this screen is for the{' '}
              {stageLabel}.
            </p>
            <button
              type="button"
              onClick={handleLogout}
              className="btn-cf-outline mt-4 px-4 py-2 text-sm"
            >
              Sign out
            </button>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Navbar title={title} subtitle={`${approver.name} · ${approver.department}`} onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5 page-enter">
        <DashboardHero
          icon={heroIcon}
          title={title}
          subtitle={subtitle || `Requests waiting on your decision as the ${stageLabel}.`}
        />

        <div className="mt-4">
          <OdApprovalPanel
            stage={stage}
            title="Waiting on you"
            emptyText={emptyText}
          />
        </div>

        <p className="mt-3 text-xs text-slate-400">
          This is the only screen for your role. A request reaches you once the stage before you
          has approved it, and approving hands it to the next person in the chain.
        </p>
      </main>
    </div>
  )
}