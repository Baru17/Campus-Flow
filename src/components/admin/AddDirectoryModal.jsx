import { useRef, useState } from 'react'
import { XIcon, UploadIcon, CheckIcon, AlertIcon } from '../Icons'
import { parseImportFile } from '../../utils/adminImport'
import { DEPARTMENTS } from '../../constants'
import ImportPreviewTable from './ImportPreviewTable'
import ManualRowEditor from './ManualRowEditor'
import InitialPasswordNotice from './InitialPasswordNotice'

/*
 * Adding a person to a directory: heads of department, and contest coordinators.
 *
 * Both are the same three facts -- a name, an address, and a department -- in a
 * single department-keyed table, with a login account created alongside. They are
 * therefore one component driven by a description of the entity, rather than two
 * near-identical modals. What is shared is not just the code but the *workflow*,
 * and it is the workflow this file exists to keep identical to `AddStaffModal`:
 *
 *   Upload | Manual Entry  ->  validate  ->  preview  ->  confirm  ->  provision
 *
 * with the initial-password notice shown before the import and again in the
 * success panel, the four summary tiles, the amber per-row error list, and the
 * same dropzone, tabs, buttons and modal frame. Every class name and every message
 * shape is the one the staff and subject dialogs already use, so this reads as the
 * same screen rather than a new one.
 *
 * The differences from the staff dialog are all consequences of the entity being
 * simpler, not of it being different: there is no batch step because neither table
 * is keyed by cohort, and there are no advisor columns because neither table has
 * one.
 *
 * The id is never part of the form. `hod_id` and `coordinator_id` are
 * `INTEGER PRIMARY KEY AUTOINCREMENT`, so the database assigns them and there is no
 * input here that could supply one.
 */
export default function AddDirectoryModal({
  title,
  nameKey,
  nameLabel,
  namePlaceholder = 'Full name',
  rowLabel,
  pluralNoun,
  pluralUnit,
  csvColumns,
  validateRows,
  onSubmit,
  onClose,
  onImported,
}) {
  const [mode, setMode] = useState('upload')
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [validation, setValidation] = useState(null)
  const [manualRows, setManualRows] = useState([emptyRow(nameKey)])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [result, setResult] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

  const previewColumns = [
    { key: nameKey, label: nameLabel, bold: true },
    { key: 'email', label: 'Email', monospace: true },
    { key: 'department', label: 'Department' },
  ]

  const manualColumns = [
    { key: nameKey, label: nameLabel, required: true, placeholder: namePlaceholder },
    { key: 'email', label: 'Email', required: true },
    { key: 'department', label: 'Department', required: true, type: 'select', options: DEPARTMENTS },
  ]

  const handleFile = async (file) => {
    setFileError('')
    setSubmitError(null)
    setValidation(null)
    setResult(null)
    setFileName('')

    const parsed = await parseImportFile(file)
    if (parsed.error) {
      setFileError(parsed.error)
      return
    }

    setFileName(file.name)
    setValidation(validateRows(parsed.rows))
  }

  const handleFileInput = (event) => {
    const file = event.target.files?.[0]
    if (file) handleFile(file)
    event.target.value = ''
  }

  const handleDrop = (event) => {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer?.files?.[0]
    if (file) handleFile(file)
  }

  /*
   * Manual rows are shaped for the editor's convenience, where the department is a
   * chosen option rather than free text. They are converted to the shape the
   * validator and the API expect here, so both input paths reach the backend in one
   * format and a hand-typed row is validated by identical code to an uploaded one.
   */
  const buildManualRows = () =>
    manualRows
      .map((row) => ({
        [nameKey]: String(row[nameKey] || '').trim(),
        email: String(row.email || '').trim(),
        department: String(row.department || '').trim().toUpperCase(),
      }))
      .filter((row) => row[nameKey] !== '' || row.email !== '' || row.department !== '')

  const manualValidation = (() => {
    if (mode !== 'manual') return null
    const rows = buildManualRows()
    if (rows.length === 0) return null
    return validateRows(rows)
  })()

  const activeValidation = mode === 'upload' ? validation : manualValidation

  const handleSubmit = async () => {
    const rows = activeValidation?.validRows
    if (!rows || rows.length === 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const data = await onSubmit(rows)
      setResult(data)
    } catch (err) {
      setSubmitError(err)
    } finally {
      setSubmitting(false)
    }
  }

  const switchMode = (next) => {
    setMode(next)
    setSubmitError(null)
    setResult(null)
    if (next === 'manual') {
      setValidation(null)
      setFileName('')
      setFileError('')
    }
  }

  const renderFilePicker = () => (
    <div>
      <div
        className={`admin-dropzone ${dragOver ? 'admin-dropzone-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx"
          onChange={handleFileInput}
          className="hidden"
          aria-label={`Upload ${pluralNoun.toLowerCase()} file`}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex flex-col items-center gap-2 text-center"
        >
          <span className="admin-dropzone-icon">
            <UploadIcon size={22} />
          </span>
          <span className="text-sm font-bold text-slate-700">
            {fileName || 'Click to choose or drag a file here'}
          </span>
          <span className="text-xs text-slate-400">
            CSV or Excel (.xlsx) with columns:{' '}
            <span className="font-semibold text-slate-500">{csvColumns.join(', ')}</span>
          </span>
        </button>
      </div>

      {fileError && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
        >
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          {fileError}
        </div>
      )}

      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">
          Column details
        </p>
        <ul className="space-y-1">
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              {nameKey}
            </code>
            <span>Full name of the {rowLabel.toLowerCase()}.</span>
          </li>
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              email
            </code>
            <span>Valid email address. Also the login name.</span>
          </li>
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              department
            </code>
            <span>Their department. One of {DEPARTMENTS.join(', ')}.</span>
          </li>
        </ul>
        <p className="mt-2 text-xs font-semibold text-slate-500">
          The ID is generated automatically, and a login account is created for each{' '}
          {rowLabel.toLowerCase()}.
        </p>
      </div>
    </div>
  )

  const renderValidation = () => {
    if (!activeValidation) return null
    if (activeValidation.missingColumns.length > 0) {
      return (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
        >
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-bold">The file is missing required columns.</p>
            <p className="mt-1 text-red-600">
              Missing: {activeValidation.missingColumns.join(', ')}. Add these columns to your
              file and upload again, or switch to entering {pluralNoun.toLowerCase()} by hand.
            </p>
          </div>
        </div>
      )
    }

    return (
      <div className="mt-4 space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="admin-import-stat admin-import-stat-total">
            <span className="admin-import-stat-value">{activeValidation.total}</span>
            <span className="admin-import-stat-label">Total rows</span>
          </div>
          <div className="admin-import-stat admin-import-stat-valid">
            <span className="admin-import-stat-value">{activeValidation.validRows.length}</span>
            <span className="admin-import-stat-label">Valid rows</span>
          </div>
          <div className="admin-import-stat admin-import-stat-invalid">
            <span className="admin-import-stat-value">{activeValidation.invalidRows.length}</span>
            <span className="admin-import-stat-label">Invalid rows</span>
          </div>
          <div className="admin-import-stat admin-import-stat-dup">
            <span className="admin-import-stat-value">
              {activeValidation.duplicateEmails?.length || 0}
            </span>
            <span className="admin-import-stat-label">Duplicate emails</span>
          </div>
        </div>

        {activeValidation.invalidRows.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-bold">
              {activeValidation.invalidRows.length} row
              {activeValidation.invalidRows.length === 1 ? '' : 's'} will be skipped. The rest will
              still be added:
            </p>
            <ul className="mt-1.5 max-h-32 space-y-1 overflow-y-auto text-xs">
              {activeValidation.invalidRows.slice(0, 12).map((row) => (
                <li key={row.rowNumber}>
                  Row {row.rowNumber} — <span className="font-bold">{row.reason}</span>
                </li>
              ))}
              {activeValidation.invalidRows.length > 12 && (
                <li className="font-semibold">
                  …and {activeValidation.invalidRows.length - 12} more.
                </li>
              )}
            </ul>
          </div>
        )}

        {activeValidation.duplicateEmails?.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-bold">Duplicate emails in the file will be skipped:</p>
            <p className="mt-1 text-xs">
              {activeValidation.duplicateEmails.slice(0, 8).join(', ')}
              {activeValidation.duplicateEmails.length > 8
                ? ` (+${activeValidation.duplicateEmails.length - 8} more)`
                : ''}
            </p>
          </div>
        )}

        {activeValidation.validRows.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
              <CheckIcon size={16} className="text-emerald-500" />
              Preview of {activeValidation.validRows.length} valid row
              {activeValidation.validRows.length === 1 ? '' : 's'}
            </div>
            <ImportPreviewTable rows={activeValidation.validRows} columns={previewColumns} />
          </>
        )}
      </div>
    )
  }

  const renderResult = () => (
    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
      <div className="flex items-center gap-2 font-bold">
        <CheckIcon size={16} />
        {rowLabel} provisioning successful
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="font-semibold">{rowLabel} records created:</dt>
          <dd>{result.created || 0}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-semibold">Auth accounts created:</dt>
          <dd>{result.authAccountsCreated || 0}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-semibold">Already existed, skipped:</dt>
          <dd>{result.skipped || 0}</dd>
        </div>
      </dl>

      {result.invalid?.length > 0 && (
        <p className="mt-2 text-xs">
          <span className="font-bold">{result.invalid.length}</span> invalid rows skipped.
        </p>
      )}
      {result.duplicates?.length > 0 && (
        <p className="mt-1 text-xs">
          <span className="font-bold">{result.duplicates.length}</span> duplicate rows in the file
          skipped.
        </p>
      )}
      {result.roleMismatches?.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-bold">
            {result.roleMismatches.length} skipped: the address already has a login of another
            kind.
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {result.roleMismatches.slice(0, 8).map((mismatch) => (
              <li key={`${mismatch.row}-${mismatch.reason}`}>{mismatch.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Only when accounts were actually created: re-importing a file that already
        exists makes nothing, and telling the admin to hand out a password for
        accounts that were not created would be misleading.
      */}
      {result.authAccountsCreated > 0 && (
        <InitialPasswordNotice password={result.defaultPassword} tone="success" className="mt-3" />
      )}
    </div>
  )

  const renderModeTabs = () => (
    <div className="flex gap-2" role="tablist" aria-label={`How to add ${pluralNoun.toLowerCase()}`}>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'upload'}
        onClick={() => switchMode('upload')}
        className={`btn-cf-outline px-3 py-1.5 text-sm ${mode === 'upload' ? 'ring-2 ring-blue-500' : ''}`}
      >
        Upload Document
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'manual'}
        onClick={() => switchMode('manual')}
        className={`btn-cf-outline px-3 py-1.5 text-sm ${mode === 'manual' ? 'ring-2 ring-blue-500' : ''}`}
      >
        Manual Entry
      </button>
    </div>
  )

  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="admin-modal max-w-4xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">{title}</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Upload a CSV/Excel file, or enter the records by hand.
            </p>
          </div>
          <button type="button" onClick={onClose} className="admin-modal-close" aria-label="Close">
            <XIcon size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {!result && renderModeTabs()}

          {/* Stated before importing, so the password is known up front. */}
          {!result && <InitialPasswordNotice />}

          {!result && mode === 'upload' && renderFilePicker()}

          {!result && mode === 'manual' && (
            <>
              <p className="text-sm text-slate-600">
                Give the {rowLabel.toLowerCase()}&apos;s name, their email address, and their
                department. The ID is generated for you, and a login account is created so they
                can sign in.
              </p>
              <ManualRowEditor
                columns={manualColumns}
                rows={manualRows}
                onChange={setManualRows}
                makeEmptyRow={() => emptyRow(nameKey)}
                addLabel={`Add another ${rowLabel.toLowerCase()}`}
                rowLabel={rowLabel}
              />
            </>
          )}

          {!result && renderValidation()}

          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              {submitError.message}
            </div>
          )}

          {result && renderResult()}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-4">
          {result ? (
            <button
              type="button"
              onClick={() => {
                onClose()
                if (onImported) onImported(result)
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
                disabled={submitting || !activeValidation || activeValidation.validRows.length === 0}
                className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                {submitting && <span className="cf-spinner" role="status" aria-hidden="true" />}
                {submitting
                  ? 'Creating…'
                  : `Confirm and create ${activeValidation?.validRows?.length || 0} ${pluralUnit}${
                      activeValidation?.validRows?.length === 1 ? '' : 's'
                    }`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** A blank manual row. The department starts empty so it has to be chosen. */
function emptyRow(nameKey) {
  return { [nameKey]: '', email: '', department: '' }
}