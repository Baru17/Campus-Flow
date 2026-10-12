import { useEffect, useRef } from 'react'
import { sendActivityPing } from '../api/activityApi'

/*
 * The student heartbeat.
 *
 * One shared tracker for the whole application rather than a call on every student
 * page: it is mounted once, above the router, so navigating between the entry screen,
 * the OTP page and the OD form cannot start a second timer. Nothing about attendance,
 * OTP or OD knows this hook exists.
 *
 * ## It does not decide who is counted
 *
 * Neither `/active-students` nor `/class-active-students` reads `student_activity`.
 * An account is counted because it holds a valid, unexpired login session, and this
 * heartbeat has no say in it: a student with no beat at all is counted, and a student
 * with a beat seconds old and no session is not. The tracker is therefore no longer on
 * the path that anything depends on, and nothing here can change a count.
 */

const HEARTBEAT_MS = 20_000

/*
 * How recently the student has to have touched the page for the next beat to go out.
 *
 * This used to mirror a 60s window on the server, so the two had to be kept in step.
 * Nothing on the server reads the table now, so the number is only about how often a
 * beat is worth sending.
 */
const INTERACTION_WINDOW_MS = 45_000

/*
 * Shared across tabs through localStorage, so five open tabs of the same account
 * produce one write per interval rather than five. This is an optimisation only: the
 * server counts distinct accounts, so a missed slot costs an extra beat, never an
 * extra student.
 */
const LAST_BEAT_KEY = 'campus-flow:student-activity:last-beat'

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll']

function claimBeatSlot(now) {
  try {
    const previous = Number(window.localStorage.getItem(LAST_BEAT_KEY))
    if (Number.isFinite(previous) && now - previous < HEARTBEAT_MS) return false
    window.localStorage.setItem(LAST_BEAT_KEY, String(now))
    return true
  } catch {
    // Private-mode or storage-blocked browsers still get tracked, just without dedupe.
    return true
  }
}

function releaseBeatSlot() {
  try {
    window.localStorage.removeItem(LAST_BEAT_KEY)
  } catch {
    // Nothing to release if the slot was never ours to take.
  }
}

export function useStudentActivity(enabled) {
  /*
   * Refs, not state. Nothing here is rendered, and a re-render on every beat would put
   * work in the way of the page the student is actually using.
   */
  const lastInteraction = useRef(Date.now())

  useEffect(() => {
    if (!enabled || typeof document === 'undefined' || typeof window === 'undefined') {
      return undefined
    }

    let disposed = false
    const controller = new AbortController()
    lastInteraction.current = Date.now()

    const markInteraction = () => {
      lastInteraction.current = Date.now()
    }

    /*
     * A beat is only sent while the tab is in front of the student. A backgrounded tab
     * is either throttled (so its timer would not fire anyway) or genuinely not being
     * used, and one hidden tab holding an account in the count would misreport a
     * student who had walked away.
     */
    const beat = async () => {
      if (disposed || controller.signal.aborted) return
      if (document.visibilityState === 'hidden') return
      if (Date.now() - lastInteraction.current > INTERACTION_WINDOW_MS) return
      if (!claimBeatSlot(Date.now())) return
      try {
        await sendActivityPing({ signal: controller.signal })
      } catch {
        /*
         * Monitoring is never worth failing a student's session over. Give the slot
         * back so the next tick retries, and move on silently.
         */
        releaseBeatSlot()
      }
    }

    /*
     * Coming back to the tab and regaining connectivity both count as activity, and
     * both are the moments where a beat is most overdue.
     */
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      lastInteraction.current = Date.now()
      beat()
    }
    const handleOnline = () => {
      lastInteraction.current = Date.now()
      beat()
    }

    INTERACTION_EVENTS.forEach((name) =>
      window.addEventListener(name, markInteraction, { passive: true })
    )
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('online', handleOnline)

    beat()
    const timer = window.setInterval(beat, HEARTBEAT_MS)

    return () => {
      disposed = true
      controller.abort()
      window.clearInterval(timer)
      INTERACTION_EVENTS.forEach((name) =>
        window.removeEventListener(name, markInteraction)
      )
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('online', handleOnline)
    }
  }, [enabled])
}
