import ApproverDashboard from './ApproverDashboard'
import { ShieldIcon } from '../components/Icons'

/**
 * A Head of Department's dashboard. The last approval in the chain, so a request that
 * reaches here has already been approved by the mentor, the class advisor and the contest
 * coordinator.
 *
 * Because the HOD approves last, their decision is the one that empties the request out of
 * Pending for the final time -- so the Approved view is not a convenience here, it is the
 * only place the screen can show what this person has authorised at all.
 */
export default function HodDashboard() {
  return (
    <ApproverDashboard
      stage="HOD"
      stageLabel="Head of Department"
      title="Head of Department"
      subtitle="OD requests waiting on your decision for your department."
      emptyText="No OD requests are waiting on you. A request arrives once the mentor, the class advisor and the contest coordinator have all approved it."
      heroIcon={<ShieldIcon size={26} />}
    />
  )
}