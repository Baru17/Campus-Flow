import { usePwaInstall } from '../hooks/usePwaInstall'
import { DownloadIcon } from './Icons'

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
 * Two variants, so the same behaviour can live in the two places that make sense:
 *
 * - `icon` sits in the navbar next to Logout and mirrors that button's shape, including
 *   collapsing to its glyph below the `sm` breakpoint. This is what keeps the option
 *   reachable from any dashboard without taking a line of its own.
 * - `full` is the labelled button used inside the "Access CampusFlow" card on the
 *   role-selection screen, where there is room to say what installing does.
 */
export default function InstallPwaButton({ variant = 'icon', className = '' }) {
  const { canInstall, promptInstall } = usePwaInstall()

  if (!canInstall) return null

  const labelled = variant === 'full'
  const shape = labelled
    ? 'auth-btn-primary text-sm'
    : 'btn-cf-ghost inline-flex items-center gap-2 px-4 py-2 text-sm'

  return (
    <button
      type="button"
      className={`${shape} ${className}`.trim()}
      onClick={promptInstall}
      title="Install CampusFlow on this device"
    >
      <DownloadIcon size={labelled ? 16 : 15} />
      <span className={labelled ? '' : 'hide-sm'}>Install CampusFlow</span>
    </button>
  )
}