import { supabase, BACKEND_CONFIGURED } from './supabase'

export class ApiError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const NOT_CONFIGURED_MESSAGE =
  'The attendance backend is not configured yet. Contact the administrator.'

function notConfigured() {
  return new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
}

const NETWORK_MESSAGE =
  'Unable to reach the server. Please check your connection and try again.'

async function parseFunctionsError(error) {
  const context = error?.context

  // Newer @supabase/functions-js versions put the raw Response in `context`.
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json()
      if (body && typeof body === 'object' && typeof body.error === 'string') {
        return new ApiError(body.error, { status: context.status })
      }
    } catch {
      // response body could not be read as JSON
    }
    return new ApiError(NETWORK_MESSAGE, { code: 'network' })
  }

  // Older versions put `{ data, status }` in `context`.
  const body = context?.data
  if (body && typeof body === 'object' && typeof body.error === 'string') {
    return new ApiError(body.error, { status: context?.status })
  }

  return new ApiError(NETWORK_MESSAGE, { code: 'network' })
}

function assertBackend() {
  if (!BACKEND_CONFIGURED || !supabase) throw notConfigured()
}

/**
 * Fetch subjects from the central `subjects` table, filtered by the
 * selected department, year and section.
 */
export async function getSubjects(department, year, section) {
  assertBackend()
  const { data, error } = await supabase
    .from('subjects')
    .select('subject_id, subject_code, subject_name, department, year, section')
    .eq('department', department)
    .eq('year', year)
    .eq('section', section)
    .order('subject_code', { ascending: true })

  if (error) {
    throw new ApiError('Could not load subjects right now. Please try again.', {
      code: error.code,
    })
  }
  return data || []
}

/**
 * Call the `generate-otp` Edge Function. The OTP is always created by the
 * backend — never by the frontend.
 */
export async function generateAttendanceOTP(payload) {
  assertBackend()
  const { data, error } = await supabase.functions.invoke('generate-otp', { body: payload })
  if (error) throw await parseFunctionsError(error)
  if (!data || data.success !== true) {
    throw new ApiError(data?.error || 'Unable to start the attendance session.')
  }
  return data
}

/**
 * Call the `verify-otp` Edge Function. Verification is always done by the
 * backend — never by the frontend.
 */
export async function verifyAttendanceOTP({ student_id, otp }) {
  assertBackend()
  const { data, error } = await supabase.functions.invoke('verify-otp', {
    body: { student_id, otp },
  })
  if (error) throw await parseFunctionsError(error)
  if (!data || data.success !== true) {
    throw new ApiError(data?.error || 'Unable to verify the OTP.')
  }
  return data
}
