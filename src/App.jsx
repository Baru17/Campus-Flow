import { BrowserRouter, Routes, Route } from 'react-router-dom'
import AuthProvider from './context/AuthContext'
import StaffAuthProvider from './context/StaffAuthContext'
import AdminAuthProvider from './context/AdminAuthContext'
import LoadingScreen from './components/LoadingScreen'
import ResetPassword from './pages/ResetPassword'
import RoleSelection from './pages/RoleSelection'
import StaffDashboard from './pages/StaffDashboard'
import StudentDashboard from './pages/StudentDashboard'
import AdvisorDashboard from './pages/AdvisorDashboard'
import AdminLoginPage from './pages/AdminLoginPage'
import AdminDashboard from './pages/AdminDashboard'
import AdminStudentManagement from './pages/AdminStudentManagement'
import AdminStaffManagement from './pages/AdminStaffManagement'
import AdminRoute from './components/AdminRoute'
import NotFound from './pages/NotFound'

export default function App() {
  return (
    <AuthProvider>
      <StaffAuthProvider>
        <AdminAuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<LoadingScreen />} />
              <Route path="/role-selection" element={<RoleSelection />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/staff" element={<StaffDashboard />} />
              <Route path="/advisor" element={<AdvisorDashboard />} />
              <Route path="/student" element={<StudentDashboard />} />
              <Route path="/admin" element={<AdminLoginPage />} />
              <Route
                path="/admin/dashboard"
                element={
                  <AdminRoute>
                    <AdminDashboard />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/students"
                element={
                  <AdminRoute>
                    <AdminStudentManagement />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/staff"
                element={
                  <AdminRoute>
                    <AdminStaffManagement />
                  </AdminRoute>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </AdminAuthProvider>
      </StaffAuthProvider>
    </AuthProvider>
  )
}