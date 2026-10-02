import ApproverDashboard from './ApproverDashboard'
import { CompassIcon } from '../components/Icons'

/**
 * A Contest Coordinator's dashboard. The third approval in the chain, so a request that
 * reaches here has already been approved by the student's mentor and the class advisor.
 *
 * The same screen serves both questions a coordinator has: Pending is the queue, and
 * Approved is everything they have already signed off. Both are their own screen because a
 * coordinator is a member of staff first -- appointed out of a department's roster and
 * reusing that staff login -- and this is where their coordinator queue lives.
 */
export default function CoordinatorDashboard() {
  return (
    <ApproverDashboard
      stage="CONTEST_COORDINATOR"
      stageLabel="Contest Coordinator"
      title="Contest Coordinator"
      subtitle="OD requests waiting on your decision for your department."
      emptyText="No contest requests are waiting on you. A request arrives once the student's mentor and the class advisor have approved it."
      heroIcon={<CompassIcon size={26} />}
    />
  )
}