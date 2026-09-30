import { useEffect, useRef, useState } from 'react'
import { XIcon, UploadIcon, CheckIcon, AlertIcon } from '../Icons'
import { parseImportFile, validateStaffRows } from '../../utils/adminImport'
import { fetchAdminBatches, createAdminStaff } from '../../api/adminApi'
import { ALLOWED_SECTIONS } from '../../utils/sectionValidation'
import ImportPreviewTable from './ImportPreviewTable'
import ManualRowEditor from './ManualRowEditor'
import InitialPasswordNotice from './InitialPasswordNotice'

/*
 * Adding staff has no batch step, unlike adding students.
 *
 * Students live in per-cohort tables, so the batch decides which table they go
 * into and the admin has to name one. Staff live in a single `staff` table keyed by
 * department, so there is nothing to choose. A batch appears here only as an
 * attribute of a class advisor, which is why it is a column on the row and not a
 * control above the form.
 *
 * The staff ID is not offered as an input. The column is `TEXT NOT NULL UNIQUE`
 * with no default, and `/api/auth/staff/login` accepts a staff ID as an alternative
 * to an email but only after checking it is a positive integer, so an admin-chosen
 * value would risk creating a row that cannot be signed into by ID. The server
 * generates it.
 */

const PREVIEW_COLUMNS = [
  { key: 'staff_name', label: 'Name', bold: true },
  { key: 'email', label: 'Email', monospace: true },
  { key: 'class_advisor', label: 'Class advisor' },
  { key: 'advisor_batch', label: 'Advisor batch' },
  { key: 'advisor_year', label: 'Advisor year' },
  { key: 'advisor_section', label: 'Advisor section' },
]

const MANUAL_COLUMNS = [
  { key: 'staff_name', label: 'Name', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'class_advisor', label: 'Advisor?', required: true, type: 'select', options: ['No', 'Yes'] },
  { key: 'advisor_batch', label: 'Advisor batch' },
  { key: 'advisor_year', label: 'Advisor year', type: 'number', placeholder: '1-4' },
  { key: 'advisor_section', label: 'Advisor section', type: 'select', options: ['', ...ALLOWED_SECTIONS] },
]

const emptyStaff = () => ({
  staff_name: '',
  email: '',
  class_advisor: 'No',
  advisor_batch: '',
  advisor_year: '',
  advisor_section: '',
})

export default function AddStaffModal({ department, onClose, onImported }) {
  const [mode, setMode] = useState('upload')
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [validation, setValidation] = useState(null)
  const [manualRows, setManualRows] = useState([emptyStaff()])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [result, setResult] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

  /*
   * The department's cohorts, needed only to name the cohorts an advisor may be
   * assigned. It is a choice list, not a form-level requirement: a staff import
   * never has to name a batch, so this fetch failing must not block adding staff.
   */
  const [advisorBatches, setAdvisorBatches] = useState([])

  useEffect(() => {
    let cancelled = false
    fetchAdminBatches(department)
      .then((data) => {
        if (!cancelled) setAdvisorBatches(data.batches?.[department] || [])
      })
      .catch(() => {
        // Left empty on purpose. The advisor batch is typed in that case, and the
        // server remains the authority on whether it exists.
      })
    return () => {
      cancelled = true
    }
  }, [department])

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

  /*
   * Manual rows are shaped for the editor's convenience, where the advisor flag is
   * a Yes/No choice and a year is text from a number input. They are converted to
   * the shape the validator and the API expect here, so both input paths reach the
   * backend in one format.
   *
   * A row only carries advisor fields when the toggle says yes. Sending them for a
   * non-advisor would ask the server to store a cohort for someone who does not
   * advise one.
   */
  const buildManualRows = () =>
    manualRows
      .map((row) => {
        const isAdvisor = String(row.class_advisor).toLowerCase() === 'yes'
        const year = row.advisor_year === '' ? '' : Number(row.advisor_year)
        return {
          staff_name: String(row.staff_name || '').trim(),
          email: String(row.email || '').trim(),
          class_advisor: isAdvisor,
          advisor_batch: isAdvisor ? String(row.advisor_batch || '').trim() : '',
          advisor_year: isAdvisor && year !== '' && !Number.isNaN(year) ? year : '',
          advisor_section: isAdvisor ? String(row.advisor_section || '').trim() : '',
        }
      })
      .filter((row) => row.staff_name !== '' || row.email !== '')

  const manualValidation = (() => {
    if (mode !== 'manual') return null
    const rows = buildManualRows()
    if (rows.length === 0) return null
    return validateStaffRows(rows)
  })()

  const activeValidation = mode === 'upload' ? validation : manualValidation

  const handleSubmit = async () => {
    const rows = activeValidation?.validRows
    if (!rows || rows.length === 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const data = await createAdminStaff(department, rows)
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
            <span>Valid staff email address. Also the login name.</span>
          </li>
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              class_advisor
            </code>
            <span>
              Optional. Set to <span className="font-bold">Yes</span> only for a class advisor; leave
              blank or <span className="font-bold">No</span> for everyone else.
            </span>
          </li>
          <li className="flex items-baseline gap-2 text-xs text-slate-600">
            <code className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 font-bold text-slate-700">
              advisor_batch, advisor_year, advisor_section
            </code>
            <span>
              Required together for a class advisor, and ignored otherwise. The batch is the cohort
              they advise, not a table selector.
            </span>
          </li>
        </ul>
        <p className="mt-2 text-xs font-semibold text-slate-500">
          Department is set to {department}. The staff ID is generated automatically, and a login
          account is created for each person.
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
              and upload again, or switch to entering staff by hand.
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
              kind="staff"
              rows={activeValidation.validRows}
              columns={PREVIEW_COLUMNS}
            />
          </>
        )}
      </div>
    )
  }

  const renderResult = () => (
    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
      <div className="flex items-center gap-2 font-bold">
        <CheckIcon size={16} />
        Staff provisioning successful
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="font-semibold">Department:</dt>
          <dd>{result.department || department}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-semibold">Staff records created:</dt>
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
    <div className="flex gap-2" role="tablist" aria-label="How to add staff">
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
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="Add staff">
      <div className="admin-modal max-w-4xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">
              Add Staff — {department}
            </h2>
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
                Set <span className="font-bold">Advisor? = Yes</span> only for a class advisor, then
                give the cohort they advise, their year, and their section. Everyone else needs just
                a name and an email.
                {advisorBatches.length > 0 && (
                  <>
                    {' '}
                    Cohorts available in {department}:{' '}
                    {advisorBatches.map((b) => b.key).join(', ')}.
                  </>
                )}
              </p>
              <ManualRowEditor
                columns={MANUAL_COLUMNS}
                rows={manualRows}
                onChange={setManualRows}
                makeEmptyRow={emptyStaff}
                addLabel="Add another staff member"
                rowLabel="Staff"
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
                  : `Confirm and create ${activeValidation?.validRows?.length || 0} staff member${
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
