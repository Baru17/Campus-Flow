import { ApiError } from './attendanceApi'
import { BACKEND_URL } from './backendUrl'

const NOT_CONFIGURED_MESSAGE =
  'The authentication service is not configured yet. Contact the administrator.'

const NETWORK_MESSAGE =
  'Unable to connect to the authentication service. Please try again.'

const INVALID_CREDENTIALS_MESSAGE = 'Invalid staff email or password.'

const RESET_FAILED_MESSAGE = 'Password reset could not be completed. Please try again.'

const INVALID_RESET_LINK_MESSAGE =
  'Your password reset link is invalid or has expired. Please request a new one.'

const PASSWORD_UPDATED_MESSAGE = 'Your password has been updated successfully.'

const RESET_SENT_MESSAGE = 'Password reset link has been sent to your staff email.'

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
    if (error?.status === 503) {
      return new ApiError('The authentication service is temporarily busy. Please retry shortly.', { status: 503, code: 'database-busy' })
    }
    if (error?.status >= 500) {
      return new ApiError('The authentication service encountered an error. Please retry shortly.', { status: error.status, code: error.code })
    }
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

  if (kind === 'update-password') {
    if (message.includes('auth session missing')) {
      return new ApiError(INVALID_RESET_LINK_MESSAGE, { code: 'reset-link-invalid' })
    }
    return new ApiError(RESET_FAILED_MESSAGE, { code: 'reset-failed' })
  }

  if (kind === 'reset') {
    return new ApiError(RESET_FAILED_MESSAGE, { code: 'reset-failed' })
  }

  return new ApiError('Something went wrong. Please try again.', { code: 'generic' })
}

async function resolveStaffEmail(identifier) {
  const value = String(identifier || '').trim()
  if (!value) {
    throw new ApiError('Please enter your staff email or staff ID.', { code: 'invalid-staff-id' })
  }
  if (value.includes('@')) return value.toLowerCase()

  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError('Please enter a valid staff email or staff ID.', { code: 'invalid-staff-id' })
  }

  try {
    const { data } = await apiRequest(`/api/auth/staff/resolve/${id}`)
    if (!data?.email) {
      throw new ApiError(
        'Could not resolve that staff ID. Please sign in with your staff email instead.',
        { code: 'staff-id-unresolved' }
      )
    }
    return data.email
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(
      'Could not resolve that staff ID. Please sign in with your staff email instead.',
      { code: 'staff-id-unresolved' }
    )
  }
}

export async function staffLogin(identifier, password) {
  assertBackend()
  if (!password) {
    throw new ApiError('Please enter your password.', { code: 'invalid-password' })
  }
  const email = await resolveStaffEmail(identifier)
  const { data } = await apiRequest('/api/auth/staff/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  if (!data?.user) {
    throw mapAuthError({ message: 'Invalid credentials' }, 'login')
  }
  const staff = data.staff || (await apiRequest(`/api/auth/staff/${data.user.auth_user_id}`).then(r => r.data))
  if (!staff) {
    await apiRequest('/api/auth/staff/logout', { method: 'POST' }).catch(() => {})
    throw new ApiError(
      'Your account is not linked to a staff record. Please contact your administrator.',
      { code: 'unlinked-staff' }
    )
  }
  const session = await getCurrentSession()
  return { user: data.user, staff, session }
}

export async function staffLogout() {
  if (!BACKEND_URL) return
  await apiRequest('/api/auth/staff/logout', { method: 'POST' }).catch(() => {})
}

export async function getCurrentUser() {
  if (!BACKEND_URL) return null
  try {
    const { data } = await apiRequest('/api/auth/user')
    if (!data?.user) return null
    return data.user
  } catch (error) {
    if (error?.status === 401) return null
    throw error
  }
}

export async function getCurrentStaff(userId) {
  assertBackend()
  if (!userId) return null
  try {
    const { data } = await apiRequest(`/api/auth/staff/${userId}`)
    if (!data) return null
    return data
  } catch (error) {
    if (error?.status === 401 || error?.status === 404) return null
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

export function onAuthStateChange(callback) {
  if (!BACKEND_URL) return () => {}
  const checkSession = async () => {
    try {
      const { data } = await apiRequest('/api/auth/session')
      callback(data?.session, data?.session ? 'SIGNED_IN' : 'SIGNED_OUT')
    } catch {
      callback(null, 'SIGNED_OUT')
    }
  }
  checkSession()
  return () => {}
}

export async function requestStaffPasswordReset(email) {
  assertBackend()
  const value = String(email || '').trim().toLowerCase()
  if (!value || !value.includes('@')) {
    throw new ApiError('Please enter a valid staff email.', { code: 'invalid-email' })
  }
  const { data } = await apiRequest('/api/auth/staff/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email: value, redirectTo: `${window.location.origin}/reset-password` }),
  })
  if (data?.error) throw mapAuthError(data, 'reset')
  return RESET_SENT_MESSAGE
}

export async function updateStaffPassword(newPassword) {
  assertBackend()
  const { data } = await apiRequest('/api/auth/staff/update-password', {
    method: 'POST',
    body: JSON.stringify({ password: newPassword }),
  })
  if (data?.error) throw mapAuthError(data, 'update-password')
  return PASSWORD_UPDATED_MESSAGE
}
