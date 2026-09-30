import { useEffect, useRef, useState } from 'react'
import { XIcon, UploadIcon, CheckIcon, AlertIcon } from '../Icons'
import { parseImportFile, validateStudentRows } from '../../utils/adminImport'
import { createAdminStudents, fetchAdminBatches } from '../../api/adminApi'
import { ALLOWED_SECTIONS } from '../../utils/sectionValidation'
import { formatBatchLabel } from '../../utils/batchValidation'
import ImportPreviewTable from './ImportPreviewTable'
import ManualRowEditor from './ManualRowEditor'
import InitialPasswordNotice from './InitialPasswordNotice'
import BatchChooser from './BatchChooser'

/*
 * The batch is a first step inside this modal, not a control on the page.
 *
 * Browsing a cohort and adding students to one are different jobs: selecting a
 * batch on the page means "show me these students", and must not start a write
 * workflow. So the chooser lives here, behind the Add Students button, and offers
 * the two cases that actually differ -- an existing cohort, or a new one whose
 * tables get provisioned on the spot.
 *
 * A new batch is provisioned before any row is inserted, so a failed import leaves
 * an empty table rather than a half-populated one.
 */

const PREVIEW_COLUMNS = [
  { key: 'student_id', label: 'Student ID', bold: true, monospace: true },
  { key: 'register_no', label: 'Register No', monospace: true },
  { key: 'student_name', label: 'Name' },
  { key: 'year', label: 'Year' },
  { key: 'section', label: 'Section' },
  { key: 'email', label: 'Email' },
]

const MANUAL_COLUMNS = [
  { key: 'student_id', label: 'Student ID', required: true, placeholder: '2K24CS001' },
  { key: 'register_no', label: 'Register No', required: true },
  { key: 'student_name', label: 'Name', required: true },
  { key: 'year', label: 'Year', required: true, type: 'number', placeholder: '1-4' },
  { key: 'section', label: 'Section', required: true, type: 'select', options: ALLOWED_SECTIONS },
  { key: 'email', label: 'Email', required: true },
]

const emptyStudent = () => ({
  student_id: '',
  register_no: '',
  student_name: '',
  year: '',
  section: ALLOWED_SECTIONS[0],
  email: '',
})

export default function AddStudentsModal({ department, batch, onClose, onImported }) {
  /*
   * `batch` is the cohort the admin was already looking at, so it is offered as the
   * starting point. It is only a default: the chooser below can move to a different
   * existing cohort or create a new one.
   */
  const [batches, setBatches] = useState([])
  const [batchKey, setBatchKey] = useState('')
  const [batchLabel, setBatchLabel] = useState('')
  const [batchResolved, setBatchResolved] = useState(false)

  const [mode, setMode] = useState('upload')
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [validation, setValidation] = useState(null)
  const [manualRows, setManualRows] = useState([emptyStudent()])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [result, setResult] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

  // The cohort's own batches, so the chooser only ever offers this department.
  useEffect(() => {
    let cancelled = false
    fetchAdminBatches(department)
      .then((data) => {
        if (!cancelled) setBatches(data.batches?.[department] || [])
      })
      .catch(() => {
        // The chooser degrades to "New Batch" only, and the server still validates
        // everything, so a failure here is not worth blocking the workflow.
        if (!cancelled) setBatches([])
      })
    return () => {
      cancelled = true
    }
  }, [department])

  const handleBatchResolved = (key, label) => {
    setBatchKey(key)
    setBatchLabel(label || formatBatchLabel(key))
    setBatchResolved(true)
    // Starting a different cohort invalidates anything already parsed.
    setValidation(null)
    setFileName('')
    setFileError('')
    setManualRows([emptyStudent()])
  }

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

  /*
   * Manual rows go through the same validator as uploaded ones, so a hand-typed
   * record and a spreadsheet row are held to one standard. A year typed as a
   * string is coerced first because `Number("3")` is 3 but the raw field is a
   * string from the input element.
   */
  const manualValidation = (() => {
    if (mode !== 'manual') return null
    const rows = manualRows.map((row) => ({
      ...row,
      year: row.year === '' ? '' : Number(row.year),
    }))
    const nonEmpty = rows.filter(
      (row) => Object.values(row).some((value) => String(value ?? '').trim() !== '')
    )
    if (nonEmpty.length === 0) return null
    return validateStudentRows(nonEmpty)
  })()

  const activeValidation = mode === 'upload' ? validation : manualValidation

  const handleSubmit = async () => {
    const rows = activeValidation?.validRows
    if (!rows || rows.length === 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const data = await createAdminStudents(department, batchKey, rows)
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
          aria-label="Upload student list file"
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
            <span className="font-semibold text-slate-500">
              student_id, register_no, student_name, year, section, email
            </span>
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
              student_id
            </code>
            <span>Unique within the batch</span>
          </li>
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              register_no
            </code>
            <span>Unique within the batch</span>
          </li>
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              email
            </code>
            <span>
              Required and unique. Also used as the login name, so a student signs in with either their
              ID or this address.
            </span>
          </li>
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              section
            </code>
            <span>One of {ALLOWED_SECTIONS.join(', ')}</span>
          </li>
        </ul>
        <p className="mt-2 text-xs font-semibold text-slate-500">
          Students are added to {department} {batchLabel}.
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
              Missing: {activeValidation.missingColumns.join(', ')}. Add these columns to your file
              and upload again, or switch to entering students by hand.
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
            <span className="admin-import-stat-value">{activeValidation.duplicateEmails.length}</span>
            <span className="admin-import-stat-label">Duplicate emails</span>
          </div>
        </div>

        {activeValidation.invalidRows.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-bold">
              {activeValidation.invalidRows.length} row
              {activeValidation.invalidRows.length === 1 ? '' : 's'} will be skipped:
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

        {activeValidation.duplicateEmails.length > 0 && (
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
            <ImportPreviewTable
              kind="student"
              rows={activeValidation.validRows}
              columns={PREVIEW_COLUMNS}
            />
          </>
        )}
      </div>
    )
  }

  const renderResult = () => {
    const conflicts = result.conflicts || []
    const roleMismatches = result.roleMismatches || []
    return (
      <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        <div className="flex items-center gap-2 font-bold">
          <CheckIcon size={16} />
          Student provisioning successful
        </div>

        {/*
          The resolved table names are shown because they are the outcome the admin
          actually asked for, and the fastest way to confirm a new batch landed on the
          name they expected. They are echoed from the server response, never built
          here.
        */}
        <dl className="mt-2 space-y-1 text-xs">
          <div className="flex gap-2">
            <dt className="font-semibold">Department:</dt>
            <dd>{result.department || department}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Batch:</dt>
            <dd>{formatBatchLabel(result.batch || batchKey)}</dd>
          </div>
          {result.studentTable && (
            <div className="flex gap-2">
              <dt className="font-semibold">Student table:</dt>
              <dd className="font-mono">{result.studentTable}</dd>
            </div>
          )}
          {result.attendanceTable && (
            <div className="flex gap-2">
              <dt className="font-semibold">Attendance table:</dt>
              <dd className="font-mono">{result.attendanceTable}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="font-semibold">Students created:</dt>
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
            <span className="font-bold">{result.duplicates.length}</span> duplicate rows in the
            file skipped.
          </p>
        )}

        {/* Only when accounts were actually created; see the staff modal for why. */}
        {result.authAccountsCreated > 0 && (
          <InitialPasswordNotice
            password={result.defaultPassword}
            tone="success"
            className="mt-3"
          />
        )}

        {conflicts.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
            <p className="text-xs font-bold">
              {conflicts.length} row{conflicts.length === 1 ? '' : 's'} conflicted with existing
              students and were not added:
            </p>
            <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-xs">
              {conflicts.slice(0, 10).map((row) => (
                <li key={`conflict-${row.row}`}>
                  Row {row.row} — {row.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {roleMismatches.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
            <p className="text-xs font-bold">
              {roleMismatches.length} email{roleMismatches.length === 1 ? '' : 's'} already belong to
              a non-student account and were not linked:
            </p>
            <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-xs">
              {roleMismatches.slice(0, 10).map((row) => (
                <li key={`role-${row.row}`}>
                  Row {row.row} — {row.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  const renderModeTabs = () => (
    <div className="flex gap-2" role="tablist" aria-label="How to add students">
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
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="Add students">
      <div className="admin-modal max-w-4xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">
              Add Students — {department}
              {batchLabel ? ` · ${batchLabel}` : ''}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {batchResolved
                ? 'Upload a CSV/Excel file, or type the records in yourself.'
                : 'Choose a batch to add students to.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="admin-modal-close" aria-label="Close">
            <XIcon size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* Step 1: which cohort. */}
          {!result && (
            <BatchChooser
              department={department}
              batches={batches}
              initialBatch={batch?.key}
              onResolved={handleBatchResolved}
            />
          )}

          {/* Step 2 onward, only once a cohort is settled. */}
          {!result && batchResolved && (
            <div className="flex items-center justify-between border-t border-slate-200 pt-4">
              <p className="text-sm font-bold text-slate-700">
                Adding to{' '}
                <span className="text-blue-700">
                  {department} {batchLabel}
                </span>
              </p>
              <button
                type="button"
                onClick={() => {
                  setBatchResolved(false)
                  setValidation(null)
                  setFileName('')
                  setFileError('')
                  setManualRows([emptyStudent()])
                }}
                className="text-xs font-semibold text-slate-500 underline transition-colors hover:text-blue-600"
              >
                Change batch
              </button>
            </div>
          )}

          {!result && batchResolved && (
            <p className="text-sm font-bold text-slate-700">Choose Input Method</p>
          )}

          {!result && batchResolved && renderModeTabs()}

          {/* Stated before importing, so the password is known up front. */}
          {!result && batchResolved && <InitialPasswordNotice />}

          {!result && batchResolved && mode === 'upload' && renderFilePicker()}

          {!result && batchResolved && mode === 'manual' && (
            <ManualRowEditor
              columns={MANUAL_COLUMNS}
              rows={manualRows}
              onChange={setManualRows}
              makeEmptyRow={emptyStudent}
              addLabel="Add another student"
              rowLabel="Student"
            />
          )}

          {!result && batchResolved && renderValidation()}

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
                  ? 'Importing…'
                  : `Import ${activeValidation?.validRows?.length || 0} student${
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
