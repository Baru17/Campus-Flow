import { useMemo, useRef, useState } from 'react'
import { XIcon, UploadIcon, CheckIcon, AlertIcon, PlusIcon, TrashIcon } from '../Icons'
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
  student_id: 'e.g. 2K27IT001',
  register_no: 'e.g. 611224205001',
  student_name: 'Full name of the student',
  year: '1, 2, 3 or 4',
  section: 'e.g. A or B',
}

const NEW_BATCH = '__new__'

const SUBJECT_YEAR_OPTIONS = [1, 2, 3, 4]

function normalizeBatchInput(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '_')
}

function isValidBatchKey(key) {
  const match = /^(\d{4})_(\d{4})$/.exec(key)
  if (!match) return false
  return Number(match[2]) === Number(match[1]) + 4
}

function formatBatchLabel(key) {
  const [start, end] = key.split('_')
  return `${start} - ${end}`
}

function emptySubject() {
  return { subject_code: '', subject_name: '', year: 2, section: 'A' }
}

function normalizeSubject(raw) {
  return {
    subject_code: String(raw?.subject_code || '').trim().toUpperCase(),
    subject_name: String(raw?.subject_name || '').trim(),
    year: Number(raw?.year) || 2,
    section: String(raw?.section || 'A').trim().toUpperCase(),
  }
}

function validateSubject(sub) {
  if (!sub.subject_code) return 'Subject code is required'
  if (!sub.subject_name) return 'Subject name is required'
  if (!Number.isInteger(sub.year) || sub.year < 1 || sub.year > 4) return 'Year must be 1-4'
  if (!sub.section) return 'Section is required'
  return null
}

export default function AddStudentsModal({ department, batch, batches, onClose, onImported }) {
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

  // Subject management state
  const [subjects, setSubjects] = useState([emptySubject()])
  const [subjectResult, setSubjectResult] = useState(null)

  // Resolve the batch key that will actually be used.
  const { batchKey, batchLabel, batchError } = useMemo(() => {
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
  }, [selectedBatch, newBatchText, batches])

  const isReady = Boolean(batchKey)

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

  // Subject management helpers
  const handleSubjectChange = (index, field, value) => {
    setSubjects((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: value }
      return next
    })
  }

  const addSubject = () => {
    setSubjects((prev) => [...prev, emptySubject()])
  }

  const removeSubject = (index) => {
    setSubjects((prev) => prev.filter((_, i) => i !== index))
  }

  const validSubjects = useMemo(() => {
    return subjects.map(normalizeSubject).filter((s) => s.subject_code || s.subject_name)
  }, [subjects])

  const completeSubjects = useMemo(
    () => validSubjects.filter((s) => s.subject_code && s.subject_name && !validateSubject(s)),
    [validSubjects]
  )

  const handleSubmit = async () => {
    if (!isReady) return
    if (completeSubjects.length === 0) {
      setSubmitError('Add at least one complete subject before importing.')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const data = await adminStudents('add', {
        department,
        batch: batchKey,
        rows: validation?.validRows || [],
      })
      setResult(data)

      // After students are imported, add subjects if any were provided.
      const subjectsToAdd = completeSubjects
      if (subjectsToAdd.length > 0) {
        try {
          const subResult = await adminStudents('add-subjects', {
            department,
            batch: batchKey,
            subjects: subjectsToAdd,
          })
          setSubjectResult(subResult)
        } catch (subErr) {
          // Students were imported but subjects failed — report both.
          setSubmitError(
            `Students imported but subjects failed: ${subErr.message || 'Unknown error'}`
          )
        }
      }
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

  const renderSubjects = () => (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="text-sm font-bold text-slate-700">Subjects</h3>
          <p className="text-xs text-slate-500">
            Add subjects for this batch. These will be available to staff for attendance.
          </p>
        </div>
        <button
          type="button"
          onClick={addSubject}
          className="btn-cf-outline inline-flex items-center gap-1 px-3 py-1.5 text-xs"
        >
          <PlusIcon size={14} />
          Add Subject
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="px-4 py-2 font-bold">Code</th>
              <th className="px-4 py-2 font-bold">Name</th>
              <th className="px-4 py-2 font-bold">Year</th>
              <th className="px-4 py-2 font-bold">Section</th>
              <th className="px-4 py-2 font-bold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((sub, index) => {
              const norm = normalizeSubject(sub)
              const error = sub.subject_code || sub.subject_name ? validateSubject(norm) : null
              return (
                <tr
                  key={index}
                  className={`border-b border-slate-100 last:border-b-0 ${error ? 'bg-amber-50/40' : ''}`}
                >
                  <td className="px-4 py-2 align-top">
                    <input
                      type="text"
                      value={sub.subject_code}
                      onChange={(e) => handleSubjectChange(index, 'subject_code', e.target.value)}
                      placeholder="e.g. ADC"
                      className={`cf-input w-full text-sm ${error && !sub.subject_code ? 'border-red-300' : ''}`}
                      maxLength={20}
                    />
                    {error === 'Subject code is required' && (
                      <p className="mt-0.5 text-[11px] font-semibold text-red-500">{error}</p>
                    )}
                  </td>
                  <td className="px-4 py-2 align-top">
                    <input
                      type="text"
                      value={sub.subject_name}
                      onChange={(e) => handleSubjectChange(index, 'subject_name', e.target.value)}
                      placeholder="e.g. Analog and Digital Communication"
                      className={`cf-input w-full text-sm ${error && !sub.subject_name ? 'border-red-300' : ''}`}
                    />
                    {error === 'Subject name is required' && (
                      <p className="mt-0.5 text-[11px] font-semibold text-red-500">{error}</p>
                    )}
                  </td>
                  <td className="px-4 py-2 align-top">
                    <select
                      value={sub.year}
                      onChange={(e) => handleSubjectChange(index, 'year', Number(e.target.value))}
                      className="cf-select w-full text-sm"
                    >
                      {SUBJECT_YEAR_OPTIONS.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2 align-top">
                    <input
                      type="text"
                      value={sub.section}
                      onChange={(e) => handleSubjectChange(index, 'section', e.target.value)}
                      placeholder="A"
                      className="cf-input w-full text-sm"
                      maxLength={5}
                    />
                  </td>
                  <td className="px-4 py-2 align-top text-right">
                    {subjects.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeSubject(index)}
                        className="inline-flex items-center gap-1 text-slate-400 transition-colors hover:text-red-500"
                        aria-label={`Remove subject ${index + 1}`}
                        title="Remove"
                      >
                        <TrashIcon size={14} />
                      </button>
                    ) : (
                      <span className="text-slate-300" title="At least one subject is required">
                        <TrashIcon size={14} />
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {validSubjects.length > 0 && (
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
          <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">
            Ready — {completeSubjects.length} of {validSubjects.length} subject
            {validSubjects.length === 1 ? '' : 's'} complete
          </p>
          <div className="space-y-1">
            {validSubjects.map((sub, i) => {
              const error = validateSubject(sub)
              return (
                <div
                  key={i}
                  className={`flex items-center gap-2 text-xs ${error ? 'text-amber-600' : 'text-slate-700'}`}
                >
                  {error ? (
                    <AlertIcon size={12} className="shrink-0" />
                  ) : (
                    <CheckIcon size={12} className="shrink-0 text-emerald-500" />
                  )}
                  <span className="font-bold">{sub.subject_code}</span>
                  <span className="truncate">{sub.subject_name}</span>
                  <span className="text-slate-400">·</span>
                  <span>Year {sub.year}</span>
                  <span className="text-slate-400">·</span>
                  <span>Sec {sub.section}</span>
                  {error && <span className="ml-auto text-amber-600">{error}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )

  const renderResult = () => (
    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
      <div className="flex items-center gap-2 font-bold">
        <CheckIcon size={16} />
        Import complete
      </div>
      <ul className="mt-1.5 space-y-0.5 text-xs">
        {result.table_created && (
          <li>
            Created a new batch table for <span className="font-bold">{batchLabel}</span> and imported
            students into it.
          </li>
        )}
        {validation?.validRows?.length > 0 && (
          <li>
            <span className="font-bold">{result.inserted || 0}</span> student
            {result.inserted === 1 ? '' : 's'} added to {department} → {batchLabel}.
          </li>
        )}
        {validation?.validRows?.length === 0 && (
          <li>
            <span className="font-bold">0</span> students imported (no student file uploaded).
          </li>
        )}
        <li>
          <span className="font-bold">{result.skippedExisting || 0}</span> already existed and were
          skipped.
        </li>
        {result.auth_backfilled > 0 && (
          <li>
            <span className="font-bold">{result.auth_backfilled}</span> previously imported
            student{result.auth_backfilled === 1 ? '' : 's'} had missing login setup repaired.
          </li>
        )}
        {(result.auth_accounts_created > 0 || result.auth_linked_existing > 0) && (
          <li>
            <span className="font-bold">
              {(result.auth_accounts_created || 0) + (result.auth_linked_existing || 0)}
            </span>{' '}
            login account{(result.auth_accounts_created || 0) + (result.auth_linked_existing || 0) === 1 ? '' : 's'} ready
            {result.auth_accounts_created > 0 && (
              <>
                {' '}— initial password{' '}
                <code className="rounded bg-emerald-100 px-1 py-0.5 font-mono font-bold">
                  1234
                </code>
              </>
            )}
            . Students log in with their student ID.
          </li>
        )}
        {result.auth_failed > 0 && (
          <li className="font-semibold text-amber-700">
            <span className="font-bold">{result.auth_failed}</span> login account
            {result.auth_failed === 1 ? '' : 's'} could not be created
            {Array.isArray(result.auth_failures) && result.auth_failures.length > 0 &&
              ` (first: ${result.auth_failures[0].student_id} — ${result.auth_failures[0].reason})`}
            .
          </li>
        )}
        {validation?.invalidRows?.length > 0 && (
          <li>
            <span className="font-bold">{validation.invalidRows.length}</span> invalid rows skipped.
          </li>
        )}
        {subjectResult && (
          <li>
            <span className="font-bold">{subjectResult.inserted || 0}</span> subject
            {subjectResult.inserted === 1 ? '' : 's'} added.
            {subjectResult.skippedExisting > 0 && (
              <> <span className="font-bold">{subjectResult.skippedExisting}</span> already existed.</>
            )}
          </li>
        )}
      </ul>
    </div>
  )

  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="Add students">
      <div className="admin-modal max-w-3xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">
              Add Students — {department}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {isReady
                ? `Batch: ${batchLabel} — choose a file and optionally add subjects.`
                : 'Choose an existing batch or create a new one.'}
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

        <div className="max-h-[70vh] overflow-y-auto space-y-4 p-5">
          {!result && (
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
                      New batch {batchLabel} — tables will be created automatically on import.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {!result && isReady && renderSubjects()}
          {!result && renderFilePicker()}
          {!result && renderValidation()}

          {/* Summary before submission */}
          {!result && isReady && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm">
              <p className="font-bold text-blue-800 mb-2">Summary before import</p>
              <div className="space-y-1 text-xs text-blue-700">
                <p>Department: <span className="font-bold">{department}</span></p>
                <p>Batch: <span className="font-bold">{batchLabel}</span></p>
                <p>Tables to be created:</p>
                <ul className="ml-4 space-y-0.5">
                  <li>✓ {department.toLowerCase()}_students_{batchKey}</li>
                  <li>✓ {department.toLowerCase()}_attendance_{batchKey}</li>
                  <li>✓ {department.toLowerCase()}_subjects_{batchKey}</li>
                </ul>
                <p>
                  Students: <span className="font-bold">{validation?.validRows?.length || 0}</span>
                  {' · '}
                  Subjects: <span className="font-bold">{completeSubjects.length}</span>
                </p>
              </div>
            </div>
          )}

          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              {typeof submitError === 'string' ? submitError : submitError.message}
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
                disabled={submitting || !isReady || completeSubjects.length === 0}
                title={
                  completeSubjects.length === 0
                    ? 'Add at least one complete subject before importing'
                    : undefined
                }
                className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                {submitting && <span className="cf-spinner" role="status" aria-hidden="true" />}
                {submitting
                  ? 'Importing…'
                  : `Import${validation?.validRows?.length ? ` ${validation.validRows.length} students` : ''}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
