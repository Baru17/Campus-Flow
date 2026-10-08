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
let snapshot = { canInstall: false, installed }
const listeners = new Set()

function computeSnapshot() {
  return { canInstall: deferredPrompt !== null && !installed, installed }
}

/*
 * `useSyncExternalStore` compares snapshots by identity, so a new object is only handed out
 * when a value actually changed. Returning a fresh-but-equal object on every event would
 * spin React in a render loop.
 */
function refresh() {
  const next = computeSnapshot()
  if (next.canInstall === snapshot.canInstall && next.installed === snapshot.installed) return
  snapshot = next
  listeners.forEach((listener) => listener())
}

function handleBeforeInstallPrompt(event) {
  /*
   * Keeping the event is what makes the browser show its own install dialog on the next
   * gesture. Preventing the default also suppresses Chrome's mini-infobar, so CampusFlow's
   * own affordance is the only one on screen.
   */
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
 * A deferred prompt is single-use, so it is consumed whether or not the user accepts.
 * Declining leaves `canInstall` false until the browser offers another one, which is the
 * same behaviour as before: no nagging, and no button that cannot work.
 *
 * Browsers that do not implement installation never dispatch `beforeinstallprompt`, so
 * there is nothing to spend and this reports false without attempting anything.
 */
export async function promptInstall() {
  const prompt = deferredPrompt
  if (!prompt) return false

  deferredPrompt = null
  refresh()

  try {
    await prompt.prompt()
    const choice = await prompt.userChoice
    return choice.outcome === 'accepted'
  } catch {
    /* A dismissed or superseded prompt is not an error worth surfacing. */
    return false
  }
}