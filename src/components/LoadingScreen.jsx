import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogoIcon } from './Icons'

const LOADING_DURATION_MS = 2600

export default function LoadingScreen() {
  const navigate = useNavigate()

  useEffect(() => {
    const timer = setTimeout(() => navigate('/role-selection', { replace: true }), LOADING_DURATION_MS)
    return () => clearTimeout(timer)
  }, [navigate])

  return (
    <div className="loading-screen">
      <div className="loading-logo-ring">
        <span className="loading-ring" aria-hidden="true" />
        <span className="loading-logo">
          <LogoIcon size={46} />
        </span>
      </div>
      <h1 className="loading-title mb-0">
        Campus-<span>Flow</span>
      </h1>
      <p className="loading-sub mb-0">College Attendance. Made simple.</p>
      <div className="loading-bar" role="progressbar" aria-label="Loading" aria-valuenow={100} aria-valuemin={0} aria-valuemax={100}>
        <div className="loading-bar-fill" />
      </div>
      <div className="loading-hint" aria-live="polite">
        Preparing your dashboard…
      </div>
    </div>
  )
}