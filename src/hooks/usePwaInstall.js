import { useCallback, useEffect, useRef, useState } from 'react'

/*
 * Whether this tab is already running as an installed CampusFlow.
 *
 * `navigator.standalone` is the iOS Safari spelling; the `display-mode` media queries
 * are what Android and desktop browsers use. Both are checked because there is no
 * single property that covers every platform, and being wrong in the "not installed"
 * direction would leave an install button on a screen that is already the installed app.
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

/*
 * Offers the browser's own install flow for the generated CampusFlow service worker.
 *
 * Returns nothing at all until the browser says installation is actually possible:
 *
 * - `installed` is true when the app is already running standalone, so callers can hide
 *   their affordance instead of offering to install what is already installed.
 * - `canInstall` is only true between `beforeinstallprompt` firing and the prompt being
 *   used. Browsers that do not implement installation (iOS Safari before 16.4, Firefox
 *   desktop, anything that declines to install) never fire that event, so on those the
 *   hook reports `canInstall: false` and the UI disappears rather than showing a button
 *   that cannot work.
 *
 * Nothing here touches authentication. Installing only changes how the same frontend
 * is launched; the session is still whatever cookie the backend set, and the role of
 * whoever is signed in is still whatever the backend says it is.
 */
export function usePwaInstall() {
  const deferredPrompt = useRef(null)
  const [canInstall, setCanInstall] = useState(false)
  const [installed, setInstalled] = useState(isRunningInstalled)

  useEffect(() => {
    const handleBeforeInstallPrompt = (event) => {
      /*
       * Keeping the event is what makes the browser show its own install dialog on the
       * next gesture. Preventing the default also stops Chrome's mini-infobar from
       * appearing, so the app's own affordance is the only one on screen.
       */
      event.preventDefault()
      deferredPrompt.current = event
      setCanInstall(true)
    }

    const handleInstalled = () => {
      deferredPrompt.current = null
      setCanInstall(false)
      setInstalled(true)
    }

    /* Installing or uninstalling happens from browser UI too, while the tab is open. */
    const syncInstalledState = () => setInstalled(isRunningInstalled())

    const displayModes = DISPLAY_MODE_QUERIES.map((query) =>
      typeof window.matchMedia === 'function' ? window.matchMedia(query) : null,
    ).filter(Boolean)

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
    displayModes.forEach((media) => media.addEventListener('change', syncInstalledState))

    /* The events can only be observed from here on, so the current state is read once. */
    setInstalled(isRunningInstalled())
    setCanInstall(deferredPrompt.current !== null)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
      displayModes.forEach((media) => media.removeEventListener('change', syncInstalledState))
    }
  }, [])

  const promptInstall = useCallback(async () => {
    const prompt = deferredPrompt.current
    if (!prompt) return false

    /* A deferred prompt is single-use, so it is spent whether or not the user agrees. */
    deferredPrompt.current = null
    setCanInstall(false)

    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      return choice.outcome === 'accepted'
    } catch {
      /* A dismissed or superseded prompt is not an error worth surfacing. */
      return false
    }
  }, [])

  return { canInstall: canInstall && !installed, installed, promptInstall }
}