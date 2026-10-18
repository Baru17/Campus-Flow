import { ApiError, apiRequest, assertBackend, isNetworkError } from './http'
import { SESSION_NOT_STORED_MESSAGE } from './authApi'
import { BACKEND_URL } from './backendUrl'
import { clearCurrentUser, getCurrentUser, refreshCurrentUser, setCurrentUser } from './sessionApi'

const ADMIN_EMAIL = 'admin@kiot.ac.in'

const NETWORK_MESSAGE = 'Unable to connect to the authentication service. Please try again.'

const INVALID_CREDENTIALS_MESSAGE = 'Invalid admin email or password.'

const UNAUTHORIZED_MESSAGE = 'This account is not authorized to access the admin dashboard.'

function mapAuthError(error, kind = 'generic') {
  if (isNetworkError(error)) {
    return new ApiError(NETWORK_MESSAGE, { code: 'network' })
  }
  const message = String(error?.message || '').toLowerCase()
  const code = String(error?.code || '')

  if (kind === 'login') {
    if (
      code === 'invalid_credentials' ||
      message.includes('invalid login credentials') ||
      message.includes('invalid email') ||
      message.includes('email not confirmed') ||
      (error?.status && error.status >= 400 && error.status < 500)
    ) {
      return new ApiError(INVALID_CREDENTIALS_MESSAGE, { code: 'invalid-credentials' })
    }
    return new ApiError(NETWORK_MESSAGE, { code: 'network' })
  }

  return new ApiError('Something went wrong. Please try again.', { code: 'generic' })
}

export function isAdminUser(user) {
  if (!user) return false
  const identifier = String(user.email || user.user_name || '').toLowerCase()
  if (identifier !== ADMIN_EMAIL) return false
  return user.role === 'admin'
}

export async function adminLogin(email, password) {
  assertBackend()
  if (!email || !password) {
    throw new ApiError('Please enter your admin email and password.', { code: 'invalid-credentials' })
  }
  const { data } = await apiRequest('/api/auth/admin/login', {
    method: 'POST',
    body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
  })
  if (!data?.user) {
    throw mapAuthError({ message: 'Invalid credentials' }, 'login')
  }
  if (!isAdminUser(data.user)) {
    await apiRequest('/api/auth/admin/logout', { method: 'POST' }).catch(() => {})
    clearCurrentUser()
    throw new ApiError(UNAUTHORIZED_MESSAGE, { code: 'unauthorized' })
  }
  /*
   * Confirms the session cookie round-tripped against the server rather than against
   * what this page already knows, and records the new account so the providers that
   * have already settled on "signed out" agree with this one immediately.
   */
  setCurrentUser(data.user)
  const verifiedUser = await asAdmin(refreshCurrentUser())
  if (!verifiedUser) {
    await apiRequest('/api/auth/admin/logout', { method: 'POST' }).catch(() => {})
    clearCurrentUser()
    throw new ApiError(SESSION_NOT_STORED_MESSAGE, { code: 'session-not-stored' })
  }
  return { user: verifiedUser }
}

export async function adminLogout() {
  if (!BACKEND_URL) {
    clearCurrentUser()
    return
  }
  try {
    await apiRequest('/api/auth/admin/logout', { method: 'POST' })
  } catch {
    // The session is being ended either way; the cookie and the memory are cleared below.
  } finally {
    clearCurrentUser()
  }
}

/*
 * The shared read, narrowed to an administrator.
 *
 * A session that is valid but belongs to somebody else is not an admin session, so it
 * reads as "no admin" rather than as an error -- which is the same rule the admin route
 * guard has always applied to this endpoint's answer.
 */
export async function getCurrentAdmin() {
  return asAdmin(await getCurrentUser())
}

async function asAdmin(user) {
  return isAdminUser(user) ? user : null
}

export async function getCurrentSession() {
  if (!BACKEND_URL) return null
  try {
    const { data } = await apiRequest('/api/auth/session')
    return data?.session || null
  } catch (error) {
    if (error?.status === 401) return null
    throw error
  }
}
