import { supabase, BACKEND_CONFIGURED } from './supabase'
import { ApiError } from './attendanceApi'

const ADMIN_EMAIL = 'admin@kiot.ac.in'

const NOT_CONFIGURED_MESSAGE =
  'The authentication service is not configured yet. Contact the administrator.'

const NETWORK_MESSAGE = 'Unable to connect to the authentication service. Please try again.'

const INVALID_CREDENTIALS_MESSAGE = 'Invalid admin email or password.'

const UNAUTHORIZED_MESSAGE = 'This account is not authorized to access the admin dashboard.'

function assertBackend() {
  if (!BACKEND_CONFIGURED || !supabase) {
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

/**
 * The authenticated user must be the configured administrator. The role is
 * stored in app_metadata (set via the service role), so a normal student or
 * staff member can never impersonate the admin.
 */
export function isAdminUser(user) {
  if (!user) return false
  if (String(user.email || '').toLowerCase() !== ADMIN_EMAIL) return false
  return user.app_metadata?.role === 'admin'
}

export async function adminLogin(email, password) {
  assertBackend()
  if (!email || !password) {
    throw new ApiError('Please enter your admin email and password.', { code: 'invalid-credentials' })
  }
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  })
  if (error || !data?.user) {
    throw mapAuthError(error, 'login')
  }
  if (!isAdminUser(data.user)) {
    await supabase.auth.signOut().catch(() => {})
    throw new ApiError(UNAUTHORIZED_MESSAGE, { code: 'unauthorized' })
  }
  return { user: data.user, session: data.session }
}

export async function adminLogout() {
  if (!BACKEND_CONFIGURED || !supabase) return
  await supabase.auth.signOut()
}

export async function getCurrentAdmin() {
  if (!BACKEND_CONFIGURED || !supabase) return null
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) return null
  return isAdminUser(data.user) ? data.user : null
}

export async function getCurrentSession() {
  if (!BACKEND_CONFIGURED || !supabase) return null
  const { data } = await supabase.auth.getSession()
  return data?.session || null
}
