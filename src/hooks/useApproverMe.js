import { useCallback, useEffect, useState } from 'react'
import { approverLogout, fetchApproverMe } from '../api/odApi'

/**
 * The signed-in Contest Coordinator or HOD, for a dashboard that has no staff record.
 *
 * Deliberately a hook rather than a provider like `useStaffAuth`. A provider would have
 * to be mounted above the router to survive navigation, and it would then have to decide
 * what a *student* or a *lecturer* is -- which it cannot, and does not need to. Only the
 * two dedicated dashboards need this, and only they are inside the route that asks for
 * it, so the fetch stays where it is used.
 *
 * A mentor and a class advisor deliberately do not come through here. They already have
 * the staff context, which knows their name and department and handles their sign-out, and
 * routing them through a second identity fetch would mean two sources for one person.
 *
 * Returns `null` for `approver` while loading, on error, or when the session is not an
 * approver session at all -- the caller decides what to render for each, because "still
 * checking" and "you are not signed in as an approver" should not look the same.
 */
export function useApproverMe() {
  const [approver, setApprover] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expired, setExpired] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setExpired(false)
    try {
      const data = await fetchApproverMe()
      setApprover(data.approver || null)
    } catch (err) {
      /*
       * An expired session and a misconfigured account are told apart deliberately.
       *
       * Both arrive as a failure with no approver behind it, but they need opposite
       * advice: an expired session means "sign in again", while no directory record means
       * "contact the administrator". Collapsing them would send a coordinator whose
       * session merely timed out to the wrong place, with no way to tell the difference.
       */
      const wasUnauthorized = err?.status === 401
      setExpired(wasUnauthorized)
      setApprover(null)
      setError(
        wasUnauthorized
          ? 'Your session has expired. Sign in again to continue.'
          : err.message
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /**
   * Ends the session. A failure here is swallowed on purpose: the cookie is cleared
   * optimistically by the route either way, and a coordinator staring at a signed-in
   * screen they have just been shown a sign-out error for is worse than one that simply
   * lands back on the sign-in page.
   */
  const logout = useCallback(async () => {
    await approverLogout().catch(() => {})
  }, [])

  return { approver, loading, error, expired, reload: load, logout }
}