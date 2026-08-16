import { BrowserRouter, Routes, Route } from 'react-router-dom'
import AuthProvider from './context/AuthContext'
import StaffAuthProvider from './context/StaffAuthContext'
import LoadingScreen from './components/LoadingScreen'
import ResetPassword from './pages/ResetPassword'
import RoleSelection from './pages/RoleSelection'
import StaffDashboard from './pages/StaffDashboard'
import StudentDashboard from './pages/StudentDashboard'
import AdvisorDashboard from './pages/AdvisorDashboard'
import NotFound from './pages/NotFound'

export default function App() {
  return (
    <AuthProvider>
      <StaffAuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LoadingScreen />} />
            <Route path="/role-selection" element={<RoleSelection />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/staff" element={<StaffDashboard />} />
            <Route path="/advisor" element={<AdvisorDashboard />} />
            <Route path="/student" element={<StudentDashboard />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </StaffAuthProvider>
    </AuthProvider>
  )
}