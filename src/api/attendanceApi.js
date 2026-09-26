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

async function parseFunctionsError(error) {
  const context = error?.context
  if (context && typeof context.json === 'function') { try { const body = await context.json(); if (typeof body?.error === 'string') return new ApiError(body.error, { status: context.status }) } catch { /* response was not JSON */ } }
  if (typeof context?.data?.error === 'string') return new ApiError(context.data.error, { status: context.status })
  return new ApiError(NETWORK_MESSAGE, { code: 'network' })
}

export async function getAcademicBatches(department) {
  assertBackend()
  const { data, error } = await apiRequest(`/api/academic-batches?department=${String(department || '').toUpperCase()}`)
  if (error) throw new ApiError('Could not load academic batches right now.', { code: error.code })
  return data || []
}

export async function getSubjects(department, batchCode) {
  assertBackend()
  const { data: batch } = await apiRequest(`/api/academic-batches?department=${String(department || '').toUpperCase()}&batch_code=${batchCode}`).catch(() => ({}))
  if (!batch?.current_semester) throw new ApiError('This batch has no current semester configured. Ask an administrator to configure it.')
  const { data, error } = await apiRequest(`/api/semester-subjects?semester=${batch.current_semester}`)
  if (error) throw new ApiError('Could not load subjects right now. Please try again.', { code: error.code })
  return (data || []).map((row) => ({ ...row, subject_id: row.id }))
}

export async function getLegacySubjects() {
  assertBackend()
  const { data, error } = await apiRequest('/api/class-advisors/subjects')
  if (error) throw new ApiError('Could not load historical subjects right now.', { code: error.code })
  const subjects = data?.data || data || []
  return subjects.map((row) => ({ ...row, subject_id: row.subject_id ?? row.id }))
}

export async function generateOtp({ year, department, section, period, subject_code, subject_name }) {
  assertBackend()
  const response = await apiRequest('/api/attendance/generate', {
    method: 'POST',
    body: JSON.stringify({ year, department, section, period, subject_code, subject_name }),
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
  const { data, error } = await apiRequest('/api/functions/generate-otp', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (error) throw await parseFunctionsError(error)
  if (!data?.success) throw new ApiError(data?.error || 'Unable to start the attendance session.')
  return data
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
