/**
 * Account creation for provisioned students and staff.
 *
 * The student tables and `auth_users` are linked by `auth_user_id`, and login
 * walks from the authenticated account out to the roster row through that link.
 * A roster row with no account is therefore an account that can never log in, so
 * provisioning has to create both halves or neither.
 *
 * This module owns that step so the student, staff and subject handlers cannot
 * each invent their own version. Two decisions are worth stating explicitly:
 *
 *   1. The default password is hashed with the same `bcryptjs` and the same cost
 *      the login handler verifies against. A hash written by anything else would
 *      not verify, and the student would appear provisioned but be unable to log
 *      in.
 *   2. The plaintext default is never returned by the API and never logged. The
 *      admin is told once, in the response, that accounts were created with the
 *      documented default; the per-account password is never echoed.
 *
 * `auth_user_id` is a UUID rather than a counter: the login and password-reset
 * code both treat it as an opaque identifier and never parse it, and generating
 * it here keeps the database from having to hand out a sequence.
 */

import bcrypt from "bcryptjs";

/**
 * The documented initial password for a newly provisioned account.
 *
 * Exported so the admin response and the tests can refer to one value. It is a
 * constant because it is a product decision, not a per-run secret.
 */
export const DEFAULT_INITIAL_PASSWORD = "1234";

/**
 * bcrypt work factor, matching the one the existing hashes were produced with.
 * Raising it here without re-hashing existing accounts would not change what
 * verifies, so it is deliberately the current value rather than a new one.
 */
const BCRYPT_ROUNDS = 10;

/**
 * The roles this application issues for an account it provisions.
 *
 * `hod` and `contest_coordinator` join the three that already existed. They are
 * deliberately *not* folded into `staff` or `class_advisor`: those two are the
 * roles `/api/auth/staff/login` and `requireStaff` authorise on, so widening
 * either would silently grant a head of department the staff dashboard, the
 * subject catalog and the attendance generator. Their accounts exist so they can
 * be identified at sign-in; what they are allowed to do is decided by the workflow
 * that needs them, and until then they hold no permissions at all.
 *
 * Nothing enforces membership of this union at runtime -- `auth_users.role` is
 * plain TEXT -- but it is the set the provisioning code is allowed to write, so a
 * typo becomes a type error rather than a row nobody can ever be granted access.
 */
export type ProvisionedRole =
  | "student"
  | "staff"
  | "class_advisor"
  | "hod"
  | "contest_coordinator";

export interface AccountPlan {
  auth_user_id: string;
  user_name: string;
  role: ProvisionedRole;
  pwdHash: string;
  email: string;
}

export interface ExistingAccount {
  auth_user_id: string;
  user_name: string;
  role: string;
  email: string | null;
}

/** Generates the opaque identifier linking an account to its roster row. */
export function newAuthUserId(): string {
  return crypto.randomUUID();
}

/**
 * The login lookup is `WHERE user_name = ? OR email = ?`, and the student handler
 * upper-cases a non-email identifier before querying. Account names are therefore
 * created upper-case so that a student typing `2k24it001` still matches.
 */
export function studentUserName(studentId: string): string {
  return studentId.trim().toUpperCase();
}

export function staffUserName(email: string): string {
  return emailUserName(email);
}

/**
 * The account name for anyone who signs in with an email address.
 *
 * A staff member, a head of department and a contest coordinator all sign in with
 * their address and nothing else, so all three get the same treatment: the
 * lower-cased address as `user_name`.
 *
 * Lower-casing matters because `/api/auth/login` looks an account up with
 * `WHERE user_name = ? OR email = ?` and upper-cases the identifier it was given
 * unless it contains an `@`, in which case it lower-cases it. Storing the address
 * lower-cased is what makes the two paths agree.
 */
export function emailUserName(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashDefaultPassword(): Promise<string> {
  return bcrypt.hash(DEFAULT_INITIAL_PASSWORD, BCRYPT_ROUNDS);
}

/** Verifies the default password against a hash, for tests and re-provisioning. */
export function verifyDefaultPassword(pwdHash: string): Promise<boolean> {
  return bcrypt.compare(DEFAULT_INITIAL_PASSWORD, pwdHash);
}

export interface PlanAccountsResult {
  plans: AccountPlan[];
  /** Accounts that already exist and are reused rather than recreated. */
  reused: number;
}

/**
 * Decides, for each row, whether to create an account or attach to one that
 * already exists.
 *
 * Reuse matters for the two flows the dashboard has to survive: re-uploading the
 * same file, and adding a lateral-entry student to a cohort that already has
 * accounts. In both cases the `auth_users` row is found by identifier or email and
 * linked to the new roster row instead of being created a second time, which
 * would otherwise fail the UNIQUE constraint on `user_name` and leave the student
 * half-provisioned.
 *
 * `existing` is the caller's already-queried view of `auth_users`, keyed by
 * lower-cased identifier and by email, so this stays a pure function and the
 * caller keeps control of the query.
 */
export function planAccounts(
  rows: { key: string; email: string; role: ProvisionedRole }[],
  existing: { byKey: Map<string, ExistingAccount>; byEmail: Map<string, ExistingAccount> },
  pwdHash: string
): PlanAccountsResult {
  const plans: AccountPlan[] = [];
  let reused = 0;

  for (const row of rows) {
    const byKey = existing.byKey.get(row.key.toLowerCase());
    const byEmail = existing.byEmail.get(row.email.toLowerCase());
    const found = byKey ?? byEmail;

    if (found) {
      reused += 1;
      plans.push({
        // The existing id is what the roster row must point at, so the student can
        // already log in with the account they had. No hash is produced: the row
        // already exists, and importing a roster never resets an existing
        // account's password.
        auth_user_id: found.auth_user_id,
        user_name: found.user_name,
        role: row.role,
        pwdHash: "",
        email: found.email ?? row.email,
      });
      continue;
    }

    plans.push({
      auth_user_id: newAuthUserId(),
      user_name: row.key,
      role: row.role,
      pwdHash,
      email: row.email,
    });
  }

  return { plans, reused };
}
