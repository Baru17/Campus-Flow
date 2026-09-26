import { CalendarIcon, CheckIcon, ClockIcon } from './Icons'
import { formatDate } from '../utils/format'

export default function AttendanceSuccess({ result, onDone, onAnother }) {
  const student = result?.student || {}
  const attendance = result?.attendance || {}
  const hasSubject = Boolean(attendance?.subject_id)
  const markedTime = attendance?.marked_at || attendance?.attendance_date

  const cell = 'min-w-0'
  const label = 'text-[11px] font-bold uppercase tracking-wider text-slate-400'
  const value = 'mt-0.5 truncate text-sm font-bold text-slate-800'

  return (
    <div className="stage-enter flex flex-col items-center text-center">
      <div className="success-wrap">
        <span className="success-ring" aria-hidden="true" />
        <div className="success-check success-check-draw" aria-hidden="true">
          <CheckIcon size={42} />
        </div>
      </div>

      <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
        Attendance Marked Successfully
      </h1>
      <p className="mt-2 text-slate-500">Your presence has been recorded for this session.</p>

      <div className="mt-6 w-full max-w-sm rounded-2xl border border-slate-200 bg-slate-50/70 p-5 text-left">
        <div className="grid grid-cols-2 gap-x-4 gap-y-4">
          <div className={cell}>
            <div className={label}>Student</div>
            <div className={value}>{student.student_name || '—'}</div>
          </div>
          <div className={cell}>
            <div className={label}>Student ID</div>
            <div className={value}>{student.student_id || '—'}</div>
          </div>
          <div className={cell}>
            <div className={label}>Department</div>
            <div className={value}>{student.department || '—'}</div>
          </div>
          <div className={cell}>
            <div className={label}>Register No.</div>
            <div className={value}>{student.register_no || '—'}</div>
          </div>
          {hasSubject && (
            <div className={cell}>
              <div className={label}>Subject</div>
              <div className={value}>Subject {attendance.subject_id}</div>
            </div>
          )}
          <div className={cell}>
            <div className={label}>Status</div>
            <div className="mt-0.5 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Present
            </div>
          </div>
        </div>

        {(attendance.attendance_date || markedTime) && (
          <div className="mt-4 flex items-center justify-center gap-4 border-t border-slate-200 pt-4 text-xs text-slate-500">
            {attendance.attendance_date && (
              <span className="inline-flex items-center gap-1">
                <CalendarIcon size={13} />
                {formatDate(attendance.attendance_date)}
              </span>
            )}
            {markedTime && (
              <span className="inline-flex items-center gap-1">
                <ClockIcon size={13} />
                {new Date(markedTime).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mt-7 flex w-full max-w-sm flex-col gap-3 sm:flex-row">
        <button type="button" onClick={onDone} className="auth-btn-primary flex-1">
          Done
        </button>
        <button type="button" onClick={onAnother} className="auth-btn-secondary flex-1">
          Mark Another Student
        </button>
      </div>
    </div>
  )
}