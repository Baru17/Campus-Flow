import { supabase, BACKEND_CONFIGURED } from './supabase'

export class ApiError extends Error {
  constructor(message, { status = null, code = null } = {}) { super(message); this.name = 'ApiError'; this.status = status; this.code = code }
}
const NOT_CONFIGURED_MESSAGE = 'The attendance backend is not configured yet. Contact the administrator.'
const NETWORK_MESSAGE = 'Unable to reach the server. Please check your connection and try again.'
const assertBackend = () => { if (!BACKEND_CONFIGURED || !supabase) throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' }) }
async function parseFunctionsError(error) {
  const context = error?.context
  if (context && typeof context.json === 'function') { try { const body = await context.json(); if (typeof body?.error === 'string') return new ApiError(body.error, { status: context.status }) } catch { /* response was not JSON */ } }
  if (typeof context?.data?.error === 'string') return new ApiError(context.data.error, { status: context.status })
  return new ApiError(NETWORK_MESSAGE, { code: 'network' })
}

/** Batches are selected explicitly; their semester is never inferred from year. */
export async function getAcademicBatches(department) {
  assertBackend()
  const { data, error } = await supabase.from('academic_batches').select('batch_code, current_semester').eq('department', String(department || '').toUpperCase()).order('batch_code')
  if (error) throw new ApiError('Could not load academic batches right now.', { code: error.code })
  return data || []
}

/** Fetch central master subjects for a batch's explicitly configured semester. */
export async function getSubjects(department, batchCode) {
  assertBackend()
  const { data: batch, error: batchError } = await supabase.from('academic_batches').select('current_semester').eq('department', String(department || '').toUpperCase()).eq('batch_code', batchCode).maybeSingle()
  if (batchError || !batch?.current_semester) throw new ApiError('This batch has no current semester configured. Ask an administrator to configure it.')
  const { data, error } = await supabase.from('semester_subjects').select('id, semester, subject_code, subject_name').eq('semester', batch.current_semester).order('subject_code')
  if (error) throw new ApiError('Could not load subjects right now. Please try again.', { code: error.code })
  return (data || []).map((row) => ({ ...row, subject_id: row.id }))
}

// The Class Advisor screen can still open reports for pre-semester records.
// It deliberately keeps this read-only compatibility lookup until advisors are
// assigned an explicit batch; it is not used to create new attendance sessions.
export async function getLegacySubjects(department, year) {
  assertBackend()
  const currentYear = new Date().getFullYear()
  const yr = Number(year)
  const batchKey = Number.isInteger(yr) ? `${currentYear - (yr - 1)}_${currentYear - (yr - 1) + 4}` : ''
  const table = batchKey ? `${String(department).toLowerCase()}_subjects_${batchKey}` : ''
  if (table) {
    const { data, error } = await supabase.from(table).select('subject_id, subject_code, subject_name').order('subject_code')
    if (!error && data?.length) return data
  }
  const { data, error } = await supabase.from('subjects').select('subject_id, subject_code, subject_name').eq('department', department).eq('year', year).order('subject_code')
  if (error) throw new ApiError('Could not load historical subjects right now.', { code: error.code })
  return data || []
}

export async function generateAttendanceOTP(payload) {
  assertBackend()
  const { data, error } = await supabase.functions.invoke('generate-otp', { body: payload })
  if (error) throw await parseFunctionsError(error)
  if (!data?.success) throw new ApiError(data?.error || 'Unable to start the attendance session.')
  return data
}
export async function verifyAttendanceOTP({ student_id, otp }) {
  assertBackend()
  const { data, error } = await supabase.functions.invoke('verify-otp', { body: { student_id, otp } })
  if (error) throw await parseFunctionsError(error)
  if (!data?.success) throw new ApiError(data?.error || 'Unable to verify the OTP.')
  return data
}
