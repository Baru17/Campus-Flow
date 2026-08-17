import { supabase, BACKEND_CONFIGURED } from './supabase'
import { ApiError } from './attendanceApi'
import { STUDENT_EMAIL_DOMAIN } from '../constants'
import { isValidStudentId, normalizeStudentId } from '../utils/validation'

const NOT_CONFIGURED_MESSAGE =
  'The authentication service is not configured yet. Contact the administrator.'

const NETWORK_MESSAGE =
  'Unable to connect to the authentication service. Please try again.'

const INVALID_CREDENTIALS_MESSAGE = 'Invalid student ID or password.'

const RESET_FAILED_MESSAGE = 'Password reset could not be completed. Please try again.'

const INVALID_RESET_LINK_MESSAGE =
  'Your password reset link is invalid or has expired. Please request a new one.'

const PASSWORD_UPDATED_MESSAGE = 'Your password has been updated successfully.'

const RESET_SENT_MESSAGE = 'Password reset link has been sent to your college email.'

function assertBackend() {
  if (!BACKEND_CONFIGURED || !supabase) {
    throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  }
}

/**
 * Normalize a student ID, validate its expected format, then convert it
 * to the student's @kiot.ac.in email used by Supabase Auth.
 */
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
 * Authenticate a student using their student ID and password.
 *
 * The student ID is converted to the matching @kiot.ac.in email and the
 * password is verified by Supabase Auth. After a successful sign-in the
 * student's database record is resolved through the authenticated user's
 * UUID — never through a browser-supplied student ID.
 */
export async function studentLogin(studentId, password) {
  assertBackend()
  if (!password) {
    throw new ApiError('Please enter your password.', { code: 'invalid-password' })
  }
  const email = studentIdToEmail(studentId)
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !data?.user) {
    throw mapAuthError(error, 'login')
  }
  const student = await getCurrentStudent(data.user.id)
  if (!student) {
    await supabase.auth.signOut().catch(() => {})
    throw new ApiError(
      'Your account is not linked to a student record. Please contact your administrator.',
      { code: 'unlinked-student' }
    )
  }
  return { user: data.user, student }
}

export async function studentLogout() {
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
 * Resolve the authenticated user's student record. The lookup is always
 * keyed by the authenticated user's UUID via `auth_user_id`.
 */
export async function getCurrentStudent(userId) {
  assertBackend()
  if (!userId) return null

 const itStudentTables = [
  'it_students_2026_2030',
  'it_students_2025_2029',
  'it_students_2024_2028',
  'it_students_2023_2027',
]

  for (const table of itStudentTables) {
    const { data, error } = await supabase
      .from(table)
      .select('student_id, register_no, student_name, year, section, email')
      .eq('auth_user_id', userId)
      .maybeSingle()

    if (error) throw mapAuthError(error)

    if (data) {
      return { ...data, department: 'IT' }
    }
  }

  return null
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
 * Send a password reset email to the student's @kiot.ac.in address.
 * The student only ever enters their student ID here.
 */
export async function requestPasswordReset(studentId) {
  assertBackend()
  const email = studentIdToEmail(studentId)
  const redirectTo = `${window.location.origin}/reset-password`
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  if (error) throw mapAuthError(error, 'reset')
  return RESET_SENT_MESSAGE
}

/**
 * Update the signed-in student's password. Supabase Auth verifies the
 * current password — the frontend never asks for it.
 */
export async function updatePassword(newPassword) {
  assertBackend()
  const { data, error } = await supabase.auth.updateUser({ password: newPassword })
  if (error || !data?.user) throw mapAuthError(error, 'update-password')
  return PASSWORD_UPDATED_MESSAGE
}