import { supabase, BACKEND_CONFIGURED } from './supabase'
import { ApiError } from './attendanceApi'

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

/**
 * Resolve a staff identifier to their login email.
 *
 * An email is used directly. A staff ID is resolved through public.staff.
 * Note: public.staff is protected by RLS, so an unauthenticated staff ID
 * lookup is intentionally restricted — sign in with your staff email.
 */
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

  const { data, error } = await supabase
    .from('staff')
    .select('email')
    .eq('staff_id', id)
    .maybeSingle()

  if (error) throw mapAuthError(error, 'login')
  if (!data?.email) {
    throw new ApiError(
      'Could not resolve that staff ID. Please sign in with your staff email instead.',
      { code: 'staff-id-unresolved' }
    )
  }
  return data.email
}

/**
 * Authenticate a staff member.
 *
 * The password is verified by Supabase Auth using the staff member's
 * email. After a successful sign-in the staff record is resolved through
 * the authenticated user's UUID (auth_user_id) — never through a
 * browser-supplied department or staff ID.
 */
export async function staffLogin(identifier, password) {
  assertBackend()
  if (!password) {
    throw new ApiError('Please enter your password.', { code: 'invalid-password' })
  }
  const email = await resolveStaffEmail(identifier)
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !data?.user) {
    throw mapAuthError(error, 'login')
  }
  const staff = await getCurrentStaff(data.user.id)
  if (!staff) {
    await supabase.auth.signOut().catch(() => {})
    throw new ApiError(
      'Your account is not linked to a staff record. Please contact your administrator.',
      { code: 'unlinked-staff' }
    )
  }
  const session = await getCurrentSession()
  return { user: data.user, staff, session }
}

export async function staffLogout() {
  if (!BACKEND_CONFIGURED || !supabase) return
  await supabase.auth.signOut()
}

export async function getCurrentUser() {
  if (!BACKEND_CONFIGURED || !supabase) return null
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) return null
  return data.user
}

/**
 * Resolve the authenticated user's staff record. The lookup is always
 * keyed by the authenticated user's UUID via `auth_user_id`, and the
 * department comes from public.staff — never from the browser.
 */
export async function getCurrentStaff(userId) {
  assertBackend()
  if (!userId) return null
  const { data, error } = await supabase
    .from('staff')
    .select('staff_id, staff_name, email, department')
    .eq('auth_user_id', userId)
    .maybeSingle()
  if (error) throw mapAuthError(error)
  if (!data) return null
  return data
}

export async function getCurrentSession() {
  if (!BACKEND_CONFIGURED || !supabase) return null
  const { data } = await supabase.auth.getSession()
  return data?.session || null
}

export function onAuthStateChange(callback) {
  if (!BACKEND_CONFIGURED || !supabase) return () => {}
  const { data } = supabase.auth.onAuthStateChange(callback)
  return () => data?.subscription?.unsubscribe()
}

/**
 * Send a password reset email to the staff member's address.
 * The staff member enters their staff email.
 */
export async function requestStaffPasswordReset(email) {
  assertBackend()
  const value = String(email || '').trim().toLowerCase()
  if (!value || !value.includes('@')) {
    throw new ApiError('Please enter a valid staff email.', { code: 'invalid-email' })
  }
  const redirectTo = `${window.location.origin}/reset-password`
  const { error } = await supabase.auth.resetPasswordForEmail(value, { redirectTo })
  if (error) throw mapAuthError(error, 'reset')
  return RESET_SENT_MESSAGE
}

/**
 * Update the signed-in staff member's password. Supabase Auth verifies
 * the current password — the frontend never asks for it.
 */
export async function updateStaffPassword(newPassword) {
  assertBackend()
  const { data, error } = await supabase.auth.updateUser({ password: newPassword })
  if (error || !data?.user) throw mapAuthError(error, 'update-password')
  return PASSWORD_UPDATED_MESSAGE
}