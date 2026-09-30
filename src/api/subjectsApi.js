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

/*
 * The subject catalog.
 *
 * Subjects carry no department and no year, so there is nothing to narrow this by
 * and the whole list comes back in one request. Searching is done in the browser
 * against this array, which is why the staff dashboard fetches it once instead of
 * re-requesting a filtered list on every keystroke.
 */
export async function getSubjects() {
  if (!BACKEND_URL) throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  const response = await apiRequest(`/api/subjects`)
  if (!response?.success) {
    throw new ApiError(response?.error || 'Failed to load subjects. Please try again.')
  }
  return response.subjects || []
}
