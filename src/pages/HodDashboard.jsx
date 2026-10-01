import ApproverDashboard from './ApproverDashboard'
import { ShieldIcon } from '../components/Icons'

/**
 * A Head of Department's dashboard. The last approval in the chain, so a request that
 * reaches here has already been approved by the mentor, the contest coordinator and the
 * class advisor.
 */
export default function HodDashboard() {
  return (
    <ApproverDashboard
      stage="HOD"
      stageLabel="Head of Department"
      title="Head of Department"
      subtitle="OD requests waiting on your decision for your department."
      emptyText="No OD requests are waiting on you. A request arrives once the mentor, the contest coordinator and the class advisor have all approved it."
      heroIcon={<ShieldIcon size={26} />}
    />
  )
}