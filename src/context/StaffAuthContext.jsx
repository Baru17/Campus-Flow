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

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const currentUser = await getCurrentUser()
        const currentSession = await getCurrentSession()
        if (!active) return
        if (currentUser) {
          setUser(currentUser)
          setSession(currentSession)
          const currentStaff = await getCurrentStaff(currentUser.id)
          if (active) setStaff(currentStaff || null)
        }
      } catch {
        // Session restore failure is non-fatal; the user stays signed out.
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])

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

  const changePassword = useCallback(async (newPassword) => {
    return updateStaffPassword(newPassword)
  }, [])

  const value = useMemo(
    () => ({ user, staff, session, loading, login, logout, resetPassword, changePassword }),
    [user, staff, session, loading, login, logout, resetPassword, changePassword]
  )

  return <StaffAuthContext.Provider value={value}>{children}</StaffAuthContext.Provider>
}