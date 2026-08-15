import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthContext } from './authContextValue'
import {
  getCurrentStudent,
  getCurrentUser,
  requestPasswordReset,
  studentLogin,
  studentLogout,
  updatePassword,
} from '../api/authApi'

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [student, setStudent] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const currentUser = await getCurrentUser()
        if (!active) return
        if (currentUser) {
          setUser(currentUser)
          const currentStudent = await getCurrentStudent(currentUser.id)
          if (active) setStudent(currentStudent || null)
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
    setUser(null)
    setStudent(null)
  }, [])

  const resetPassword = useCallback(async (studentId) => {
    return requestPasswordReset(studentId)
  }, [])

  const changePassword = useCallback(async (newPassword) => {
    return updatePassword(newPassword)
  }, [])

  const value = useMemo(
    () => ({ user, student, loading, login, logout, resetPassword, changePassword }),
    [user, student, loading, login, logout, resetPassword, changePassword]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}