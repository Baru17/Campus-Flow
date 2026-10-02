import { useCallback, useState } from 'react'
import { AlertIcon, CheckIcon, CompassIcon, StaffIcon, XIcon } from '../Icons'
import DropdownField from '../DropdownField'
import SearchableSelect from '../SearchableSelect'
import InitialPasswordNotice from './InitialPasswordNotice'
import { fetchAdminStaff } from '../../api/adminApi'
import { DEPARTMENTS } from '../../constants'

/*
 * Adding a contest coordinator by choosing a member of staff.
 *
 * ## Why this replaces the CSV/manual-entry dialog
 *
 * A contest coordinator is not appointed out of thin air: they are somebody already on
 * a department's staff roster. Typing their address into a free-text form meant an admin
 * could write somebody who was not staff at all, or -- the case that actually bit -- the
 * right person at an address they no longer use.
 *
 * It also meant the one appointment that is most common could not be made at all. Every
 * staff member already has an `auth_users` row with the role `staff`, and the create
 * route refused an address whose account was not already a coordinator. So appointing
 * Priya -- who is on the IT roster, which is where coordinators come from -- was
 * reported as "already used by another faculty" about Priya herself. The server now
 * reuses her existing staff account instead of refusing her; see
 * `spec.reuseStaffAccount` in `backend/src/api/admin.ts`.
 *
 * ## Department first, deliberately
 *
 * The department is chosen before the staff list is even requested. That is what makes
 * the list usable: `/api/admin/staff` is department-scoped, and the college has enough
 * staff that loading them all would be both slow and pointless. Changing the department
 * clears the selected person and reloads, so a stale selection from another department
 * can never be submitted.
 *
 * Staff are picked through `SearchableSelect` rather than a native `<select>` because
 * a department roster is long and an admin knows the person by name or by their address.
 * Both are in the option label, so either one matches.
 *
 * ## Nothing here sets an identity
 *
 * There is no name input, no email input and no department input for the coordinator.
 * They are read from the staff record and shown as a read-only summary, and the row
 * that is submitted is built from that same record. So the form cannot claim an
 * identity the staff record does not hold -- which is the mismatch the OD workflow
 * authorises against, matching `contest_coordinators.email` beside the department.
 *
 * ## The account, not a new password
 *
 * A selected staff member has a login already. Reusing it means no second `auth_users`
 * row, no reset password, and no role change -- they keep signing in exactly as they
 * did. Coordinator authority follows from the coordinator row rather than from the
 * role: `verifyApprover` matches the caller's own address against
 * `contest_coordinators`, and `/api/auth/od-approver/login` already accepts `staff`.
 *
 * So the initial-password notice is shown *only* when the response says an account was
 * created, which is the case of a roster row that never had one. Telling an admin to
 * hand out a password for an account that was not created would be wrong.
 */
export default function AddContestCoordinatorModal({
  title = 'Add Contest Coordinator',
  submitLabel = 'Add Coordinator',
  onSubmit,
  onClose,
  onAdded,
}) {
  const [department, setDepartment] = useState('')
  const [staff, setStaff] = useState([])
  const [staffId, setStaffId] = useState('')
  const [loadingStaff, setLoadingStaff] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [result, setResult] = useState(null)

  const loadStaff = useCallback(async (forDepartment) => {
    if (!forDepartment) {
      setStaff([])
      return
    }
    setLoadingStaff(true)
    try {
      // The existing department-scoped staff endpoint, reused rather than duplicated: it
      // already filters by department, already returns the four columns this form needs,
      // and it sits behind requireAuth + requireAdmin like every other admin route.
      const data = await fetchAdminStaff(forDepartment)
      setStaff(data.staff || [])
    } catch (err) {
      setSubmitError(err)
      setStaff([])
    } finally {
      setLoadingStaff(false)
    }
  }, [])

  /*
   * Changing department reloads the list *and* clears the person.
   *
   * Clearing is not cosmetic. Keeping the old selection would put a member of another
   * department in the read-only summary while the heading still said IT, and the admin
   * would be looking at a form that claims one department and submits another.
   */
  const handleDepartmentChange = (next) => {
    setDepartment(next)
    setStaffId('')
    setSubmitError(null)
    setResult(null)
    loadStaff(next)
  }

  const selected = staff.find((person) => String(person.staff_id) === staffId) || null

  const handleSubmit = async () => {
    if (!department || !selected) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      // Built from the staff record, not from the form. One row, through the same
      // `rows` contract every other directory import uses, so the API is unchanged.
      const data = await onSubmit([
        {
          coordinator_name: selected.staff_name,
          email: selected.email,
          department: selected.department || department,
        },
      ])
      setResult(data)
    } catch (err) {
      setSubmitError(err)
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = Boolean(department && selected) && !submitting
  const added = (result?.created || 0) > 0
  const reused = result?.authAccountsReused || 0

  /*
   * Why `created === 0` needs to be explained rather than reported as one thing.
   *
   * Zero rows written is not one condition, it is four, and only one of them is
   * "they are already a coordinator":
   *
   *   - `skipped` -- the address was already in `contest_coordinators`. The genuine
   *     duplicate, and the only case the word "already" fits.
   *   - `roleMismatches` -- the address holds an `auth_users` row of another role,
   *     which is the refusal described at the top of this file. The coordinator row
   *     was *not* written, so calling this "already a coordinator" states the
   *     opposite of what happened and leaves the admin with nothing to act on.
   *   - `invalid` / `duplicates` -- the row never got far enough to be considered.
   *
   * So the reason is chosen here, in order of how much it explains, and rendered
   * as text. A server that refuses must be able to say why, or the message is worse
   * than no message at all.
   */
  const notAddedReason = (() => {
    if (!result) return null
    if ((result.roleMismatches || []).length > 0) {
      const reasons = result.roleMismatches
        .map((mismatch) => mismatch.reason)
        .filter(Boolean)
        .join(' ')
      return {
        heading: 'The account could not be reused',
        body: reasons
          ? `${reasons}. No coordinator was added.`
          : 'This address already holds a login account with a different role, so it ' +
            'cannot also be a coordinator login. No coordinator was added.',
      }
    }
    if ((result.invalid || []).length > 0) {
      const messages = result.invalid
        .flatMap((entry) => (entry.errors || []).map((e) => e.message))
        .filter(Boolean)
      return {
        heading: 'That row was rejected',
        body: `${messages.join(' ') || 'The row did not pass validation.'} No coordinator was added.`,
      }
    }
    if ((result.duplicates || []).length > 0) {
      return {
        heading: 'Nothing to add',
        body: 'The same address was submitted more than once in this request, so there ' +
          'was nothing new to add.',
      }
    }
    if ((result.skipped || 0) > 0) {
      return {
        heading: 'Already a coordinator',
        body: `${selected?.email} is already a contest coordinator, so nothing was changed.`,
      }
    }
    return {
      heading: 'Nothing was added',
      body: 'The request produced no coordinator row and the server gave no reason. ' +
        'Nothing was changed.',
    }
  })()

  const staffOptions = staff.map((person) => ({
    value: String(person.staff_id),
    label: `${person.staff_name} — ${person.email}`,
  }))

  const staffPlaceholder = !department
    ? 'Choose a department first'
    : loadingStaff
      ? 'Loading staff…'
      : staff.length === 0
        ? `No ${department} staff to choose from`
        : `Select ${department} staff`

  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="admin-modal max-w-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">{title}</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Choose a department, then choose someone from that department.
            </p>
          </div>
          <button type="button" onClick={onClose} className="admin-modal-close" aria-label="Close">
            <XIcon size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {!result && (
            <>
              <p className="text-sm text-slate-600">
                A contest coordinator is an existing member of staff. Their name, email and
                department come from the staff record, so they cannot be typed here and
                cannot disagree with it.
              </p>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <DropdownField
                  label="Department"
                  name="coordinator-department"
                  value={department}
                  onChange={handleDepartmentChange}
                  options={DEPARTMENTS}
                  placeholder="Select department"
                  icon={<CompassIcon size={14} />}
                />

                {/*
                  Only meaningful once a department is chosen, so it is disabled until
                  then rather than showing an empty list that would look like a bug.
                */}
                <SearchableSelect
                  label="Staff Member"
                  name="coordinator-staff"
                  value={staffId}
                  onChange={(option) => setStaffId(option.value)}
                  options={staffOptions}
                  disabled={!department || loadingStaff || staff.length === 0}
                  loading={loadingStaff}
                  loadingText="Loading staff…"
                  placeholder={staffPlaceholder}
                  searchPlaceholder="Search by name or email…"
                  emptyText={`No ${department} staff match that search.`}
                  icon={<StaffIcon size={14} />}
                />
              </div>

              {department && !loadingStaff && staff.length === 0 && !submitError && (
                <p className="text-sm text-slate-500">
                  There are no {department} staff members to choose from. Add the person to the{' '}
                  {department} staff list first, then appoint them here.
                </p>
              )}

              {/*
                The read-only summary. Rendered from the staff record, as text, with no
                inputs anywhere -- so there is nothing on this form that can set a
                coordinator's identity, and nothing to be inconsistent with the database.
              */}
              {selected && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500">
                    <StaffIcon size={13} />
                    Selected staff
                  </p>
                  <dl className="space-y-1.5 text-sm">
                    <ReadOnlyRow label="Name" value={selected.staff_name} />
                    <ReadOnlyRow label="Email" value={selected.email} />
                    <ReadOnlyRow label="Department" value={selected.department} />
                    <ReadOnlyRow label="Staff ID" value={selected.staff_id} mono />
                  </dl>
                  <p className="mt-2 text-xs text-slate-500">
                    These come from the staff record and cannot be edited here.
                  </p>
                </div>
              )}
            </>
          )}

          {result && (
            <div
              role="status"
              className={`rounded-xl border px-4 py-3 text-sm ${
                added
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              <div className="flex items-center gap-2 font-bold">
                {added ? <CheckIcon size={16} /> : <AlertIcon size={16} />}
                {added ? 'Coordinator added' : notAddedReason?.heading || 'Nothing was added'}
              </div>

              {added ? (
                <>
                  <p className="mt-1">
                    <span className="font-semibold">{selected?.staff_name}</span> (
                    {selected?.email}) is now the {selected?.department} contest coordinator.
                  </p>

                  {/*
                    The distinction an admin actually needs. A reused account means there
                    is no new password to hand out -- they keep the staff login they
                    already have, and their OD approvals follow from this coordinator row.
                  */}
                  <p className="mt-2 text-xs">
                    {reused > 0 ? (
                      <>
                        Their existing staff login was kept, so nothing changed about how they
                        sign in and no new password was created. They will receive contest
                        coordinator approvals alongside their staff duties.
                      </>
                    ) : (
                      <>
                        A coordinator login was created for them. They will receive contest
                        coordinator approvals from now on.
                      </>
                    )}
                  </p>
                </>
              ) : (
                <p className="mt-1">{notAddedReason?.body}</p>
              )}

              {/* Only when an account was actually created. */}
              {added && (result.authAccountsCreated || 0) > 0 && (
                <InitialPasswordNotice
                  password={result.defaultPassword}
                  tone="success"
                  className="mt-3"
                />
              )}
            </div>
          )}

          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              {submitError.message}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-4">
          {result ? (
            <button
              type="button"
              onClick={() => {
                onClose()
                if (onAdded) onAdded(result)
              }}
              className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
            >
              Done
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} className="btn-cf-outline px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                {submitting && <span className="cf-spinner" role="status" aria-hidden="true" />}
                {submitting ? 'Adding…' : submitLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** One summary line. A `dt`/`dd` pair, so it reads as data rather than as a field. */
function ReadOnlyRow({ label, value, mono }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 font-semibold text-slate-500">{label}</dt>
      <dd className={`min-w-0 break-words text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  )
}