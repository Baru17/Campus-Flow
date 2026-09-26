import { ApiError } from './attendanceApi'
import { BACKEND_URL } from './backendUrl'

const ADMIN_EMAIL = 'admin@kiot.ac.in'

const NOT_CONFIGURED_MESSAGE =
  'The authentication service is not configured yet. Contact the administrator.'

const NETWORK_MESSAGE = 'Unable to connect to the authentication service. Please try again.'

const INVALID_CREDENTIALS_MESSAGE = 'Invalid admin email or password.'

const UNAUTHORIZED_MESSAGE = 'This account is not authorized to access the admin dashboard.'

function assertBackend() {
  if (!BACKEND_URL) {
    throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  }
}

function isNetworkError(error) {
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

async function apiRequest(url, options) {
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
    throw new ApiError(UNAUTHORIZED_MESSAGE, { code: 'unauthorized' })
  }
  return { user: data.user }
}

export async function adminLogout() {
  if (!BACKEND_URL) return
  await apiRequest('/api/auth/admin/logout', { method: 'POST' }).catch(() => {})
}

export async function getCurrentAdmin() {
  if (!BACKEND_URL) return null
  try {
    const { data } = await apiRequest('/api/auth/user')
    if (!data?.user) return null
    return isAdminUser(data.user) ? data.user : null
  } catch (error) {
    if (error?.status === 401) return null
    throw error
  }
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
