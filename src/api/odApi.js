import { ApiError } from './attendanceApi'
import { BACKEND_URL } from './backendUrl'

/*
 * The student's OD and mentor calls, and the approver half of the workflow.
 *
 * A separate module from `attendanceApi` and `adminApi` because it is neither an
 * attendance concern nor an administrative one: these routes belong to a signed-in
 * student's own request, and to the four people who decide its outcome.
 *
 * The one thing worth reading twice is what is *not* here. There is no function that
 * sends a student id, a department, a batch, a year, a section, a mentor address, or a
 * status, because the server derives all six and accepts none of them. The browser
 * cannot name itself, cannot name who will approve, and cannot say what stage a
 * request is at. That is enforced on the Worker rather than here, but a client with no
 * way to express the thing has nothing to get wrong.
 */

const NOT_CONFIGURED_MESSAGE =
  'The Campus-Flow backend is not configured yet. Contact the administrator.'
const NETWORK_MESSAGE =
  'Unable to reach the server. Please check your connection and try again.'

function assertBackend() {
  if (!BACKEND_URL) throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
}

/**
 * A JSON request that keeps the server's error shape.
 *
 * `details.errors` is preserved rather than flattened, because the OD form reports
 * field-level problems and it needs to know which input each one belongs to -- the
 * same `{ field, message }` pair the admin validators return.
 */
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
    if (error instanceof TypeError || String(error?.message || '').includes('failed to fetch')) {
      throw new ApiError(NETWORK_MESSAGE, { code: 'network' })
    }
    throw error
  }

  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }

  if (!response.ok) {
    throw new ApiError(data.error || `Request failed (${response.status})`, {
      status: response.status,
      code: data.code || null,
    })
  }
  return data
}

/* --------------------------------------------------------------- student */

/**
 * The signed-in student, and the OD days they have banked.
 *
 * One call because the entry screen, the mentor page and the OD form all need the
 * same five facts, and three round trips to render one page would be silly.
 */
export function fetchStudentMe() {
  return request('/api/student/me')
}

/**
 * Staff this student may pick as a mentor.
 *
 * Already narrowed to their department by the server, so the page renders whatever
 * comes back rather than filtering client-side and appearing to work when it does not.
 */
export function fetchEligibleMentors() {
  return request('/api/student/mentors')
}

/**
 * Allocates or replaces the mentor.
 *
 * `staffId` is the only value sent. `confirmChange` is what makes a replacement
 * explicit rather than silent: without it the server refuses to overwrite an existing
 * mentor and answers with the address currently on file, so the form can ask first.
 */
export function assignMentor(staffId, { confirmChange = false } = {}) {
  return request('/api/student/mentor', {
    method: 'POST',
    body: { staff_id: staffId, confirm_change: confirmChange },
  })
}

/**
 * Files an OD request.
 *
 * The three fields below are the whole contract. There is deliberately no `name`,
 * `department`, `year`, `section`, `student_id` or `mentor_email` parameter, because
 * the server reads every one of those from the session and would ignore them if they
 * were sent.
 */
export function submitOdRequest({ odDaysRequested, odDates, reason }) {
  return request('/api/student/od', {
    method: 'POST',
    body: { od_days_requested: odDaysRequested, od_dates: odDates, reason },
  })
}

/** The student's own requests, newest first. */
export function fetchMyOdRequests() {
  return request('/api/student/od')
}

/* -------------------------------------------------------------- approver */

/**
 * Requests waiting on one stage of the chain.
 *
 * `stage` is the role's place in the order -- MENTOR, CONTEST_COORDINATOR,
 * CLASS_ADVISOR or HOD -- and the server matches it against the fixed chain rather
 * than trusting it, so a value that is not one of those four is refused.
 */
export function fetchPendingApprovals(stage) {
  return request('/api/od/requests', { query: { stage } })
}

/**
 * Approves or rejects one request.
 *
 * `decision` is a verdict, not a status: the request does not move to
 * `APPROVED` because an approver said so, it moves to whatever that approver's stage
 * hands it to, and the server decides what that is.
 */
export function submitApprovalDecision(requestId, stage, decision, comment) {
  return request(`/api/od/requests/${encodeURIComponent(requestId)}/decision`, {
    method: 'POST',
    query: { stage },
    body: { decision, ...(comment ? { comment } : {}) },
  })
}

/** Whether the signed-in approver may action a request, for showing the buttons. */
export function checkApprovalPermission(requestId, stage) {
  return request(`/api/od/requests/${encodeURIComponent(requestId)}/permission`, {
    query: { stage },
  })
}

/* --------------------------------------------------- approver sign-in */

/**
 * Signs a mentor, coordinator, class advisor or HOD in to action OD requests.
 *
 * A separate entry point from the student and staff logins on purpose. A coordinator
 * or HOD has no staff record, so `/staff/login` would refuse them; and widening that
 * route would change how every lecturer signs in, which this feature must not do.
 *
 * The session is the same one every other role gets.
 */
export function approverLogin(email, password) {
  return request('/api/auth/od-approver/login', {
    method: 'POST',
    body: { email, password },
  })
}

/**
 * The signed-in approver's own role, name and department.
 *
 * A mentor and a class advisor already get these from the staff context, but a Contest
 * Coordinator and an HOD have no staff record and no other screen that would tell the
 * browser who they are. Their dashboard header needs it.
 *
 * Read from the session, so it always describes the caller.
 */
export function fetchApproverMe() {
  return request('/api/od/approver/me')
}

/**
 * Signs out of the approver session.
 *
 * The role-neutral `/auth/logout` rather than `/auth/staff/logout`, which refuses
 * anything that is not staff or a class advisor -- and a coordinator or HOD signing out
 * of their own dashboard is exactly the case that endpoint turns away.
 */
export function approverLogout() {
  return request('/api/auth/logout', { method: 'POST' })
}