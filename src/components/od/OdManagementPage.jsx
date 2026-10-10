import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DashboardHero from '../DashboardHero'
import { ChevronLeftIcon } from '../Icons'
import OdApprovalPanel from './OdApprovalPanel'
import OdViewTabs from './OdViewTabs'

/**
 * The OD Management screen: Pending and Approved, for a mentor and for a class advisor.
 *
 * This is a *frame*, not a second implementation of an approval queue. Every request row,
 * every field inside a request, the down-arrow expand, the progress trail, the Approve and
 * Reject buttons and the rejection dialog all come from `OdApprovalPanel`, and the
 * Pending/Approved switch is `OdViewTabs` -- the same two components the Contest
 * Coordinator and HOD dashboards are built from. All four approvers therefore read the same
 * way, and a change to how a request is displayed lands in one file rather than six.
 *
 * ## What is different per role, and what is not
 *
 * The only thing that varies is `stage`: `MENTOR` for a member of staff, `CLASS_ADVISOR`
 * for a class advisor. Everything about the page follows from that one string, because the
 * server reads the same string to decide which queue to return:
 *
 *   - **Pending** is `GET /api/od/requests?stage=<stage>&view=pending`, which is
 *     `status = <the status this stage waits on>` plus that stage's own scope -- the
 *     mentor's mentees for a mentor, the advisor's own cohort for an advisor. A request
 *     appears here only while it is actually waiting on this person.
 *   - **Approved** is the same route with `view=approved`, which filters on this stage's own
 *     `<stage>_decided_by` column and `<stage>_decision = 'APPROVED'` with the same scope
 *     applied on top.
 *
 * That second point is the one worth being precise about, because it is what keeps the
 * Approved tab honest. It is *not* "every request whose overall status is APPROVED". It is
 * "requests this person approved at their own stage". For a mentor or a class advisor that
 * distinction is not cosmetic: by the time they look at the tab the request has usually
 * moved on to the coordinator or the HOD and may not yet be approved at all, and it stays in
 * this list as this person's decision regardless. A request appears in Approved because
 * *they* said yes, not because the request finished.
 *
 * Neither view is authoritative about the outcome. A request the mentor approved can still
 * be rejected by the class advisor, and one the class advisor approved can still be waiting
 * on the coordinator. The current `status` is shown on every row, so that is visible rather
 * than implied.
 *
 * ## Why the mentor gets a search box too
 *
 * It does not. `searchable` is deliberately not passed: the mentor and class advisor queues
 * are one cohort each, small enough to scan, which is the reason `OdApprovalPanel` defaults
 * it off for these two roles. The coordinator and HOD keep theirs, where a department-wide
 * queue is twenty requests long.
 *
 * ## Why there is no Navbar here
 *
 * This renders inside the dashboard that owns it -- `/staff/od` is nested under the Staff
 * Dashboard route and `/advisor/od` under the Advisor route -- so the shell, the header and
 * the Logout button come from the dashboard above it, as does the session check that guards
 * this page. What this component owns is the `<main>` below that bar.
 *
 * Nesting rather than sitting beside it is deliberate: it means opening the OD queue does
 * not unmount the dashboard behind it, so a staff member who steps away mid-attendance
 * session comes back to a live OTP and a still-filled form rather than a blank page. It also
 * means `/staff/od` cannot be reached without the same staff session the dashboard requires,
 * without this component having to repeat the check.
 *
 * ## Going back
 *
 * `dashboardPath` rather than history's back button, so the button always returns to the
 * dashboard for this role even when the page was opened directly by URL. It is a client-side
 * route change: no reload, no new sign-in, and the session cookie is untouched.
 */
export default function OdManagementPage({
  stage,
  stageLabel,
  dashboardPath,
  backLabel = 'Back to Dashboard',
  heroIcon,
  title = 'OD Management',
  subtitle,
  pendingEmptyText,
  approvedEmptyText,
  chainHint,
}) {
  const navigate = useNavigate()
  const [view, setView] = useState('pending')

  return (
    <main className="container-cf py-4 lg:py-5 page-enter">
      {/*
        Top-left, above the heading, and the only control on the page that leaves it.

        `navigate(dashboardPath)` rather than `navigate(-1)`: this page is reachable by URL,
        and history would then send someone who typed it to wherever they came from -- the
        sign-in screen, or nothing at all -- instead of to their own dashboard.
      */}
      <button
        type="button"
        onClick={() => navigate(dashboardPath)}
        className="mb-3 inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <ChevronLeftIcon size={16} />
        {backLabel}
      </button>

      <DashboardHero
        icon={heroIcon}
        title={title}
        subtitle={subtitle || 'Manage pending OD requests and review requests you have approved.'}
      />

      <OdViewTabs stage={stage} view={view} onChange={setView} />

      <div className="mt-4">
        {view === 'pending' ? (
          <OdApprovalPanel
            stage={stage}
            view="pending"
            title="Pending"
            emptyText={pendingEmptyText}
            collapsible
          />
        ) : (
          <OdApprovalPanel
            stage={stage}
            view="approved"
            title="Approved"
            emptyText={
              approvedEmptyText ||
              `You have not approved any OD requests as the ${stageLabel} yet. Requests you approve appear here, newest decision first.`
            }
            collapsible
          />
        )}
      </div>

      <p className="mt-3 text-xs text-slate-400">
        {chainHint ||
          'Approving hands the request to the next stage of the chain. Rejecting stops it and emails the student.'}
      </p>
    </main>
  )
}
