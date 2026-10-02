import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom'
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
import AdminSubjectManagement from './pages/AdminSubjectManagement'
import AdminHodManagement from './pages/AdminHodManagement'
import AdminContestCoordinatorManagement from './pages/AdminContestCoordinatorManagement'
import StudentEntry from './pages/StudentEntry'
import StudentMentorAllocation from './pages/StudentMentorAllocation'
import StudentOdForm from './pages/StudentOdForm'
import ApproverLogin from './pages/ApproverLogin'
import ApproverOdInbox from './pages/ApproverOdInbox'
import CoordinatorDashboard from './pages/CoordinatorDashboard'
import HodDashboard from './pages/HodDashboard'
import AdminRoute from './components/AdminRoute'
import NotFound from './pages/NotFound'

/*
 * The four stages of the OD approval chain, as a route parameter.
 *
 * Anything outside this list is answered with NotFound rather than being passed to the
 * inbox, so a mistyped or stale link cannot open a queue for a stage that does not
 * exist. The server matches the same four values and refuses anything else, so this is
 * about not rendering an empty screen rather than about security.
 */
const OD_STAGES = ['MENTOR', 'CLASS_ADVISOR', 'CONTEST_COORDINATOR', 'HOD']

function ApproverOdInboxRoute() {
  const { stage } = useParams()
  if (!OD_STAGES.includes(stage)) {
    return <NotFound />
  }
  return <ApproverOdInbox stage={stage} />
}

export default function App() {
  return (
    <AuthProvider>
      <StaffAuthProvider>
        <AdminAuthProvider>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route path="/" element={<LoadingScreen />} />
              <Route path="/role-selection" element={<RoleSelection />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/staff" element={<StaffDashboard />} />
              <Route path="/advisor" element={<AdvisorDashboard />} />
              <Route path="/student" element={<StudentDashboard />} />
              {/*
                The student's entry screen, and the two things it leads to.

                A student login now lands on `/student/entry` rather than going
                straight to the OTP page, because attendance is one of three things a
                student can come here to do. `/student` is unchanged and is what
                "Mark Attendance" opens.
              */}
              <Route path="/student/entry" element={<StudentEntry />} />
              <Route path="/student/mentor" element={<StudentMentorAllocation />} />
              <Route path="/student/od" element={<StudentOdForm />} />
{/* Approvers. The stage is in the path and is re-checked server-side. */}
              <Route path="/approver/login" element={<ApproverLogin />} />
              <Route path="/approver/od/:stage" element={<ApproverOdInboxRoute />} />
              {/*
                The two dedicated approver dashboards. Contest coordinators and heads of
                department are not staff, so they are not on the role-selection screen and
                have no dashboard anyone reaches from it -- these two are their whole reason
                for existing, and they render the same approval panel the Staff and Class
                Advisor dashboards use.
              */}
              <Route path="/coordinator" element={<CoordinatorDashboard />} />
              <Route path="/hod" element={<HodDashboard />} />
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
              <Route path="/admin/subjects" element={<AdminRoute><AdminSubjectManagement /></AdminRoute>} />
              <Route path="/admin/hods" element={<AdminRoute><AdminHodManagement /></AdminRoute>} />
              <Route
                path="/admin/contest-coordinators"
                element={
                  <AdminRoute>
                    <AdminContestCoordinatorManagement />
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
