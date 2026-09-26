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

function buildCookieSuffix(isSecureRequest: boolean, maxAge: number): string {
  if (!isSecureRequest) {
    return `; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  }
  return `; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=None; Secure; Partitioned`;
}

export function setSessionCookie(c: any, token: string): void {
  const isSecureRequest = new URL(c.req.url).protocol === "https:";
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const cookieValue = `${COOKIE_NAME}=${token}${buildCookieSuffix(isSecureRequest, maxAge)}`;
  c.header("Set-Cookie", cookieValue);
}

export function clearSessionCookie(c: any): void {
  const isSecureRequest = new URL(c.req.url).protocol === "https:";
  const cookieValue = `${COOKIE_NAME}=${buildCookieSuffix(isSecureRequest, 0)}`;
  c.header("Set-Cookie", cookieValue);
}

export function getSessionExpiry(): string {
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  return expires.toISOString();
}

export const SESSION_TTL_MS_VALUE = SESSION_TTL_MS;
