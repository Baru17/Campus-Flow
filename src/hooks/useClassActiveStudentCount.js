import { useCallback, useEffect, useRef, useState } from 'react'
import { getClassActiveStudentCount } from '../api/activityApi'

/*
 * The class-specific active student count.
 *
 * The same shape as the global hook it grew out of: poll once a second while the view
 * is on, never overlap two requests, and never let a failure empty the card. What is
 * new is the class, which changes three things.
 *
 *   - The result is scoped to one (department, year, section), so changing any of
 *     them has to invalidate what is on screen. `classKey` is that invalidation: it
 *     changes only when the selection does, and the effect below resets on it.
 *   - There is a manual refresh, so `refresh()` is handed back. It calls the very
 *     same guarded fetch the timer calls, which is what makes "refresh only the
 *     count" true by construction rather than by discipline -- there is no other
 *     request this hook is capable of making.
 *   - `pending` is exposed so the button can be disabled and the spinner can run.
 *
 * ## A failure is never zero
 *
 * `count` stays `null` until the server has actually answered, and stays at its last
 * good value through any later failure. Nothing here ever turns an error into a 0, so
 * a component cannot render "0 students" for a request that failed -- the only way a
 * 0 reaches the screen is a real 0 from a real response.
 */
const POLL_INTERVAL_MS = 1000

export function useClassActiveStudentCount({ enabled, department, year, section }) {
  const [count, setCount] = useState(null)
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
      setCount(null)
      setError(null)
      return undefined
    }

    let disposed = false
    const controller = new AbortController()

    const fetchOnce = async () => {
      if (disposed || inFlight.current) return
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
        setCount(next)
        setError(null)
      } catch (err) {
        if (disposed || err?.name === 'AbortError') return
        /*
         * The last good number stays on screen and polling carries on, so a dropped
         * request shows as a stale badge rather than as a dashboard that empties
         * itself every time the network hiccups.
         */
        setError(err)
      } finally {
        inFlight.current = false
        if (!disposed) setPending(false)
      }
    }

    fetchRef.current = fetchOnce
    setCount(null)
    setError(null)
    setPending(true)
    fetchOnce()
    const timer = window.setInterval(fetchOnce, POLL_INTERVAL_MS)

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
      fetchRef.current = null
      inFlight.current = false
    }
    // `classKey` encodes all three selectors; `enabled` is folded into it above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classKey])

  const refresh = useCallback(() => {
    fetchRef.current?.()
  }, [])

  return { count, error, pending, refresh }
}