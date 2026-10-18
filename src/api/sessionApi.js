/*
 * "Who am I?" -- asked once per page load, wherever it is asked from.
 *
 * ## Why this module exists
 *
 * `GET /api/auth/user` is the one request that every role needs and every provider used
 * to make on its own. Three providers are mounted above the router -- `AuthProvider`,
 * `StaffAuthProvider` and `AdminAuthProvider` -- and each one had its own private copy of
 * `getCurrentUser()`, in its own API module, with its own `fetch`. There was nothing to
 * deduplicate them, so a single page load issued three identical requests, and React's
 * `StrictMode` double-invoked effects made that six in development.
 *
 * For a signed-out visitor all three are answered `401`, and the browser logs every
 * non-2xx response to the console whether or not the application handles it. So the
 * symptom was three (six in dev) copies of
 *
 *     Failed to load resource: the server responded with a status of 401 ()
 *
 * on a page nobody had signed in to. The 401 was correct; the repetition was the defect.
 *
 * ## What this module does and does not do
 *
 * It does not make the request optional and it does not soften the answer. Every read
 * still goes to `GET /api/auth/user` with the session cookie attached, and a 401 is
 * still resolved to `null` -- "there is no session", never "there is a session". The
 * only thing it changes is how many times that question is asked.
 *
 * Two things are shared:
 *
 *   - **One request in flight.** Callers that arrive while a read is running are given
 *     that same read. This is what turns three providers into one request.
 *   - **A very short memory.** A resolved answer is reused for {@link CACHE_TTL_MS}.
 *     That is long enough for the providers mounting in the same commit to share it and
 *     far too short to be an authentication decision anyone could notice.
 *
 * Anything that is a real check rather than a mount-time lookup goes through
 * {@link refreshCurrentUser}, which ignores the memory and asks the server. Sign-in uses
 * it to prove the cookie actually round-tripped, and the OTP screen uses it so the
 * "is this tab still signed in?" check is never answered from memory.
 *
 * ## Why sign-in and sign-out have to be visible here
 *
 * The memory is a cache of a session, so a sign-in or a sign-out has to supersede it in
 * both directions:
 *
 *   - {@link setCurrentUser} records who just signed in, so the providers that already
 *     settled on "signed out" are not left holding an answer that is now wrong.
 *   - {@link clearCurrentUser} records the sign-out, so nothing can read the old user
 *     back out of memory after the server has deleted the session row.
 *
 * Both also bump `epoch`, which is what stops a read that was already in the air when
 * the sign-in or sign-out happened from writing its answer into the memory afterwards.
 * That is the failure that would otherwise show a signed-out visitor as still signed in,
 * so it is the one thing here that is a correctness concern rather than an optimisation.
 */
import { apiRequest } from './http'
import { BACKEND_URL } from './backendUrl'

const CURRENT_USER_PATH = '/api/auth/user'

/*
 * How long a resolved answer is reused.
 *
 * Long enough that every provider mounting in one commit shares a single request, and
 * short enough that this is never the reason a session looks valid. Anything that needs
 * certainty calls `refreshCurrentUser` instead of waiting this out.
 */
const CACHE_TTL_MS = 15_000

/* `null` here means "not asked yet", which is different from a cached `null`. */
let cache = null
let inFlight = null
let epoch = 0

/*
 * The raw read. A 401 is the server saying there is no valid session, which is an answer
 * rather than a failure, so it resolves to `null`. Every other status -- 403, 500, a
 * network failure -- is still an error and is still raised for the caller to handle.
 */
function readCurrentUser() {
  if (!BACKEND_URL) return Promise.resolve(null)
  return apiRequest(CURRENT_USER_PATH).then(
    ({ data }) => data?.user || null,
    (error) => {
      if (error?.status === 401) return null
      throw error
    }
  )
}

function startRequest() {
  const entry = { epoch, request: readCurrentUser() }
  inFlight = entry

  const release = () => {
    if (inFlight === entry) inFlight = null
  }
  /* `then` with both handlers rather than `finally`: `finally` hands back a promise that
   * rejects again, and nothing is listening to it. */
  entry.request.then(release, release)

  return entry.request.then((user) => {
    if (epoch === entry.epoch) {
      cache = { user, at: Date.now() }
    }
    return user
  })
}

/**
 * The signed-in account, or `null` when there is no valid session.
 *
 * Reuses a read already running and an answer already resolved; starts one otherwise.
 * Rejects on anything that is not a 401, exactly as before.
 *
 * @returns {Promise<object|null>}
 */
export function getCurrentUser() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return Promise.resolve(cache.user)
  }
  if (inFlight) return inFlight.request
  return startRequest()
}

/**
 * Asks the server now, ignoring whatever was remembered.
 *
 * Still joins a read that is already in the air, because a request that left the browser
 * before this call was made already carries the answer this call wants.
 *
 * @returns {Promise<object|null>}
 */
export function refreshCurrentUser() {
  epoch += 1
  cache = null
  return getCurrentUser()
}

/**
 * Records who has just signed in, so the shared answer matches the new session.
 *
 * @param {object|null} user the account from the login response, or `null` to clear it
 */
export function setCurrentUser(user) {
  epoch += 1
  inFlight = null
  cache = { user: user || null, at: Date.now() }
}

/**
 * Records a sign-out.
 *
 * The session row is deleted and the cookie cleared server-side first; this makes the
 * browser agree. It also detaches any read still in the air, so a response that was on
 * its way during the sign-out cannot write the old account back into memory.
 */
export function clearCurrentUser() {
  setCurrentUser(null)
}

/**
 * Test seam: forgets the remembered answer and any read in flight.
 *
 * Production code reaches the same states through `refreshCurrentUser`,
 * `setCurrentUser` and `clearCurrentUser`; this exists so each test starts from a known
 * one instead of inheriting the previous test's session.
 */
export function resetSessionCache() {
  epoch += 1
  cache = null
  inFlight = null
}
