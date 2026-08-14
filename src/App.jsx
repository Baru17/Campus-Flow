import { BrowserRouter, Routes, Route } from 'react-router-dom'
import LoadingScreen from './components/LoadingScreen'
import RoleSelection from './pages/RoleSelection'
import StaffDashboard from './pages/StaffDashboard'
import StudentDashboard from './pages/StudentDashboard'
import NotFound from './pages/NotFound'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LoadingScreen />} />
        <Route path="/role-selection" element={<RoleSelection />} />
        <Route path="/staff" element={<StaffDashboard />} />
        <Route path="/student" element={<StudentDashboard />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
