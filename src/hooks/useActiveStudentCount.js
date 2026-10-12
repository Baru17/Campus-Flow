import { useEffect, useRef, useState } from 'react'
import { getActiveStudentCount } from '../api/activityApi'

/*
 * How often the dashboard re-reads the aggregate number.
 *
 * One second is what the card promises, so that is what it does. It is a single small
 * indexed count, and `inFlight` below means a slow response is waited out rather than
 * stacked on top of the next tick.
 */
const POLL_INTERVAL_MS = 1000

export function useActiveStudentCount(enabled) {
  const [count, setCount] = useState(null)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)

  useEffect(() => {
    if (!enabled) {
      setCount(null)
      setError(null)
      return undefined
    }

    let disposed = false
    const controller = new AbortController()

    const poll = async () => {
      if (disposed || inFlight.current) return
      inFlight.current = true
      try {
        const next = await getActiveStudentCount({ signal: controller.signal })
        if (disposed) return
        setCount(next)
        setError(null)
      } catch (err) {
        if (disposed || err?.name === 'AbortError') return
        /*
         * The last good number stays on screen and polling carries on. A dashboard
         * that blanks itself because one request failed would be worse than one that
         * is briefly a few seconds stale, and it is the only thing this hook can
         * affect either way.
         */
        setError(err)
      } finally {
        inFlight.current = false
      }
    }

    poll()
    const timer = window.setInterval(poll, POLL_INTERVAL_MS)

    return () => {
      disposed = true
      controller.abort()
      window.clearInterval(timer)
      inFlight.current = false
    }
  }, [enabled])

  return { count, error }
}
