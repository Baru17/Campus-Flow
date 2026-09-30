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
 * The batch registry, for the staff batch selector.
 *
 * The backend answers with every cohort it can actually serve: a pair is listed
 * only when it is registered in `academic_batches` *and* both of its physical
 * tables exist. That is why this is the only batch list in the frontend. The one
 * that used to live in `constants.js` could neither learn about a cohort
 * provisioned after the build shipped nor forget one that had been deleted.
 *
 * `departments` and `batches` are returned together so a client cannot end up
 * offering a department the registry has no cohorts for. `batches` is keyed by
 * department and each entry is `{ key, label }`, where `key` is the backend batch
 * key ("2024_2028") and `label` is presentation only. The key is the value that
 * must be sent in a generate request.
 *
 * No table name is ever returned, so nothing here can be interpolated into SQL.
 */
export async function fetchBatchRegistry() {
  if (!BACKEND_URL) throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  const response = await apiRequest(`/api/batches`)
  if (!response?.success) {
    throw new ApiError(response?.error || 'Failed to load batches. Please try again.')
  }
  const batches = response?.batches
  if (!batches || typeof batches !== 'object') {
    throw new ApiError('The batch list came back in an unexpected format. Reload the page; if it persists, tell an administrator.')
  }
  const departments = Array.isArray(response?.departments) ? response.departments : []
  return { departments, batches }
}
