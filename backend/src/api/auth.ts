import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { hashToken, generateToken, setSessionCookie, clearSessionCookie, getSessionExpiry, getSessionCookie } from "../utils/auth";
import { requireAuth, requireRole, requireStaff, requireAdmin, requireStudent, type AuthUser } from "../middleware/auth";

const app = new Hono<{ Bindings: { DB: D1Database } }>();

class InvalidJsonError extends Error {}

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

    const studentTables = ["IT_Students_2024_2028", "IT_Students_2025_2029"];
    let student = null;
    for (const table of studentTables) {
      const s = await c.env.DB
        .prepare(`SELECT id, student_id, register_no, student_name, year, section, email, created_at, auth_user_id FROM ${table} WHERE auth_user_id = ? LIMIT 1`)
        .bind(user.auth_user_id)
        .first();
      if (s) {
        student = { ...s, department: "IT", batch: table.replace("IT_Students_", "") };
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
    console.error("Login error:", error);
    return c.json({ success: false, error: "Login failed", code: "login_failed" }, 500);
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
    console.error("Staff login error:", error);
    return c.json({ success: false, error: "Login failed", code: "login_failed" }, 500);
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
    console.error("Logout error:", error);
    return c.json({ success: false, error: "Logout failed" }, 500);
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
    console.error("Admin login error:", error);
    return c.json({ success: false, error: "Login failed", code: "login_failed" }, 500);
  }
});

app.post("/admin/logout", requireAuth, requireAdmin, async (c) => {
  try {
    clearSessionCookie(c);
    await deleteCurrentSession(c);
    return c.json({ success: true, message: "Logged out" });
  } catch (error) {
    console.error("Admin logout error:", error);
    return c.json({ success: false, error: "Logout failed" }, 500);
  }
});

app.post("/logout", requireAuth, async (c) => {
  try {
    clearSessionCookie(c);
    await deleteCurrentSession(c);
    return c.json({ success: true, message: "Logged out" });
  } catch (error) {
    console.error("Logout error:", error);
    return c.json({ success: false, error: "Logout failed" }, 500);
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
    console.error("Resolve staff error:", error);
    return c.json({ success: false, error: "Failed to resolve staff", code: "resolve_failed" }, 500);
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
    console.error("Get staff error:", error);
    return c.json({ success: false, error: "Failed to fetch staff", code: "staff_fetch_failed" }, 500);
  }
});

app.post("/reset-password", requireAuth, async (c) => {
  return c.json({ success: false, error: "Password reset requires an email provider. Configure EMAIL_SENDER and EMAIL_PASSWORD secrets.", code: "email-provider-required" }, 501);
});

app.post("/update-password", requireAuth, async (c) => {
  return c.json({ success: false, error: "Password update requires an email provider. Configure EMAIL_SENDER and EMAIL_PASSWORD secrets.", code: "email-provider-required" }, 501);
});

app.post("/staff/reset-password", requireAuth, requireStaff, async (c) => {
  return c.json({ success: false, error: "Password reset requires an email provider. Configure EMAIL_SENDER and EMAIL_PASSWORD secrets.", code: "email-provider-required" }, 501);
});

app.post("/staff/update-password", requireAuth, requireStaff, async (c) => {
  return c.json({ success: false, error: "Password update requires an email provider. Configure EMAIL_SENDER and EMAIL_PASSWORD secrets.", code: "email-provider-required" }, 501);
});

app.get("/auth/student", requireAuth, requireStudent, async (c) => {
  try {
    const user = (c as any).get("authUser") as AuthUser;
    const tables = ["IT_Students_2024_2028", "IT_Students_2025_2029"];
    for (const table of tables) {
      const student = await c.env.DB
        .prepare(`SELECT id, student_id, register_no, student_name, year, section, email, created_at, auth_user_id FROM ${table} WHERE auth_user_id = ? LIMIT 1`)
        .bind(user.auth_user_id)
        .first();
      if (student) {
        return c.json({ success: true, student: { ...student, department: "IT", batch: table.replace("IT_Students_", "") } });
      }
    }
    return c.json({ success: true, student: null });
  } catch (error) {
    console.error("Get student error:", error);
    return c.json({ success: false, error: "Failed to fetch student", code: "student_fetch_failed" }, 500);
  }
});

export default app;
