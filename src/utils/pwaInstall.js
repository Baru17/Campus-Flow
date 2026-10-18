/*
 * Application-level capture of the browser's install prompt for CampusFlow.
 *
 * ## Why this is a module and not a hook
 *
 * `beforeinstallprompt` is dispatched by the browser at a moment of the browser's
 * choosing -- once a service worker is active, the page is controlled by it, and the
 * manifest has been fetched and judged installable. That is not tied to React's lifecycle
 * in any way, and it routinely happens either before the first component has mounted or
 * while a screen that happened to hold the event has since unmounted.
 *
 * Holding the deferred event in a `useRef` inside a component therefore loses it: a ref
 * belongs to one component instance, so a component mounting later starts with an empty
 * one, and an instance that unmounts takes its captured event with it. That is what made
 * "Install CampusFlow" invisible on a first visit and only appear after a refresh -- by
 * the second load the event fired against a component that stayed mounted long enough to
 * hold it.
 *
 * So the event is captured once, here, at module scope, before React renders anything. Any
 * component that asks later reads the already-captured state instead of waiting for an
 * event that will not fire twice. Nothing is polled and no timer is involved: the state is
 * correct on the very first paint after the browser has an opinion, whenever that is.
 *
 * Nothing here touches authentication. Installing only changes how the same frontend is
 * launched; the session is still whatever cookie the backend set, and the role of whoever
 * is signed in is still whatever the backend says it is.
 */

/*
 * Whether this tab is already running as an installed CampusFlow.
 *
 * `navigator.standalone` is the iOS Safari spelling; the `display-mode` media queries are
 * what Android and desktop browsers use. Both are checked because no single property
 * covers every platform, and being wrong in the "not installed" direction would leave an
 * install button on a screen that is already the installed app.
 */
const DISPLAY_MODE_QUERIES = [
  '(display-mode: standalone)',
  '(display-mode: fullscreen)',
  '(display-mode: window-controls-overlay)',
]

function isRunningInstalled() {
  if (typeof window === 'undefined') return false
  if (window.navigator.standalone === true) return true
  return DISPLAY_MODE_QUERIES.some((query) => {
    if (typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })
}

let deferredPrompt = null
let installed = isRunningInstalled()
let pending = false
let snapshot = null
const listeners = new Set()

/*
 * What `promptInstall` reports back.
 *
 * The distinction matters to the caller and used to be lost: the previous version returned
 * a bare boolean, so "the user dismissed the dialog", "there was nothing to prompt" and
 * "the dialog failed to open" were all `false`, and the button could not tell the user
 * anything useful about which had happened.
 */
export const INSTALL_OUTCOME = {
  ACCEPTED: 'accepted',
  DISMISSED: 'dismissed',
  UNAVAILABLE: 'unavailable',
}

function computeSnapshot() {
  return { canInstall: deferredPrompt !== null && !installed && !pending, installed, pending }
}

/*
 * `useSyncExternalStore` compares snapshots by identity, so a new object is only handed out
 * when a value actually changed. Returning a fresh-but-equal object on every event would
 * spin React in a render loop.
 */
function refresh() {
  const next = computeSnapshot()
  if (
    next.canInstall === snapshot.canInstall &&
    next.installed === snapshot.installed &&
    next.pending === snapshot.pending
  ) {
    return
  }
  snapshot = next
  listeners.forEach((listener) => listener())
}

function handleBeforeInstallPrompt(event) {
  /*
   * Keeping the event is what makes the browser show its own install dialog on the next
   * gesture. Preventing the default also suppresses Chrome's mini-infobar, so CampusFlow's
   * own affordance is the only one on screen.
   *
   * This is also the source of the console line
   *
   *   Banner not shown: beforeinstallpromptevent.preventDefault() called. The page must
   *   call beforeinstallpromptevent.prompt() to show the banner.
   *
   * Chromium emits it from `AppBannerManager::Terminate` whenever the page navigates away
   * or closes while a prevented event is still unspent -- so it appears for anyone who
   * never presses "Install CampusFlow". It is the browser confirming the interception
   * worked rather than a failure, and it cannot be avoided without giving the button up,
   * because calling `prompt()` without a user gesture is not permitted. What this module
   * can do is guarantee the event is spent whenever the user *does* ask for it.
   *
   * Already running as the installed app there is nothing to offer, so there is nothing
   * worth cancelling either.
   */
  if (installed) return
  event.preventDefault()
  deferredPrompt = event
  refresh()
}

function handleInstalled() {
  deferredPrompt = null
  installed = true
  refresh()
}

/*
 * Installing or uninstalling also happens from browser UI while the tab is open, so the
 * display mode is watched rather than read once.
 */
function syncInstalledState() {
  const next = isRunningInstalled()
  if (next === installed) return
  installed = next
  if (installed) deferredPrompt = null
  refresh()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
  window.addEventListener('appinstalled', handleInstalled)
  DISPLAY_MODE_QUERIES.forEach((query) => {
    if (typeof window.matchMedia !== 'function') return
    window.matchMedia(query).addEventListener('change', syncInstalledState)
  })
  snapshot = computeSnapshot()
}

export function getInstallSnapshot() {
  return snapshot
}

export function subscribeInstallState(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/*
 * Spends the captured prompt on the browser's native install dialog.
 *
 * Only ever called from a click on CampusFlow's own button, never on load. A deferred
 * prompt is single-use, so it is consumed whether or not the user accepts, and `canInstall`
 * goes false the moment it is spent -- which also takes the button out of the way while the
 * browser's dialog is open, instead of letting a second click try to spend a spent event.
 *
 * Returns one of {@link INSTALL_OUTCOME} so the caller can say something true:
 *
 *   - `accepted`    the user installed; `appinstalled` follows and the button stays gone.
 *   - `dismissed`   the dialog was shown and declined. No second prompt is issued.
 *   - `unavailable` there was nothing to spend, or it failed to open. Nothing is
 *                  fabricated and nothing is retried automatically.
 *
 * Browsers that do not implement installation never dispatch `beforeinstallprompt`, so the
 * last case is the permanent one there and no attempt is ever made.
 */
export async function promptInstall() {
  const prompt = deferredPrompt
  if (!prompt || installed || pending) return INSTALL_OUTCOME.UNAVAILABLE

  pending = true
  deferredPrompt = null
  refresh()

  try {
    await prompt.prompt()
    /*
     * `userChoice` is part of the spec, but reading it defensively costs nothing and keeps
     * a partial implementation from being reported as a dismissal.
     */
    const choice = await prompt.userChoice
    return choice?.outcome === 'accepted' ? INSTALL_OUTCOME.ACCEPTED : INSTALL_OUTCOME.DISMISSED
  } catch {
    /* A dismissed or superseded prompt is not an error worth surfacing as one. */
    return INSTALL_OUTCOME.UNAVAILABLE
  } finally {
    pending = false
    refresh()
  }
}

/*
 * Test seam: returns the module to its pre-capture state without touching the registered
 * listeners, which are installed once at module scope and have to stay installed.
 *
 * Production code reaches the same states through `promptInstall`, `appinstalled` and the
 * display-mode watchers; this exists so one test does not inherit the previous test's
 * captured event.
 */
export function resetInstallState() {
  deferredPrompt = null
  installed = isRunningInstalled()
  pending = false
  refresh()
}
