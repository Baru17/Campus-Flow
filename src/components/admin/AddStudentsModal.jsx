import { useMemo, useRef, useState } from 'react'
import { XIcon, UploadIcon, CheckIcon, AlertIcon } from '../Icons'
import { parseImportFile, validateStudentRows } from '../../utils/adminImport'
import { adminStudents } from '../../api/adminApi'
import ImportPreviewTable from './ImportPreviewTable'

const REQUIRED_COLUMNS = ['student_id', 'register_no', 'student_name', 'year', 'section']

const PREVIEW_COLUMNS = [
  { key: 'student_id', label: 'Student ID', monospace: true },
  { key: 'register_no', label: 'Register No', monospace: true },
  { key: 'student_name', label: 'Name', bold: true },
  { key: 'year', label: 'Year' },
  { key: 'section', label: 'Section' },
]

const COLUMN_HINTS = {
  student_id: 'e.g. 24IT101',
  register_no: 'e.g. 727824TUIT001',
  student_name: 'Full name of the student',
  year: '1, 2, 3 or 4',
  section: 'e.g. A or B',
}

const NEW_BATCH = '__new__'

/** Normalize a user-typed batch ("2027 - 2031", "2027-2031") to "2027_2031". */
function normalizeBatchInput(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '_')
}

/** A valid batch key is YYYY_YYYY where the end year = start year + 4. */
function isValidBatchKey(key) {
  const match = /^(\d{4})_(\d{4})$/.exec(key)
  if (!match) return false
  return Number(match[2]) === Number(match[1]) + 4
}

function formatBatchLabel(key) {
  const [start, end] = key.split('_')
  return `${start} - ${end}`
}

export default function AddStudentsModal({ department, batch, batches, onClose, onImported }) {
  const isIT = department === 'IT'
  const [selectedBatch, setSelectedBatch] = useState(batch?.key || '')
  const [newBatchText, setNewBatchText] = useState('')
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [validation, setValidation] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [result, setResult] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

  // Resolve the batch key that will actually be used for the import.
  const { batchKey, batchLabel, batchError } = useMemo(() => {
    if (!isIT) return { batchKey: null, batchLabel: null, batchError: '' }

    if (selectedBatch === NEW_BATCH) {
      const normalized = normalizeBatchInput(newBatchText)
      if (!normalized) {
        return { batchKey: '', batchLabel: '', batchError: '' }
      }
      if (!isValidBatchKey(normalized)) {
        return {
          batchKey: '',
          batchLabel: '',
          batchError: 'Enter a valid batch like 2027_2031 (the end year must be the start year + 4).',
        }
      }
      if (batches.some((b) => b.key === normalized)) {
        return {
          batchKey: '',
          batchLabel: '',
          batchError: 'This batch already exists. Pick it from the list instead.',
        }
      }
      return { batchKey: normalized, batchLabel: formatBatchLabel(normalized), batchError: '' }
    }

    const found = batches.find((b) => b.key === selectedBatch)
    return {
      batchKey: selectedBatch,
      batchLabel: found ? found.label : selectedBatch,
      batchError: '',
    }
  }, [isIT, selectedBatch, newBatchText, batches])

  const isReady = isIT ? Boolean(batchKey) : true

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
    setValidation(validateStudentRows(parsed.rows))
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
    if (!validation || validation.validRows.length === 0 || !isReady) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const data = await adminStudents('add', {
        department,
        batch: isIT ? batchKey : undefined,
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
          aria-label="Upload student list file"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="admin-dropzone-btn"
        >
          <span className="admin-dropzone-icon">
            <UploadIcon size={22} />
          </span>
          <span className="admin-dropzone-title">
            {fileName || 'Click to choose or drag a file here'}
          </span>
          <span className="admin-dropzone-hint">
            CSV or Excel (.xlsx) with columns:{' '}
            <span className="font-semibold text-slate-500">
              student_id, register_no, student_name, year, section
            </span>
            {isIT ? '' : ', email (optional)'}
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
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          {REQUIRED_COLUMNS.map((col) => (
            <li key={col} className="flex items-baseline gap-2 text-xs text-slate-600">
              <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
                {col}
              </code>
              <span>{COLUMN_HINTS[col]}</span>
            </li>
          ))}
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              email
            </code>
            <span>Optional</span>
          </li>
        </ul>
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
            <span className="admin-import-stat-value">
              {validation.duplicateStudentIds.length + validation.duplicateRegisterNos.length}
            </span>
            <span className="admin-import-stat-label">Duplicate entries</span>
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

        {(validation.duplicateStudentIds.length > 0 || validation.duplicateRegisterNos.length > 0) && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-bold">Duplicate entries in the file will be skipped:</p>
            {validation.duplicateStudentIds.length > 0 && (
              <p className="mt-1 text-xs">
                Student IDs: {validation.duplicateStudentIds.slice(0, 8).join(', ')}
                {validation.duplicateStudentIds.length > 8
                  ? ` (+${validation.duplicateStudentIds.length - 8} more)`
                  : ''}
              </p>
            )}
            {validation.duplicateRegisterNos.length > 0 && (
              <p className="mt-0.5 text-xs">
                Register nos: {validation.duplicateRegisterNos.slice(0, 8).join(', ')}
                {validation.duplicateRegisterNos.length > 8
                  ? ` (+${validation.duplicateRegisterNos.length - 8} more)`
                  : ''}
              </p>
            )}
          </div>
        )}

        {validation.validRows.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
              <CheckIcon size={16} className="text-emerald-500" />
              Preview of {validation.validRows.length} valid row
              {validation.validRows.length === 1 ? '' : 's'}
            </div>
            <ImportPreviewTable rows={validation.validRows} columns={PREVIEW_COLUMNS} />
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
        {result.table_created && isIT && (
          <li>
            Created a new batch table for <span className="font-bold">{batchLabel}</span> and imported
            students into it.
          </li>
        )}
        <li>
          <span className="font-bold">{result.inserted || 0}</span> student
          {result.inserted === 1 ? '' : 's'} added to {department}
          {isIT ? ` → ${batchLabel}` : ''}.
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
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="Add students">
      <div className="admin-modal max-w-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">
              Add Students — {department}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {isIT
                ? 'Choose an existing batch or create a new one, then upload a CSV/Excel file.'
                : 'Upload a CSV/Excel file.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="admin-modal-close"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {isIT && !result && (
            <div>
              <label htmlFor="adminBatchSelect" className="cf-form-label">
                Batch
              </label>
              <select
                id="adminBatchSelect"
                value={selectedBatch}
                onChange={(e) => {
                  setSelectedBatch(e.target.value)
                  setNewBatchText('')
                  setSubmitError(null)
                }}
                className="cf-select w-full"
              >
                <option value="">Select a batch…</option>
                {batches.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
                <option value={NEW_BATCH}>+ New batch…</option>
              </select>

              {selectedBatch === NEW_BATCH && (
                <div className="mt-2">
                  <label htmlFor="adminNewBatch" className="cf-form-label">
                    New batch (start_year_end_year)
                  </label>
                  <input
                    id="adminNewBatch"
                    type="text"
                    value={newBatchText}
                    onChange={(e) => {
                      setNewBatchText(e.target.value)
                      setSubmitError(null)
                    }}
                    placeholder="e.g. 2027 - 2031"
                    className="cf-input w-full"
                    inputMode="numeric"
                  />
                  {batchError && (
                    <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-red-600">
                      <AlertIcon size={13} />
                      {batchError}
                    </p>
                  )}
                  {batchKey && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                      <CheckIcon size={13} />
                      New batch {batchLabel} — a table will be created automatically on import.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

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
              <button
                type="button"
                onClick={onClose}
                className="btn-cf-outline px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={
                  submitting || !isReady || !validation || validation.validRows.length === 0
                }
                className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                {submitting && <span className="cf-spinner" role="status" aria-hidden="true" />}
                {submitting ? 'Importing…' : `Import ${validation?.validRows?.length || 0} students`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}