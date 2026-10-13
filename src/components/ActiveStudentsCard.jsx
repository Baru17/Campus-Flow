import { useEffect, useState } from 'react'
import { useClassActiveStudentCount } from '../hooks/useClassActiveStudentCount'
import { describeClassActivity, missingToggleLabel } from '../utils/classActivity'
import StatusMessage from './StatusMessage'
import { UsersIcon, RefreshIcon, AlertIcon, ChevronRightIcon, CheckIcon } from './Icons'

/*
 * The live class activity for the class the staff member has selected.
 *
 * It is a card rather than a fourth stat chip, because it is no longer a single
 * glanceable number: it is a control (which class), a result (how many of how many),
 * a second way to refresh, and a list of who is not there. Built from the same
 * `cf-card`, `cf-card-header`, `section-title`, `cf-icon-badge`, `cf-list-*`,
 * `cf-status-pill` and `btn-cf-*` pieces as the rest of the dashboard, including the
 * OD entry card it sits beside.
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
 * ## What the staff member is shown
 *
 * `active / total` as one figure, because "42" against an unknown denominator is not
 * an answer, and the missing list because a fraction nobody can act on is not either.
 *
 * A class with nobody enrolled in it is rendered as itself -- a sentence, and no
 * statistic and no list. `0 / 0` would be true and unreadable, and an empty
 * missing-student panel would read as a successful all-clear rather than as "this class
 * does not exist yet".
 *
 * The list carries a register number and a name and nothing else: no email, no account
 * id, no year or section (the card header already says which class this is), and no
 * timestamp of when the student was last seen. Those two fields are what it takes to
 * recognise somebody in a room, and the endpoint was written to send no more.
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

  /*
   * Whether the missing list is open. Reset with the class rather than carried across,
   * for the same reason the number is: an open list of yesterday's class is a list of
   * people who are wrong to be looking at right now.
   */
  const [missingOpen, setMissingOpen] = useState(false)
  useEffect(() => {
    setMissingOpen(false)
  }, [classKey])

  const viewing = Boolean(enabled && classKey && viewingClass === classKey)

  const { activity, error, pending, refresh } = useClassActiveStudentCount({
    enabled: viewing,
    department,
    year,
    section,
  })

  const failed = Boolean(error)

  /*
   * How to present this response, decided once in `describeClassActivity`.
   *
   * An empty class is rendered as itself -- a sentence, and no statistic and no list --
   * because `0 / 0` is true and unreadable, and an empty missing-student panel would read
   * as a successful all-clear rather than as "this class does not exist yet".
   */
  const {
    hasActivity,
    totalStudents,
    missing,
    isEmptyClass,
    allPresent,
    ratio,
    showMissingControl,
  } = describeClassActivity(activity)

  let pillVariant = 'active'
  let pillText = 'Live'
  let pillTitle = 'Refreshing every few seconds'

  if (!hasActivity && failed) {
    pillVariant = 'expired'
    pillText = 'Failed'
    pillTitle = error?.message || 'The class activity could not be loaded.'
  } else if (!hasActivity) {
    pillVariant = 'idle'
    pillText = 'Loading'
    pillTitle = 'Loading the class activity'
  } else if (failed) {
    pillVariant = 'idle'
    pillText = 'Stale'
    pillTitle = `Showing the last update that loaded. ${error?.message || ''}`.trim()
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
            {isEmptyClass ? (
              /*
               * The empty class, in place of the statistic.
               *
               * Built from `cf-list-card` + `cf-list-item`, the same pair the missing
               * list below it uses, so the two states share one visual language. The
               * row is the card's only child, which is what lets the `:last-child` rule
               * drop the dashed divider -- without that it would draw a rule under the
               * whole block and read as a broken table.
               *
               * `w-full sm:w-auto sm:flex-1 min-w-0` is the same trio the statistic
               * chip uses, so the pill and the refresh button keep their position at
               * every screen size and only the contents of the flexed line change.
               */
              <div className="cf-list-card w-full sm:w-auto sm:flex-1 min-w-0">
                <div className="cf-list-item">
                  <span className="cf-list-icon" aria-hidden="true">
                    <UsersIcon size={16} />
                  </span>
                  <div className="cf-list-meta">
                    <div className="title">There are no students in this class.</div>
                    <div className="sub">
                      Nobody is enrolled in {department} · Year {year} · Section {section} yet. This
                      card keeps updating, so it will fill in as soon as the roster does.
                    </div>
                  </div>
                </div>
              </div>
            ) : hasActivity ? (
              /*
               * Full width below `sm`, so the chip keeps its natural width on a phone
               * instead of being squeezed. Sharing a row with the pill and the button,
               * this chip is `flex-1`, which is a flex basis of zero: the row hands it
               * whatever is left after the two fixed-width items. On a 360px screen
               * that is about 100px for a chip whose icon, padding and gap already take
               * 70 -- less than the width of the word "STUDENTS". Taking the whole line
               * below `sm` puts the pill and the button underneath instead, and above
               * `sm` it goes back to sharing one row with them.
               */
              <div className="stat-chip stat-chip-green w-full sm:w-auto sm:flex-1 min-w-0">
                <span className="stat-chip-icon" aria-hidden="true">
                  <UsersIcon size={18} />
                </span>
                <div className="min-w-0">
                  <div className="stat-chip-label">Active / Total</div>
                  <div className="stat-chip-value">{ratio}</div>
                </div>
              </div>
            ) : failed ? (
              /*
               * No numbers are shown at all here. A request that failed has neither a
               * count nor a denominator, and rendering zeroes in their place would be a
               * lie the staff member would act on -- "0 / 68" reads as "the entire class
               * is absent".
               */
              <span className="text-muted-2 text-sm w-full sm:w-auto sm:flex-1 min-w-0">
                No class activity available.
              </span>
            ) : (
              <div className="flex items-center gap-2 w-full sm:w-auto sm:flex-1 min-w-0">
                <span className="cf-spinner" role="status" aria-hidden="true" />
                <span className="text-muted-2 text-sm">Loading the class activity…</span>
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

          {/*
            The missing list.

            Collapsed by default: a class of sixty with forty absent is a wall of text
            on a dashboard whose job is to be scannable, and the count on the chip above
            already answers "is anyone missing" without opening anything.

            The toggle is rendered once the numbers are in for a class that has students,
            including when the list is empty, because "everyone is here" is itself
            information and a header that appears and disappears as people sign in and out
            is worse than one that stays put.

            An empty class gets no toggle at all. There is nothing to list and nothing
            to report, so a control that opened onto an empty panel would be an
            invitation to read absence as reassurance.
          */}
          {showMissingControl && (
            <div className="mt-3">
              <button
                type="button"
                className="btn-cf-outline w-full inline-flex items-center justify-between gap-2 px-3 py-2 text-sm"
                onClick={() => setMissingOpen((open) => !open)}
                aria-expanded={missingOpen}
                aria-controls="active-students-missing-list"
              >
                <span className="inline-flex items-center gap-2 min-w-0">
                  {allPresent ? (
                    <CheckIcon size={16} />
                  ) : (
                    <AlertIcon size={16} />
                  )}
                  <span className="truncate">{missingToggleLabel({ isEmptyClass, allPresent, missingCount: missing.length })}</span>
                </span>
                <ChevronRightIcon
                  size={16}
                  className={`shrink-0 transition-transform duration-200 ${
                    missingOpen ? 'rotate-90' : ''
                  }`}
                />
              </button>

              {missingOpen && (
                <div id="active-students-missing-list" className="cf-list-card mt-2 overflow-hidden">
                  {/*
                  Only reachable when the counts say the whole class is present, since
                  the toggle that opens this panel is not rendered for an empty class
                  and says "Everyone is signed in" otherwise. The `allPresent` guard
                  keeps the panel honest if that toggle is ever relaxed.
                */}
                {allPresent ? (
                    <div className="cf-list-item">
                      <span className="cf-list-icon green" aria-hidden="true">
                        <CheckIcon size={16} />
                      </span>
                      <div className="cf-list-meta">
                        <div className="title">No missing students</div>
                        <div className="sub">
                          All {totalStudents} students in this class are signed in with a valid
                          session.
                        </div>
                      </div>
                    </div>
                  ) : (
                    missing.map((student) => (
                      /*
                       * Keyed on `register_no`, which is UNIQUE within a roster table
                       * and stable across polls. It is the one identifier that does not
                       * change between renders, so React reuses the row instead of
                       * unmounting and remounting it -- which is what lets `.cf-list-item`
                       * animate in and lets a row that has just signed in leave without
                       * the rest of the list reshuffling around it.
                       */
                      <div className="cf-list-item" key={student.register_no}>
                        <span className="cf-list-icon" aria-hidden="true">
                          <AlertIcon size={16} />
                        </span>
                        <div className="cf-list-meta">
                          {/*
                            Name first and on its own line. `.title` truncates with an
                            ellipsis rather than wrapping, which is right for a name on a
                            phone and still leaves the register number legible underneath
                            it on the `.sub` line.
                          */}
                          <div className="title" title={student.student_name}>
                            {student.student_name}
                          </div>
                          <div className="sub">{student.register_no}</div>
                        </div>
                      </div>
                    ))
                  )}

                  {/*
                    Only reachable if the server capped the list, which a real section
                    never does. It is stated rather than left to be assumed: a list that
                    quietly stops at N rows reads as "these are the missing ones".
                  */}
                  {activity.missingTruncated && (
                    <div className="cf-list-item">
                      <div className="cf-list-meta">
                        <div className="title">List truncated</div>
                        <div className="sub">
                          Showing the first {missing.length} by register number. The count above is
                          the full number missing.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {failed && (
            <div className="mt-3">
              <StatusMessage variant="danger">
                {error?.message || 'The class activity could not be loaded. Try refreshing.'}
              </StatusMessage>
            </div>
          )}
        </>
      )}
    </div>
  )
}