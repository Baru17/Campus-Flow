import { useEffect, useMemo, useState } from 'react'
import { fetchAdminBatches, updateAdminStaff } from '../../api/adminApi'
import { validateStaffRows } from '../../utils/adminImport'
import { ALLOWED_SECTIONS, isAdvisorFlag } from '../../utils/sectionValidation'
import EditField from './EditField'
import EditRecordModal from './EditRecordModal'

/*
 * Editing one staff member.
 *
 * Department is editable here, unlike a student's, and the difference is the
 * storage: staff all live in one table with a department column, so moving someone
 * is a single column write. That move is also why the advisor cohort is re-checked
 * against the *new* department -- a coordinator transferred from IT to CSE must not
 * keep an IT cohort, or their attendance routes would resolve another department's
 * tables. The server refuses that; this form simply never offers it.
 *
 * `staff_id` is not editable and is shown read-only. It is the UNIQUE key the row
 * is addressed by and the alternative handle `/api/auth/staff/login` accepts, and
 * it is generated from the current maximum on create rather than typed, so there is
 * no value to change it to.
 *
 * The class-advisor fields are the same three the import asks for, under the same
 * rules: required together, and cleared entirely when the answer is No. The cohort
 * list is fetched from `GET /api/admin/batches` rather than being written down
 * here, so it is the registry's list and a cohort created in the dashboard appears
 * without a code change. The field degrades to a free-text box if that fetch fails,
 * which keeps an edit possible on a flaky network; the server is the authority
 * either way.
 */
const toForm = (member) => ({
  staff_name: member.staff_name ?? '',
  email: member.email ?? '',
  department: member.department ?? '',
  class_advisor: isAdvisorFlag(member.class_advisor) ? 'Yes' : 'No',
  advisor_batch: member.advisor_batch ?? '',
  advisor_year: member.advisor_year ?? '',
  advisor_section: member.advisor_section ?? '',
})

export default function EditStaffModal({ member, onClose, onSaved }) {
  const [form, setForm] = useState(() => toForm(member))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [departments, setDepartments] = useState([])
  const [batches, setBatches] = useState([])
  const [batchesFailed, setBatchesFailed] = useState(false)

  const setField = (key) => (value) => {
    setForm((current) => ({ ...current, [key]: value }))
    setFieldErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }

  const isAdvisor = String(form.class_advisor).toLowerCase() === 'yes'

  /*
   * Departments and cohorts, for the two pickers. Fetched without a department
   * because the department is editable here: narrowing to the stored one would
   * leave the new department with no cohorts to offer. The list comes from the
   * registry, so nothing about which cohorts exist is written into this file.
   */
  useEffect(() => {
    let cancelled = false
    fetchAdminBatches()
      .then((data) => {
        if (cancelled) return
        setDepartments(data.departments || [])
        setBatches((data.batches?.[form.department] || []).map((b) => b.key))
        setBatchesFailed(false)
      })
      .catch(() => {
        if (!cancelled) setBatchesFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [form.department])

  // The stored department is kept in the list even if the fetch failed, so the
  // picker can never lose the value the record already has.
  const departmentOptions = useMemo(() => {
    const values = new Set(departments)
    if (member.department) values.add(member.department)
    return [...values].map((value) => ({ value, label: value }))
  }, [departments, member.department])

  /*
   * The stored cohort is offered even when the registry list does not contain it.
   * That happens when the department was just changed, and a select whose value is
   * not among its options renders as blank while the state still holds the old
   * value -- so the form would look empty but submit a stale cohort. Showing it,
   * labelled, means the admin sees what is actually stored and picks a replacement
   * deliberately. The server refuses the mismatched pair either way.
   */
  const advisorBatchOptions = useMemo(() => {
    const options = ['']
    if (form.advisor_batch && !batches.includes(form.advisor_batch)) {
      options.push(form.advisor_batch)
    }
    return [...options, ...batches]
  }, [batches, form.advisor_batch])

  const check = useMemo(
    () =>
      validateStaffRows([
        {
          staff_name: form.staff_name,
          email: form.email,
          class_advisor: isAdvisor,
          advisor_batch: isAdvisor ? form.advisor_batch : '',
          advisor_year: isAdvisor && form.advisor_year !== '' ? Number(form.advisor_year) : '',
          advisor_section: isAdvisor ? form.advisor_section : '',
        },
      ]),
    [form, isAdvisor]
  )
  const clientReason = check.invalidRows[0]?.reason || null

  const handleSave = async () => {
    if (saving || !check.validRows.length) return
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      const data = await updateAdminStaff(member.staff_id, {
        staff_name: form.staff_name,
        email: form.email,
        department: form.department,
        class_advisor: isAdvisor,
        // Sent as nulls when not an advisor rather than omitted, so the server
        // clears whatever the row used to hold instead of keeping it.
        advisor_batch: isAdvisor ? form.advisor_batch : null,
        advisor_year: isAdvisor && form.advisor_year !== '' ? Number(form.advisor_year) : null,
        advisor_section: isAdvisor ? form.advisor_section : null,
      })
      onSaved(data.staff ?? null)
    } catch (err) {
      setError(err)
      const details = err?.details?.errors
      if (Array.isArray(details)) {
        setFieldErrors(
          Object.fromEntries(details.filter((e) => e.field).map((e) => [e.field, e.message]))
        )
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <EditRecordModal
      title={`Edit staff — ${member.staff_name}`}
      subtitle={`Staff ID ${member.staff_id}`}
      onClose={onClose}
      onSave={handleSave}
      saving={saving}
      error={error}
      disabled={!check.validRows.length}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <EditField
          id="edit-staff-id"
          label="Staff ID"
          value={member.staff_id ?? '—'}
          readOnly
          hint="The key of this record, and an alternative sign-in handle."
        />
        <EditField
          id="edit-staff-department"
          label="Department"
          value={form.department}
          onChange={setField('department')}
          options={departmentOptions}
          error={fieldErrors.department}
        />
        <EditField
          id="edit-staff-name"
          label="Name"
          value={form.staff_name}
          onChange={setField('staff_name')}
          placeholder="Full name"
          error={fieldErrors.staff_name}
        />
        <EditField
          id="edit-staff-email"
          label="Email"
          value={form.email}
          onChange={setField('email')}
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="staff@kiot.ac.in"
          error={fieldErrors.email}
          hint="Their sign-in address. Changing it updates the existing login; the password is not changed."
        />

        <div className="sm:col-span-2">
          <EditField
            id="edit-staff-class-advisor"
            label="Class advisor?"
            value={form.class_advisor}
            onChange={setField('class_advisor')}
            options={[
              { value: 'No', label: 'No' },
              { value: 'Yes', label: 'Yes' },
            ]}
            error={fieldErrors.class_advisor}
            hint="A class advisor is responsible for one cohort, year and section. Choosing No clears the three fields below."
          />
        </div>

        {isAdvisor && (
          <>
            <EditField
              id="edit-staff-advisor-batch"
              label="Advisor batch"
              value={form.advisor_batch}
              onChange={setField('advisor_batch')}
              options={batchesFailed ? null : advisorBatchOptions}
              error={fieldErrors.advisor_batch}
              hint={
                batchesFailed
                  ? 'The cohort list could not be loaded. Type the cohort, for example the YYYY_YYYY label.'
                  : 'The cohort this person advises, from the batch registry.'
              }
            />
            <EditField
              id="edit-staff-advisor-year"
              label="Advisor year"
              value={form.advisor_year}
              onChange={setField('advisor_year')}
              type="number"
              placeholder="1-4"
              error={fieldErrors.advisor_year}
            />
            <EditField
              id="edit-staff-advisor-section"
              label="Advisor section"
              value={form.advisor_section}
              onChange={setField('advisor_section')}
              options={['', ...ALLOWED_SECTIONS]}
              error={fieldErrors.advisor_section}
            />
          </>
        )}
      </div>

      {clientReason && !error && <p className="text-xs font-semibold text-red-600">{clientReason}</p>}
    </EditRecordModal>
  )
}
