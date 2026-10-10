import { useNavigate } from 'react-router-dom'
import { CalendarIcon, ChevronRightIcon } from '../Icons'

/**
 * The way onto the OD Management page, from the dashboard that owns it.
 *
 * One card, used by both the Staff Dashboard and the Class Advisor Dashboard, so the two
 * roles are offered the same door in the same words and the same place on the page -- it
 * sits where each dashboard's approval queue used to sit, so anybody who already knew to
 * look down there still finds it.
 *
 * It navigates with the router rather than a link, because it is a button that looks like
 * the rest of the dashboard's primary actions and `useNavigate` is already the way this app
 * moves between screens. The target is a child route of the dashboard it is rendered in, so
 * the dashboard stays mounted behind it: the attendance session and the filled-in form are
 * still there on the way back, and the session cookie is never touched.
 *
 * It deliberately shows no count. A pending count would mean a second call to the same
 * endpoint the OD page fetches on arrival -- and a number on this card that is stale the
 * moment somebody approves something elsewhere. The queue itself is the thing that should
 * tell you whether anything is waiting.
 */
export default function OdManagementEntry({ to, title, description }) {
  const navigate = useNavigate()

  return (
    <div className="cf-card cf-card-hover p-3 md:p-4">
      <div className="cf-card-header">
        <div className="min-w-0">
          <h2 className="section-title">{title}</h2>
          <p className="text-muted-2 text-sm mb-0">{description}</p>
        </div>
        <span className="cf-icon-badge violet">
          <CalendarIcon size={22} />
        </span>
      </div>

      <button
        type="button"
        onClick={() => navigate(to)}
        className="btn-cf-primary mt-3 inline-flex items-center gap-2 px-4 py-2 text-sm"
      >
        <CalendarIcon size={16} />
        OD Management
        <ChevronRightIcon size={16} />
      </button>
    </div>
  )
}
