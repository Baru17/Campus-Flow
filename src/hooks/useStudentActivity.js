import { useEffect, useRef } from 'react'
import { sendActivityPing } from '../api/activityApi'

/*
 * The student heartbeat.
 *
 * One shared tracker for the whole application rather than a call on every student page:
 * it is mounted once, above the router, so navigating between the entry screen, the OTP
 * page and the OD form cannot start a second timer. Nothing about attendance, OTP or OD
 * knows this hook exists.
 *
 * ## This hook is half of the counting rule
 *
 * The staff dashboard counts an account as active when it holds a valid session *and*
 * has a beat within the last sixty seconds. That second half is only worth anything
 * because of what this file refuses to send.
 *
 * A beat is written **in response to real interaction**, and never otherwise -- not on a
 * bare timer, not on render, not because an earlier beat succeeded, not because the tab
 * happens to be open. A tracker that beat on a timer would hold a student "active" for
 * as long as their browser was open, including a tab left in the background all
 * afternoon, which is precisely the failure this signal exists to avoid.
 *
 * The server and the client are therefore one design. `activity.ts` documents the half
 * that lives there.
 *
 * ## Why the interval is 15 seconds
 *
 * It has to be comfortably shorter than the 60-second window on the server, or a beat
 * that lands slightly late would age out the account it was meant to keep. Fifteen
 * seconds gives four beats of headroom inside every window, and it is the floor for how
 * often one write per account is worth making.
 */

/** The most often this hook will write for one account, in one browser. */
const BEAT_INTERVAL_MS = 15_000

/*
 * How long after the last real interaction a trailing beat may still be sent.
 *
 * Interaction events can arrive in bursts faster than the interval, and the ones inside
 * a burst are dropped by the throttle below. Allowing one interval of slack guarantees
 * the *last* interaction of a burst still produces a beat, so an account never ages out
 * mid-gesture.
 *
 * It is deliberately one interval and not more. Every extra interval of slack is added
 * to how long a student stays on the board after they have actually stopped, and the
 * promise the dashboard makes is sixty seconds.
 */
const TRAILING_BEAT_WINDOW_MS = 15_000

/*
 * What counts as the student using CampusFlow.
 *
 * `pointerdown`, `keydown` and `touchstart` are deliberate acts. `wheel` and `scroll`
 * are there because reading a page by scrolling is use, and a student reading the OTP
 * page without tapping would otherwise vanish while doing exactly what they were asked
 * to do. `input` and `change` cover form work.
 *
 * What is deliberately absent matters more than what is present: no `mousemove`, no
 * `pointermove`, no `touchmove`. A mouse resting on a desk generates movement events
 * forever, and treating those as activity would keep every account counted for as long
 * as its browser was open.
 */
const INTERACTION_EVENTS = [
  'pointerdown',
  'keydown',
  'touchstart',
  'wheel',
  'scroll',
  'input',
  'change',
  'submit',
]

/*
 * Shared across tabs through localStorage, so five open tabs of the same account produce
 * one write per interval rather than five.
 *
 * This is an optimisation and nothing more. The server counts distinct accounts and
 * `student_activity` is keyed on the account, so a missed slot costs an extra beat and
 * never an extra student -- and a beat skipped here because another tab just sent one is
 * exactly as good as a beat sent here, because the timestamp is per account either way.
 *
 * It also means a tab cannot extend an account's presence on its own: the slot is
 * account-wide and time-based, not per tab.
 *
 * Keyed by account as well as by purpose, because the slot belongs to whoever is signed
 * in. Without the account in the key, a student signing in on a shared lab machine
 * moments after the previous one logged out would inherit their throttle and could not
 * beat for up to a full interval. That is harmless inside a sixty-second window, but it
 * is another account's state deciding this one's, and it costs one key to avoid.
 */
const LAST_BEAT_KEY_PREFIX = 'campus-flow:student-activity:last-beat:'

function beatKeyFor(authUserId) {
  return `${LAST_BEAT_KEY_PREFIX}${authUserId || 'anonymous'}`
}

function claimBeatSlot(now, authUserId) {
  try {
    const key = beatKeyFor(authUserId)
    const previous = Number(window.localStorage.getItem(key))
    if (Number.isFinite(previous) && now - previous < BEAT_INTERVAL_MS) return false
    window.localStorage.setItem(key, String(now))
    return true
  } catch {
    // Private-mode or storage-blocked browsers still get tracked, just without dedupe.
    return true
  }
}

function releaseBeatSlot(authUserId) {
  try {
    window.localStorage.removeItem(beatKeyFor(authUserId))
  } catch {
    // Nothing to release if the slot was never ours to take.
  }
}

export function useStudentActivity(enabled, authUserId) {
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

    /*
     * The one place a beat is written, and it decides for itself whether this is a
     * moment worth writing.
     */
    const beat = async () => {
      if (disposed || controller.signal.aborted) return

      /*
       * A backgrounded tab is not a student using CampusFlow. Background tabs also have
       * their timers throttled to the point of uselessness, so a beat that does get
       * sent from one is a beat sent by a browser that is not in front of anyone.
       */
      if (document.visibilityState === 'hidden') return

      /*
       * And only for a moment close to real interaction. This is the guard that keeps a
       * tab sitting open from holding an account on the dashboard indefinitely.
       */
      if (Date.now() - lastInteraction.current > TRAILING_BEAT_WINDOW_MS) return

      if (!claimBeatSlot(Date.now(), authUserId)) return
      try {
        await sendActivityPing({ signal: controller.signal })
      } catch {
        /*
         * Monitoring is never worth failing a student's session over. Give the slot
         * back so the next interaction retries, and move on silently.
         */
        releaseBeatSlot(authUserId)
      }
    }

    /*
     * Interaction marks the moment and then asks for a beat straight away, rather than
     * waiting for the timer. The throttle still applies, so a burst of events produces
     * one write and the rest are free.
     */
    const handleInteraction = () => {
      lastInteraction.current = Date.now()
      beat()
    }

    /*
     * Coming back to the tab and regaining connectivity both count as the student
     * picking CampusFlow back up, and both are the moments where a beat is most overdue.
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
      window.addEventListener(name, handleInteraction, { passive: true })
    )
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('online', handleOnline)

    /*
     * One beat as soon as the tracker starts, so a student who has just signed in is
     * counted straight away rather than waiting for their first tap. The window above is
     * seeded with "now" above, which is what allows this.
     */
    beat()
    const timer = window.setInterval(beat, BEAT_INTERVAL_MS)

    return () => {
      disposed = true
      controller.abort()
      window.clearInterval(timer)
      INTERACTION_EVENTS.forEach((name) =>
        window.removeEventListener(name, handleInteraction)
      )
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('online', handleOnline)
    }
    /*
     * `authUserId` is a dependency in its own right: a different account on this browser
     * must not inherit the previous one's beat slot, and the tracker has to restart so
     * its listeners and interval belong to whoever is signed in now.
     */
  }, [enabled, authUserId])
}