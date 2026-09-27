/*
 * The session cookie is first-party only while the browser talks to the same
 * origin that serves the app. `VITE_API_BASE_URL` points at the Worker, so
 * calling it directly from a page on any other host makes the cookie
 * third-party, and browsers drop it without a word -- login returns 200 and
 * every later call 401s. Both the Vite dev/preview server and the Cloudflare
 * Pages Function proxy `/api/*` on the app's own origin, so proxied is the
 * default. Set VITE_API_MODE=direct only when hosting the SPA somewhere with no
 * proxy in front, and accept that the session then depends on third-party
 * cookies being allowed.
 */
const configuredBackendUrl = import.meta.env.VITE_API_BASE_URL || ''
const apiMode = (import.meta.env.VITE_API_MODE || 'proxy').trim().toLowerCase()

export const BACKEND_URL =
  apiMode === 'direct'
    ? configuredBackendUrl
    : typeof window === 'undefined'
      ? configuredBackendUrl
      : window.location.origin
