import { useMemo, useState } from 'react'
import { DEPARTMENTS } from '../../constants'
import EditField from './EditField'
import EditRecordModal from './EditRecordModal'

/*
 * Editing one directory entry: a head of department, or a contest coordinator.
 *
 * Built on `EditRecordModal` and `EditField`, the same frame and the same field
 * component the student, staff and subject edit dialogs use, so the save
 * behaviour, the double-submit guard and the "keep the dialog open on failure"
 * rule are the ones those dialogs already have.
 *
 * Three fields are editable: the name, the address and the department. The id is
 * not, and is shown read-only for the same reason it is read-only everywhere else
 * in the admin dashboard -- it is the key the row is addressed by, it is the
 * table's autoincrement primary key, and no edit form gets to set one. It is also
 * absent from the request body, so there is no way to express an id change even by
 * accident.
 *
 * The address is the one editable field with a consequence outside this table. It
 * is also the sign-in handle: an account created for a directory entry signs in
 * with the address and nothing else. So changing it moves the existing account's
 * handle with it, keeping the same account and the same password, rather than
 * creating a second account for the new address and orphaning the old one. The
 * hint says so, because an admin editing an address should know that the person
 * signs in with the new one.
 *
 * The department list is the shared `DEPARTMENTS` constant rather than a local one,
 * and the server validates it against the same list it builds table names from, so
 * the picker cannot offer a department the API would refuse.
 */
export default function EditDirectoryRecordModal({
  record,
  idField,
  nameField,
  idLabel,
  nameLabel,
  title,
  /** Key the API returns the saved record under, e.g. `hod`. */
  responseKey,
  onSubmit,
  onClose,
  onSaved,
}) {
  const toForm = (value) => ({
    [nameField]: value?.[nameField] ?? '',
    email: value?.email ?? '',
    department: value?.department ?? '',
  })

  const [form, setForm] = useState(() => toForm(record))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  const setField = (key) => (value) => {
    setForm((current) => ({ ...current, [key]: value }))
    setFieldErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }

  /*
   * The same three checks the upload path applies, run against this one record so
   * Save is disabled while the form is invalid rather than failing on save. The
   * server re-checks all of it; this only decides whether the button is live.
   */
  const check = useMemo(() => {
    const name = form[nameField].trim()
    const email = form.email.trim()
    const department = form.department.trim().toUpperCase()

    const errors = []
    if (!name) errors.push({ field: nameField, message: `${nameLabel} is required` })
    else if (name.length > 120)
      errors.push({ field: nameField, message: `${nameLabel} must be 120 characters or fewer` })
    if (!email || !email.includes('@'))
      errors.push({ field: 'email', message: 'Enter a valid email address' })
    if (!department)
      errors.push({ field: 'department', message: 'Department is required' })
    else if (!DEPARTMENTS.includes(department))
      errors.push({
        field: 'department',
        message: `Department must be one of ${DEPARTMENTS.join(', ')}`,
      })

    return { valid: errors.length === 0, errors, reason: errors[0]?.message || null }
  }, [form, nameField, nameLabel])

  const handleSave = async () => {
    if (saving || !check.valid) return
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      const data = await onSubmit(record[idField], {
        [nameField]: form[nameField].trim(),
        email: form.email.trim(),
        department: form.department.trim().toUpperCase(),
      })
      // Read the saved record out of the response rather than handing back the
      // values that were submitted, so the caller always gets the row D1 now
      // holds -- which matters because the server trims and case-folds them.
      onSaved(data[responseKey] ?? null)
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

  const clientReason = check.reason

  return (
    <EditRecordModal
      title={title}
      subtitle={`${idLabel} ${record[idField]}`}
      onClose={onClose}
      onSave={handleSave}
      saving={saving}
      error={error}
      disabled={!check.valid}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <EditField
          id={`edit-${idField}`}
          label={idLabel}
          value={record[idField] ?? '—'}
          readOnly
          hint="The key of this record. Assigned automatically and never changes."
        />
        <EditField
          id={`edit-${nameField}-department`}
          label="Department"
          value={form.department}
          onChange={setField('department')}
          options={DEPARTMENTS.map((value) => ({ value, label: value }))}
          error={fieldErrors.department}
        />
        <EditField
          id={`edit-${nameField}`}
          label={nameLabel}
          value={form[nameField]}
          onChange={setField(nameField)}
          placeholder="Full name"
          error={fieldErrors[nameField]}
        />
        <EditField
          id={`edit-${nameField}-email`}
          label="Email"
          value={form.email}
          onChange={setField('email')}
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="name@kiot.ac.in"
          error={fieldErrors.email}
          hint="Their sign-in address. Changing it updates the existing login; the password is not changed."
        />
      </div>

      {/* The same trailing hint the staff edit dialog uses: Save is already
          disabled, so this explains why rather than reporting a failure. */}
      {clientReason && !error && <p className="text-xs font-semibold text-red-600">{clientReason}</p>}
    </EditRecordModal>
  )
}