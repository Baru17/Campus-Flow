import {
  ChevronRightIcon,
  CompassIcon,
  GraduationIcon,
  KeyIcon,
  LockIcon,
  ShieldIcon,
  StudentIcon,
} from './Icons'

/**
 * The six doors into Campus-Flow, in the order they are offered.
 *
 * Staff, class advisor, student, contest coordinator, head of department, admin.
 *
 * ## Why a coordinator and a head of department are on this screen at all
 *
 * They used not to be, deliberately: they are not staff, they have no staff record, and
 * adding them to the staff dashboard would have meant widening what "staff" means for every
 * lecturer in the system. They had a working sign-in at `/approver/login`, but nothing on
 * the front door linked to it, so reaching a coordinator's queue meant typing a URL -- and
 * that is how the coordinator dashboard ended up being looked at through
 * `/approver/od/CONTEST_COORDINATOR` rather than at `/coordinator`.
 *
 * So they are listed now, and they are listed *last of the approvers* rather than hidden
 * with the admin, because they are ordinary participants in the OD chain. What does not
 * change is that they are not staff: choosing one opens this same sign-in form and then the
 * existing approver endpoint, which checks their directory row on the server and issues the
 * same session cookie everybody else gets. Being listed is not being trusted.
 *
 * Every card is a button that opens the matching sign-in form on this same screen. None of
 * them navigates straight to a dashboard -- an unauthenticated visitor who landed on
 * `/coordinator` would see a sign-in prompt instead of somebody else's queue.
 */
export default function RoleSelection({
  onStaff,
  onStudent,
  onAdvisor,
  onCoordinator,
  onHod,
  onAdmin,
}) {
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

        <button type="button" onClick={onCoordinator} className="auth-role-card group w-full text-left">
          <span className="auth-role-icon auth-role-icon-amber">
            <CompassIcon size={24} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-lg font-bold text-slate-900 transition-colors group-hover:text-amber-700">
              Contest Coordinator Login
              <span className="rounded-full border border-amber-100 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-600">
                OD Approvals
              </span>
            </span>
            <span className="mt-1 block text-sm text-slate-500 transition-colors group-hover:text-slate-600">
              Approve on-duty requests waiting on the coordinator queue for your department.
            </span>
          </span>
          <ChevronRightIcon
            size={20}
            className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-amber-500"
          />
        </button>

        <button type="button" onClick={onHod} className="auth-role-card group w-full text-left">
          <span className="auth-role-icon auth-role-icon-cyan">
            <ShieldIcon size={24} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-lg font-bold text-slate-900 transition-colors group-hover:text-cyan-700">
              HOD Login
              <span className="rounded-full border border-cyan-100 bg-cyan-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-600">
                Final Approval
              </span>
            </span>
            <span className="mt-1 block text-sm text-slate-500 transition-colors group-hover:text-slate-600">
              Give the final approval on on-duty requests for your department.
            </span>
          </span>
          <ChevronRightIcon
            size={20}
            className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-cyan-500"
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