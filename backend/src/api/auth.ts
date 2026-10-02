import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { hashToken, generateToken, setSessionCookie, clearSessionCookie, getSessionExpiry, getSessionCookie } from "../utils/auth";
import { requireAuth, requireRole, requireStaff, requireAdmin, requireStudent, type AuthUser } from "../middleware/auth";
import { isTransientD1Error } from "../utils/databaseErrors";
import { assertAllowedStudentTable, listAllowedStudentTables } from "../utils/tableResolver";
import { isApproverRole, resolveApproverIdentity } from "../utils/approverDirectory";

const app = new Hono<{ Bindings: { DB: D1Database } }>();

class InvalidJsonError extends Error {}

function serverError(c: any, error: unknown, message: string, code: string) {
  console.error(message, error);
  const transient = isTransientD1Error(error);
  return c.json(
    {
      success: false,
      error: transient ? "Authentication service is temporarily busy. Please retry." : message,
      code: transient ? "database-busy" : code,
    },
    transient ? 503 : 500
  );
}

function safeUser(user: { id: number; auth_user_id: string; user_name: string; role: string }) {
  return {
    id: user.auth_user_id,
    auth_user_id: user.auth_user_id,
    user_name: user.user_name,
    role: user.role,
  };
}

async function parseBody(c: any): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new InvalidJsonError();
  }
}

app.post("/login", async (c) => {
  try {
    const body = await parseBody(c);
    const rawUserName = typeof body.user_name === "string" ? body.user_name : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user_name = rawUserName.trim();
    const isEmail = user_name.includes("@");
    const lookupUser = isEmail ? user_name.toLowerCase() : user_name.toUpperCase();

    if (!user_name || !password) {
      return c.json({ success: false, error: "Username and password are required", code: "missing_credentials" }, 400);
    }

    const user = await c.env.DB
      .prepare("SELECT id, auth_user_id, user_name, pwd_hash, role, email FROM auth_users WHERE user_name = ? OR email = ? LIMIT 1")
      .bind(lookupUser, lookupUser)
      .first() as { id: number; auth_user_id: string; user_name: string; pwd_hash: string; role: string; email: string } | null;

    if (!user) {
      return c.json({ success: false, error: "Invalid username or password", code: "invalid_credentials" }, 401);
    }

    const validPassword = await bcrypt.compare(password, user.pwd_hash);
    if (!validPassword) {
      return c.json({ success: false, error: "Invalid username or password", code: "invalid_credentials" }, 401);
    }

    if (user.role !== "student") {
      return c.json({ success: false, error: "Invalid username or password", code: "invalid_credentials" }, 401);
    }

    let student = null;
    for (const tables of listAllowedStudentTables()) {
      const s = await c.env.DB
        .prepare(`SELECT id, student_id, register_no, student_name, year, section, email, created_at, auth_user_id FROM ${assertAllowedStudentTable(tables.studentTable)} WHERE auth_user_id = ? LIMIT 1`)
        .bind(user.auth_user_id)
        .first();
      if (s) {
        student = { ...s, department: tables.department, batch: tables.batch };
        break;
      }
    }

    if (!student) {
      return c.json({ success: false, error: "Your account is not linked to a student record", code: "unlinked-student" }, 403);
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = getSessionExpiry();

    await c.env.DB
      .prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
      .bind(tokenHash, user.auth_user_id, expiresAt)
      .run();

    setSessionCookie(c, token);

    return c.json({
      success: true,
      user: safeUser(user),
      student,
    });
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return c.json({ success: false, error: "Invalid JSON body", code: "invalid_json" }, 400);
    }
    return serverError(c, error, "Login failed", "login_failed");
  }
});

app.post("/staff/login", async (c) => {
  try {
    const body = await parseBody(c);
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const staff_id = body.staff_id;

    if (!password) {
      return c.json({ success: false, error: "Password is required", code: "missing_credentials" }, 400);
    }

    let resolvedEmail = email?.trim().toLowerCase();

    if (!resolvedEmail && staff_id) {
      const id = Number(staff_id);
      if (Number.isInteger(id) && id > 0) {
        const staff = await c.env.DB
          .prepare("SELECT email FROM staff WHERE staff_id = ? LIMIT 1")
          .bind(String(id))
          .first() as { email: string } | null;
        if (staff) {
          resolvedEmail = staff.email.trim().toLowerCase();
        }
      }
    }

    if (!resolvedEmail || !resolvedEmail.includes("@")) {
      return c.json({ success: false, error: "Please enter a valid staff email or staff ID", code: "invalid_credentials" }, 400);
    }

    const user = await c.env.DB
      .prepare("SELECT id, auth_user_id, user_name, pwd_hash, role FROM auth_users WHERE user_name = ? OR email = ? LIMIT 1")
      .bind(resolvedEmail, resolvedEmail)
      .first() as { id: number; auth_user_id: string; user_name: string; pwd_hash: string; role: string } | null;

    if (!user) {
      return c.json({ success: false, error: "Invalid credentials", code: "invalid_credentials" }, 401);
    }

    const validPassword = await bcrypt.compare(password, user.pwd_hash);
    if (!validPassword) {
      return c.json({ success: false, error: "Invalid credentials", code: "invalid_credentials" }, 401);
    }

    const staffRole = user.role.trim().toLowerCase().replace(/[ -]+/g, "_");
    if (staffRole !== "staff" && staffRole !== "class_advisor") {
      return c.json({ success: false, error: "Invalid credentials", code: "invalid_credentials" }, 401);
    }

    const staffRecord = await c.env.DB
      .prepare("SELECT id, staff_id, staff_name, email, department, class_advisor, created_at, auth_user_id FROM staff WHERE auth_user_id = ? LIMIT 1")
      .bind(user.auth_user_id)
      .first();

    if (!staffRecord) {
      return c.json({ success: false, error: "Your account is not linked to a staff record", code: "unlinked-staff" }, 403);
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = getSessionExpiry();

    await c.env.DB
      .prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
      .bind(tokenHash, user.auth_user_id, expiresAt)
      .run();

    setSessionCookie(c, token);

    return c.json({
      success: true,
      user: safeUser(user),
      staff: { ...staffRecord as object },
    });
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return c.json({ success: false, error: "Invalid JSON body", code: "invalid_json" }, 400);
    }
    return serverError(c, error, "Login failed", "login_failed");
  }
});

/*
 * Sign-in for the people who action OD requests.
 *
 * The OD workflow has four approver roles and none of them is the admin: a mentor and
 * a class advisor are staff, and a contest coordinator and a head of department are
 * the two roles the admin dashboard provisions. Three of those four could already sign
 * in -- staff through `/staff/login` -- but the coordinator and HOD could not, because
 * no route accepted their role. This closes that gap without touching the routes that
 * already work.
 *
 * ## What is deliberately *not* changed
 *
 *   - `/api/auth/login` still accepts students only, and `/api/auth/staff/login` still
 *     accepts staff and class advisors only. A coordinator cannot reach either, so
 *     nothing about how a student or a lecturer signs in moves.
 *   - `requireStaff` still authorises on `staff` or `class_advisor`, so a session
 *     created here grants no access to the subject catalog, the batch picker or the
 *     attendance generator. A coordinator who signs in here can do exactly one thing:
 *     action OD requests.
 *   - The session is the established one -- `auth_sessions`, the same token hashing,
 *     the same cookie, the same 7-day expiry. There is no account TTL for either role.
 *
 * So this adds a way in for two roles rather than widening any door. The OD routes
 * authorise on the directory the request names, not on the role alone, so a valid
 * session here still has to be matched against a real coordinator or HOD row for the
 * student's department before it can decide anything.
 *
 * ## Why the role in the response is not always the role on the account
 *
 * A contest coordinator is appointed out of a department's staff roster and *reuses*
 * that person's staff login, so their `auth_users.role` is `staff` -- correctly, since
 * renaming it would take their mentor and attendance access away. What makes them a
 * coordinator is the `contest_coordinators` row, and that is what decides which dashboard
 * they land in. `resolveApproverIdentity` reads it; the account role is still checked
 * first, so a student or an admin cannot get a session here at all.
 */

app.post("/od-approver/login", async (c) => {
  try {
    const body = await parseBody(c);
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      return c.json(
        { success: false, error: "Email and password are required", code: "missing_credentials" },
        400
      );
    }

    const resolvedEmail = email.trim().toLowerCase();
    const user = (await c.env.DB
      .prepare("SELECT id, auth_user_id, user_name, pwd_hash, role, email FROM auth_users WHERE user_name = ? OR email = ? LIMIT 1")
      .bind(resolvedEmail, resolvedEmail)
      .first()) as
      | { id: number; auth_user_id: string; user_name: string; pwd_hash: string; role: string; email: string }
      | null;

    if (!user) {
      return c.json({ success: false, error: "Invalid credentials", code: "invalid_credentials" }, 401);
    }

    const validPassword = await bcrypt.compare(password, user.pwd_hash);
    if (!validPassword) {
      return c.json({ success: false, error: "Invalid credentials", code: "invalid_credentials" }, 401);
    }

    if (!isApproverRole(user.role)) {
      // A student or an admin account must not be able to sign in here, or the session
      // would be a second way to reach the approver routes.
      return c.json({ success: false, error: "Invalid credentials", code: "invalid_credentials" }, 401);
    }

    /*
     * The role has to correspond to a real directory record before a session is created,
     * so an account whose role was set but whose row is missing cannot sign in to an empty
     * inbox. Resolution is by `auth_user_id` against the caller's own session -- the tables
     * are literals inside that module, never anything from the request.
     */
    const identity = await resolveApproverIdentity(c.env.DB, user.auth_user_id);

    if (!identity) {
      return c.json(
        {
          success: false,
          error: "Your account is not linked to an approver record. Contact the administrator.",
          code: "unlinked-approver",
        },
        403
      );
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = getSessionExpiry();

    await c.env.DB
      .prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
      .bind(tokenHash, user.auth_user_id, expiresAt)
      .run();

    setSessionCookie(c, token);

    return c.json({
      success: true,
      user: safeUser(user),
      approver: {
        role: identity.role,
        name: identity.name,
        department: identity.department,
      },
    });
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return c.json({ success: false, error: "Invalid JSON body", code: "invalid_json" }, 400);
    }
    return serverError(c, error, "Login failed", "login_failed");
  }
});

async function deleteCurrentSession(c: any): Promise<void> {
  const token = getSessionCookie(c);
  if (!token) return;
  await c.env.DB
    .prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
    .bind(hashToken(token))
    .run();
}

app.post("/staff/logout", requireAuth, requireRole("staff", "class_advisor"), async (c) => {
  try {
    clearSessionCookie(c);
    await deleteCurrentSession(c);
    return c.json({ success: true, message: "Logged out" });
  } catch (error) {
    return serverError(c, error, "Logout failed", "logout_failed");
  }
});

app.post("/admin/login", async (c) => {
  try {
    const body = await parseBody(c);
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      return c.json({ success: false, error: "Admin email and password are required", code: "missing_credentials" }, 400);
    }

    const adminEmail = email.trim().toLowerCase();
    if (adminEmail !== "admin@kiot.ac.in") {
      return c.json({ success: false, error: "Invalid admin credentials", code: "invalid_credentials" }, 401);
    }

    const user = await c.env.DB
      .prepare("SELECT id, auth_user_id, user_name, pwd_hash, role FROM auth_users WHERE user_name = ? AND role = 'admin' LIMIT 1")
      .bind(adminEmail)
      .first() as { id: number; auth_user_id: string; user_name: string; pwd_hash: string; role: string } | null;

    if (!user) {
      return c.json({ success: false, error: "Invalid admin credentials", code: "invalid_credentials" }, 401);
    }

    const validPassword = await bcrypt.compare(password, user.pwd_hash);
    if (!validPassword) {
      return c.json({ success: false, error: "Invalid admin credentials", code: "invalid_credentials" }, 401);
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = getSessionExpiry();

    await c.env.DB
      .prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
      .bind(tokenHash, user.auth_user_id, expiresAt)
      .run();

    setSessionCookie(c, token);

    return c.json({
      success: true,
      user: safeUser(user),
    });
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return c.json({ success: false, error: "Invalid JSON body", code: "invalid_json" }, 400);
    }
    return serverError(c, error, "Login failed", "login_failed");
  }
});

app.post("/admin/logout", requireAuth, requireAdmin, async (c) => {
  try {
    clearSessionCookie(c);
    await deleteCurrentSession(c);
    return c.json({ success: true, message: "Logged out" });
  } catch (error) {
    return serverError(c, error, "Logout failed", "logout_failed");
  }
});

app.post("/logout", requireAuth, async (c) => {
  try {
    clearSessionCookie(c);
    await deleteCurrentSession(c);
    return c.json({ success: true, message: "Logged out" });
  } catch (error) {
    return serverError(c, error, "Logout failed", "logout_failed");
  }
});

app.get("/user", requireAuth, async (c) => {
  const user = (c as any).get("authUser") as AuthUser;
  return c.json({ success: true, user: safeUser(user) });
});

app.get("/session", requireAuth, async (c) => {
  const user = (c as any).get("authUser") as AuthUser;
  return c.json({ success: true, user: safeUser(user), session: { active: true, role: user.role } });
});

app.get("/staff/resolve/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const staffId = Number(id);
    if (!Number.isInteger(staffId) || staffId <= 0) {
      return c.json({ success: false, error: "Invalid staff ID", code: "invalid-staff-id" }, 400);
    }
    const staff = await c.env.DB
      .prepare("SELECT email FROM staff WHERE staff_id = ? LIMIT 1")
      .bind(String(staffId))
      .first() as { email: string } | null;
    if (!staff) {
      return c.json({ success: false, error: "Staff not found", code: "staff-id-unresolved" }, 404);
    }
    return c.json({ success: true, email: staff.email.trim().toLowerCase() });
  } catch (error) {
    return serverError(c, error, "Failed to resolve staff", "resolve_failed");
  }
});

app.get("/staff/:authUserId", requireAuth, requireStaff, async (c) => {
  try {
    const authUserId = c.req.param("authUserId");
    const staffRecord = await c.env.DB
      .prepare("SELECT id, staff_id, staff_name, email, department, class_advisor, created_at, auth_user_id FROM staff WHERE auth_user_id = ? LIMIT 1")
      .bind(authUserId)
      .first();
    if (!staffRecord) {
      return c.json({ success: false, error: "Staff not found", code: "staff-not-found" }, 404);
    }
    return c.json({ success: true, ...staffRecord });
  } catch (error) {
    return serverError(c, error, "Failed to fetch staff", "staff_fetch_failed");
  }
});

/*
 * Password reset lives in ./passwordReset and is mounted on the same /api/auth
 * prefix. Those routes authorize with a one-time emailed token instead of the
 * session cookie, so they are not guarded by requireAuth.
 */

app.get("/auth/student", requireAuth, requireStudent, async (c) => {
  try {
    const user = (c as any).get("authUser") as AuthUser;
    for (const tables of listAllowedStudentTables()) {
      const student = await c.env.DB
        .prepare(`SELECT id, student_id, register_no, student_name, year, section, email, created_at, auth_user_id FROM ${assertAllowedStudentTable(tables.studentTable)} WHERE auth_user_id = ? LIMIT 1`)
        .bind(user.auth_user_id)
        .first();
      if (student) {
        return c.json({ success: true, student: { ...student, department: tables.department, batch: tables.batch } });
      }
    }
    return c.json({ success: true, student: null });
  } catch (error) {
    return serverError(c, error, "Failed to fetch student", "student_fetch_failed");
  }
});

export default app;
