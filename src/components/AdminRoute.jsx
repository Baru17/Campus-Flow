import { Navigate } from 'react-router-dom'
import { useAdminAuth } from '../hooks/useAdminAuth'

/**
 * Route guard for administrative pages. Redirects unauthenticated or
 * non-admin visitors to the admin login screen.
 */
export default function AdminRoute({ children }) {
  const { user, loading } = useAdminAuth()

  if (loading) {
    return (
      <div className="app-shell">
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Checking your session…</p>
          </div>
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/admin" replace />
  }

  return children
}
