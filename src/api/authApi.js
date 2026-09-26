import { ApiError } from './attendanceApi'
import { BACKEND_URL } from './backendUrl'
import { STUDENT_EMAIL_DOMAIN } from '../constants'
import { isValidStudentId, normalizeStudentId } from '../utils/validation'

const NOT_CONFIGURED_MESSAGE =
  'The authentication service is not configured yet. Contact the administrator.'

const NETWORK_MESSAGE =
  'Unable to connect to the authentication service. Please try again.'

const INVALID_CREDENTIALS_MESSAGE = 'Invalid student ID or password.'

export const SESSION_NOT_STORED_MESSAGE =
  'Sign-in succeeded but this browser did not keep the session cookie, so your login is not active. ' +
  'Your browser is most likely blocking third-party cookies for this site. ' +
  'Allow cookies for this site in your browser settings (or use a private/incognito window) and sign in again.'

const RESET_FAILED_MESSAGE = 'Password reset could not be completed. Please try again.'

const INVALID_RESET_LINK_MESSAGE =
  'Your password reset link is invalid or has expired. Please request a new one.'

const PASSWORD_UPDATED_MESSAGE = 'Your password has been updated successfully.'

const RESET_SENT_MESSAGE = 'Password reset link has been sent to your college email.'

function assertBackend() {
  if (!BACKEND_URL) {
    throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  }
}

export function studentIdToEmail(studentId) {
  const id = normalizeStudentId(studentId)
  if (!isValidStudentId(id)) {
    throw new ApiError('Please enter a valid student ID.', { code: 'invalid-student-id' })
  }
  return `${id.toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`
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
      const error = new Error(body.error || 'Request failed')
      error.status = response.status
      error.code = body.code || null
      throw error
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

export async function studentLogin(studentId, password) {
  assertBackend()
  if (!password) {
    throw new ApiError('Please enter your password.', { code: 'invalid-password' })
  }
  const isEmail = String(studentId).includes('@')
  const user_name = isEmail ? String(studentId).trim().toLowerCase() : normalizeStudentId(studentId)
  const { data } = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ user_name, password }),
  })
  if (!data?.user) {
    throw mapAuthError({ message: 'Invalid credentials' }, 'login')
  }
  if (data.student) {
    const verifiedUser = await getCurrentUser()
    if (!verifiedUser || verifiedUser.role !== 'student') {
      throw new ApiError(SESSION_NOT_STORED_MESSAGE, { code: 'session-not-stored' })
    }
    return { user: data.user, student: data.student }
  }
  throw new ApiError(
    'Your account is not linked to a student record. Please contact your administrator.',
    { code: 'unlinked-student' }
  )
}

export async function studentLogout() {
  if (!BACKEND_URL) return
  await apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {})
}

export async function getCurrentUser() {
  if (!BACKEND_URL) return null
  try {
    const { data } = await apiRequest('/api/auth/user')
    return data?.user || null
  } catch {
    return null
  }
}

export async function getCurrentStudent(authUserId) {
  if (!BACKEND_URL || !authUserId) return null
  try {
    const { data } = await apiRequest('/api/auth/auth/student')
    return data?.student || null
  } catch {
    return null
  }
}

export async function getCurrentSession() {
  if (!BACKEND_URL) return null
  try {
    const { data } = await apiRequest('/api/auth/session')
    return data?.session || null
  } catch {
    return null
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

export async function requestPasswordReset(studentId) {
  assertBackend()
  const email = studentIdToEmail(studentId)
  const { data } = await apiRequest('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, redirectTo: `${window.location.origin}/reset-password` }),
  })
  if (data?.error) throw mapAuthError(data, 'reset')
  return RESET_SENT_MESSAGE
}

export async function updatePassword(newPassword) {
  assertBackend()
  const { data } = await apiRequest('/api/auth/update-password', {
    method: 'POST',
    body: JSON.stringify({ password: newPassword }),
  })
  if (data?.error) throw mapAuthError(data, 'update-password')
  return PASSWORD_UPDATED_MESSAGE
}
