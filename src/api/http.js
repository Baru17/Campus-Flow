/*
 * The one `fetch` wrapper the authentication endpoints share.
 *
 * Three separate modules used to carry a byte-identical copy of this function --
 * `authApi`, `staffAuthApi` and `adminAuthApi` each had their own -- which is how three
 * providers ended up able to ask the server the same question three times in the same
 * tick. One definition means one request shape, one set of cookie rules and one place
 * where a session cookie is (or is not) attached.
 *
 * Nothing here decides anything about authentication. The session cookie is sent
 * because the whole app is served from the origin that proxies `/api`, so the cookie is
 * first-party and `credentials: 'include'` is what carries it; a 401 is still a 401 and
 * is still turned into an `ApiError` carrying its status, for the caller to interpret.
 *
 * `ApiError` is re-exported from `attendanceApi` rather than redeclared so every module
 * in the API layer keeps throwing and catching the same class.
 */
import { ApiError } from './attendanceApi'
import { BACKEND_URL } from './backendUrl'

export { ApiError }

export const NOT_CONFIGURED_MESSAGE =
  'The authentication service is not configured yet. Contact the administrator.'

export const NETWORK_MESSAGE =
  'Unable to connect to the authentication service. Please try again.'

export function isNetworkError(error) {
  const message = String(error?.message || error?.name || '').toLowerCase()
  return (
    error instanceof TypeError ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network error') ||
    message.includes('load failed') ||
    message.includes('fetch failed') ||
    message.includes('unexpected end of json input')
  )
}

export function assertBackend() {
  if (!BACKEND_URL) {
    throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  }
}

export async function apiRequest(url, options) {
  try {
    const response = await fetch(`${BACKEND_URL}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...options,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new ApiError(body.error || 'Request failed', {
        status: response.status,
        code: body.code || null,
      })
    }
    return { data: body, error: body.error || null }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (isNetworkError(error)) {
      throw new ApiError(NETWORK_MESSAGE, { code: 'network' })
    }
    throw error
  }
}
