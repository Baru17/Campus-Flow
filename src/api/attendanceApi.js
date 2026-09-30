import { BACKEND_URL } from './backendUrl'

const NOT_CONFIGURED_MESSAGE = 'The attendance backend is not configured yet. Contact the administrator.'
const NETWORK_MESSAGE = 'Unable to reach the server. Please check your connection and try again.'

export class ApiError extends Error {
  constructor(message, { status = null, code = null } = {}) { super(message); this.name = 'ApiError'; this.status = status; this.code = code }
}
const assertBackend = () => { if (!BACKEND_URL) throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' }) }

async function apiRequest(url, options) {
  try {
    const response = await fetch(`${BACKEND_URL}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...options,
    })
    const data = await response.json()
    if (!response.ok) {
      const error = new Error(data.error || 'Request failed')
      error.status = response.status
      error.code = data.code || null
      throw error
    }
    return data
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof TypeError || String(error?.message || '').toLowerCase().includes('failed to fetch')) {
      throw new ApiError(NETWORK_MESSAGE, { code: 'network' })
    }
    throw error
  }
}

/*
 * The subject catalog lives in `subjectsApi.js` and is fetched from `/api/subjects`.
 *
 * `getAcademicBatches`, `getSubjects` and `getLegacySubjects` used to live here,
 * reading `/api/academic-batches` and `/api/semester-subjects` and narrowing
 * subjects by a per-batch `current_semester`. None of those routes exist on the
 * Worker, and the semester model was removed from the schema, so all three would
 * have failed. They had no remaining callers: components import `getSubjects` from
 * `subjectsApi`, and only the `ApiError` class is imported from this module.
 */

export async function generateOtp({ year, department, batch, section, period, subject_code, subject_name }) {
  assertBackend()
  const response = await apiRequest('/api/attendance/generate', {
    method: 'POST',
    body: JSON.stringify({ year, department, batch, section, period, subject_code, subject_name }),
  })
  if (!response?.success) {
    throw new ApiError(response?.error || 'Unable to start the attendance session.')
  }
  return response
}

export async function verifyOtp({ otp }) {
  assertBackend()
  const response = await apiRequest('/api/attendance/verify', {
    method: 'POST',
    body: JSON.stringify({ otp }),
  })
  if (!response?.success) {
    throw new ApiError(response?.error || 'Unable to verify the OTP.')
  }
  return response
}

export async function finalizeAttendanceSession(sessionId) {
  assertBackend()
  const response = await apiRequest(`/api/attendance/finalize/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  if (!response?.success) {
    throw new ApiError(response?.error || 'Unable to finalize the attendance session.')
  }
  return response
}

export async function generateAttendanceOTP(payload) {
  assertBackend()
  /*
   * This used to call `POST /api/functions/generate-otp`, which does not exist on
   * the Worker: it was the last Supabase Edge Function the dashboard still reached
   * for, so starting a session from the staff UI failed with a 404 before any
   * attendance was written. The handler is `attendance.post("/generate")`, mounted
   * under `/api/attendance`, and it returns the same `{ success, ... }` envelope
   * the other calls here already handle.
   */
  const response = await apiRequest('/api/attendance/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (!response?.success) throw new ApiError(response?.error || 'Unable to start the attendance session.')
  return response
}

export async function verifyAttendanceOTP({ student_id, otp }) {
  assertBackend()
  const response = await apiRequest('/api/attendance/verify', {
    method: 'POST',
    body: JSON.stringify({ otp }),
  })
  if (!response?.success) {
    throw new ApiError(response?.error || 'Unable to verify the OTP.')
  }
  return {
    ...response,
    student: response.student || { student_id },
    attendance: response.attendance || {
      attendance_date: response.session?.attendance_date,
      marked_at: new Date().toISOString(),
      subject_code: response.session?.subject_code,
      subject_name: response.session?.subject_name,
      period: response.session?.period,
      section: response.session?.section,
    },
  }
}
