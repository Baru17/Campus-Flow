import { ApiError } from './attendanceApi'
import { BACKEND_URL } from './backendUrl'

/**
 * The admin dashboard's data layer.
 *
 * This used to call `POST /api/functions/admin-students`, and the three
 * `admin-*` functions it named have no implementation on the Worker. That URL
 * shape is the old Supabase Edge Function convention, where one function per
 * domain multiplexed every operation through an `action` field in the body. It is
 * deliberately not revived here.
 *
 * These are ordinary REST resources under `/api/admin`, mounted in `index.ts` and
 * authorised with `requireAuth` + `requireAdmin` on the Worker, so access depends
 * on the session and role in the database rather than on anything the browser
 * sends. Errors come back in the same `{ success, error, code }` shape the rest of
 * the API uses, and a bulk import reports per-row problems alongside them.
 */
const NOT_CONFIGURED_MESSAGE =
  'The admin backend is not configured yet. Contact the administrator.'

const NETWORK_MESSAGE =
  'Unable to reach the server. Please check your connection and try again.'

function notConfigured() {
  return new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
}

function assertBackend() {
  if (!BACKEND_URL) throw notConfigured()
}

function isNetworkFailure(error) {
  if (error instanceof TypeError) return true
  const message = String(error?.message || '').toLowerCase()
  return message.includes('failed to fetch') || message.includes('networkerror')
}

/**
 * Parses a response body, tolerating a non-JSON error page.
 *
 * The Worker answers an unrouted path with a plain-text 404, and `response.json()`
 * on that throws a `SyntaxError` which is neither an `ApiError` nor a network
 * failure, so it used to escape unhandled. A failed parse is treated as an empty
 * body and the status code decides the message.
 */
async function readBody(response) {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

async function request(path, { method = 'GET', query, body } = {}) {
  assertBackend()

  const url = new URL(`${BACKEND_URL}${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  let response
  try {
    response = await fetch(url.toString(), {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (isNetworkFailure(error)) {
      throw new ApiError(NETWORK_MESSAGE, { code: 'network' })
    }
    throw error
  }

  const data = await readBody(response)
  if (!response.ok) {
    throw new ApiError(data.error || `Request failed (${response.status})`, {
      code: data.code || null,
      status: response.status,
      details: data.details || data.invalid || null,
    })
  }
  return data
}

function withTarget(path, department, batch) {
  const query = new URLSearchParams()
  if (department) query.set('department', department)
  if (batch) query.set('batch', batch)
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

/* ------------------------------------------------------------------ batches */

/**
 * Departments and the batches already provisioned for each of them.
 *
 * Pass a department to get only that department's cohorts, which is what the
 * picker wants once the department step is done. Omit it for the full map, which is
 * what the department step itself needs.
 */
export function fetchAdminBatches(department) {
  return request(withTarget('/api/admin/batches', department))
}

/**
 * Creates a cohort's tables and registers it. Idempotent, so calling it for a
 * batch that already exists reports `created: false` rather than failing.
 */
export function createAdminBatch(department, batch) {
  return request('/api/admin/batches', { method: 'POST', body: { department, batch } })
}

/* ------------------------------------------------------------------ students */

export function fetchAdminStudents(department, batch) {
  return request(withTarget('/api/admin/students', department, batch))
}

export function createAdminStudents(department, batch, rows) {
  return request(withTarget('/api/admin/students', department, batch), {
    method: 'POST',
    body: { rows },
  })
}

/**
 * Edits one student.
 *
 * Only the four editable fields are sent: `student_name`, `year`, `section` and
 * `email`. `student_id` is not among them and `register_no` is not either -- the
 * department and batch here are query parameters that tell the backend *where* the
 * student is, and the physical table is resolved from the registry on the server
 * either way. The id being edited is the last path segment, so there is nothing in
 * this call for the server to take the student's identity from, and no way to
 * express a change to the register number attendance is recorded against.
 */
export function updateAdminStudent(studentId, { department, batch, ...fields }) {
  return request(withTarget(`/api/admin/students/${encodeURIComponent(studentId)}`, department, batch), {
    method: 'PATCH',
    body: fields,
  })
}

/* --------------------------------------------------------------------- staff */

/**
 * Every staff member in a department.
 *
 * There is no batch parameter, and deliberately so: staff are rows in one `staff`
 * table, not spread across per-cohort tables the way students are. A batch only
 * appears on a staff record when the person is a class advisor, and that is
 * surfaced as a column rather than used as a filter.
 */
export function fetchAdminStaff(department) {
  return request(withTarget('/api/admin/staff', department))
}

/**
 * Creates staff records and their accounts.
 *
 * No batch argument: `advisor_batch` travels inside each row, and only for rows
 * that are actually advisors, so a file may mix people with and without a class.
 */
export function createAdminStaff(department, rows) {
  return request(withTarget('/api/admin/staff', department), {
    method: 'POST',
    body: { rows },
  })
}

/**
 * Edits one staff member.
 *
 * `staff_id` is the last path segment and is deliberately absent from the body:
 * it is the key, the UNIQUE column, and the alternative handle `/api/auth/staff/login`
 * accepts, so it is not something an edit form gets to set. Everything else,
 * including the department and the three advisor fields, travels in the body and
 * is validated server-side.
 */
export function updateAdminStaff(staffId, fields) {
  return request(`/api/admin/staff/${encodeURIComponent(staffId)}`, {
    method: 'PATCH',
    body: fields,
  })
}

/* ----------------------------------------------------------------- subjects */

export function fetchAdminSubjects() {
  return request('/api/admin/subjects')
}

export function createAdminSubjects(rows) {
  return request('/api/admin/subjects', { method: 'POST', body: { rows } })
}

/**
 * Edits one catalog subject.
 *
 * `subject_code` and `subject_name` only. A subject is a global catalog entry
 * with no department, year or section, so there is nothing else to send and no
 * table to resolve: unlike a student, a subject is not in a per-cohort table.
 */
export function updateAdminSubject(subjectId, fields) {
  return request(`/api/admin/subjects/${encodeURIComponent(subjectId)}`, {
    method: 'PATCH',
    body: fields,
  })
}

/* --------------------------------------------- hods / contest coordinators */

/**
 * Every head of department, or every contest coordinator.
 *
 * Both directories are single, department-keyed tables holding one person per
 * department, so both are listed whole. A department filter is accepted by the
 * server for a caller that wants to narrow, but the pages do not use it: an admin
 * checking whether a department already has an HOD needs to see the whole list to
 * know that, and a filtered picker could answer "none" while the answer should
 * have been "none in this department".
 */
export function fetchAdminHods() {
  return request('/api/admin/hods')
}

export function fetchAdminContestCoordinators() {
  return request('/api/admin/contest-coordinators')
}

/**
 * Creates directory entries and their accounts.
 *
 * Rows arrive in the entity's own column names -- `hod_name, email, department` or
 * `coordinator_name, email, department` -- exactly as the upload parser and the
 * manual editor produce them. No id is ever sent: `hod_id` and `coordinator_id`
 * are database-generated, and the server does not read them from the body.
 */
export function createAdminHods(rows) {
  return request('/api/admin/hods', { method: 'POST', body: { rows } })
}

export function createAdminContestCoordinators(rows) {
  return request('/api/admin/contest-coordinators', { method: 'POST', body: { rows } })
}

/**
 * Edits one directory entry.
 *
 * The id is the last path segment and is deliberately absent from the body: it is
 * the table's primary key and is assigned by the database, so an edit form does not
 * get to set it. The three editable fields -- the name, the address and the
 * department -- are validated server-side, and changing the address moves the
 * existing account's sign-in handle without touching its password.
 */
export function updateAdminHod(hodId, fields) {
  return request(`/api/admin/hods/${encodeURIComponent(hodId)}`, {
    method: 'PATCH',
    body: fields,
  })
}

export function updateAdminContestCoordinator(coordinatorId, fields) {
  return request(`/api/admin/contest-coordinators/${encodeURIComponent(coordinatorId)}`, {
    method: 'PATCH',
    body: fields,
  })
}