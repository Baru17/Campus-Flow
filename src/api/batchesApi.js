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
 * The complete batch registry, for the staff batch selector.
 *
 * The backend answers with the union of the built-in cohorts and everything in
 * `academic_batches`, so a batch created through the admin dashboard arrives here
 * without a redeploy. This is why the selector is never built from a list in
 * `constants.js`: that list is a hardcoded mirror of the backend's built-in floor
 * and cannot know about a cohort that was provisioned at runtime.
 *
 * `batches` is keyed by department and each entry is `{ key, label }`, where
 * `key` is the backend batch key ("2024_2028") and `label` is presentation only.
 * The key is the value that must be sent in a generate request.
 */
export async function fetchBatches() {
  if (!BACKEND_URL) throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  const response = await apiRequest(`/api/batches`)
  if (!response?.success) {
    throw new ApiError(response?.error || 'Failed to load batches. Please try again.')
  }
  const batches = response?.batches
  if (!batches || typeof batches !== 'object') {
    throw new ApiError('The batch list came back in an unexpected format. Reload the page; if it persists, tell an administrator.')
  }
  return batches
}
