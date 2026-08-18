import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminAuthContext } from './adminAuthContextValue'
import { adminLogin, adminLogout, getCurrentAdmin } from '../api/adminAuthApi'

export default function AdminAuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const currentAdmin = await getCurrentAdmin()
        if (active) setUser(currentAdmin || null)
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

  const login = useCallback(async (email, password) => {
    const result = await adminLogin(email, password)
    setUser(result.user)
    return result.user
  }, [])

  const logout = useCallback(async () => {
    await adminLogout()
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout]
  )

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>
}
