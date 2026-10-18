import { useSyncExternalStore } from 'react'
import {
  getInstallSnapshot,
  promptInstall,
  subscribeInstallState,
} from '../utils/pwaInstall'

/*
 * Reads the install state that `utils/pwaInstall` captures at app start.
 *
 * The hook holds no state of its own and registers no listeners, which is the whole point:
 * the browser event is captured once for the whole application, so a component that mounts
 * long after the event -- or a second component mounting independently -- sees the same
 * answer immediately instead of waiting for an event that will not fire again. That is what
 * makes "Install CampusFlow" appear on the first page load rather than only after a
 * refresh.
 *
 * The returned shape is unchanged, so `InstallPwaButton` and anything else reading this
 * need no changes.
 *
 * - `canInstall` is true only while a real prompt is held, the app is not already
 *   installed, and no prompt is currently open. Browsers without install support never
 *   dispatch the event, so the UI hides itself there rather than offering a button that
 *   cannot work.
 * - `installed` is true when CampusFlow is already running standalone.
 * - `pending` is true between the click and the user's answer, so the button can disable
 *   itself while the browser's own dialog is up rather than spending a spent prompt twice.
 * - `promptInstall` reports one of `INSTALL_OUTCOME`, which is what lets a caller tell an
 *   install apart from a dismissal apart from there being nothing to prompt at all.
 */
export function usePwaInstall() {
  const state = useSyncExternalStore(subscribeInstallState, getInstallSnapshot, getInstallSnapshot)

  return {
    canInstall: state.canInstall,
    installed: state.installed,
    pending: state.pending,
    promptInstall,
  }
}
