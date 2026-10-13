import { useCallback, useEffect, useRef, useState } from 'react'
import { getClassActiveStudentCount } from '../api/activityApi'

/*
 * The class-specific activity: who is signed in, how many there are, and who is not.
 *
 * The same shape as the global hook it grew out of: poll while the view is on, never
 * overlap two requests, and never let a failure empty the card. What is
 * different is the payload and the class, which changes three things.
 *
 *   - The result is scoped to one (department, year, section), so changing any of
 *     them has to invalidate what is on screen. `classKey` is that invalidation: it
 *     changes only when the selection does, and the effect below resets on it.
 *   - There is a manual refresh, so `refresh()` is handed back. It calls the very
 *     same guarded fetch the timer calls, which is what makes "refresh only the
 *     activity" true by construction rather than by discipline -- there is no other
 *     request this hook is capable of making.
 *   - `pending` is exposed so the button can be disabled and the spinner can run.
 *
 * ## A failure is never zero
 *
 * `activity` stays `null` until the server has actually answered, and stays at its last
 * good value through any later failure. Nothing here ever turns an error into a 0 or
 * an empty list, so a component cannot render "0 of 68 students present" for a request
 * that failed -- which would read as "the whole class is absent". The only way a 0
 * reaches the screen is a real 0 from a real response.
 */
/*
 * How often the card re-reads the class.
 *
 * This was one second, which was right when the count was simply "holds a session": the
 * number could change on any poll and a staff member watching a class wanted to see it
 * move.
 *
 * It is not right now. A student qualifies through a login session that must have been
 * created in the last five minutes, so the underlying state can only change when
 * somebody signs in or signs out, or when a session ages past the window -- and nothing
 * about the answer is more precise than the polling interval makes it. Polling a
 * five-minute window sixty times a minute spends two D1 round trips per second per open
 * card to notice changes that are, at worst, five seconds old.
 *
 * Five seconds is the compromise: a sign-in is visible almost immediately, an ageing-out
 * is noticed well inside the margin of the window itself, and the request rate drops by
 * five times. The manual refresh button still calls the same guarded fetch, so a staff
 * member who needs the number now is never waiting on the timer.
 */
const POLL_INTERVAL_MS = 5000

/*
 * A hidden tab is not a staff member who has stopped watching the class.
 *
 * The timer keeps running and each tick returns immediately, so there is no interval
 * to tear down and rebuild and no way to end up with two. This is the same reasoning
 * `useStudentActivity` applies to the student heartbeat for the same reason: a
 * backgrounded tab is not idle data, it is data nobody is reading.
 */
function tabIsHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function useClassActiveStudentCount({ enabled, department, year, section }) {
  const [activity, setActivity] = useState(null)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)

  const inFlight = useRef(false)
  /*
   * The latest fetch, so the returned `refresh` is stable across renders while still
   * calling the closure that has the current class and the current AbortController.
   */
  const fetchRef = useRef(null)

  const classKey = enabled ? `${department}|${year}|${section}` : null

  useEffect(() => {
    if (!classKey) {
      fetchRef.current = null
      inFlight.current = false
      setPending(false)
      setActivity(null)
      setError(null)
      return undefined
    }

    let disposed = false
    const controller = new AbortController()

    const fetchOnce = async () => {
      if (disposed || inFlight.current) return
      /*
       * Skipped before `pending` is set, so a paused tab never shows a spinner it is
       * not going to resolve.
       */
      if (tabIsHidden()) return
      inFlight.current = true
      setPending(true)
      try {
        const next = await getClassActiveStudentCount({
          department,
          year,
          section,
          signal: controller.signal,
        })
        if (disposed) return
        setActivity(next)
        setError(null)
      } catch (err) {
        if (disposed || err?.name === 'AbortError') return
        /*
         * The last good numbers stay on screen and polling carries on, so a dropped
         * request shows as a stale badge rather than as a dashboard that empties
         * itself every time the network hiccups.
         */
        setError(err)
      } finally {
        inFlight.current = false
        if (!disposed) setPending(false)
      }
    }

    /*
     * Coming back to the tab is a refresh, not a wait. A class can empty completely
     * while the tab is in the background -- every session ending at once is exactly
     * what happens when a period ends -- and the staff member returning to the card
     * must not be shown the state they left it in.
     *
     * `inFlight` is deliberately not forced clear here. If a request is genuinely in
     * flight it is fetching *now*, and letting this start a second one would be the
     * overlap the guard exists to prevent; it settles on its own and the data is just
     * as fresh. Clearing the flag to "make sure" something runs would trade a skipped
     * poll, which costs nothing, for two concurrent reads.
     */
    const handleVisibilityChange = () => {
      if (tabIsHidden()) return
      fetchOnce()
    }

    fetchRef.current = fetchOnce
    setActivity(null)
    setError(null)
    /*
     * `pending` is raised inside `fetchOnce` rather than here, because on a hidden tab
     * that call returns without fetching. Setting it out here would leave the refresh
     * button permanently disabled with nothing in flight to re-enable it.
     */
    fetchOnce()
    const timer = window.setInterval(fetchOnce, POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      disposed = true
      /*
       * Aborting rather than merely ignoring the result: without it a request issued
       * for a class the staff member has already moved away from stays in flight and
       * keeps `inFlight` held until it settles, which would stall the new class's
       * first poll for as long as the old one takes.
       */
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      fetchRef.current = null
      inFlight.current = false
    }
    // `classKey` encodes all three selectors; `enabled` is folded into it above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classKey])

  const refresh = useCallback(() => {
    fetchRef.current?.()
  }, [])

  return { activity, error, pending, refresh }
}