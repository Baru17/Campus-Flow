import { ApiError } from './attendanceApi'
import { BACKEND_URL } from './backendUrl'

const NOT_CONFIGURED_MESSAGE =
  'The attendance backend is not configured yet. Contact the administrator.'

function assertBackend() {
  if (!BACKEND_URL) {
    throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  }
}

async function apiRequest(url, options) {
  try {
    const response = await fetch(`${BACKEND_URL}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...options,
    })
    const body = await response.json()
    if (!response.ok) {
      const error = new Error(body.error || 'Request failed')
      error.status = response.status
      error.code = body.code || null
      throw error
    }
    return body.data !== undefined ? body.data : body
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof TypeError || String(error?.message || '').toLowerCase().includes('failed to fetch')) {
      throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'network' })
    }
    throw error
  }
}

export async function getAdvisorAssignment(staffId) {
  assertBackend()
  if (!staffId) return null
  return (await apiRequest(`/api/class-advisors?staff_id=${staffId}&is_active=true`)) || null
}

export async function getClassStudents() {
  assertBackend()
  const data = await apiRequest('/api/class-advisors/students')
  return Array.isArray(data) ? data : (data?.students || data || [])
}

export async function getLegacySubjects() {
  assertBackend()
  const data = await apiRequest('/api/class-advisors/subjects').catch(() => null)
  const subjects = Array.isArray(data) ? data : (data?.data || data || [])
  return subjects.map((row) => ({ ...row, subject_id: row.subject_id ?? row.id }))
}

export async function getAttendance(date, period) {
  assertBackend()
  const params = new URLSearchParams({ date, period })
  const data = await apiRequest(`/api/class-advisors/attendance?${params}`)
  if (!data || data.success === false) return null
  return data
}

export async function patchAttendance(sessionId, registerNo, status) {
  assertBackend()
  const data = await apiRequest(`/api/class-advisors/attendance/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ register_no: registerNo, status }),
  })
  if (!data.success) {
    throw new ApiError(data.error || 'Failed to update attendance', { code: data.code })
  }
  return data.attendance
}

export async function getReport(date, period) {
  assertBackend()
  const params = new URLSearchParams({ date, period })
  const data = await apiRequest(`/api/class-advisors/attendance/report?${params}`)
  if (!data || data.success === false) return null
  return data
}

export function getAttendanceTable(department, year) {
  const yr = Number(year)
  if (yr === 3) return 'IT_Attendance_2024_2028'
  if (yr === 2) return 'IT_Attendance_2025_2029'
  return null
}

export function getStudentTable(department, year) {
  const yr = Number(year)
  if (yr === 3) return 'IT_Students_2024_2028'
  if (yr === 2) return 'IT_Students_2025_2029'
  return null
}
