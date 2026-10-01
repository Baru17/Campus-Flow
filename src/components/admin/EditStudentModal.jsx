import { useMemo, useState } from 'react'
import { updateAdminStudent } from '../../api/adminApi'
import { validateStudentRows } from '../../utils/adminImport'
import { ALLOWED_SECTIONS } from '../../utils/sectionValidation'
import EditField from './EditField'
import EditRecordModal from './EditRecordModal'

/*
 * Editing one student.
 *
 * Four fields are editable: name, year, section and email. The rest of the record
 * is fixed, and every fixed field is shown read-only so the admin can see it
 * rather than wonder where it went:
 *
 *   - `student_id` is the key the row is addressed by, and the login name the
 *     account was created under. Renaming it would mean a new account, which is
 *     not what an edit is.
 *   - `register_no` is what attendance is filed under. Every mark recorded for
 *     this cohort, and every advisor report built from it, carries this number, so
 *     changing it would strand that history against a roster that no longer has it.
 *     Re-enrolling under a new number is a deliberate act, not a correction.
 *   - department and batch are not columns on the row. They decide which physical
 *     table the student lives in, and moving a student between cohorts is a
 *     delete-and-reimport, not a field edit.
 *
 * Read-only here is presentation only. `updateAdminStudent` does not send
 * `student_id` or `register_no` at all, and the server refuses either one anyway,
 * so disabling an input is never what makes them immutable.
 *
 * The same validators the import path uses decide whether the form can be saved,
 * so a hand-typed correction is held to exactly the standard a spreadsheet row is:
 * sections from the shared A-D list, a whole year from 1 to 4, a real address, and
 * a required name and email. The register number is passed to that validator from
 * the stored record, since the whole roster row has to be valid for the editable
 * half to be saved. Those checks are a convenience, not the authority -- the server
 * re-validates and its per-field errors are mapped back onto the inputs, so the two
 * ends of this form cannot disagree.
 */
const toForm = (student) => ({
  student_name: student.student_name ?? '',
  year: student.year ?? '',
  section: student.section ?? ALLOWED_SECTIONS[0],
  email: student.email ?? '',
})

/*
 * The import validator is given every column it expects, including the two that
 * cannot be edited, because it validates a spreadsheet *row*. Neither is being
 * judged as a change here -- the stored values are what is stored -- so passing
 * them through unchanged is honest: the validator sees a complete, valid row.
 */
const toValidatedRow = (form, student) => ({
  student_id: student.student_id,
  register_no: student.register_no,
  student_name: form.student_name,
  year: form.year === '' ? '' : Number(form.year),
  section: form.section,
  email: form.email,
})

export default function EditStudentModal({ student, department, batch, onClose, onSaved }) {
  const [form, setForm] = useState(() => toForm(student))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  const setField = (key) => (value) => {
    setForm((current) => ({ ...current, [key]: value }))
    // Clear a field's error as soon as it is touched, so a stale message never
    // contradicts what is on screen.
    setFieldErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }

  const check = useMemo(
    () => validateStudentRows([toValidatedRow(form, student)]),
    [form, student]
  )
  const clientReason = check.invalidRows[0]?.reason || null

  const handleSave = async () => {
    if (saving || !check.validRows.length) return
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      /*
       * Only the four editable fields are sent. `student_id` is the path segment
       * and `register_no` is not sent at all, so the request has no way to express
       * a change to either -- and the server refuses one regardless.
       */
      const data = await updateAdminStudent(student.student_id, {
        department,
        batch,
        student_name: form.student_name,
        year: Number(form.year),
        section: form.section,
        email: form.email,
      })
      onSaved(data.student ?? null)
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
      title={`Edit student — ${student.student_id}`}
      subtitle={`${department} ${batch}`}
      onClose={onClose}
      onSave={handleSave}
      saving={saving}
      error={error}
      disabled={!check.validRows.length}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <EditField
          id="edit-student-id"
          label="Student ID"
          value={student.student_id}
          readOnly
          hint="The identity of this record. The login name and the roster key."
        />
        <EditField
          id="edit-student-cohort"
          label="Department and batch"
          value={`${department} · ${batch}`}
          readOnly
          hint="Decides which student table this row lives in."
        />
        <EditField
          id="edit-student-name"
          label="Name"
          value={form.student_name}
          onChange={setField('student_name')}
          placeholder="Full name"
          error={fieldErrors.student_name}
        />
        <EditField
          id="edit-student-register-no"
          label="Register No"
          value={student.register_no}
          readOnly
          hint="Attendance is recorded against this number, so it is fixed. Re-enrolling under a new number is a separate task."
          error={fieldErrors.register_no}
        />
        <EditField
          id="edit-student-year"
          label="Year"
          value={form.year}
          onChange={setField('year')}
          type="number"
          placeholder="1-4"
          error={fieldErrors.year}
        />
        <EditField
          id="edit-student-section"
          label="Section"
          value={form.section}
          onChange={setField('section')}
          options={ALLOWED_SECTIONS}
          error={fieldErrors.section}
        />
        <div className="sm:col-span-2">
          <EditField
            id="edit-student-email"
            label="Email"
            value={form.email}
            onChange={setField('email')}
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="student@kiot.ac.in"
            error={fieldErrors.email}
            hint="Also the student's sign-in address. Changing it moves their login email; their password is not changed."
          />
        </div>
      </div>

      {/*
        Shown only while the form is the thing that is wrong. Once the server has
        answered, its message is in the alert above and repeating the reason here
        would just be the same sentence twice.
      */}
      {clientReason && !error && <p className="text-xs font-semibold text-red-600">{clientReason}</p>}

      <p className="text-xs text-slate-500">
        Attendance already recorded for this student is not changed by an edit.
      </p>
    </EditRecordModal>
  )
}
