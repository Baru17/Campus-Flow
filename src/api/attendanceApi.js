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
 * Compute the batch key for a given department + year based on the
 * current academic calendar.
 *
 * Formula: batchStartYear = currentYear - (year - 1)
 * e.g. currentYear=2026, year=2 => 2025 => batch 2025_2029
 */
function computeBatchKeyForYear(year) {
  if (!Number.isInteger(year) || year < 1 || year > 4) return null
  const currentYear = new Date().getFullYear()
  const batchStartYear = currentYear - (year - 1)
  return `${batchStartYear}_${batchStartYear + 4}`
}

/**
 * Fetch subjects for a department + year. First tries the batch-specific
 * subject table ({dept}_subjects_{batch}), then falls back to the central
 * `subjects` table for backward compatibility.
 *
 * Subjects are shared across all sections of a department + year, so the
 * section is intentionally ignored and duplicates are removed by subject code.
 */
export async function getSubjects(department, year) {
  assertBackend()
  const dept = String(department || '').toUpperCase()
  const yr = Number(year)

  // Try the batch-specific subject table first.
  const batchKey = computeBatchKeyForYear(yr)
  if (batchKey) {
    const batchTable = `${dept.toLowerCase()}_subjects_${batchKey}`
    try {
      const { data, error } = await supabase
        .from(batchTable)
        .select('subject_id, subject_code, subject_name, year, section')
        .order('subject_code', { ascending: true })

      if (!error && data && data.length > 0) {
        const seen = new Set()
        const unique = []
        for (const row of data) {
          const key = String(row.subject_code || '').toUpperCase()
          if (!key || seen.has(key)) continue
          seen.add(key)
          unique.push({ ...row, department: dept })
        }
        return unique
      }
    } catch {
      // Batch table doesn't exist or has no data — fall through.
    }
  }

  // Fall back to the central `subjects` table.
  const { data, error } = await supabase
    .from('subjects')
    .select('subject_id, subject_code, subject_name, department, year, section')
    .eq('department', department)
    .eq('year', year)
    .order('subject_code', { ascending: true })

  if (error) {
    throw new ApiError('Could not load subjects right now. Please try again.', {
      code: error.code,
    })
  }

  const seen = new Set()
  const unique = []
  for (const row of data || []) {
    const key = String(row.subject_code || '').toUpperCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  return unique
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
