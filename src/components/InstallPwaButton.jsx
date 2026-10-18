import { useEffect, useRef, useState } from 'react'
import { usePwaInstall } from '../hooks/usePwaInstall'
import { INSTALL_OUTCOME } from '../utils/pwaInstall'
import { DownloadIcon } from './Icons'

/*
 * How long the outcome of an install attempt stays on screen.
 *
 * Long enough to read on a phone, short enough that the navbar is not carrying a sentence
 * about a dialog nobody asked about for the rest of the session.
 */
const OUTCOME_MESSAGE_MS = 6000

const OUTCOME_MESSAGES = {
  [INSTALL_OUTCOME.ACCEPTED]: 'CampusFlow installed.',
  [INSTALL_OUTCOME.DISMISSED]: 'Install dismissed. You can install later from the browser menu.',
}

/*
 * The "Install CampusFlow" affordance.
 *
 * It renders nothing at all unless the browser has actually offered an install for this
 * site, and nothing at all once the app is running as an installed one. That is the whole
 * point of going through `usePwaInstall` rather than testing for service worker support:
 * "can this browser run a service worker" is not the same question as "can this browser
 * install this app right now", and answering the first one leaves a dead button in front
 * of anyone on a browser that will never prompt.
 *
 * The prompt itself is saved and spent only here, from a real click -- never on load. That
 * is also what settles the
 *
 *   Banner not shown: beforeinstallpromptevent.preventDefault() called.
 *
 * line Chromium prints: it appears for anyone who never presses this button, because the
 * browser says so when a prevented event is discarded on navigation. This button is what
 * spends the event the moment the user asks for it, and `appinstalled` clears the capture
 * when they install from browser UI instead.
 *
 * ## Why the outcome is reported at all
 *
 * The button used to be `onClick={promptInstall}`, which computed whether the user had
 * accepted and threw the answer away. That made three different outcomes indistinguishable:
 * installed, dismissed, and there was never anything to prompt. All three now say
 * something, in a polite live region so it is announced without stealing focus. The message
 * renders only when there is one, so the ordinary case is byte-for-byte the button it was.
 *
 * Two variants, so the same behaviour can live in the two places that make sense:
 *
 * - `icon` sits in the navbar next to Logout and mirrors that button's shape, including
 *   collapsing to its glyph below the `sm` breakpoint. This is what keeps the option
 *   reachable from any dashboard without taking a line of its own.
 * - `full` is the labelled button used inside the "Access CampusFlow" card on the
 *   role-selection screen, where there is room to say what installing does.
 */
export default function InstallPwaButton({ variant = 'icon', className = '' }) {
  const { canInstall, pending, promptInstall } = usePwaInstall()
  const [message, setMessage] = useState('')
  const clearTimer = useRef(null)

  useEffect(() => () => {
    if (clearTimer.current) clearTimeout(clearTimer.current)
  }, [])

  const handleClick = async () => {
    const outcome = await promptInstall()
    const text = OUTCOME_MESSAGES[outcome]

    if (clearTimer.current) clearTimeout(clearTimer.current)
    setMessage(text || '')
    /*
     * `unavailable` has nothing worth showing -- it is the permanent state on a browser
     * that never dispatches the event -- so the message is simply empty and nothing is
     * scheduled to clear.
     */
    if (text) clearTimer.current = setTimeout(() => setMessage(''), OUTCOME_MESSAGE_MS)
  }

  const labelled = variant === 'full'
  const shape = labelled
    ? 'auth-btn-primary text-sm'
    : 'btn-cf-ghost inline-flex items-center gap-2 px-4 py-2 text-sm'

  return (
    <>
      {canInstall ? (
        <button
          type="button"
          className={`${shape} ${className}`.trim()}
          onClick={handleClick}
          /*
           * The browser's own dialog is up while `pending` is true. The event is already
           * spent at that point, so this is belt and braces on top of `canInstall` going
           * false -- it also stops the button taking focus in the middle of the dialog.
           */
          disabled={pending}
          aria-busy={pending}
          title="Install CampusFlow on this device"
        >
          <DownloadIcon size={labelled ? 16 : 15} />
          <span className={labelled ? '' : 'hide-sm'}>Install CampusFlow</span>
        </button>
      ) : null}
      {message ? (
        <span role="status" aria-live="polite" className="text-xs text-slate-500">
          {message}
        </span>
      ) : null}
    </>
  )
}
