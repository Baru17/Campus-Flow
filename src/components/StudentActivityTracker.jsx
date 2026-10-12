import { useAuth } from '../hooks/useAuth'
import { useStudentActivity } from '../hooks/useStudentActivity'

/*
 * Mounted once, at the top of the app, so every authenticated student route is
 * covered by the same tracker.
 *
 * It sits above the router rather than inside any page on purpose. Putting a beat on
 * the entry screen, the OTP page and the OD form would mean three timers to keep in
 * step with navigation, and a page added later would silently go untracked. Mounted
 * here, navigation cannot start a second tracker and cannot stop the first one either.
 *
 * It renders nothing and it is gated on the session this app already holds: the beat
 * only runs for a signed-in student, so a visitor, a staff member or an administrator
 * on the same device sends nothing. It never touches login, logout, routing or
 * session refresh, and it cannot make the app wait -- every failure is swallowed
 * inside the hook.
 */
export default function StudentActivityTracker() {
  const { user, loading } = useAuth()
  useStudentActivity(!loading && user?.role === 'student')
  return null
}
