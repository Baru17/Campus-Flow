import { useNavigate } from 'react-router-dom'
import { LogoIcon, LogoutIcon } from './Icons'

export default function Navbar({ title, subtitle, onLogout }) {
  const navigate = useNavigate()

  const handleLogout = () => {
    if (onLogout) {
      onLogout()
      return
    }
    navigate('/role-selection')
  }

  return (
    <nav className="cf-navbar">
      <div className="container-cf cf-navbar-inner">
        <button
          type="button"
          className="cf-brand-btn"
          onClick={() => navigate('/role-selection')}
          aria-label="Campus-Flow home"
        >
          <span className="cf-logo">
            <LogoIcon size={22} />
          </span>
          <span className="cf-brand-title">
            Campus-<span>Flow</span>
          </span>
        </button>

        <div className="cf-nav-center">
          <div className="font-semibold">{title || 'Dashboard'}</div>
          {subtitle && <small className="block text-muted-2 text-sm">{subtitle}</small>}
        </div>

        <div className="cf-nav-actions">
          <button
            type="button"
            className="btn-cf-ghost inline-flex items-center gap-2 px-4 py-2 text-sm"
            onClick={handleLogout}
          >
            <LogoutIcon size={15} />
            <span className="hide-sm">Logout</span>
          </button>
        </div>
      </div>
    </nav>
  )
}