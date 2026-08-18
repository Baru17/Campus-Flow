import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import { useClock } from '../hooks/useClock'
import { useAdminAuth } from '../hooks/useAdminAuth'
import {
  StudentIcon,
  StaffIcon,
  ChevronRightIcon,
  ShieldIcon,
} from '../components/Icons'

export default function AdminDashboard() {
  const clock = useClock()
  const navigate = useNavigate()
  const { user, logout } = useAdminAuth()

  const handleLogout = async () => {
    await logout()
    navigate('/admin', { replace: true })
  }

  const adminLabel = user?.email || 'Administrator'

  const cards = [
    {
      title: 'STUDENTS',
      subtitle: 'Manage Students',
      description: 'View, search and import student records for every department and batch.',
      icon: <StudentIcon size={30} />,
      tone: 'blue',
      onClick: () => navigate('/admin/students'),
    },
    {
      title: 'STAFF',
      subtitle: 'Manage Staff',
      description: 'View staff records and import new staff members by department.',
      icon: <StaffIcon size={30} />,
      tone: 'violet',
      onClick: () => navigate('/admin/staff'),
    },
  ]

  return (
    <div className="app-shell">
      <Navbar title="Administrative Dashboard" subtitle={adminLabel} onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5 page-enter">
        <DashboardHero
          icon={<ShieldIcon size={26} />}
          title="Administrative Dashboard"
          subtitle={`${clock.greeting} — manage students and staff across all departments.`}
          right={
            <div className="live-clock">
              <div className="time">{clock.time}</div>
              <div className="date">{clock.date}</div>
            </div>
          }
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {cards.map((card) => (
            <button
              key={card.title}
              type="button"
              onClick={card.onClick}
              className="admin-option-card group text-left"
            >
              <div className={`admin-option-icon admin-option-icon-${card.tone}`}>{card.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-extrabold tracking-tight text-slate-900 group-hover:text-blue-700">
                    {card.title}
                  </h2>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    {card.subtitle}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-500">{card.description}</p>
              </div>
              <ChevronRightIcon
                size={22}
                className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-blue-500"
              />
            </button>
          ))}
        </div>

        <div className="mt-5 flex items-center gap-2 text-xs text-slate-400">
          <ShieldIcon size={13} />
          Admin access is restricted to the configured administrator account.
        </div>
      </main>
    </div>
  )
}
