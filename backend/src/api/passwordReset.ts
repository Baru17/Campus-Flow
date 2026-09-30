import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { generateToken, hashToken, clearSessionCookie } from "../utils/auth";
import { isTransientD1Error } from "../utils/databaseErrors";
import { assertAllowedStudentTable, listAllowedStudentTables } from "../utils/tableResolver";
import {
  sendPasswordResetEmail,
  EmailNotConfiguredError,
  EmailDeliveryError,
  type EmailBindings,
} from "../utils/email";

/*
 * Password reset over one-time emailed links.
 *
 * These routes are deliberately unauthenticated: the whole point is that a user
 * who cannot sign in can still recover the account. Authorization comes from the
 * reset token itself, so every handler below validates the token before touching
 * a password.
 */

const app = new Hono<{
  Bindings: { DB: D1Database } & EmailBindings & { ALLOWED_ORIGINS?: string };
}>();

const STUDENT_ROLES = ["student"];
const STAFF_ROLES = ["staff", "class_advisor"];

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

const MIN_PASSWORD_LENGTH = 6;

/* bcrypt silently truncates anything past 72 bytes, so longer input is rejected
 * rather than quietly hashed as a shorter password. */
const MAX_PASSWORD_LENGTH = 72;

const TOKEN_PATTERN = /^[A-Za-z0-9-]{8,200}$/;

/* Identical for a known and an unknown account so the endpoint cannot be used
 * to enumerate who has an account. */
const RESET_REQUESTED_MESSAGE =
  "If an account matches, a password reset link has been sent to its registered email.";

const INVALID_TOKEN_MESSAGE = "This password reset link is invalid or has expired.";

const PASSWORD_UPDATED_MESSAGE = "Your password has been updated.";

const PRODUCTION_APP_URL = "https://campus-flow-cdl.pages.dev";

const LOCAL_APP_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

class InvalidJsonError extends Error {}

type ResettableRole = (typeof STUDENT_ROLES)[number] | (typeof STAFF_ROLES)[number];

interface ResolvedAccount {
  auth_user_id: string;
  email: string;
  displayName: string;
}

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

function normalizeRole(role: string): string {
  return role.trim().toLowerCase().replace(/[ -]+/g, "_");
}

function readToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const token = value.trim();
  return TOKEN_PATTERN.test(token) ? token : "";
}

/*
 * The emailed link always points at a known origin. A `redirectTo` supplied by
 * the browser is ignored entirely, so the endpoint cannot be turned into an
 * open redirect that delivers a valid token to an attacker's site. Local dev
 * origins stay usable so the flow can be exercised on localhost.
 */
function resolveAppOrigin(c: any): string {
  const origin = c.req.header("Origin");
  if (typeof origin === "string" && LOCAL_APP_ORIGINS.includes(origin.trim())) {
    return origin.trim();
  }
  return PRODUCTION_APP_URL;
}

function buildResetLink(appOrigin: string, token: string): string {
  return `${appOrigin}/reset-password?token=${encodeURIComponent(token)}`;
}

async function loadRole(db: D1Database, authUserId: string): Promise<string | null> {
  const user = await db
    .prepare("SELECT role FROM auth_users WHERE auth_user_id = ? LIMIT 1")
    .bind(authUserId)
    .first() as { role: string } | null;
  return user ? normalizeRole(user.role) : null;
}

async function issueResetToken(c: any, account: ResolvedAccount): Promise<void> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS).toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE password_reset_tokens SET used_at = ? WHERE auth_user_id = ? AND used_at IS NULL"
    ).bind(now.toISOString(), account.auth_user_id),
    c.env.DB.prepare(
      "INSERT INTO password_reset_tokens (auth_user_id, token_hash, expires_at) VALUES (?, ?, ?)"
    ).bind(account.auth_user_id, tokenHash, expiresAt),
  ]);

  try {
    await sendPasswordResetEmail(c.env, {
      to: account.email,
      toName: account.displayName,
      resetUrl: buildResetLink(resolveAppOrigin(c), token),
      expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
    });
    console.error(JSON.stringify({ event: "password_reset_email_sent", kind: "password-reset" }));
  } catch (error) {
    /*
     * The token row is already committed, and a delivery failure must not
     * become a response the caller could distinguish from a miss, or the
     * endpoint turns into an account-existence oracle. Only the server log
     * records the outcome.
     */
    console.error(
      JSON.stringify({
        event: "password_reset_email_failed",
        kind: "password-reset",
        unconfigured: error instanceof EmailNotConfiguredError,
        status: error instanceof EmailDeliveryError ? error.status : null,
      })
    );
  }
}

/*
 * Every outcome of a reset request - account found, account unknown, or email
 * delivery failed - returns this identical body, so the endpoint cannot be used
 * to discover who has an account.
 */
function resetRequestedResponse(c: any) {
  return c.json({ success: true, message: RESET_REQUESTED_MESSAGE });
}

async function resolveStudent(db: D1Database, identifier: string, lowered: string) {
  for (const tables of listAllowedStudentTables()) {
    const row = (await db
      .prepare(
        `SELECT student_name, email, auth_user_id
         FROM ${assertAllowedStudentTable(tables.studentTable)}
         WHERE student_id = ? OR LOWER(email) = ?
         LIMIT 1`
      )
      .bind(identifier, lowered)
      .first()) as
      | { student_name: string; email: string; auth_user_id: string | null }
      | null;

    if (row?.auth_user_id) {
      return {
        auth_user_id: row.auth_user_id,
        email: row.email,
        displayName: row.student_name,
      } satisfies ResolvedAccount;
    }
  }
  return null;
}

async function resolveStaff(db: D1Database, identifier: string, lowered: string) {
  const row = (await db
    .prepare(
      `SELECT staff_name, email, auth_user_id
       FROM staff
       WHERE LOWER(email) = ? OR staff_id = ?
       LIMIT 1`
    )
    .bind(lowered, identifier)
    .first()) as
    | { staff_name: string; email: string; auth_user_id: string | null }
    | null;

  if (!row?.auth_user_id) {
    return null;
  }
  return {
    auth_user_id: row.auth_user_id,
    email: row.email,
    displayName: row.staff_name,
  } satisfies ResolvedAccount;
}

/*
 * Issues a reset link for a resolved account, or returns the same generic
 * success when nothing matches. `expectedRoles` keeps a staff account from
 * being reset through the student route and vice versa.
 */
async function handleResetRequest(
  c: any,
  allowedRoles: string[],
  resolve: (db: D1Database, identifier: string, lowered: string) => Promise<ResolvedAccount | null>
) {
  const body = await parseBody(c);
  const raw = body.studentId ?? body.staffId ?? body.email;
  const identifier = typeof raw === "string" ? raw.trim() : "";
  const lowered = identifier.toLowerCase();

  if (!identifier || identifier.length > 200) {
    return resetRequestedResponse(c);
  }

  const account = await resolve(c.env.DB, identifier, lowered);
  if (!account || !allowedRoles.includes((await loadRole(c.env.DB, account.auth_user_id)) ?? "")) {
    return resetRequestedResponse(c);
  }

  await issueResetToken(c, account);
  return resetRequestedResponse(c);
}

interface ActiveToken {
  id: number;
  auth_user_id: string;
  role: string;
}

/*
 * Resolves a raw token to its owning account, rejecting unknown, already-used
 * and expired links with one indistinguishable error.
 */
async function resolveActiveToken(c: any, token: string): Promise<ActiveToken | null> {
  if (!token) {
    return null;
  }
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const row = (await c.env.DB.prepare(
    `SELECT id, auth_user_id, used_at, (expires_at > ?) AS token_is_valid
     FROM password_reset_tokens
     WHERE token_hash = ?
     LIMIT 1`
  )
    .bind(now, tokenHash)
    .first()) as
    | { id: number; auth_user_id: string; used_at: string | null; token_is_valid: number }
    | null;

  if (!row || row.used_at || !row.token_is_valid) {
    return null;
  }

  const role = await loadRole(c.env.DB, row.auth_user_id);
  if (!role) {
    return null;
  }

  return { id: row.id, auth_user_id: row.auth_user_id, role };
}

function invalidToken(c: any) {
  return c.json({ success: false, error: INVALID_TOKEN_MESSAGE, code: "invalid-reset-token" }, 400);
}

function readNewPassword(body: Record<string, unknown>): string {
  return typeof body.password === "string" ? body.password : "";
}

function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Your password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Your password must be at most ${MAX_PASSWORD_LENGTH} characters long.`;
  }
  return null;
}

/*
 * Consumes the token, writes the new hash, and drops every existing session so
 * a stolen cookie cannot outlive a password change.
 */
async function completePasswordReset(c: any, active: ActiveToken, password: string) {
  const now = new Date().toISOString();

  /*
   * Claiming the token is the serialization point. The conditional update means
   * two concurrent submissions of the same link cannot both succeed.
   */
  const claim = await c.env.DB.prepare(
    "UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL"
  )
    .bind(now, active.id)
    .run();

  if ((claim.meta?.changes ?? 0) !== 1) {
    return invalidToken(c);
  }

  const pwdHash = await bcrypt.hash(password, 10);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE auth_users SET pwd_hash = ? WHERE auth_user_id = ?").bind(
      pwdHash,
      active.auth_user_id
    ),
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE auth_user_id = ?").bind(active.auth_user_id),
  ]);

  clearSessionCookie(c);
  console.error(JSON.stringify({ event: "password_reset_completed", role: active.role }));
  return c.json({ success: true, message: PASSWORD_UPDATED_MESSAGE });
}

async function handleUpdatePassword(c: any, allowedRoles: ResettableRole[]) {
  const body = await parseBody(c);
  const password = readNewPassword(body);

  const passwordError = validatePassword(password);
  if (passwordError) {
    return c.json({ success: false, error: passwordError, code: "weak-password" }, 400);
  }

  const active = await resolveActiveToken(c, readToken(body.token));
  if (!active || !allowedRoles.includes(active.role as ResettableRole)) {
    return invalidToken(c);
  }

  return completePasswordReset(c, active, password);
}

app.post("/reset-password", async (c) => {
  try {
    return await handleResetRequest(c, STUDENT_ROLES, resolveStudent);
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return resetRequestedResponse(c);
    }
    return serverError(c, error, "Password reset failed", "reset_failed");
  }
});

app.post("/staff/reset-password", async (c) => {
  try {
    return await handleResetRequest(c, STAFF_ROLES, resolveStaff);
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return resetRequestedResponse(c);
    }
    return serverError(c, error, "Password reset failed", "reset_failed");
  }
});

app.post("/validate-reset-token", async (c) => {
  try {
    const body = await parseBody(c);
    const active = await resolveActiveToken(c, readToken(body.token));
    if (!active) {
      return invalidToken(c);
    }
    return c.json({ success: true, role: active.role });
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return invalidToken(c);
    }
    return serverError(c, error, "Password reset failed", "reset_failed");
  }
});

app.post("/update-password", async (c) => {
  try {
    return await handleUpdatePassword(c, ["student"]);
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return invalidToken(c);
    }
    return serverError(c, error, "Password update failed", "update_failed");
  }
});

app.post("/staff/update-password", async (c) => {
  try {
    return await handleUpdatePassword(c, ["staff", "class_advisor"]);
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return invalidToken(c);
    }
    return serverError(c, error, "Password update failed", "update_failed");
  }
});

export default app;
