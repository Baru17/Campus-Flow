import ApproverDashboard from './ApproverDashboard'
import { CompassIcon } from '../components/Icons'

/** A Contest Coordinator's dashboard. The only screen for the role. */
export default function CoordinatorDashboard() {
  return (
    <ApproverDashboard
      stage="CONTEST_COORDINATOR"
      stageLabel="Contest Coordinator"
      title="Contest Coordinator"
      subtitle="OD requests waiting on your decision for your department."
      emptyText="No contest requests are waiting on you. A request arrives once the student's mentor has approved it."
      heroIcon={<CompassIcon size={26} />}
    />
  )
}