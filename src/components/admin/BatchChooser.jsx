/**
 * Step one of adding students: which cohort?
 *
 * Students live in per-cohort tables, so unlike staff there is nothing to add
 * without naming a batch. This step therefore always asks, and offers the two
 * genuinely different cases:
 *
 *   - an existing cohort, picked from a list the server supplied, and
 *   - a new cohort, typed as a year range and provisioned on demand.
 *
 * Both paths converge on the same key, which is all the rest of the workflow needs.
 * The new-batch path calls the provisioning endpoint here so the tables exist
 * *before* any student is inserted, rather than relying on the import to create
 * them; a failure therefore costs nothing and no half-populated table is left.
 *
 * Table names are never assembled here. The frontend sends a department and a batch
 * key and the server builds the physical names, so a malformed label cannot become
 * a table name even if the checks below were bypassed.
 */
import { useState } from 'react'
import { AlertIcon, CheckIcon, PlusIcon } from '../Icons'
import { createAdminBatch } from '../../api/adminApi'
import { formatBatchLabel, validateBatchInput } from '../../utils/batchValidation'

const NEW_BATCH = '__new__'

export default function BatchChooser({ department, batches, initialBatch, onResolved }) {
  const [choice, setChoice] = useState(initialBatch ? 'existing' : 'existing')
  const [existing, setExisting] = useState(initialBatch || '')
  const [typed, setTyped] = useState('')
  const [touched, setTouched] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)
  const [created, setCreated] = useState(null)

  const isNew = choice === NEW_BATCH
  const typedCheck = isNew ? validateBatchInput(typed) : null
  const showTypedError = isNew && touched && !typedCheck.valid

  const alreadyExists = isNew && typedCheck.valid && batches.some((b) => b.key === typedCheck.batch)

  const handleCreate = async () => {
    if (!typedCheck.valid) {
      setTouched(true)
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const data = await createAdminBatch(department, typedCheck.batch)
      setCreated({ key: data.batch, label: data.label || formatBatchLabel(data.batch) })
      onResolved(data.batch, formatBatchLabel(data.batch), Boolean(data.created))
    } catch (err) {
      setCreateError(err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="cf-form-label mb-2">Choose Batch</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setChoice('existing')}
            className={`rounded-xl border p-3 text-left transition-colors ${
              !isNew
                ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                : 'border-slate-200 bg-white hover:border-blue-300'
            }`}
          >
            <span className="block text-sm font-bold text-slate-800">Existing Batch</span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Add to a cohort that is already set up.
            </span>
          </button>
          <button
            type="button"
            onClick={() => setChoice(NEW_BATCH)}
            className={`rounded-xl border p-3 text-left transition-colors ${
              isNew
                ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                : 'border-slate-200 bg-white hover:border-blue-300'
            }`}
          >
            <span className="block text-sm font-bold text-slate-800">New Batch</span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Create the cohort and its tables, then add students.
            </span>
          </button>
        </div>
      </div>

      {!isNew ? (
        <div>
          <label htmlFor="addStudentsBatch" className="cf-form-label">
            Batch
          </label>
          <select
            id="addStudentsBatch"
            value={existing}
            onChange={(e) => setExisting(e.target.value)}
            className="cf-select"
          >
            <option value="">Select a batch</option>
            {batches.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>
          {batches.length === 0 && (
            <p className="mt-1 text-xs text-amber-700">
              {department} has no batches yet. Choose &quot;New Batch&quot; to create the first one.
            </p>
          )}
          {existing && (
            <button
              type="button"
              onClick={() => onResolved(existing, formatBatchLabel(existing), false)}
              className="btn-cf-primary mt-2 inline-flex items-center gap-2 px-4 py-2 text-sm"
            >
              <CheckIcon size={16} />
              Continue with {formatBatchLabel(existing)}
            </button>
          )}
        </div>
      ) : (
        <div>
          <label htmlFor="addStudentsNewBatch" className="cf-form-label">
            New batch
          </label>
          <input
            id="addStudentsNewBatch"
            type="text"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value)
              setCreateError(null)
              setCreated(null)
            }}
            onBlur={() => setTouched(true)}
            placeholder="2027_2031"
            className="cf-input"
            disabled={creating}
          />
          <p className="mt-1 text-xs text-slate-500">
            A four-year cohort, written as the admission years. A space or dash works too.
          </p>

          {showTypedError && (
            <p role="alert" className="mt-1 text-xs font-semibold text-red-600">
              {typedCheck.message}
            </p>
          )}
          {alreadyExists && (
            <p className="mt-1 text-xs font-semibold text-amber-700">
              {department} already has {typedCheck.batch}. Switch to &quot;Existing Batch&quot; to add
              students to it.
            </p>
          )}

          {createError && (
            <div
              role="alert"
              className="mt-2 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              {createError.message}
            </div>
          )}

          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !typedCheck.valid || alreadyExists}
            className="btn-cf-primary mt-2 inline-flex items-center gap-2 px-4 py-2 text-sm"
          >
            {creating ? (
              <>
                <span className="cf-spinner" role="status" aria-hidden="true" />
                Creating…
              </>
            ) : (
              <>
                <PlusIcon size={16} />
                Create batch and continue
              </>
            )}
          </button>

          {created && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700">
              <CheckIcon size={14} />
              {department} {created.label} is ready. Its student and attendance tables were created.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
