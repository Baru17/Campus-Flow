import { useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, StudentIcon } from './Icons'
import { isValidStudentId, normalizeStudentId } from '../utils/validation'

export default function StudentLogin({ onBack, onContinue }) {
  const [studentId, setStudentId] = useState('')
  const [error, setError] = useState(null)

  const handleSubmit = (event) => {
    event.preventDefault()
    const id = normalizeStudentId(studentId)
    if (!isValidStudentId(id)) {
      setError('Please enter a valid student ID.')
      return
    }
    setError(null)
    onContinue(id)
  }

  return (
    <div className="stage-enter flex flex-col">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
      >
        <ChevronLeftIcon size={16} />
        Back to role selection
      </button>

      <div className="mt-6 flex items-center gap-3">
        <span className="auth-step-icon">
          <StudentIcon size={22} />
        </span>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
            Student Attendance
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">Enter your student ID to continue.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
        <div>
          <label htmlFor="studentId" className="cf-form-label">
            <StudentIcon size={14} className="text-muted-2" />
            Student ID
          </label>
          <div className="relative">
            <span className="auth-input-icon" aria-hidden="true">
              <StudentIcon size={16} />
            </span>
            <input
              id="studentId"
              type="text"
              value={studentId}
              onChange={(e) => {
                setStudentId(e.target.value)
                setError(null)
              }}
              placeholder="e.g. 2K24IT001"
              className="auth-input"
              autoComplete="off"
              inputMode="text"
            />
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Format: 2K24IT001 — ask your staff if you need help finding your ID.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
          >
            {error}
          </div>
        )}

        <button type="submit" className="auth-btn-primary w-full">
          Continue
          <ChevronRightIcon size={18} />
        </button>
      </form>
    </div>
  )
}