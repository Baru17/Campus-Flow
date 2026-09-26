import { ApiError } from './attendanceApi'
import { BACKEND_URL } from './backendUrl'

const NOT_CONFIGURED_MESSAGE =
  'The admin backend is not configured yet. Contact the administrator.'

const NETWORK_MESSAGE =
  'Unable to reach the server. Please check your connection and try again.'

function notConfigured() {
  return new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
}

function assertBackend() {
  if (!BACKEND_URL) throw notConfigured()
}

async function apiRequest(functionName, payload) {
  assertBackend()
  try {
    const response = await fetch(`${BACKEND_URL}/api/functions/${functionName}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      method: 'POST',
      body: JSON.stringify(payload),
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

export async function adminStudents(action, payload = {}) {
  return apiRequest('admin-students', { action, ...payload })
}

export async function adminStaff(action, payload = {}) {
  return apiRequest('admin-staff', { action, ...payload })
}

export async function adminSubjects(action, payload = {}) {
  return apiRequest('admin-subjects', { action, ...payload })
}
