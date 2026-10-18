// @vitest-environment jsdom
/*
 * An unauthenticated page load.
 *
 * `App.jsx` mounts `AuthProvider`, `StaffAuthProvider` and `AdminAuthProvider` above the
 * router, one per family of roles. Each used to hold a private copy of "who am I?", so a
 * single page load issued three identical `GET /api/auth/user` requests -- six under
 * React's `StrictMode`, which runs mount effects twice -- and a visitor who had not
 * signed in saw that many copies of
 *
 *     Failed to load resource: the server responded with a status of 401 ()
 *
 * for what is one unanswered question. These mount the real providers, in the real
 * nesting, and count.
 */
import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminAuthProvider from '../src/context/AdminAuthContext'
import AuthProvider from '../src/context/AuthContext'
import StaffAuthProvider from '../src/context/StaffAuthContext'
import { resetSessionCache } from '../src/api/sessionApi'
import { useAdminAuth } from '../src/hooks/useAdminAuth'
import { useAuth } from '../src/hooks/useAuth'
import { useStaffAuth } from '../src/hooks/useStaffAuth'

const STUDENT = {
  id: 'auth-student-1',
  auth_user_id: 'auth-student-1',
  user_name: '2K24IT001',
  role: 'student',
}

const CLASS_ADVISOR = {
  id: 'auth-staff-1',
  auth_user_id: 'auth-staff-1',
  user_name: 'advisor@kiot.ac.in',
  role: 'class_advisor',
}

const ADMIN = {
  id: 'auth-admin-1',
  auth_user_id: 'auth-admin-1',
  user_name: 'admin@kiot.ac.in',
  role: 'admin',
}

const STAFF_RECORD = { staff_id: 'CMP042', staff_name: 'A. Advisor', department: 'IT' }

const STUDENT_RECORD = {
  student_id: '2K24IT001',
  register_no: '24IT001',
  student_name: 'Test Student',
  department: 'IT',
  batch: '2024_2028',
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

const UNAUTHENTICATED = jsonResponse(401, {
  success: false,
  error: 'Authentication required',
  code: 'auth-required',
})

/**
 * A `fetch` that answers only the routes a provider mount reaches, and records every
 * call so a test can count them.
 *
 * `session` is the account `/api/auth/user` should return, or `null` for a signed-out
 * visitor -- which is the `401` the production server sends.
 */
function installFetch({ session = null } = {}) {
  const calls = []
  const mock = vi.fn((input) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    calls.push(path)

    if (path === '/api/auth/user') {
      return Promise.resolve(
        session
          ? jsonResponse(200, { success: true, user: session })
          : jsonResponse(401, { success: false, error: 'Authentication required', code: 'auth-required' })
      )
    }
    if (path === '/api/auth/session') {
      return Promise.resolve(
        session
          ? jsonResponse(200, { success: true, user: session, session: { active: true, role: session.role } })
          : UNAUTHENTICATED
      )
    }
    if (path.startsWith('/api/auth/staff/')) {
      return Promise.resolve(jsonResponse(200, { success: true, ...STAFF_RECORD }))
    }
    if (path === '/api/auth/auth/student') {
      return Promise.resolve(jsonResponse(200, { success: true, student: STUDENT_RECORD }))
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: 'Not found', code: 'not-found' }))
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

function Probe() {
  const auth = useAuth()
  const staffAuth = useStaffAuth()
  const adminAuth = useAdminAuth()
  return (
    <div data-testid="probe">
      {JSON.stringify({
        settled: !auth.loading && !staffAuth.loading && !adminAuth.loading,
        /*
         * `AuthProvider` mirrors whatever account is signed in -- that is the session,
         * not a role gate -- and only fetches a student record for a student. The
         * dashboard a session actually lands on is what the other two admit.
         */
        sessionRole: auth.user?.role ?? null,
        studentRecord: auth.student?.student_id ?? null,
        staffRole: staffAuth.user?.role ?? null,
        staffRecord: staffAuth.staff?.staff_id ?? null,
        adminRole: adminAuth.user?.role ?? null,
      })}
    </div>
  )
}

function renderProviders({ strict = false } = {}) {
  const tree = (
    <AuthProvider>
      <StaffAuthProvider>
        <AdminAuthProvider>
          <Probe />
        </AdminAuthProvider>
      </StaffAuthProvider>
    </AuthProvider>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

function probeState() {
  return JSON.parse(screen.getByTestId('probe').textContent)
}

describe('an unauthenticated page load', () => {
  beforeEach(() => {
    resetSessionCache()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('asks who the visitor is once, not once per role', async () => {
    const calls = installFetch({ session: null })

    renderProviders()

    await waitFor(() => expect(probeState().settled).toBe(true))
    expect(calls.filter((path) => path === '/api/auth/user')).toHaveLength(1)
  })

  it('asks once under StrictMode, which runs mount effects twice', async () => {
    /*
     * The development build mounts every effect twice. Before this, that turned three
     * requests into six and made the console unreadable on exactly the machine a
     * developer was trying to debug on.
     */
    const calls = installFetch({ session: null })

    renderProviders({ strict: true })

    await waitFor(() => expect(probeState().settled).toBe(true))
    expect(calls.filter((path) => path === '/api/auth/user')).toHaveLength(1)
  })

  it('leaves every provider signed out rather than signed in by accident', async () => {
    installFetch({ session: null })

    renderProviders()

    await waitFor(() => expect(probeState().settled).toBe(true))
    expect(probeState()).toMatchObject({
      sessionRole: null,
      studentRecord: null,
      staffRole: null,
      adminRole: null,
    })
  })

  it('sends the session cookie on that one request', async () => {
    const calls = installFetch({ session: null })
    const mock = globalThis.fetch

    renderProviders()

    await waitFor(() => expect(probeState().settled).toBe(true))
    expect(calls).toContain('/api/auth/user')
    expect(mock.mock.calls[0][1].credentials).toBe('include')
  })
})

describe('an authenticated page load', () => {
  beforeEach(() => {
    resetSessionCache()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('routes a student to the student screen and nobody else', async () => {
    const calls = installFetch({ session: STUDENT })

    renderProviders()

    await waitFor(() => expect(probeState().settled).toBe(true))
    expect(calls.filter((path) => path === '/api/auth/user')).toHaveLength(1)
    expect(probeState()).toMatchObject({
      sessionRole: 'student',
      studentRecord: '2K24IT001',
      staffRole: null,
      adminRole: null,
    })
  })

  it('keeps a class advisor on the staff provider', async () => {
    /*
     * Role-based access, unchanged: the same single read feeds all three providers and
     * each still admits only its own roles.
     */
    const calls = installFetch({ session: CLASS_ADVISOR })

    renderProviders()

    await waitFor(() => expect(probeState().settled).toBe(true))
    expect(calls.filter((path) => path === '/api/auth/user')).toHaveLength(1)
    expect(probeState()).toMatchObject({
      sessionRole: 'class_advisor',
      studentRecord: null,
      staffRole: 'class_advisor',
      staffRecord: 'CMP042',
      adminRole: null,
    })
  })

  it('keeps an admin on the admin provider', async () => {
    const calls = installFetch({ session: ADMIN })

    renderProviders()

    await waitFor(() => expect(probeState().settled).toBe(true))
    expect(calls.filter((path) => path === '/api/auth/user')).toHaveLength(1)
    expect(probeState()).toMatchObject({
      sessionRole: 'admin',
      studentRecord: null,
      staffRole: null,
      adminRole: 'admin',
    })
  })

  it('does not let one session reach two dashboards', async () => {
    /*
     * Sharing one read must not blur the roles. Each account reaches exactly one of the
     * three providers' dashboards, and the other two stay signed out.
     */
    for (const [session, admitted] of [
      [STUDENT, 'studentRecord'],
      [CLASS_ADVISOR, 'staffRecord'],
      [ADMIN, 'adminRole'],
    ]) {
      resetSessionCache()
      installFetch({ session })
      const view = renderProviders()

      await waitFor(() => expect(probeState().settled).toBe(true))
      const state = probeState()
      const held = ['studentRecord', 'staffRecord', 'adminRole'].filter((key) => state[key])
      expect(held).toEqual([admitted])

      view.unmount()
    }
  })
})
