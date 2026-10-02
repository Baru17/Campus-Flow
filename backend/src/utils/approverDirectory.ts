/**
 * Which directory a signed-in account belongs to.
 *
 * ## Why this exists
 *
 * `auth_users.role` holds exactly one value, and a contest coordinator's account holds
 * `staff` -- correctly, because a coordinator is appointed out of a department's staff
 * roster and reuses that person's existing staff login. Renaming the account's role to
 * `contest_coordinator` would take their mentor and attendance access away, and minting a
 * second account for them would mean two passwords for one person, so neither is done.
 *
 * The consequence is that the role on the account cannot answer "which dashboard does this
 * person belong in?", because a coordinator's account says `staff`. What answers it is
 * directory membership: if there is a `contest_coordinators` row for this account then
 * they are a coordinator, whatever their account role says, and they are *also* a member
 * of staff. Those are not competing facts.
 *
 * So this module answers "which of the three directories holds a row for this account",
 * in a fixed precedence, and both approver routes ask it the same way rather than each
 * re-deriving the answer from the role string.
 *
 * ## Precedence
 *
 * `hod`, then `contest_coordinator`, then the staff roster, most specific first.
 *
 * It is fixed rather than "first row found" so that a person who happens to hold more than
 * one directory row always lands on the same dashboard, and so that the two routes cannot
 * disagree with each other. An HOD or a coordinator who is also on the staff roster keeps
 * their staff dashboard at `/staff/login` -- that route authorises on the account role,
 * which this module never touches -- and reaches the approver dashboard through the
 * approver door, which is where the coordinator queue lives.
 */

import type { ProvisionedRole } from "./accountProvisioning";

/** The three directories an OD approver can be recorded in. */
export type DirectoryTable = "staff" | "contest_coordinators" | "hods";

/** The roles the approver routes recognise, spelled the way `auth_users.role` spells them. */
export type ApproverRole = Extract<ProvisionedRole, "staff" | "class_advisor" | "contest_coordinator" | "hod">;

export interface ApproverIdentity {
  /** The role this person acts as *in the approver flow*, which is not always their account role. */
  role: ApproverRole;
  /** Directory display name: `staff_name`, `coordinator_name` or `hod_name`. */
  name: string;
  /** The department the OD queue is scoped to. Null only for a staff row that has none. */
  department: string | null;
  table: DirectoryTable;
}

/**
 * The directories to consult, in precedence order.
 *
 * `table` and `nameColumn` are literals from this file, never anything a request
 * supplied, so neither can reach the SQL as a client-controlled value. `staffRole` is the
 * role to report for a staff row, decided in SQL by the `class_advisor` flag rather than
 * read back and branched on here.
 */
const DIRECTORIES: readonly {
  table: DirectoryTable;
  nameColumn: string;
  /** Fixed role, or null when it depends on the row. */
  role: ApproverRole | null;
}[] = [
  { table: "hods", nameColumn: "hod_name", role: "hod" },
  { table: "contest_coordinators", nameColumn: "coordinator_name", role: "contest_coordinator" },
  { table: "staff", nameColumn: "staff_name", role: null },
];

/**
 * Resolves a session to the directory row it belongs to, or null when it belongs to none.
 *
 * The account is identified by `auth_user_id` throughout -- never by an address from the
 * browser -- so this cannot be pointed at somebody else's row.
 *
 * `staff` is handled by its own statement rather than by the loop, because its role
 * depends on the row: a member of staff mapped to a class is a `class_advisor`, which the
 * class-advisor endpoints authorise on, and one who is not is a `staff`.
 */
export async function resolveApproverIdentity(
  db: D1Database,
  authUserId: string
): Promise<ApproverIdentity | null> {
  for (const directory of DIRECTORIES) {
    if (directory.table === "staff") {
      const staff = await db
        .prepare(
          `SELECT staff_name, department,
                  CASE WHEN class_advisor = 'Y' THEN 'class_advisor' ELSE 'staff' END AS role
           FROM staff
           WHERE auth_user_id = ?
           LIMIT 1`
        )
        .bind(authUserId)
        .first<{ staff_name: string; department: string | null; role: ApproverRole }>();
      if (staff) {
        return {
          role: staff.role,
          name: staff.staff_name,
          department: staff.department,
          table: "staff",
        };
      }
      continue;
    }

    const row = await db
      .prepare(
        `SELECT ${directory.nameColumn} AS name, department
         FROM ${directory.table}
         WHERE auth_user_id = ?
         LIMIT 1`
      )
      .bind(authUserId)
      .first<{ name: string; department: string | null }>();
    if (row) {
      return {
        role: directory.role as ApproverRole,
        name: row.name,
        department: row.department,
        table: directory.table,
      };
    }
  }

  return null;
}

/**
 * Whether a stored account role is one the approver flow accepts.
 *
 * A gate on the *account*, not on the directory: a student or an admin must not be able to
 * mint an approver session even if a directory row somehow carries their `auth_user_id`.
 * The role string is normalised exactly as `requireRole` in `middleware/auth.ts`
 * normalises it, so the two cannot disagree about what "Class Advisor" means.
 */
export function normalizeRole(role: unknown): string {
  return String(role ?? "")
    .trim()
    .toLowerCase()
    .replace(/[ -]+/g, "_");
}

export const APPROVER_ROLES: readonly string[] = [
  "staff",
  "class_advisor",
  "contest_coordinator",
  "hod",
];

export function isApproverRole(role: unknown): boolean {
  return APPROVER_ROLES.includes(normalizeRole(role));
}