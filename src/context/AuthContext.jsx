import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthContext } from './authContextValue'
import {
  getCurrentStudent,
  requestPasswordReset,
  studentLogin,
  studentLogout,
  updatePassword,
  validateResetToken,
} from '../api/authApi'
import { getCurrentUser } from '../api/sessionApi'
import { broadcastActivityRefresh } from '../utils/activityEvents'

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [student, setStudent] = useState(null)
  const [loading, setLoading] = useState(true)

  /*
   * Three providers are mounted above the router and all three need to know who is
   * signed in. `getCurrentUser` is a shared read rather than a private `fetch`, so this
   * effect joins the request `StaffAuthProvider` and `AdminAuthProvider` are making at
   * the same moment instead of adding a third and fourth copy of it. A signed-out visitor
   * therefore gets one 401 on the page, not three -- and React's `StrictMode`, which runs
   * mount effects twice in development, adds no extra copies either.
   *
   * The 401 itself is not a failure and is not logged or retried: it is the server saying
   * there is no session, which is what a visitor who has not signed in should see.
   */
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const currentUser = await getCurrentUser()
        if (!active) return
        if (currentUser) {
          setUser(currentUser)
          if (currentUser.role === 'student') {
            const currentStudent = await getCurrentStudent(currentUser.id)
            if (active) setStudent(currentStudent || null)
          }
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

  const login = useCallback(async (studentId, password) => {
    const result = await studentLogin(studentId, password)
    setUser(result.user)
    setStudent(result.student)
    return result.student
  }, [])

  const logout = useCallback(async () => {
    await studentLogout()
    /*
     * The student's session row is deleted server-side by this call. Tell any
     * activity reader in this window to re-read now; it re-reads the server, so
     * the number can only ever fall to the true value and never below it.
     */
    broadcastActivityRefresh()
    setUser(null)
    setStudent(null)
  }, [])

  const resetPassword = useCallback(async (studentId) => {
    return requestPasswordReset(studentId)
  }, [])

  const changePassword = useCallback(async (token, newPassword) => {
    return updatePassword(token, newPassword)
  }, [])

  const value = useMemo(
    () => ({
      user,
      student,
      loading,
      login,
      logout,
      resetPassword,
      changePassword,
      validateResetToken,
    }),
    [user, student, loading, login, logout, resetPassword, changePassword]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}