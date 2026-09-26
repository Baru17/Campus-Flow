import { BACKEND_URL } from './backendUrl'

const NOT_CONFIGURED_MESSAGE = 'The backend is not configured yet. Contact the administrator.'
const NETWORK_MESSAGE = 'Unable to reach the server. Please check your connection and try again.'

export class ApiError extends Error {
  constructor(message, { status = null, code = null } = {}) { super(message); this.name = 'ApiError'; this.status = status; this.code = code }
}

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

export async function getSubjectsByYear(year) {
  if (!BACKEND_URL) throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  const response = await apiRequest(`/api/subjects?year=${year}`)
  if (!response?.success) {
    throw new ApiError(response?.error || 'Failed to load subjects. Please try again.')
  }
  return response.subjects || []
}
