import OdManagementPage from '../components/od/OdManagementPage'
import { GraduationIcon } from '../components/Icons'

/**
 * A Class Advisor's OD Management page. The second approval in the chain, so a request
 * reaches this screen only once the student's mentor has approved it.
 *
 * A thin wrapper, like `CoordinatorDashboard` and `HodDashboard`: it names the stage and the
 * words this role's queue needs, and every pixel and every request row comes from the shared
 * components. `CLASS_ADVISOR` is the only thing that makes this different from the staff
 * member's screen -- the server reads it, together with the advisor columns on the advisor's
 * own staff row, to scope the queue to their class.
 *
 * The cohort is not sent from here. There is nothing in this file that could widen the
 * queue: `stage` is a display hint, and the server resolves the advisor's own department,
 * batch, year and section before it queries.
 */
export default function AdvisorOdManagement() {
  return (
    <OdManagementPage
      stage="CLASS_ADVISOR"
      stageLabel="Class Advisor"
      dashboardPath="/advisor"
      heroIcon={<GraduationIcon size={26} />}
      subtitle="Manage pending OD requests and review requests you have approved."
      pendingEmptyText="No OD requests are waiting on you. A request arrives once the student's mentor has approved it."
      chainHint="Approving hands the request to the contest coordinator. Rejecting stops it and emails the student."
    />
  )
}
