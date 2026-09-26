import { type Context } from "hono";
import { getSessionCookie, hashToken } from "../utils/auth";
import { getErrorMessageForLog, isTransientD1Error } from "../utils/databaseErrors";

interface AuthUser {
  id: number;
  auth_user_id: string;
  user_name: string;
  role: string;
}

type AuthFailure = "no-cookie" | "no-session" | "session-expired" | "lookup-error";

async function resolveAuthUser(
  c: Context
): Promise<{ user: AuthUser | null; failure: AuthFailure | null; tokenHash: string | null; error?: unknown }> {
  let token: string | null = null;
  try {
    token = getSessionCookie(c);
    if (!token) {
      return { user: null, failure: "no-cookie", tokenHash: null };
    }

    const tokenHash = hashToken(token);
    const row = (await c.env.DB
      .prepare(
        `SELECT au.id, au.auth_user_id, au.user_name, au.role, s.expires_at
         FROM auth_sessions s
         JOIN auth_users au ON s.auth_user_id = au.auth_user_id
         WHERE s.token_hash = ? LIMIT 1`
      )
      .bind(tokenHash)
      .first()) as (AuthUser & { expires_at: string }) | null;

    if (!row) {
      return { user: null, failure: "no-session", tokenHash };
    }
    if (!(row.expires_at > new Date().toISOString())) {
      return { user: null, failure: "session-expired", tokenHash };
    }

    const { expires_at: _expiresAt, ...user } = row;
    return { user, failure: null, tokenHash };
  } catch (error) {
    return { user: null, failure: "lookup-error", tokenHash: token ? hashToken(token) : null, error };
  }
}

export async function getAuthenticatedUser(c: Context): Promise<AuthUser | null> {
  const { user } = await resolveAuthUser(c);
  return user;
}

export async function requireAuth(c: Context, next: () => Promise<void>): Promise<Response | void> {
  let authResult: Awaited<ReturnType<typeof resolveAuthUser>>;
  try {
    authResult = await resolveAuthUser(c);
  } catch (error) {
    authResult = { user: null, failure: "lookup-error", tokenHash: null, error };
  }
  const { user, failure, tokenHash, error } = authResult;
  if (!user) {
    const path = new URL(c.req.url).pathname;
    const origin = c.req.header("Origin") || null;

    if (failure === "lookup-error") {
      const transient = isTransientD1Error(error);
      console.error(
        JSON.stringify({
          event: "auth_lookup_failed",
          path,
          origin,
          error: getErrorMessageForLog(error),
          tokenHashPrefix: tokenHash ? tokenHash.slice(0, 8) : null,
        })
      );
      return c.json(
        {
          success: false,
          error: transient ? "Authentication service is temporarily unavailable. Please retry." : "Unexpected authentication service error.",
          code: transient ? "auth-unavailable" : "auth-internal-error",
        },
        transient ? 503 : 500
      );
    }

    console.warn(
      JSON.stringify({
        event: "auth_failed",
        path,
        origin,
        cookiePresent: failure !== "no-cookie",
        failure,
        tokenHashPrefix: tokenHash ? tokenHash.slice(0, 8) : null,
      })
    );
    return c.json({ success: false, error: "Authentication required", code: "auth-required" }, 401);
  }
  (c as any).set("authUser", user as unknown);
  await next();
  return;
}

export function requireRole(...roles: string[]) {
  const allowedRoles = new Set(roles.map((role) => role.trim().toLowerCase().replace(/[ -]+/g, "_")));
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const user = (c as any).get("authUser") as AuthUser | undefined;
    if (!user) {
      return c.json({ success: false, error: "Authentication required", code: "auth-required" }, 401);
    }
    const userRole = user.role.trim().toLowerCase().replace(/[ -]+/g, "_");
    if (!allowedRoles.has(userRole)) {
      return c.json({ success: false, error: "Insufficient permissions", code: "forbidden" }, 403);
    }
    await next();
    return;
  };
}

export function requireStudent(c: Context, next: () => Promise<void>): Promise<Response | void> {
  return requireRole("student")(c, next);
}

export function requireStaff(c: Context, next: () => Promise<void>): Promise<Response | void> {
  return requireRole("staff", "class_advisor")(c, next);
}

export function requireClassAdvisor(c: Context, next: () => Promise<void>): Promise<Response | void> {
  return requireRole("class_advisor")(c, next);
}

export function requireAdmin(c: Context, next: () => Promise<void>): Promise<Response | void> {
  return requireRole("admin")(c, next);
}

export { type AuthUser };
