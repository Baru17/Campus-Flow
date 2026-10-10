import OdManagementPage from '../components/od/OdManagementPage'
import { UsersIcon } from '../components/Icons'

/**
 * A member of staff's OD Management page. The first approval in the chain, so a request
 * reaches this screen the moment a student who has this person as their mentor submits one.
 *
 * A thin wrapper, like `CoordinatorDashboard` and `HodDashboard`: it names the stage and the
 * words this role's queue needs, and every pixel and every request row comes from the shared
 * components. `MENTOR` is the only thing that makes this different from the class advisor's
 * screen -- the server reads it to scope the queue to this person's mentees, and the panel
 * sends it back on every decision.
 */
export default function StaffOdManagement() {
  return (
    <OdManagementPage
      stage="MENTOR"
      stageLabel="Mentor"
      dashboardPath="/staff"
      heroIcon={<UsersIcon size={26} />}
      subtitle="Manage pending OD requests and review requests you have approved."
      pendingEmptyText="No OD requests are waiting on you. A request arrives as soon as a student who has you as their mentor submits one."
      chainHint="Approving hands the request to the class advisor. Rejecting stops it and emails the student."
    />
  )
}
