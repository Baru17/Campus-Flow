import { BACKEND_URL } from './backendUrl'

const NOT_CONFIGURED_MESSAGE = 'The backend is not configured yet. Contact the administrator.'
const NETWORK_MESSAGE = 'Unable to reach the server. Please check your connection and try again.'

export class ApiError extends Error {
  constructor(message, { status = null, code = null } = {}) { super(message); this.name = 'ApiError'; this.status = status; this.code = code }
}

function assertBackend() {
  if (!BACKEND_URL) throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
}

function isNetworkError(error) {
  const message = String(error?.message || error?.name || '').toLowerCase()
  return (
    error instanceof TypeError ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network error') ||
    message.includes('load failed') ||
    message.includes('fetch failed')
  )
}

async function apiRequest(url, options) {
  try {
    const response = await fetch(`${BACKEND_URL}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...options,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new ApiError(data.error || 'Request failed', {
        status: response.status,
        code: data.code || null,
      })
    }
    return data
  } catch (error) {
    if (error instanceof ApiError) throw error
    // A cancelled request is the caller tidying up, not a failure to report.
    if (error?.name === 'AbortError') throw error
    if (isNetworkError(error)) throw new ApiError(NETWORK_MESSAGE, { code: 'network' })
    throw error
  }
}

/*
 * The student heartbeat.
 *
 * The body is empty on purpose: the Worker takes the account from the session cookie,
 * so there is nothing for the browser to say about who it is. The response is
 * deliberately unread -- a beat is fire-and-forget, and a student must never see an
 * error because monitoring was unavailable. Callers are expected to swallow failures.
 */
export async function sendActivityPing({ signal } = {}) {
  assertBackend()
  return apiRequest('/api/activity/ping', { method: 'POST', signal, body: JSON.stringify({}) })
}

/*
 * The aggregate number the staff dashboard displays.
 *
 * Returns the count alone. The endpoint exposes no per-student rows, so there is
 * nothing identifying here to leak into a component tree or a devtools log.
 */
export async function getActiveStudentCount({ signal } = {}) {
  assertBackend()
  const data = await apiRequest('/api/activity/active-students', { signal })
  const count = Number(data?.active_students)
  if (!data?.success || !Number.isFinite(count)) {
    throw new ApiError('The active student count came back in an unexpected format.', {
      code: 'bad-response',
    })
  }
  return count
}

/*
 * The aggregate number for one class.
 *
 * The three selectors are sent as query parameters rather than in a path segment
 * because they are values, not identifiers: the server validates each one against
 * the same rules the admin import and the student form use, and answers 400 rather
 * than resolving anything when one of them is missing or malformed.
 *
 * As with the global count, this returns the number alone. The endpoint exposes no
 * per-student rows, so there is nothing identifying here to leak.
 */
export async function getClassActiveStudentCount({ department, year, section, signal } = {}) {
  assertBackend()
  const query = new URLSearchParams({
    department: String(department ?? ''),
    year: String(year ?? ''),
    section: String(section ?? ''),
  })
  const data = await apiRequest(`/api/activity/class-active-students?${query.toString()}`, { signal })
  const count = Number(data?.active_students)
  if (!data?.success || !Number.isFinite(count)) {
    throw new ApiError('The active student count came back in an unexpected format.', {
      code: 'bad-response',
    })
  }
  return count
}
