import { useEffect, useState } from 'react'
import { useClassActiveStudentCount } from '../hooks/useClassActiveStudentCount'
import StatusMessage from './StatusMessage'
import { UsersIcon, RefreshIcon } from './Icons'

/*
 * The live active-student count for the class the staff member has selected.
 *
 * It is a card rather than a fourth stat chip, because it is no longer a single
 * glanceable number: it is a control (which class), a result (how many), and a second
 * way to refresh. Built from the same `cf-card`, `cf-card-header`, `section-title`,
 * `cf-icon-badge`, `cf-status-pill` and `btn-cf-*` pieces as the rest of the
 * dashboard, including the OD entry card it sits beside.
 *
 * ## Nothing is shown before it is asked for
 *
 * The staff dashboard has three class selectors, and this card deliberately shows no
 * number at all until Year, Department and Section are all chosen and
 * "View Active Students" is pressed. A global count wearing a class label is worse
 * than no number, and the three selectors are not unique until all three are set.
 *
 * Choosing a different class takes the result away again and puts the button back,
 * so a number on screen always describes the class currently selected.
 *
 * ## Count only
 *
 * No names, no register numbers, no list. The endpoint returns one integer, so there
 * is nothing to show even if this component wanted to.
 */
export default function ActiveStudentsCard({ enabled = true, department, year, section }) {
  const classReady = Boolean(department && year && section)
  const classKey = classReady ? `${department}|${year}|${section}` : null

  /*
   * Which class the staff member last chose to view. Kept as the key rather than a
   * boolean so that going back to a previously viewed class still means pressing the
   * button again: a changed selection always drops back to the button.
   */
  const [viewingClass, setViewingClass] = useState(null)
  useEffect(() => {
    setViewingClass(null)
  }, [classKey])

  const viewing = Boolean(enabled && classKey && viewingClass === classKey)

  const { count, error, pending, refresh } = useClassActiveStudentCount({
    enabled: viewing,
    department,
    year,
    section,
  })

  const hasCount = count !== null
  const failed = Boolean(error)

  let pillVariant = 'active'
  let pillText = 'Live'
  let pillTitle = 'Refreshing every second'

  if (!hasCount && failed) {
    pillVariant = 'expired'
    pillText = 'Failed'
    pillTitle = error?.message || 'The active student count could not be loaded.'
  } else if (!hasCount) {
    pillVariant = 'idle'
    pillText = 'Loading'
    pillTitle = 'Loading the active student count'
  } else if (failed) {
    pillVariant = 'idle'
    pillText = 'Stale'
    pillTitle = `Showing the last count that loaded. ${error?.message || ''}`.trim()
  }

  return (
    <div className="cf-card cf-card-hover p-3 md:p-4">
      <div className="cf-card-header">
        <div className="min-w-0">
          <h2 className="section-title">Active Students</h2>
          <p className="text-muted-2 text-sm mb-0">
            {viewing
              ? `Student accounts signed in to CampusFlow · ${department} · Year ${year} · Section ${section}`
              : 'Pick a department, year and section to see how many students are on CampusFlow right now.'}
          </p>
        </div>
        <span className="cf-icon-badge green">
          <UsersIcon size={22} />
        </span>
      </div>

      {!viewing && (
        <>
          <button
            type="button"
            className="btn-cf-primary mt-3 inline-flex items-center gap-2 px-4 py-2 text-sm"
            disabled={!classReady}
            onClick={() => setViewingClass(classKey)}
          >
            <UsersIcon size={16} />
            View Active Students
          </button>
          {!classReady && (
            <p className="text-muted-2 text-sm mt-2 mb-0">
              Select a department, a year and a section to continue.
            </p>
          )}
        </>
      )}

      {viewing && (
        <>
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            {hasCount ? (
              <div className="stat-chip stat-chip-green flex-1 min-w-0">
                <span className="stat-chip-icon" aria-hidden="true">
                  <UsersIcon size={18} />
                </span>
                <div className="min-w-0">
                  <div className="stat-chip-label">Active Students</div>
                  <div className="stat-chip-value">{count}</div>
                </div>
              </div>
            ) : failed ? (
              /*
               * No number is shown at all here. A request that failed has no count,
               * and rendering a 0 in its place would be a lie the staff member would
               * act on.
               */
              <span className="text-muted-2 text-sm flex-1 min-w-0">
                No count available for this class.
              </span>
            ) : (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="cf-spinner" role="status" aria-hidden="true" />
                <span className="text-muted-2 text-sm">Loading the active student count…</span>
              </div>
            )}

            <span className={`cf-status-pill ${pillVariant}`} title={pillTitle}>
              <span className="dot" aria-hidden="true" />
              {pillText}
            </span>

            {/*
              Manual refresh, and only that. It calls the same guarded fetch the one
              second timer calls, so it cannot overlap an in-flight request and it has
              no connection to any other dashboard action -- no OTP is generated and no
              attendance session is created, finalized or otherwise touched.
            */}
            <button
              type="button"
              className="btn-cf-outline inline-flex items-center gap-2 px-3 py-2 text-sm shrink-0"
              onClick={refresh}
              disabled={pending}
              aria-label="Refresh active students"
              title="Refresh active students"
            >
              <RefreshIcon size={16} />
              <span className="sm:hidden">Refresh</span>
            </button>
          </div>

          {failed && (
            <div className="mt-3">
              <StatusMessage variant="danger">
                {error?.message || 'The active student count could not be loaded. Try refreshing.'}
              </StatusMessage>
            </div>
          )}
        </>
      )}
    </div>
  )
}