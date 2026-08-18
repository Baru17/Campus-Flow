import { supabase, BACKEND_CONFIGURED } from './supabase'
import { ApiError } from './attendanceApi'

const NOT_CONFIGURED_MESSAGE =
  'The admin backend is not configured yet. Contact the administrator.'

const NETWORK_MESSAGE =
  'Unable to reach the server. Please check your connection and try again.'

function notConfigured() {
  return new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
}

function assertBackend() {
  if (!BACKEND_CONFIGURED || !supabase) throw notConfigured()
}

async function parseFunctionsError(error) {
  const context = error?.context

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

  const body = context?.data
  if (body && typeof body === 'object' && typeof body.error === 'string') {
    return new ApiError(body.error, { status: context?.status })
  }

  return new ApiError(NETWORK_MESSAGE, { code: 'network' })
}

/**
 * Invoke an admin Edge Function. The admin's Supabase session token is sent
 * automatically; the Edge Function re-verifies the caller's identity server-side.
 */
async function invokeAdmin(functionName, payload) {
  assertBackend()
  const { data, error } = await supabase.functions.invoke(functionName, { body: payload })
  if (error) throw await parseFunctionsError(error)
  if (!data || data.success !== true) {
    const message = data?.error || 'Unable to complete the admin request.'
    const status = data?.error === 'Unauthorized' ? 401 : null
    throw new ApiError(message, {
      status,
      code: status === 401 ? 'unauthorized' : null,
    })
  }
  return data
}

/**
 * Student management via the `admin-students` Edge Function.
 * action: 'meta' | 'list' | 'add'
 */
export async function adminStudents(action, payload = {}) {
  return invokeAdmin('admin-students', { action, ...payload })
}

/**
 * Staff management via the `admin-staff` Edge Function.
 * action: 'meta' | 'list' | 'add'
 */
export async function adminStaff(action, payload = {}) {
  return invokeAdmin('admin-staff', { action, ...payload })
}
