import { ChevronRightIcon, GraduationIcon, KeyIcon, LockIcon, ShieldIcon, StudentIcon } from './Icons'

export default function RoleSelection({ onStaff, onStudent, onAdvisor, onAdmin }) {
  return (
    <div className="stage-enter flex flex-col">
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-blue-700">
        <ShieldIcon size={13} />
        Secure OTP Attendance
      </span>

      <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
        Welcome to{' '}
        <span className="bg-linear-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
          Campus-Flow
        </span>
      </h1>
      <p className="mt-3 max-w-sm leading-relaxed text-slate-500">
        Smart attendance management made simple, secure, and fast.
      </p>

      <div className="mt-8 space-y-4">
        <button type="button" onClick={onStaff} className="auth-role-card group w-full text-left">
          <span className="auth-role-icon auth-role-icon-blue">
            <ShieldIcon size={24} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-lg font-bold text-slate-900 transition-colors group-hover:text-blue-700">
              Staff Login
              <span className="rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-600">
                Dashboard
              </span>
            </span>
            <span className="mt-1 block text-sm text-slate-500 transition-colors group-hover:text-slate-600">
              Generate attendance sessions and manage classroom attendance.
            </span>
          </span>
          <ChevronRightIcon
            size={20}
            className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-blue-500"
          />
        </button>

        <button type="button" onClick={onAdvisor} className="auth-role-card group w-full text-left">
          <span className="auth-role-icon auth-role-icon-emerald">
            <GraduationIcon size={24} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-lg font-bold text-slate-900 transition-colors group-hover:text-emerald-700">
              Class Advisor Login
              <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-600">
                Reports
              </span>
            </span>
            <span className="mt-1 block text-sm text-slate-500 transition-colors group-hover:text-slate-600">
              Manage your class attendance and generate daily reports.
            </span>
          </span>
          <ChevronRightIcon
            size={20}
            className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-emerald-500"
          />
        </button>

        <button type="button" onClick={onStudent} className="auth-role-card group w-full text-left">
          <span className="auth-role-icon auth-role-icon-violet">
            <StudentIcon size={24} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-lg font-bold text-slate-900 transition-colors group-hover:text-violet-700">
              Student Login
              <span className="rounded-full border border-violet-100 bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-600">
                OTP Check-in
              </span>
            </span>
            <span className="mt-1 block text-sm text-slate-500 transition-colors group-hover:text-slate-600">
              Enter your student ID and attendance OTP.
            </span>
          </span>
          <ChevronRightIcon
            size={20}
            className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-violet-500"
          />
        </button>

        <button type="button" onClick={onAdmin} className="auth-role-card group w-full text-left">
          <span className="auth-role-icon auth-role-icon-rose">
            <KeyIcon size={24} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-lg font-bold text-slate-900 transition-colors group-hover:text-rose-700">
              Admin Login
              <span className="rounded-full border border-rose-100 bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-600">
                Restricted
              </span>
            </span>
            <span className="mt-1 block text-sm text-slate-500 transition-colors group-hover:text-slate-600">
              Manage students and staff across all departments.
            </span>
          </span>
          <ChevronRightIcon
            size={20}
            className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-rose-500"
          />
        </button>
      </div>

      <div className="mt-8 flex items-center gap-2 text-xs text-slate-400">
        <LockIcon size={13} />
        Your identity and attendance are protected end to end.
      </div>
    </div>
  )
}