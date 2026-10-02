/*
 * Contest coordinators, provisioned from the staff directory.
 *
 * ## Why this is not the generic directory route
 *
 * `hods` and `contest_coordinators` used to share one implementation
 * (`registerDirectoryRoutes` in `admin.ts`), which took a name, an address and a
 * department per row and let the client supply all three. That is right for a head of
 * department, who is appointed to a department rather than already being on its
 * roster. It is wrong for a contest coordinator: the coordinator *is* a member of that
 * department's staff, and a form that lets an admin type a third address next to the
 * one on their staff record is a form that will eventually hold two different
 * addresses for the same person -- and the OD workflow authorises on
 * `contest_coordinators.email`, so the duplicate would silently stop receiving
 * approvals.
 *
 * So this module exists to make the staff record authoritative, and the identity
 * columns on `contest_coordinators` become a derived copy rather than an input:
 *
 *     department  ->  staff of that department  ->  staff_id  ->  staff record
 *                                                                 ->  name/email/department
 *
 * ## The join is on email, and that is deliberate
 *
 * `contest_coordinators` has no `staff_id` column, and adding one needs a migration.
 * It does not need one: `staff.email` is UNIQUE and `contest_coordinators.email` is
 * UNIQUE, so the address identifies the staff member unambiguously, and it is the
 * key this codebase *already* uses to relate these two tables -- the directory rows
 * carry no `auth_user_id` either, so the login account has always been found by
 * address. Reusing that key keeps the change additive and keeps the OD workflow's
 * `WHERE email = ? AND department = ?` lookup working exactly as it did.
 *
 * The cost is that a coordinator can drift from its staff record if the staff row's
 * email is later edited. That is reported rather than hidden: the list route marks
 * such rows `unlinked`, and `README` carries the query to find them. Silently
 * rewriting production rows is the wrong answer; surfacing them is the right one.
 *
 * ## What the client may send
 *
 * One field: `staff_id`. Everything else on the coordinator -- the name, the address
 * and the department -- is read from the staff row here. A body that tries to set
 * them is refused rather than ignored, because a client that believes it can set
 * `email` is a client that will keep sending it, and silently dropping it would make
 * the bug invisible until someone read the row back.
 */

import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { isTransientD1Error } from "../utils/databaseErrors";
import { normalizeDepartment } from "../utils/tableResolver";
import {
  DEFAULT_INITIAL_PASSWORD,
  emailUserName,
  hashDefaultPassword,
  planAccounts,
  type ExistingAccount,
} from "../utils/accountProvisioning";
import { validateStaffId } from "../utils/adminValidation";

const app = new Hono<{ Bindings: { DB: D1Database } }>();

/** Literal table and column names. Nothing here is ever client-supplied. */
const COORDINATOR_TABLE = "contest_coordinators";
const COORDINATOR_ID = "coordinator_id";
const COORDINATOR_NAME = "coordinator_name";

/** The account role a coordinator signs in with. Unchanged from before. */
const COORDINATOR_ROLE = "contest_coordinator";

/**
 * The identity fields a client is not allowed to set.
 *
 * Listed as literals so the refusal message can name them and the test can assert on
 * the exact set. `coordinator_name` is included alongside the two the old free-form
 * form sent under their generic names, because it is the column that form typed.
 *
 * `department` is deliberately *not* here. The admin is looking at a department picker
 * when they choose a person, so the client has to be able to say which one -- and it is
 * checked against the staff record instead, below. Refusing it outright would leave a
 * stale dropdown undetectable; accepting it as authority would reintroduce the exact
 * inconsistency this module exists to prevent.
 */
const DERIVED_FIELDS = ["coordinator_name", "email", "name"] as const;

function fail(c: any, status: number, error: string, code: string, details?: unknown) {
  return c.json({ success: false, error, code, ...(details ? { details } : {}) }, status);
}

function serverError(c: any, error: unknown, message: string, code: string) {
  console.error(message, error);
  const transient = isTransientD1Error(error);
  return c.json(
    {
      success: false,
      error: transient ? "Admin service is temporarily busy. Please retry." : message,
      code: transient ? "database-busy" : code,
    },
    transient ? 503 : 500
  );
}

async function readObjectBody(c: any): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "Invalid JSON body", "invalid-json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(c, 400, "Expected a JSON object", "invalid-body");
  }
  return body as Record<string, unknown>;
}

/** The four columns this flow needs from a staff row, and nothing else. */
interface StaffIdentity {
  staff_id: string;
  staff_name: string;
  email: string;
  department: string;
}

/**
 * Loads one staff member by id.
 *
 * The projection is explicit and contains no `pwd_hash` and no `auth_user_id`: this
 * row is read to derive a coordinator's identity, and neither of those columns has
 * any business travelling into that derivation or into a response.
 */
async function findStaff(db: D1Database, staffId: string): Promise<StaffIdentity | null> {
  const row = await db
    .prepare("SELECT staff_id, staff_name, email, department FROM staff WHERE staff_id = ? LIMIT 1")
    .bind(staffId)
    .first<StaffIdentity>();
  return row ?? null;
}

/**
 * The common front half of both writes: parse, reject derived fields, resolve the
 * staff record, and check the department the client was looking at.
 *
 * Returning the resolved staff identity -- rather than the coordinator fields -- is
 * what makes the two routes above it incapable of disagreeing about where a name came
 * from: neither of them reads a name out of the request.
 */
async function resolveStaffSelection(
  c: any
): Promise<{ staff: StaffIdentity } | { response: Response }> {
  const body = await readObjectBody(c);
  if (body instanceof Response) return { response: body };

  /*
   * Refuse the derived fields outright rather than ignoring them. "Ignore or reject"
   * were both acceptable; rejection is chosen because a client still sending `email`
   * is a client that will display its own value back to the admin as though it had
   * been saved, and that confusion is worse than a clear 400.
   */
  const attempted = DERIVED_FIELDS.filter(
    (field) => body[field] !== undefined && body[field] !== null && body[field] !== ""
  );
  if (attempted.length > 0) {
    return {
      response: fail(
        c,
        400,
        `A coordinator's ${attempted.join(", ")} come from the staff record and cannot be set. Send staff_id only.`,
        "coordinator-identity-not-writable"
      ),
    };
  }

  const staffId = validateStaffId(body.staff_id);
  if (!staffId.ok) {
    return { response: fail(c, 400, staffId.errors[0].message, "coordinator-validation-failed", { errors: staffId.errors }) };
  }

  const staff = await findStaff(c.env.DB, staffId.value);
  if (!staff) {
    /*
     * Deliberately the same answer for "no such staff id" and "this staff id is in
     * another department". Naming which ids exist would let an admin probe the
     * directory, which they can already do; naming which do not exist in a given
     * department is a different question with no legitimate use.
     */
    return { response: fail(c, 404, "That staff member could not be found", "coordinator-staff-not-found") };
  }

  /*
   * The department is the one identity field a client may send, and it is never taken
   * on trust: it is compared against the staff record and a disagreement is refused.
   * That is what catches a stale dropdown -- the admin picked IT, the staff list had not
   * reloaded, and the staff member behind the id is in CSE -- which is the one way this
   * flow could otherwise be made to build a coordinator whose department does not match
   * their staff record.
   */
  const requested = typeof body.department === "string" ? body.department.trim() : "";
  if (requested) {
    const normalized = normalizeDepartment(requested);
    if (!normalized) {
      return { response: fail(c, 400, "Choose a supported department", "invalid-department") };
    }
    if (normalized !== staff.department) {
      return {
        response: fail(
          c,
          409,
          `That staff member is in ${staff.department}, not ${normalized}. Choose a department, then pick someone from it.`,
          "coordinator-department-mismatch"
        ),
      };
    }
  }

  return { staff };
}

/**
 * Whether this address is already a coordinator, ignoring one row.
 *
 * `email` is UNIQUE on `contest_coordinators`, so this cannot race past the database
 * constraint -- the second insert would fail rather than duplicate. The check exists
 * to turn that into a 409 an admin can read instead of a constraint error, and to
 * cover the case-difference variant the UNIQUE index on its own would treat as a
 * different address.
 */
async function findCoordinatorByEmail(
  db: D1Database,
  email: string,
  excludeId?: number
): Promise<{ coordinator_id: number } | null> {
  const row = await db
    .prepare(
      `SELECT ${COORDINATOR_ID} FROM ${COORDINATOR_TABLE}
       WHERE LOWER(email) = ? ${excludeId === undefined ? "" : `AND ${COORDINATOR_ID} <> ?`}
       LIMIT 1`
    )
    .bind(...(excludeId === undefined ? [email.toLowerCase()] : [email.toLowerCase(), excludeId]))
    .first<{ coordinator_id: number }>();
  return row ?? null;
}

/* ------------------------------------------------------------------- list */

/**
 * Every coordinator, with their identity read from the staff record.
 *
 * The join is a LEFT JOIN on the shared email, and `staff` is preferred on every
 * field. That is what keeps a coordinator row from drifting out of step with the
 * staff member it was created from: even if the staff record is later corrected, the
 * list shows the corrected values, because the list does not trust the copy.
 *
 * `unlinked` marks a row whose address no longer matches any staff record -- the
 * coordinator was created before this flow existed, or that staff member's email has
 * since been edited. Those rows keep their own stored values rather than going blank,
 * so the admin can still see and fix them; they are surfaced rather than silently
 * dropped.
 */
app.get("/contest-coordinators", requireAuth, requireAdmin, async (c) => {
  try {
    const requested = c.req.query("department");
    const department = requested === undefined ? null : normalizeDepartment(requested);
    if (requested !== undefined && !department) {
      return fail(c, 400, "Choose a supported department", "invalid-department");
    }

    const where = department ? "WHERE COALESCE(s.department, cc.department) = ?" : "";
    const { results } = await c.env.DB
      .prepare(
        `SELECT cc.${COORDINATOR_ID},
                COALESCE(s.staff_name, cc.${COORDINATOR_NAME}) AS ${COORDINATOR_NAME},
                COALESCE(s.email, cc.email) AS email,
                COALESCE(s.department, cc.department) AS department,
                cc.created_at,
                s.staff_id AS staff_id,
                CASE WHEN s.staff_id IS NULL THEN 1 ELSE 0 END AS unlinked
         FROM ${COORDINATOR_TABLE} cc
         LEFT JOIN staff s ON LOWER(s.email) = LOWER(cc.email)
         ${where}
         ORDER BY ${COORDINATOR_NAME}`
      )
      .bind(...(department ? [department] : []))
      .all<Record<string, unknown>>();

    return c.json({
      success: true,
      ...(department ? { department } : {}),
      contest_coordinators: results ?? [],
    });
  } catch (error) {
    return serverError(c, error, "Could not load coordinators", "coordinators-list-failed");
  }
});

/* ----------------------------------------------------------------- create */

/**
 * Makes a contest coordinator out of a staff member.
 *
 * The whole request is `{ staff_id }`. The name, the address and the department are
 * read from the staff row, so it is not possible through this endpoint to create a
 * coordinator whose address disagrees with their staff record -- the mismatch that
 * would stop them receiving OD approvals, because the workflow authorises on
 * `contest_coordinators.email`.
 *
 * ## The account is reused, never duplicated
 *
 * Every staff member already has an account, created by the staff import, with the
 * role `staff` and `staff.auth_user_id` pointing at it. So the normal case here is that
 * an account already exists, and the right thing to do is nothing to it: keep the role,
 * keep the password, and do not insert a second row. That account can already reach
 * the coordinator's OD queue -- `/api/auth/od-approver/login` accepts `staff`, and
 * approval authority comes from the coordinator row rather than from the role.
 *
 * A staff member with no account at all (a row inserted by hand, say) gets one, with
 * the coordinator role, as before.
 *
 * Either way the coordinator row records the account it belongs to in
 * `auth_user_id`. That column already exists and was simply never written -- and
 * `/api/auth/od-approver/login` requires it for a coordinator-role account, so
 * without this an appointed coordinator could not sign in at all. No migration is
 * needed for it: the column is in the table already.
 */
app.post("/contest-coordinators", requireAuth, requireAdmin, async (c) => {
  try {
    const resolved = await resolveStaffSelection(c);
    if ("response" in resolved) return resolved.response;
    const { staff } = resolved;

    const existing = await findCoordinatorByEmail(c.env.DB, staff.email);
    if (existing) {
      return fail(
        c,
        409,
        "This staff member is already a Contest Coordinator.",
        "coordinator-already-exists"
      );
    }

    /*
     * The staff member's own account, when they have one.
     *
     * Resolved through `staff.auth_user_id` first -- that is the link the staff import
     * wrote and the one `staff.auth_user_id`-based routes already use -- and only then by
     * address, for a roster row that has one but was never linked.
     */
    const staffRow = await c.env.DB
      .prepare("SELECT staff_id, staff_name, email, department, auth_user_id FROM staff WHERE staff_id = ? LIMIT 1")
      .bind(staff.staff_id)
      .first<StaffIdentity & { auth_user_id: string | null }>();

    const linked = staffRow?.auth_user_id
      ? await env_account(c.env.DB, staffRow.auth_user_id)
      : await env_accountByEmail(c.env.DB, staff.email);

    let authUserId = linked?.auth_user_id ?? null;
    let accountsCreated = 0;

    if (!linked) {
      // No account at all. One is created, with the coordinator role, on the documented
      // default -- the same shape the typed directory route produced.
      const key = emailUserName(staff.email);
      const pwdHash = await hashDefaultPassword();
      const { plans } = planAccounts(
        [{ key, email: staff.email, role: COORDINATOR_ROLE }],
        { byKey: new Map(), byEmail: new Map() },
        pwdHash
      );
      const plan = plans[0];
      await c.env.DB
        .prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
        .bind(plan.auth_user_id, plan.user_name, plan.pwdHash, plan.role, plan.email)
        .run();
      authUserId = plan.auth_user_id;
      accountsCreated = 1;
    }

    /*
     * The row and the account together. One `batch()`, so a coordinator is never created
     * without knowing which account it belongs to.
     */
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO ${COORDINATOR_TABLE} (${COORDINATOR_NAME}, email, department, auth_user_id)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(staff.staff_name, staff.email, staff.department, authUserId),
      // The staff row's link is filled in when the import left it empty, so the account
      // and the roster agree in both directions afterwards.
      ...(linked && !staffRow?.auth_user_id
        ? [
            c.env.DB
              .prepare("UPDATE staff SET auth_user_id = ? WHERE staff_id = ? AND auth_user_id IS NULL")
              .bind(authUserId, staff.staff_id),
          ]
        : []),
    ]);

    const created = await c.env.DB
      .prepare(
        `SELECT ${COORDINATOR_ID}, ${COORDINATOR_NAME}, email, department, created_at
         FROM ${COORDINATOR_TABLE} WHERE LOWER(email) = ? LIMIT 1`
      )
      .bind(staff.email.toLowerCase())
      .first();

    return c.json({
      success: true,
      created: 1,
      authAccountsCreated: accountsCreated,
      // An existing account was reused rather than created, so there is no password to
      // hand out. Reported so the dashboard does not tell an admin to reset one.
      authAccountReused: Boolean(linked),
      contest_coordinator: created ?? null,
      ...(accountsCreated ? { defaultPassword: DEFAULT_INITIAL_PASSWORD } : {}),
    });
  } catch (error) {
    return serverError(c, error, "Could not create that coordinator", "coordinators-create-failed");
  }
});

/** An account by its id, which is the handle `staff.auth_user_id` holds. */
async function env_account(db: D1Database, authUserId: string): Promise<ExistingAccount | null> {
  return (
    (await db
      .prepare("SELECT auth_user_id, user_name, role, email FROM auth_users WHERE auth_user_id = ? LIMIT 1")
      .bind(authUserId)
      .first<ExistingAccount>()) ?? null
  );
}

/** An account by address, for a roster row that was never linked to one. */
async function env_accountByEmail(db: D1Database, email: string): Promise<ExistingAccount | null> {
  const lowered = email.toLowerCase();
  return (
    (await db
      .prepare("SELECT auth_user_id, user_name, role, email FROM auth_users WHERE LOWER(user_name) = ? OR LOWER(email) = ? LIMIT 1")
      .bind(lowered, lowered)
      .first<ExistingAccount>()) ?? null
  );
}

/* ------------------------------------------------------------------- edit */

/**
 * Points an existing coordinator at a different staff member.
 *
 * The name, address and department are not editable -- there is nothing to edit them
 * with. The only thing this route can change is *which staff member the coordinator
 * is*, and every identity field is re-derived from the new staff record afterwards,
 * so the row cannot end up half-moved.
 *
 * When the staff member carries a different address the login account moves with
 * it: the same `auth_user_id`, the same `pwd_hash`, and `user_name` rewritten only
 * when it currently *is* the old address. That is the behaviour the generic directory
 * edit already had, kept so a coordinator who moves between departments keeps the
 * password they had.
 */
app.patch("/contest-coordinators/:coordinatorId", requireAuth, requireAdmin, async (c) => {
  try {
    const id = Number(c.req.param("coordinatorId"));
    if (!Number.isInteger(id) || id <= 0) {
      return fail(c, 400, "Invalid Coordinator ID", "invalid-coordinator-id");
    }

    const resolved = await resolveStaffSelection(c);
    if ("response" in resolved) return resolved.response;
    const { staff } = resolved;

    const current = await c.env.DB
      .prepare(`SELECT ${COORDINATOR_ID}, ${COORDINATOR_NAME}, email, department FROM ${COORDINATOR_TABLE} WHERE ${COORDINATOR_ID} = ?`)
      .bind(id)
      .first<Record<string, string>>();
    if (!current) {
      return fail(c, 404, "Coordinator not found", "coordinator-not-found");
    }

    const clash = await findCoordinatorByEmail(c.env.DB, staff.email, id);
    if (clash) {
      return fail(
        c,
        409,
        "This staff member is already a Contest Coordinator.",
        "coordinator-already-exists"
      );
    }

    const previousEmail = (current.email ?? "").toLowerCase();
    const nextEmail = staff.email.toLowerCase();
    const emailChanged = nextEmail !== previousEmail;

    /*
     * The account is found by the *old* address, because that is what the coordinator
     * signed in with before this edit, and by `auth_user_id` on the row itself when it
     * has one. The id is preferred: it cannot be ambiguous the way an address lookup can.
     */
    const account = (await env_accountByEmail(c.env.DB, previousEmail)) ??
      (current.auth_user_id ? await env_account(c.env.DB, current.auth_user_id) : null);

    if (account && emailChanged) {
      /*
       * Sign-in is by address, so a new address that already belongs to another account
       * would match two rows at login. Refused rather than merged.
       */
      const taken = await c.env.DB
        .prepare(
          "SELECT auth_user_id FROM auth_users WHERE auth_user_id <> ? AND (LOWER(user_name) = ? OR LOWER(email) = ?) LIMIT 1"
        )
        .bind(account.auth_user_id, nextEmail, nextEmail)
        .first<{ auth_user_id: string }>();
      if (taken) {
        return fail(
          c,
          409,
          `${staff.email} already belongs to another login account`,
          "auth-email-conflict"
        );
      }
    }

    const statements: D1PreparedStatement[] = [
      // `auth_user_id` is rewritten as well, so the coordinator always points at the
      // account that owns its address rather than at the one it had at appointment.
      c.env.DB
        .prepare(
          `UPDATE ${COORDINATOR_TABLE}
           SET ${COORDINATOR_NAME} = ?, email = ?, department = ?, auth_user_id = ?
           WHERE ${COORDINATOR_ID} = ?`
        )
        .bind(staff.staff_name, staff.email, staff.department, account?.auth_user_id ?? null, id),
    ];

    if (account && emailChanged) {
      const nextUserName =
        account.user_name.toLowerCase() === previousEmail ? emailUserName(staff.email) : account.user_name;
      // `pwd_hash` is absent on purpose: pointing a coordinator at a different staff
      // member never resets a password.
      statements.push(
        c.env.DB
          .prepare("UPDATE auth_users SET user_name = ?, email = ? WHERE auth_user_id = ?")
          .bind(nextUserName, staff.email, account.auth_user_id)
      );
    }

    await c.env.DB.batch(statements);

    const updated = await c.env.DB
      .prepare(
        `SELECT ${COORDINATOR_ID}, ${COORDINATOR_NAME}, email, department, created_at FROM ${COORDINATOR_TABLE} WHERE ${COORDINATOR_ID} = ?`
      )
      .bind(id)
      .first();

    return c.json({
      success: true,
      contest_coordinator: updated ?? null,
      authAccountUpdated: Boolean(account && emailChanged),
    });
  } catch (error) {
    return serverError(c, error, "Could not update that coordinator", "coordinator-update-failed");
  }
});

export default app;