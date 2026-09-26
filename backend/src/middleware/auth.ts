import { type Context } from "hono";
import { getSessionCookie, hashToken } from "../utils/auth";

interface AuthUser {
  id: number;
  auth_user_id: string;
  user_name: string;
  role: string;
}

export async function getAuthenticatedUser(c: Context): Promise<AuthUser | null> {
  try {
    const token = getSessionCookie(c);
    if (!token) return null;

    const tokenHash = hashToken(token);
    const expiresAt = new Date().toISOString();

    const result = await c.env.DB
      .prepare(
        `SELECT au.id, au.auth_user_id, au.user_name, au.role
         FROM auth_sessions s
         JOIN auth_users au ON s.auth_user_id = au.auth_user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .bind(tokenHash, expiresAt)
      .first() as AuthUser | null;

    return result || null;
  } catch {
    return null;
  }
}

export async function requireAuth(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const user = await getAuthenticatedUser(c);
  if (!user) {
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
