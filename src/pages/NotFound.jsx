import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import LoadingButton from '../components/LoadingButton'
import { CompassIcon } from '../components/Icons'

export default function NotFound() {
  const navigate = useNavigate()

  return (
    <div className="app-shell">
      <Navbar title="Not Found" />
      <main className="container-cf py-5 page-enter text-center">
        <div className="cf-empty mx-auto" style={{ maxWidth: 460 }}>
          <span className="cf-empty-icon">
            <CompassIcon size={30} />
          </span>
          <h2 className="text-2xl font-bold mb-2">Page Not Found</h2>
          <p className="text-muted-2 mb-4">The page you are looking for does not exist.</p>
          <LoadingButton variant="primary" onClick={() => navigate('/role-selection')}>
            Go to Role Selection
          </LoadingButton>
        </div>
      </main>
    </div>
  )
}