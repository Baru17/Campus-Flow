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
 * - `canInstall` is true only while a real prompt is held and the app is not already
 *   installed. Browsers without install support never dispatch the event, so the UI hides
 *   itself there rather than offering a button that cannot work.
 * - `installed` is true when CampusFlow is already running standalone.
 */
export function usePwaInstall() {
  const state = useSyncExternalStore(subscribeInstallState, getInstallSnapshot, getInstallSnapshot)

  return { canInstall: state.canInstall, installed: state.installed, promptInstall }
}