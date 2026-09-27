import { createHash } from "crypto";

const COOKIE_NAME = "campus-flow-session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return crypto.randomUUID();
}

export function getSessionCookie(c: any): string | null {
  const cookieHeader = c.req.header("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

/*
 * A reverse proxy (Vite's dev/preview server, or the Cloudflare Pages Function
 * in front of this Worker) re-originates the request over HTTPS, so
 * `c.req.url` describes the hop to the Worker and not the hop to the browser.
 * Cookie attributes have to match what the *browser* sees: marking a cookie
 * `Secure; Partitioned; SameSite=None` for a page served over plain HTTP makes
 * it a third-party cookie, and browsers drop those silently. The proxy
 * therefore forwards `X-Forwarded-Proto` and we trust only an explicit `http`
 * downgrade from it; anything else stays HTTPS, which is what Cloudflare's own
 * edge reports. An ambiguous value (a comma-joined proxy chain) is treated as
 * HTTPS, so the cookie never silently loses `Secure` on a guess.
 */
function isClientSecure(c: any): boolean {
  const forwardedProto = c.req.header("X-Forwarded-Proto");
  if (typeof forwardedProto === "string" && forwardedProto.trim().toLowerCase() === "http") {
    return false;
  }
  return new URL(c.req.url).protocol === "https:";
}

function buildCookieSuffix(isSecureRequest: boolean, maxAge: number): string {
  if (!isSecureRequest) {
    return `; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  }
  return `; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=None; Secure; Partitioned`;
}

export function setSessionCookie(c: any, token: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const cookieValue = `${COOKIE_NAME}=${token}${buildCookieSuffix(isClientSecure(c), maxAge)}`;
  c.header("Set-Cookie", cookieValue);
}

export function clearSessionCookie(c: any): void {
  const cookieValue = `${COOKIE_NAME}=${buildCookieSuffix(isClientSecure(c), 0)}`;
  c.header("Set-Cookie", cookieValue);
}

export function getSessionExpiry(): string {
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  return expires.toISOString();
}

export const SESSION_TTL_MS_VALUE = SESSION_TTL_MS;
