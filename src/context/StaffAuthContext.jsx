import { useCallback, useEffect, useMemo, useState } from 'react'
import { StaffAuthContext } from './staffAuthContextValue'
import {
  getCurrentSession,
  getCurrentStaff,
  getCurrentUser,
  requestStaffPasswordReset,
  staffLogin,
  staffLogout,
  updateStaffPassword,
} from '../api/staffAuthApi'

export default function StaffAuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [staff, setStaff] = useState(null)
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  /*
   * Restores the signed-in staff member from the session cookie.
   *
   * Kept as one function and called from both the mount effect and `refresh`, because the
   * approver sign-in page needs to be able to ask for it again. That page signs a mentor or
   * a class advisor in through `/api/auth/od-approver/login`, which issues the *same*
   * session and the *same* cookie every other role gets, and then sends them to this
   * dashboard. The provider has already mounted by then and has already decided it is
   * showing a signed-out staff member, so without this they would land on a dashboard that
   * signs them straight back out.
   */
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const currentUser = await getCurrentUser()
      const role = String(currentUser?.role || '').trim().toLowerCase().replace(/[ -]+/g, '_')
      if (role !== 'staff' && role !== 'class_advisor') {
        setUser(null)
        setStaff(null)
        setSession(null)
        return null
      }

      setUser(currentUser)
      const currentSession = await getCurrentSession()
      setSession(currentSession)
      const currentStaff = await getCurrentStaff(currentUser.id)
      setStaff(currentStaff || null)
      return currentStaff || null
    } catch {
      // Session restore failure is non-fatal; the user stays signed out.
      setUser(null)
      setStaff(null)
      setSession(null)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const login = useCallback(async (identifier, password) => {
    const result = await staffLogin(identifier, password)
    setUser(result.user)
    setStaff(result.staff)
    setSession(result.session)
    return result.staff
  }, [])

  const logout = useCallback(async () => {
    await staffLogout()
    setUser(null)
    setStaff(null)
    setSession(null)
  }, [])

  const resetPassword = useCallback(async (email) => {
    return requestStaffPasswordReset(email)
  }, [])

  const changePassword = useCallback(async (token, newPassword) => {
    return updateStaffPassword(token, newPassword)
  }, [])

  const value = useMemo(
    () => ({ user, staff, session, loading, login, logout, resetPassword, changePassword, refresh }),
    [user, staff, session, loading, login, logout, resetPassword, changePassword, refresh]
  )

  return <StaffAuthContext.Provider value={value}>{children}</StaffAuthContext.Provider>
}