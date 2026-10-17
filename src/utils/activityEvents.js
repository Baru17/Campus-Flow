/*
 * A same-window signal that student activity has changed.
 *
 * The staff dashboard's Active Students card reads its number from the server on a
 * timer. When a student signs out, that number is already one lower on the server --
 * logout deletes the session row -- and the card would otherwise show the old number
 * until its next poll. This module lets the sign-out path say "re-read now" so a card
 * that is mounted in the same window updates on the next tick instead of waiting for
 * the five-second poll.
 *
 * It is deliberately a plain window event and not a store: it carries no data, has no
 * subscribers to leak, and a listener that has gone away simply stops receiving. It
 * never changes a count by itself -- the only thing a listener does with it is call the
 * same guarded fetch it already polls with, so no number can be invented and no total
 * can go negative.
 *
 * Cross-device is out of reach: a student signing out on their phone is a different
 * browser from the staff member's, and there is no server push to reach it. That case
 * stays on the existing poll, which is why the poll is not removed.
 */
export const ACTIVITY_REFRESH_EVENT = 'campusflow:activity-refresh'

export function broadcastActivityRefresh() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(ACTIVITY_REFRESH_EVENT))
}

export function subscribeActivityRefresh(handler) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(ACTIVITY_REFRESH_EVENT, handler)
  return () => window.removeEventListener(ACTIVITY_REFRESH_EVENT, handler)
}
