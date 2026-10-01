import { useMemo, useState } from 'react'
import { updateAdminSubject } from '../../api/adminApi'
import { validateSubjectRows } from '../../utils/adminImport'
import EditField from './EditField'
import EditRecordModal from './EditRecordModal'

/*
 * Editing one catalog subject.
 *
 * A subject is a code and a name, shared by every department and cohort, so those
 * are the only two fields and there is no department, batch, year or section to
 * offer. Those columns existed and were removed precisely because a subject must
 * never decide which attendance table a mark lands in; a subject editor that grew
 * them back would re-couple one catalog row to a cohort.
 *
 * `subject_id` is not editable, and unlike a cohort move there is nowhere to move
 * it to: it is the primary key, generated on insert. It is shown read-only so the
 * admin can see which row they are changing.
 *
 * Note what renaming does not do: attendance sessions record the code and name as
 * they were when the session was generated, so past sessions still read correctly
 * and no historical mark is rewritten.
 */
export default function EditSubjectModal({ subject, onClose, onSaved }) {
  const [form, setForm] = useState({
    subject_code: subject.subject_code ?? '',
    subject_name: subject.subject_name ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  const setField = (key) => (value) => {
    setForm((current) => ({ ...current, [key]: value }))
    setFieldErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }

  // The import validator, applied to this one row, so an edit and an uploaded
  // subject are held to one standard. The server re-checks both, and adds the
  // "this code is already taken" rule that only the database can answer.
  const check = useMemo(() => validateSubjectRows([form]), [form])
  const clientReason = check.invalidRows[0]?.reason || null

  const handleSave = async () => {
    if (saving || !check.validRows.length) return
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      const data = await updateAdminSubject(subject.subject_id, {
        subject_code: form.subject_code,
        subject_name: form.subject_name,
      })
      onSaved(data.subject ?? null)
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
      title="Edit subject"
      subtitle="The shared catalog, used by every department and cohort."
      onClose={onClose}
      onSave={handleSave}
      saving={saving}
      error={error}
      disabled={!check.validRows.length}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <EditField
          id="edit-subject-id"
          label="Subject ID"
          value={subject.subject_id ?? '—'}
          readOnly
          hint="The key of this catalog row."
        />
        <EditField
          id="edit-subject-code"
          label="Subject code"
          value={form.subject_code}
          onChange={setField('subject_code')}
          placeholder="CS3451"
          error={fieldErrors.subject_code}
          hint="Upper case, and unique across the catalog."
        />
        <div className="sm:col-span-2">
          <EditField
            id="edit-subject-name"
            label="Subject name"
            value={form.subject_name}
            onChange={setField('subject_name')}
            placeholder="Database Management Systems"
            error={fieldErrors.subject_name}
          />
        </div>
      </div>

      {clientReason && !error && <p className="text-xs font-semibold text-red-600">{clientReason}</p>}

      <p className="text-xs text-slate-500">
        Attendance already recorded keeps the code and name it was taken with, so renaming does not
        rewrite history.
      </p>
    </EditRecordModal>
  )
}
