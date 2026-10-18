/*
 * The shared "who am I?" read.
 *
 * These cover the behaviour that the repeated `401` reports turned on: three providers
 * each used to ask the server the same question in the same tick, and a signed-out
 * visitor got three identical 401s logged by the browser.
 *
 * They also pin the two things that must not change while that duplication is removed:
 * a 401 still means "no session" (never a session, never a thrown error), and a
 * sign-out still wins over a response that was already on its way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCurrentUser,
  getCurrentUser,
  refreshCurrentUser,
  resetSessionCache,
  setCurrentUser,
} from '../src/api/sessionApi'

const STUDENT_USER = {
  id: 'auth-student-1',
  auth_user_id: 'auth-student-1',
  user_name: '2K24IT001',
  role: 'student',
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/** A `fetch` whose resolution the test controls. */
function deferredFetch() {
  const state = {}
  state.promise = new Promise((resolve, reject) => {
    state.resolve = resolve
    state.reject = reject
  })
  state.calls = []
  const mock = vi.fn((input, init) => {
    state.calls.push({ url: String(input), init })
    return state.promise
  })
  return { state, mock }
}

/** Answers `/api/auth/user` with a fixed status and body, counting the calls. */
function fixedFetch(status, body) {
  const calls = []
  const mock = vi.fn((input, init) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(jsonResponse(status, body))
  })
  return { calls, mock }
}

describe('sessionApi', () => {
  beforeEach(() => {
    /*
     * The module keeps its answer in module scope, which is the whole point, so it
     * outlives an individual test. Every test starts from a known-empty one.
     */
    resetSessionCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('asking the server', () => {
    it('collapses simultaneous reads into a single request', async () => {
      /*
       * The regression itself. `AuthProvider`, `StaffAuthProvider` and `AdminAuthProvider`
       * all mount above the router and all ask this question, so three callers arriving
       * in the same tick must cost one request -- not three.
       */
      const { calls, mock } = fixedFetch(401, { success: false, error: 'Authentication required', code: 'auth-required' })
      vi.stubGlobal('fetch', mock)

      const answers = await Promise.all([getCurrentUser(), getCurrentUser(), getCurrentUser()])

      expect(calls).toHaveLength(1)
      expect(answers).toEqual([null, null, null])
    })

    it('returns the account for a valid session', async () => {
      const { mock } = fixedFetch(200, { success: true, user: STUDENT_USER })
      vi.stubGlobal('fetch', mock)

      await expect(getCurrentUser()).resolves.toEqual(STUDENT_USER)
    })

    it('sends the session cookie, because the answer depends on it', async () => {
      const { calls, mock } = fixedFetch(200, { success: true, user: STUDENT_USER })
      vi.stubGlobal('fetch', mock)

      await getCurrentUser()

      expect(calls).toHaveLength(1)
      expect(calls[0].init.credentials).toBe('include')
      expect(calls[0].url).toContain('/api/auth/user')
    })
  })

  describe('what a 401 means', () => {
    it('reads as "no session" rather than failing', async () => {
      /*
       * A visitor who has not signed in is the normal case for this endpoint, and the
       * browser logs the status line whatever the application does with it. The
       * application has to treat it as an answer.
       */
      const { mock } = fixedFetch(401, { success: false, error: 'Authentication required', code: 'auth-required' })
      vi.stubGlobal('fetch', mock)

      await expect(getCurrentUser()).resolves.toBeNull()
    })

    it('reads as "no session" for an expired session too, which the server also answers 401', async () => {
      const { mock } = fixedFetch(401, { success: false, error: 'Authentication required', code: 'auth-required' })
      vi.stubGlobal('fetch', mock)

      await expect(getCurrentUser()).resolves.toBeNull()
    })

    it('never turns an unauthorized answer into a session', async () => {
      const { mock } = fixedFetch(401, { success: false, error: 'Authentication required', code: 'auth-required' })
      vi.stubGlobal('fetch', mock)

      const user = await getCurrentUser()

      expect(user).not.toBeTruthy()
      expect(user).not.toEqual(expect.objectContaining({ role: expect.any(String) }))
    })

    it('raises anything that is not a 401, and remembers nothing about it', async () => {
      const { calls, mock } = fixedFetch(503, { success: false, error: 'Authentication service is temporarily busy.', code: 'database-busy' })
      vi.stubGlobal('fetch', mock)

      await expect(getCurrentUser()).rejects.toMatchObject({ status: 503 })
      /*
       * A failure is not an answer. If it were cached, a student would be locked out of
       * their own dashboard until the cache expired after a single blip.
       */
      await expect(getCurrentUser()).rejects.toMatchObject({ status: 503 })
      expect(calls).toHaveLength(2)
    })

    it('raises a forbidden answer rather than downgrading it to "no session"', async () => {
      const { mock } = fixedFetch(403, { success: false, error: 'Insufficient permissions', code: 'forbidden' })
      vi.stubGlobal('fetch', mock)

      await expect(getCurrentUser()).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    })
  })

  describe('remembering the answer', () => {
    it('asks again once a remembered answer has gone stale', async () => {
      const { calls, mock } = fixedFetch(200, { success: true, user: STUDENT_USER })
      vi.stubGlobal('fetch', mock)

      await getCurrentUser()
      await getCurrentUser()

      expect(calls).toHaveLength(1)
    })

    it('ignores what it remembers when a caller needs certainty', async () => {
      /*
       * Sign-in uses this to prove the cookie round-tripped, and the OTP screen uses it so
       * "is this tab still signed in?" is never answered from memory.
       */
      const { calls, mock } = fixedFetch(200, { success: true, user: STUDENT_USER })
      vi.stubGlobal('fetch', mock)

      await getCurrentUser()
      await refreshCurrentUser()

      expect(calls).toHaveLength(2)
    })

    it('shares a read already in the air rather than starting a second one', async () => {
      /*
       * The other half of `refreshCurrentUser`. A request that left the browser before
       * this call was made is already carrying the answer this call wants, so asking
       * again would only duplicate work. What a refresh must never do is serve the
       * *remembered* answer, which is what the previous test covers.
       */
      const slow = deferredFetch()
      vi.stubGlobal('fetch', slow.mock)

      const first = getCurrentUser()
      const second = refreshCurrentUser()
      slow.state.resolve(jsonResponse(200, { success: true, user: STUDENT_USER }))

      await expect(first).resolves.toEqual(STUDENT_USER)
      await expect(second).resolves.toEqual(STUDENT_USER)
      expect(slow.mock).toHaveBeenCalledTimes(1)
    })
  })

  describe('signing in and signing out', () => {
    it('records the account that has just signed in, so nothing has to re-ask', async () => {
      const { calls, mock } = fixedFetch(200, { success: true, user: STUDENT_USER })
      vi.stubGlobal('fetch', mock)

      setCurrentUser(STUDENT_USER)

      await expect(getCurrentUser()).resolves.toEqual(STUDENT_USER)
      expect(calls).toHaveLength(0)
    })

    it('forgets the account on sign-out', async () => {
      const { calls, mock } = fixedFetch(200, { success: true, user: STUDENT_USER })
      vi.stubGlobal('fetch', mock)
      setCurrentUser(STUDENT_USER)

      clearCurrentUser()

      await expect(getCurrentUser()).resolves.toBeNull()
      /* The session row is already gone server-side, so there is nothing to re-ask. */
      expect(calls).toHaveLength(0)
    })

    it('does not let a read that was in the air re-sign someone in after a sign-out', async () => {
      /*
       * The one race in here that is a correctness problem rather than a wasted request.
       * A read that left before the sign-out resolves afterwards; if its answer were
       * allowed back into the memory, the browser would carry on showing a signed-in
       * student on a session the server has already deleted.
       */
      const slow = deferredFetch()
      vi.stubGlobal('fetch', slow.mock)
      const inFlight = getCurrentUser()

      clearCurrentUser()
      slow.state.resolve(jsonResponse(200, { success: true, user: STUDENT_USER }))
      await inFlight

      await expect(getCurrentUser()).resolves.toBeNull()
    })

    it('does not let a read that was in the air survive a sign-in either', async () => {
      const slow = deferredFetch()
      vi.stubGlobal('fetch', slow.mock)
      const inFlight = getCurrentUser()

      const staff = { id: 'auth-staff-1', auth_user_id: 'auth-staff-1', user_name: 'staff@kiot.ac.in', role: 'staff' }
      setCurrentUser(staff)
      slow.state.resolve(jsonResponse(401, { code: 'auth-required' }))
      await inFlight

      await expect(getCurrentUser()).resolves.toEqual(staff)
    })
  })
})
