/*
 * Admin sign-in, end to end through the real `adminLogin`.
 *
 * ## Why this file exists
 *
 * `adminLogin` was the one authentication path in the app with no test. The other three
 * -- student, staff and session restore -- were all covered, which is why a sign-in that
 * succeeded and was then thrown away shipped: `verifiedUser` was always `null`, so every
 * admin login ended in "Sign-in succeeded, but the server could not verify the new session
 * cookie" no matter what the server had just said.
 *
 * The cause was `asAdmin`. It is `async` and does not unwrap its argument, and
 * `adminLogin` hands it the *promise* from `refreshCurrentUser()`. A Promise is truthy
 * and has no `.user_name`, so the admin address never matched and the read's answer was
 * discarded. Every symptom pointed away from it: the login returned the right user, the
 * cookie was stored, and `GET /api/auth/user` came back 200 with the right user too --
 * the request succeeded and its result was thrown away.
 *
 * These tests drive the exported `adminLogin` against a stubbed server so that a login
 * which the server *does* confirm has to be accepted, and a login which the server does
 * not confirm still has to be refused.
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminLogin } from '../src/api/adminAuthApi'
import { resetSessionCache } from '../src/api/sessionApi'

const ADMIN = {
  id: 'auth-admin-1',
  auth_user_id: 'auth-admin-1',
  user_name: 'admin@kiot.ac.in',
  role: 'admin',
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/**
 * A server that answers the admin login and then, for `currentUser`, either confirms
 * the session or does not.
 *
 * `confirmSession: false` is the browser dropping the cookie: the login answers 200 and
 * sets a cookie, and the follow-up read comes back 401. That is the case the error
 * message was written for, and the one that must keep failing after the fix.
 */
function installFetch({ confirmSession, currentUser = ADMIN } = {}) {
  const calls = []
  const mock = vi.fn((input) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    calls.push(path)

    if (path === '/api/auth/admin/login') {
      return Promise.resolve(
        jsonResponse(200, { success: true, user: ADMIN })
      )
    }
    if (path === '/api/auth/user') {
      return Promise.resolve(
        confirmSession
          ? jsonResponse(200, { success: true, user: currentUser })
          : jsonResponse(401, {
              success: false,
              error: 'Authentication required',
              code: 'auth-required',
            })
      )
    }
    if (path === '/api/auth/admin/logout') {
      return Promise.resolve(jsonResponse(200, { success: true, message: 'Logged out' }))
    }
    return Promise.resolve(
      jsonResponse(404, { success: false, error: 'Not found', code: 'not-found' })
    )
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

/** Drains the microtask queue and lets pending timers run. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  resetSessionCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetSessionCache()
})

describe('adminLogin', () => {
  it('accepts a login the current-user endpoint confirms', async () => {
    /*
     * The regression itself.
     *
     * The server says the credentials are right, and then says the session is real. The
     * only thing that could make this fail is a client that discards the second answer,
     * which is precisely what `asAdmin` used to do -- it rejected every admin login while
     * the server was answering correctly.
     */
    const calls = installFetch({ confirmSession: true })

    const result = await adminLogin('admin@kiot.ac.in', 'correct-password')

    expect(result.user).toEqual(ADMIN)
    expect(calls).toContain('/api/auth/admin/login')
    expect(calls).toContain('/api/auth/user')
  })

  it('does not end a confirmed sign-in by logging the session out again', async () => {
    // The cleanup call is what cleared the cookie and made the dashboard look signed out.
    // A login that was accepted must not make it.
    const calls = installFetch({ confirmSession: true })

    await adminLogin('admin@kiot.ac.in', 'correct-password')

    expect(calls).not.toContain('/api/auth/admin/logout')
  })

  it('still refuses a login when the session cookie did not survive', async () => {
    /*
     * The check is not bypassed. When the follow-up read comes back 401 -- the browser
     * dropped the cookie -- the sign-in has to fail and the half-made session has to be
     * ended, because that is what leaves no live session behind for an account this flow
     * has just decided it cannot use.
     */
    const calls = installFetch({ confirmSession: false })

    await expect(adminLogin('admin@kiot.ac.in', 'correct-password')).rejects.toMatchObject({
      code: 'session-not-stored',
    })
    expect(calls).toContain('/api/auth/admin/logout')
  })

  it('still refuses a confirmed session that belongs to somebody else', async () => {
    /*
     * `asAdmin` narrows the session to an administrator, so a valid session for another
     * role is not an admin session. Awaiting the argument must not have turned the
     * narrowing into a pass-through.
     */
    installFetch({
      confirmSession: true,
      currentUser: { id: 's1', auth_user_id: 's1', user_name: '2K24IT001', role: 'student' },
    })

    await expect(adminLogin('admin@kiot.ac.in', 'correct-password')).rejects.toMatchObject({
      code: 'session-not-stored',
    })
  })

  it('accepts the admin address as the email when the session carries one', async () => {
    // `isAdminUser` prefers `email` over `user_name`; both spellings must still be accepted.
    installFetch({
      confirmSession: true,
      currentUser: { ...ADMIN, email: 'admin@kiot.ac.in' },
    })

    const result = await adminLogin('admin@kiot.ac.in', 'correct-password')
    expect(result.user.role).toBe('admin')
  })

  it('waits for the current-user read rather than deciding from the login response', async () => {
    /*
     * The ordering the old code got wrong.
     *
     * `adminLogin` must settle *after* the confirmation read resolves. Reading the user
     * out of an unresolved promise is what produced `verifiedUser === null`, so this
     * asserts the sign-in does not resolve before the server has been asked.
     */
    const order = []
    let releaseUser
    const gate = new Promise((resolve) => {
      releaseUser = resolve
    })

    vi.stubGlobal(
      'fetch',
      vi.fn((input) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '')
        if (path === '/api/auth/admin/login') {
          return Promise.resolve(jsonResponse(200, { success: true, user: ADMIN }))
        }
        if (path === '/api/auth/user') {
          order.push('user-requested')
          return gate.then(() => {
            order.push('user-answered')
            return jsonResponse(200, { success: true, user: ADMIN })
          })
        }
        if (path === '/api/auth/admin/logout') {
          return Promise.resolve(jsonResponse(200, { success: true, message: 'Logged out' }))
        }
        return Promise.resolve(jsonResponse(404, { success: false }))
      })
    )

    const pending = adminLogin('admin@kiot.ac.in', 'correct-password')
    let settled = false
    pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    // Let the login response resolve and the confirmation read be issued, without
    // answering it yet.
    await flush()
    expect(order).toEqual(['user-requested'])
    expect(settled).toBe(false)

    releaseUser()
    const result = await pending
    expect(result.user).toEqual(ADMIN)
    expect(order).toEqual(['user-requested', 'user-answered'])
  })
})
