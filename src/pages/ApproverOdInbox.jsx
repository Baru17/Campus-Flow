import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import OdApprovalPanel from '../components/od/OdApprovalPanel'
import { CheckIcon } from '../components/Icons'

/**
 * A standalone approval queue for one stage of the chain, reachable by URL.
 *
 * Every role now has a real home for its queue -- the Staff Dashboard for a mentor, the
 * Class Advisor Dashboard for an advisor, and the two dedicated dashboards for a contest
 * coordinator and an HOD -- and that is where an approver is sent. This page remains for a
 * stage-specific link, and it is a thin frame around `OdApprovalPanel` rather than a second
 * implementation: the list, the two buttons and the rejection dialog all come from the same
 * component the four dashboards use, so a change to how a request is displayed cannot land
 * here and miss them.
 *
 * What it does not do is check that the signed-in person holds this stage. The panel asks
 * the server for the queue for the stage it was given, and that server check scopes the rows
 * by the approver's own address, their own staff cohort or their own directory row. A
 * coordinator opening `/approver/od/HOD` gets an empty list, not someone else's.
 */

/** How this queue knows which stage of the chain it is looking at. */
const STAGE_LABELS = {
  MENTOR: 'Mentor',
  CONTEST_COORDINATOR: 'Contest Coordinator',
  CLASS_ADVISOR: 'Class Advisor',
  HOD: 'HOD',
}

export default function ApproverOdInbox({ stage }) {
  const navigate = useNavigate()
  const label = STAGE_LABELS[stage] || stage

  return (
    <div className="app-shell">
      <Navbar title="OD Approvals" subtitle="Campus-Flow" />
      <main className="container-cf py-4 lg:py-5">
        <button
          type="button"
          onClick={() => navigate('/role-selection')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          Back to role selection
        </button>

        <DashboardHero
          icon={<CheckIcon size={26} />}
          title={`${label} approvals`}
          subtitle="Requests waiting on your decision."
        />

        <div className="page-enter mt-4">
          <OdApprovalPanel stage={stage} title="Waiting on you" />

          {/*
            Sent here rather than left blank. The dedicated dashboard for a role is where
            that role's queue is meant to live, and this page is a way in rather than a
            destination, so it says which screen is the real one.
          */}
          <p className="mt-4 text-xs text-slate-400">
            {stage === 'MENTOR' && 'Mentors normally approve from the Staff Dashboard.'}
            {stage === 'CLASS_ADVISOR' &&
              'Class advisors normally approve from the Class Advisor Dashboard.'}
            {stage === 'CONTEST_COORDINATOR' &&
              'Contest coordinators normally approve from the Contest Coordinator dashboard at /coordinator.'}
            {stage === 'HOD' && 'Heads of department normally approve from /hod.'}
          </p>
        </div>
      </main>
    </div>
  )
}