import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import ImportPreviewTable from '../components/admin/ImportPreviewTable'
import ManualRowEditor from '../components/admin/ManualRowEditor'
import { createAdminSubjects, fetchAdminSubjects } from '../api/adminApi'
import { parseImportFile, validateSubjectRows } from '../utils/adminImport'
import { useAdminAuth } from '../hooks/useAdminAuth'
import { AlertIcon, BookIcon, CheckIcon, ChevronLeftIcon, PlusIcon, UploadIcon, XIcon } from '../components/Icons'

/*
 * Subjects are a global catalog: a code and a name, shared by every department and
 * every cohort.
 *
 * The semester dimension was removed deliberately. It used to be the primary key of
 * this page, and the batch-semester sidebar that went with it implied a subject
 * belonged to one semester of one cohort, which then had to be resolved before
 * attendance could be marked. A subject never decides which attendance table a mark
 * lands in: the staff member picks the batch, and the year comes from the session.
 */

const PREVIEW_COLUMNS = [
  { key: 'subject_code', label: 'Subject code', bold: true, monospace: true },
  { key: 'subject_name', label: 'Subject name' },
]

const MANUAL_COLUMNS = [
  { key: 'subject_code', label: 'Subject code', required: true, placeholder: 'CS3451' },
  { key: 'subject_name', label: 'Subject name', required: true },
]

const emptySubject = () => ({ subject_code: '', subject_name: '' })

export default function AdminSubjectManagement() {
  const navigate = useNavigate()
  const { logout } = useAdminAuth()

  const [subjects, setSubjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

  const [showAdd, setShowAdd] = useState(false)
  const [mode, setMode] = useState('upload')
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [validation, setValidation] = useState(null)
  const [manualRows, setManualRows] = useState([emptySubject()])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [result, setResult] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAdminSubjects()
      setSubjects(data.subjects || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return subjects
    return subjects.filter((subject) =>
      [subject.subject_code, subject.subject_name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term))
    )
  }, [subjects, search])

  const handleLogout = async () => {
    await logout()
    navigate('/admin', { replace: true })
  }

  const resetForm = () => {
    setMode('upload')
    setFileName('')
    setFileError('')
    setValidation(null)
    setManualRows([emptySubject()])
    setSubmitError(null)
    setResult(null)
  }

  const chooseFile = async (event) => {
    setResult(null)
    setSubmitError(null)
    const file = event.target.files?.[0]
    if (!file) return
    const parsed = await parseImportFile(file)
    if (parsed.error) {
      setFileError(parsed.error)
      setValidation(null)
      return
    }
    setFileError('')
    setFileName(file.name)
    setValidation(validateSubjectRows(parsed.rows || []))
  }

  const handleDrop = (event) => {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer?.files?.[0]
    if (file) chooseFile({ target: { files: [file] } })
  }

  const manualValidation = (() => {
    if (mode !== 'manual') return null
    const rows = manualRows.map((row) => ({
      subject_code: String(row.subject_code || '').trim().toUpperCase(),
      subject_name: String(row.subject_name || '').trim(),
    }))
    const nonEmpty = rows.filter(
      (row) => row.subject_code !== '' || row.subject_name !== ''
    )
    if (nonEmpty.length === 0) return null
    return validateSubjectRows(nonEmpty)
  })()

  const activeValidation = mode === 'upload' ? validation : manualValidation

  const importRows = async () => {
    if (!activeValidation?.validRows?.length) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const data = await createAdminSubjects(activeValidation.validRows)
      setResult(data)
      setValidation(null)
      setManualRows([emptySubject()])
      await load()
    } catch (err) {
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const renderAddForm = () => (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="section-title text-base">Add subjects</h3>
          <p className="text-muted-2 text-sm mb-0">
            A subject is a code and a name, shared by every department and cohort.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowAdd(false)
            resetForm()
          }}
          className="admin-modal-close"
          aria-label="Close"
        >
          <XIcon size={18} />
        </button>
      </div>

      <div className="mt-3 flex gap-2" role="tablist" aria-label="How to add subjects">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'upload'}
          onClick={() => {
            setMode('upload')
            setSubmitError(null)
          }}
          className={`btn-cf-outline px-3 py-1.5 text-sm ${mode === 'upload' ? 'ring-2 ring-blue-500' : ''}`}
        >
          Upload a file
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'manual'}
          onClick={() => {
            setMode('manual')
            setSubmitError(null)
          }}
          className={`btn-cf-outline px-3 py-1.5 text-sm ${mode === 'manual' ? 'ring-2 ring-blue-500' : ''}`}
        >
          Enter by hand
        </button>
      </div>

      {mode === 'upload' ? (
        <>
          <div
            className={`admin-dropzone mt-3 ${dragOver ? 'admin-dropzone-active' : ''}`}
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
              onChange={chooseFile}
              className="hidden"
              aria-label="Upload subjects file"
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
                <span className="font-semibold text-slate-500">subject_code, subject_name</span>
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
        </>
      ) : (
        <div className="mt-3">
          <ManualRowEditor
            columns={MANUAL_COLUMNS}
            rows={manualRows}
            onChange={setManualRows}
            makeEmptyRow={emptySubject}
            addLabel="Add another subject"
            rowLabel="Subject"
          />
        </div>
      )}

      {activeValidation && activeValidation.missingColumns.length > 0 && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
        >
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-bold">The file is missing required columns.</p>
            <p className="mt-1 text-red-600">
              Missing: {activeValidation.missingColumns.join(', ')}.
            </p>
          </div>
        </div>
      )}

      {activeValidation && activeValidation.missingColumns.length === 0 && (
        <div className="mt-3">
          <p className="mb-2 text-sm font-bold text-slate-700">
            Preview of {activeValidation.validRows.length} valid row
            {activeValidation.validRows.length === 1 ? '' : 's'}
            {activeValidation.invalidRows.length > 0
              ? `, ${activeValidation.invalidRows.length} will be skipped`
              : ''}
          </p>
          {activeValidation.invalidRows.length > 0 && (
            <ul className="mb-2 max-h-24 space-y-0.5 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {activeValidation.invalidRows.slice(0, 8).map((row) => (
                <li key={row.rowNumber}>
                  Row {row.rowNumber} — {row.reason}
                </li>
              ))}
            </ul>
          )}
          {activeValidation.validRows.length > 0 && (
            <ImportPreviewTable rows={activeValidation.validRows} columns={PREVIEW_COLUMNS} />
          )}
        </div>
      )}

      {submitError && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
        >
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          {submitError}
        </div>
      )}

      {result && (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <div className="flex items-center gap-2 font-bold">
            <CheckIcon size={16} />
            Done
          </div>
          <ul className="mt-1.5 space-y-0.5 text-xs">
            <li>
              <span className="font-bold">{result.created || 0}</span> subject
              {result.created === 1 ? '' : 's'} added.
            </li>
            <li>
              <span className="font-bold">{result.skipped || 0}</span> already existed and{' '}
              {result.skipped === 1 ? 'was' : 'were'} skipped.
            </li>
            {result.duplicates?.length > 0 && (
              <li>
                <span className="font-bold">{result.duplicates.length}</span> duplicate codes in the
                file skipped.
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setShowAdd(false)
            resetForm()
          }}
          className="btn-cf-outline px-4 py-2 text-sm"
        >
          {result ? 'Close' : 'Cancel'}
        </button>
        {!result && (
          <button
            type="button"
            onClick={importRows}
            disabled={submitting || !activeValidation || activeValidation.validRows.length === 0}
            className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
          >
            {submitting && <span className="cf-spinner" role="status" aria-hidden="true" />}
            {submitting ? 'Adding…' : 'Confirm'}
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="app-shell">
      <Navbar title="Subject Management" subtitle="Administrative Dashboard" onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5 page-enter">
        <button
          type="button"
          onClick={() => navigate('/admin/dashboard')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          <ChevronLeftIcon size={16} />
          Back to dashboard
        </button>

        <DashboardHero
          icon={<BookIcon size={26} />}
          title="Subjects"
          subtitle="Maintain the catalog of subjects shared by every department and cohort."
        />

        {error && <StatusMessage variant="danger">{error}</StatusMessage>}

        <section className="cf-card mt-4 p-4">
          <div className="cf-card-header">
            <div>
              <h2 className="section-title">Subject catalog</h2>
              <p className="text-muted-2 text-sm mb-0">
                {loading ? 'Loading subjects…' : `${filtered.length} subject${filtered.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="cf-input-group-custom w-full max-w-[220px]">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search subjects…"
                  className="cf-input"
                  aria-label="Search subjects"
                />
              </div>
              {!showAdd && (
                <button
                  type="button"
                  onClick={() => setShowAdd(true)}
                  className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
                >
                  <PlusIcon size={16} />
                  Add subjects
                </button>
              )}
            </div>
          </div>

          {showAdd && renderAddForm()}

          <div className="mt-3 overflow-x-auto">
            <table className="advisor-table">
              <thead>
                <tr>
                  <th className="advisor-table-num">#</th>
                  <th>Subject code</th>
                  <th>Subject name</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td className="advisor-table-empty" colSpan="3">
                      <span className="cf-spinner" role="status" aria-hidden="true" />
                      Loading subjects…
                    </td>
                  </tr>
                ) : filtered.length ? (
                  filtered.map((subject, index) => (
                    <tr key={subject.subject_id ?? subject.subject_code}>
                      <td className="advisor-table-num">{index + 1}</td>
                      <td className="advisor-table-reg">{subject.subject_code}</td>
                      <td>{subject.subject_name}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="advisor-table-empty" colSpan="3">
                      {search ? 'No subjects match your search.' : 'No subjects yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  )
}
