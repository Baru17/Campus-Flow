/**
 * Where a link in an email should point.
 *
 * The password reset flow needed this first and got it right for a reason worth keeping:
 * the emailed link always resolves to a known origin, because a `redirectTo` supplied by
 * the browser is ignored entirely. Honouring it would turn the endpoint into an open
 * redirect that delivers a valid token to an attacker's site.
 *
 * So the list of origins is the security control, not a convenience: localhost stays
 * usable so the flow can be exercised in development, and everything else gets the
 * production origin. There is no third case.
 */

const PRODUCTION_APP_URL = "https://campus-flow-cdl.pages.dev";

const LOCAL_APP_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * Resolves an app origin from a request's `Origin` header.
 *
 * Anything that is not a recognised local origin -- including a missing header and any
 * host an attacker chose -- resolves to production. The value is then only ever used to
 * build a link into this application.
 */
export function resolveAppOrigin(origin: string | null | undefined): string {
  if (typeof origin === "string" && LOCAL_APP_ORIGINS.includes(origin.trim())) {
    return origin.trim();
  }
  return PRODUCTION_APP_URL;
}

/**
 * Builds an absolute link into the app.
 *
 * `path` is appended to a known origin. It is never supplied by a browser, so it cannot
 * be used to point a recipient somewhere else.
 */
export function appUrl(appOrigin: string, path: string): string {
  const base = appOrigin.endsWith("/") ? appOrigin.slice(0, -1) : appOrigin;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}