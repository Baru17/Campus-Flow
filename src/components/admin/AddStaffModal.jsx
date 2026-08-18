import { useRef, useState } from 'react'
import { XIcon, UploadIcon, CheckIcon, AlertIcon } from '../Icons'
import { parseImportFile, validateStaffRows } from '../../utils/adminImport'
import { adminStaff } from '../../api/adminApi'
import ImportPreviewTable from './ImportPreviewTable'

const PREVIEW_COLUMNS = [
  { key: 'staff_name', label: 'Name', bold: true },
  { key: 'email', label: 'Email', monospace: true },
]

export default function AddStaffModal({ department, onClose, onImported }) {
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [validation, setValidation] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [result, setResult] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

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
    setValidation(validateStaffRows(parsed.rows))
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

  const handleSubmit = async () => {
    if (!validation || validation.validRows.length === 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const data = await adminStaff('add', {
        department,
        rows: validation.validRows,
      })
      setResult(data)
    } catch (err) {
      setSubmitError(err)
    } finally {
      setSubmitting(false)
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
          aria-label="Upload staff list file"
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
            <span className="font-semibold text-slate-500">staff_name, email</span>
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
              staff_name
            </code>
            <span>Full name of the staff member</span>
          </li>
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              email
            </code>
            <span>Valid staff email address (unique)</span>
          </li>
        </ul>
        <p className="mt-2 text-xs font-semibold text-slate-500">
          Department is set to {department}. The staff ID is generated automatically.
        </p>
      </div>
    </div>
  )

  const renderValidation = () => {
    if (!validation) return null
    if (validation.missingColumns.length > 0) {
      return (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
        >
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-bold">The file is missing required columns.</p>
            <p className="mt-1 text-red-600">
              Missing: {validation.missingColumns.join(', ')}. Add these columns to your file and
              upload again.
            </p>
          </div>
        </div>
      )
    }

    return (
      <div className="mt-4 space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="admin-import-stat admin-import-stat-total">
            <span className="admin-import-stat-value">{validation.total}</span>
            <span className="admin-import-stat-label">Total rows</span>
          </div>
          <div className="admin-import-stat admin-import-stat-valid">
            <span className="admin-import-stat-value">{validation.validRows.length}</span>
            <span className="admin-import-stat-label">Valid rows</span>
          </div>
          <div className="admin-import-stat admin-import-stat-invalid">
            <span className="admin-import-stat-value">{validation.invalidRows.length}</span>
            <span className="admin-import-stat-label">Invalid rows</span>
          </div>
          <div className="admin-import-stat admin-import-stat-dup">
            <span className="admin-import-stat-value">{validation.duplicateEmails.length}</span>
            <span className="admin-import-stat-label">Duplicate emails</span>
          </div>
        </div>

        {validation.invalidRows.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-bold">
              {validation.invalidRows.length} row{validation.invalidRows.length === 1 ? '' : 's'} will
              be skipped:
            </p>
            <ul className="mt-1.5 max-h-32 space-y-1 overflow-y-auto text-xs">
              {validation.invalidRows.slice(0, 12).map((row) => (
                <li key={row.rowNumber}>
                  Row {row.rowNumber} — <span className="font-bold">{row.reason}</span>
                </li>
              ))}
              {validation.invalidRows.length > 12 && (
                <li className="font-semibold">
                  …and {validation.invalidRows.length - 12} more.
                </li>
              )}
            </ul>
          </div>
        )}

        {validation.duplicateEmails.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-bold">Duplicate emails in the file will be skipped:</p>
            <p className="mt-1 text-xs">
              {validation.duplicateEmails.slice(0, 8).join(', ')}
              {validation.duplicateEmails.length > 8
                ? ` (+${validation.duplicateEmails.length - 8} more)`
                : ''}
            </p>
          </div>
        )}

        {validation.validRows.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
              <CheckIcon size={16} className="text-emerald-500" />
              Preview of {validation.validRows.length} valid row
              {validation.validRows.length === 1 ? '' : 's'}
            </div>
            <ImportPreviewTable kind="staff" rows={validation.validRows} columns={PREVIEW_COLUMNS} />
          </>
        )}
      </div>
    )
  }

  const renderResult = () => (
    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
      <div className="flex items-center gap-2 font-bold">
        <CheckIcon size={16} />
        Import complete
      </div>
      <ul className="mt-1.5 space-y-0.5 text-xs">
        <li>
          <span className="font-bold">{result.inserted || 0}</span> staff member
          {result.inserted === 1 ? '' : 's'} added to {department}.
        </li>
        <li>
          <span className="font-bold">{result.skippedExisting || 0}</span> already existed and were
          skipped.
        </li>
        {validation?.invalidRows?.length > 0 && (
          <li>
            <span className="font-bold">{validation.invalidRows.length}</span> invalid rows skipped.
          </li>
        )}
      </ul>
    </div>
  )

  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="Add staff">
      <div className="admin-modal max-w-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">
              Add Staff — {department}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Upload a CSV/Excel file with staff names and emails.
            </p>
          </div>
          <button type="button" onClick={onClose} className="admin-modal-close" aria-label="Close">
            <XIcon size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {!result && renderFilePicker()}
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
                disabled={
                  submitting || !validation || validation.validRows.length === 0
                }
                className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                {submitting && <span className="cf-spinner" role="status" aria-hidden="true" />}
                {submitting ? 'Importing…' : `Import ${validation?.validRows?.length || 0} staff`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}