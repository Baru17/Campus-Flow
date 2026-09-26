import { Navigate, useNavigate } from 'react-router-dom'
import AdminLogin from '../components/AdminLogin'
import BrandPanel from '../components/BrandPanel'
import { LogoIcon } from '../components/Icons'
import { useAdminAuth } from '../hooks/useAdminAuth'

export default function AdminLoginPage() {
  const navigate = useNavigate()
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

  if (user) {
    return <Navigate to="/admin/dashboard" replace />
  }

  return (
    <div className="page-enter flex min-h-screen items-center justify-center px-4 py-8 lg:py-10">
      <div className="grid w-full max-w-[1100px] grid-cols-1 overflow-hidden rounded-[32px] border border-slate-200/60 bg-white shadow-[0_32px_90px_rgba(2,6,23,0.16)] lg:h-[88vh] lg:max-h-[860px] lg:min-h-[640px] lg:grid-cols-2">
        <section className="relative flex flex-col overflow-y-auto p-6 sm:p-9 lg:p-12">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => navigate('/role-selection')}
              className="group flex items-center gap-2.5"
              aria-label="Campus-Flow home"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-linear-to-br from-blue-600 to-violet-600 text-white shadow-lg shadow-blue-600/25 transition-shadow group-hover:shadow-blue-600/40">
                <LogoIcon size={20} />
              </span>
              <span className="text-lg font-extrabold tracking-tight text-slate-900">
                Campus-
                <span className="bg-linear-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
                  Flow
                </span>
              </span>
            </button>
            <span className="hidden items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[11px] font-bold text-rose-700 sm:inline-flex">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" aria-hidden="true" />
              Admin Access
            </span>
          </div>

          <div className="flex flex-1 flex-col justify-center py-8">
            <AdminLogin />
          </div>

          <p className="text-center text-xs text-slate-400">
            {new Date().getFullYear()} © Campus-Flow · Secure OTP-based attendance management
          </p>
        </section>

        <BrandPanel />
      </div>
    </div>
  )
}
