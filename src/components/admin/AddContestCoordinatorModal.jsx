import { useCallback, useState } from 'react'
import { XIcon, CheckIcon, AlertIcon, StaffIcon, CompassIcon } from '../Icons'
import DropdownField from '../DropdownField'
import InitialPasswordNotice from './InitialPasswordNotice'
import { fetchAdminStaff } from '../../api/adminApi'
import { DEPARTMENTS } from '../../constants'

/*
 * Adding a contest coordinator by choosing a member of staff.
 *
 * ## Why this replaces the CSV/manual-entry dialog
 *
 * A contest coordinator is not appointed out of thin air: they are somebody already on
 * a department's staff roster. The old dialog let an admin type a name, an address and
 * a department freely, which meant the coordinator record could name somebody who was
 * not staff, or -- worse -- the right person at an address they no longer use.
 *
 * That matters more than it looks. The OD workflow authorises a coordinator on
 * `contest_coordinators.email` AND the department beside it, so a coordinator row whose
 * address disagrees with the staff record is a person who silently never receives the
 * approvals they are meant to decide.
 *
 * So the only input here is *which staff member*. Their name, address and department
 * are read from the staff record and shown as a read-only summary, and the browser
 * sends `staff_id` and nothing else. The server re-reads the same staff row and derives
 * the same three values, so the form cannot assert an identity the database would not
 * agree with.
 *
 * ## Department first, deliberately
 *
 * The department is chosen before the staff list is even requested. That is what makes
 * the list usable: `/api/admin/staff` is department-scoped and the college has enough
 * staff that loading them all would be both slow and pointless. Changing the department
 * clears the selected person and reloads, so a stale selection from another department
 * can never be submitted -- and the server refuses a `department` that disagrees with
 * the staff row anyway, so a mismatch cannot get through even if the form were bypassed.
 *
 * ## Nothing here is editable
 *
 * There is no name input, no email input and no department input for the coordinator.
 * They are rendered as text inside a `dl`, so there is no field to focus and no value to
 * change. That is the whole point: there is no control that could set an identity the
 * staff record does not hold.
 */
export default function AddContestCoordinatorModal({
  title = 'Add Contest Coordinator',
  submitLabel = 'Add Coordinator',
  /** Present when re-pointing an existing coordinator at a different staff member. */
  record = null,
  onSubmit,
  onClose,
  onSaved,
}) {
  const [department, setDepartment] = useState('')
  const [staff, setStaff] = useState([])
  const [staffId, setStaffId] = useState('')
  const [loadingStaff, setLoadingStaff] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const loadStaff = useCallback(async (forDepartment) => {
    if (!forDepartment) {
      setStaff([])
      return
    }
    setLoadingStaff(true)
    try {
      // The existing department-scoped staff endpoint. Reused rather than duplicated:
      // it already filters by department and already returns only the columns this form
      // needs, and it is behind requireAuth + requireAdmin like every other admin route.
      const data = await fetchAdminStaff(forDepartment)
      setStaff(data.staff || [])
    } catch (err) {
      setError(err.message)
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
    setError(null)
    setResult(null)
    loadStaff(next)
  }

  const selected = staff.find((person) => person.staff_id === staffId) || null

  const handleSubmit = async () => {
    if (!department || !selected) return
    setSubmitting(true)
    setError(null)
    try {
      const data = await onSubmit({
        staff_id: selected.staff_id,
        // Advisory only, and checked by the server against the staff record. It is sent
        // so a stale dropdown is caught rather than silently corrected.
        department,
      })
      setResult(data)
    } catch (err) {
      setError(err)
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = Boolean(department && selected) && !submitting

  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="admin-modal max-w-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">{title}</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {record
                ? 'Point this coordinator at a different member of staff.'
                : 'Choose a department, then choose someone from that department.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="admin-modal-close" aria-label="Close">
            <XIcon size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {!result && (
            <>
              {!record && <InitialPasswordNotice />}

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

                {/* Only meaningful once a department is chosen, so disabled until then. */}
                <DropdownField
                  label="Staff Member"
                  name="coordinator-staff"
                  value={staffId}
                  onChange={setStaffId}
                  disabled={!department || loadingStaff || staff.length === 0}
                  placeholder={
                    !department
                      ? 'Select a department first'
                      : loadingStaff
                        ? 'Loading staff…'
                        : staff.length === 0
                          ? `No ${department} staff found`
                          : `Select ${department} staff`
                  }
                  options={staff.map((person) => ({
                    value: person.staff_id,
                    label: `${person.staff_id} — ${person.staff_name} — ${person.email}`,
                  }))}
                  icon={<StaffIcon size={14} />}
                />
              </div>

              {department && !loadingStaff && staff.length === 0 && (
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
                    Selected Staff
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

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
                >
                  <AlertIcon size={16} className="mt-0.5 shrink-0" />
                  {error.message}
                </div>
              )}
            </>
          )}

          {result && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <div className="flex items-center gap-2 font-bold">
                <CheckIcon size={16} />
                {record ? 'Coordinator updated' : 'Coordinator added'}
              </div>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex gap-2">
                  <dt className="font-semibold">Name:</dt>
                  <dd>{result.coordinator?.coordinator_name}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-semibold">Email:</dt>
                  <dd>{result.coordinator?.email}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-semibold">Department:</dt>
                  <dd>{result.coordinator?.department}</dd>
                </div>
                {result.authAccountsCreated > 0 && (
                  <div className="flex gap-2">
                    <dt className="font-semibold">Login accounts created:</dt>
                    <dd>{result.authAccountsCreated}</dd>
                  </div>
                )}
              </dl>

              {result.authAccountsCreated > 0 && (
                <InitialPasswordNotice
                  password={result.defaultPassword}
                  tone="success"
                  className="mt-3"
                />
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-4">
          {result ? (
            <button
              type="button"
              onClick={() => {
                onClose()
                if (onSaved) onSaved(result)
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
                {submitting ? 'Saving…' : submitLabel}
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