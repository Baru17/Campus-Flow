import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import OdApprovalPanel from '../components/od/OdApprovalPanel'
import { useApproverMe } from '../hooks/useApproverMe'
import { fetchApprovedApprovals, fetchPendingApprovals } from '../api/odApi'
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
 * A Contest Coordinator and an HOD are not staff: they have no staff record of their own,
 * and adding them to the staff dashboard would mean widening what "staff" means for every
 * lecturer in the system. They get their own door (`/approver/login`) and their own screen,
 * and neither touches how anybody else signs in.
 *
 * A coordinator *is* on the staff roster -- that is where they are appointed from -- so
 * their account keeps the `staff` role and their staff login keeps working. What makes
 * them a coordinator is their `contest_coordinators` row, and that is what the server
 * reads to decide which of the two dashboards below is theirs. The check below compares
 * the stage this screen is for against the role the server resolved, so the two cannot
 * drift.
 *
 * ## Pending and Approved
 *
 * Two questions, two views, and they are not the same list:
 *
 *   - **Pending** -- what is waiting on this approver now.
 *   - **Approved** -- what they have already signed off at their stage.
 *
 * They need separate queries because `status` is a single column that moves the moment
 * they act. An HOD's decision is the last one in the chain, so from the instant they
 * approve, that request is gone from Pending -- without a second view there would be no
 * record on their screen of anything they ever approved.
 *
 * The tabs are always both rendered, whatever the counts. A tab that only appeared once it
 * had something on it would make an empty queue indistinguishable from a missing feature,
 * and it would make the page change shape as requests arrived. A count of zero is shown as
 * a count of zero, and the empty state below says what would fill it.
 *
 * They are centred because they are the switch between the two halves of this screen
 * rather than a control that belongs to one of them, and because the page below them is a
 * single centred column of cards -- a left-aligned switch over centred content reads as
 * belonging to the left edge.
 *
 * The counts are shown on the tabs, so the count is not the length of whichever list
 * happens to be open. They are read once when the tab set is first shown and refreshed
 * after each decision, from the same two endpoints the lists use. A count that could not
 * be fetched leaves the tab without a badge rather than showing a wrong number.
 *
 * ## Compact requests, and finding one
 *
 * Both lists are collapsed and searchable, because these two roles have the longest queues
 * in the product: a coordinator's is every OD in their department that cleared the class
 * advisor, and an HOD's is everything that cleared the coordinator. A request is one
 * summary line until asked otherwise, and the search box narrows what is already in the
 * browser. Both behaviours live in `OdApprovalPanel`, which the mentor and class-advisor
 * dashboards share, so all four approvers read the same way and there is one
 * implementation rather than two.
 *
 * ## What the screen does not do
 *
 * It does not decide anything itself. The stage is baked in by which route was opened,
 * the queue is scoped by the department on the approver's own directory row, and every
 * Approve and Reject is re-checked on the server against the signed-in address. Rendering
 * a button here is not what authorises the decision. Nor does searching change what the
 * approver can see: it can only remove rows from a list the server already scoped to them.
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
  const [view, setView] = useState('pending')

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
   * The role the server resolved is not the one this screen is for. Reaching `/hod` as a
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

        <ViewTabs stage={stage} view={view} onChange={setView} />

        <div className="mt-4">
          {view === 'pending' ? (
            <OdApprovalPanel
              stage={stage}
              view="pending"
              title="Pending"
              emptyText={emptyText}
              collapsible
              searchable
            />
          ) : (
            <OdApprovalPanel
              stage={stage}
              view="approved"
              title="Approved"
              emptyText={`You have not approved any OD requests as the ${stageLabel} yet. Requests you approve appear here, newest first.`}
              collapsible
              searchable
            />
          )}
        </div>

        <p className="mt-3 text-xs text-slate-400">
          A request reaches you once the stage before you has approved it, and approving
          hands it to the next person in the chain. Everything you approve stays listed
          under Approved.
        </p>
      </main>
    </div>
  )
}

/**
 * The Pending / Approved switch.
 *
 * A real tablist rather than two links, so the arrow keys move between them and the active
 * tab is announced as selected rather than only looking different. The count on each tab is
 * fetched separately from the list itself, so the number on the tab you are *not* looking
 * at is still true -- which matters most immediately after a decision, when Pending drops
 * by one and Approved rises by one.
 *
 * A failure here degrades to no count rather than an error: the list below is the thing the
 * page is for, and a count that could not be fetched is not worth an alert above it.
 */
function ViewTabs({ stage, view, onChange }) {
  const [counts, setCounts] = useState({})

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [pending, approved] = await Promise.all([
        fetchPendingApprovals(stage).catch(() => null),
        fetchApprovedApprovals(stage).catch(() => null),
      ])
      if (cancelled) return
      setCounts({
        pending: pending ? (pending.requests || []).length : undefined,
        approved: approved ? (approved.requests || []).length : undefined,
      })
    }

    load()
    return () => {
      cancelled = true
    }
  }, [stage])

  const tabs = [
    { id: 'pending', label: 'Pending', count: counts.pending },
    { id: 'approved', label: 'Approved', count: counts.approved },
  ]

  return (
    <div className="mb-1 flex flex-wrap justify-center gap-2" role="tablist" aria-label="OD request views">
      {tabs.map((tab) => {
        const active = view === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`od-tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`od-tabpanel-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition-colors ${
              active
                ? 'bg-blue-600 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {tab.label}
            {typeof tab.count === 'number' && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                  active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}