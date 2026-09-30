/**
 * The initial password for a newly provisioned login account.
 *
 * This is a product rule, not a secret: every account created by the admin
 * dashboard — students and staff alike — starts with the same password, and the
 * admin has to be able to tell the person they just created how to sign in for
 * the first time. It is therefore written here in the clear, in the same way the
 * backend keeps it as `DEFAULT_INITIAL_PASSWORD` in
 * `backend/src/utils/accountProvisioning.ts`.
 *
 * The value is never sent to the server and never stored. The API hashes it with
 * bcrypt before the `auth_users` row is written, and only the bcrypt hash is
 * persisted. What crosses the wire back to the browser is this same string in the
 * import response, purely so the success message can name it.
 *
 * Kept in one file because the notice is shown by more than one screen, and a
 * second copy of the literal is how the student and staff messages drift apart.
 */
export const INITIAL_PASSWORD = '1234'

/** The same sentence, for use where a full sentence is wanted rather than a badge. */
export const INITIAL_PASSWORD_SENTENCE =
  `New accounts start with the password ${INITIAL_PASSWORD}.`
