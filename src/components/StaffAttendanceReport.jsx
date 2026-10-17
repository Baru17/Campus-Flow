import { useCallback, useEffect, useRef, useState } from 'react'
import AttendanceReportTable from './AttendanceReportTable'
import StatChip from './StatChip'
import StatusMessage from './StatusMessage'
import { CheckIcon, ChevronRightIcon, ClockIcon, CopyIcon, UsersIcon, XIcon } from './Icons'
import { formatClassName } from '../utils/format'
import { copyTextToClipboard } from '../utils/clipboard'

/*
 * The staff dashboard's attendance summary and report.
 *
 * It is deliberately presentational: all fetching, permission gating and editing live
 * in `useStaffAttendance`, so the "Total: present / strength" line above the OTP section
 * and this panel read from one source and can never disagree.
 *
 * The summary shows Present, Absent, OD and Total class strength, and keeps any students
 * with no recorded status out of every count (they are reported as "not marked" rather
 * than being mislabelled absent). OD is a status of its own -- written by finalization for
 * a student whose approved OD request covers that day -- so it is neither Present nor
 * Absent, but it still counts as attendance credit. The report panel reuses the shared
 * `AttendanceReportTable` (same columns, same Present/Absent editing) and copies the report
 * text the server built with the same shared formatter the Class Advisor's report uses, so
 * there is only one format and both copies carry the same PRESENT / OD / ABSENT sections.
 */
export default function StaffAttendanceReport({ session, attendance }) {
  const [open, setOpen] = useState(false)
  const [copyState, setCopyState] = useState('idle')
  const [copyError, setCopyError] = useState(null)
  const copyTimer = useRef(null)

  const sessionKey = session?.session_id

  useEffect(() => {
    setCopyState('idle')
    setCopyError(null)
  }, [sessionKey])

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  const {
    phase,
    message,
    students,
    attendanceMap,
    report,
    presentCount,
    absentCount,
    odCount,
    unmarkedCount,
    totalStrength,
    savingId,
    saveError,
    toggle,
  } = attendance

  const handleCopyReport = useCallback(async () => {
    if (!report || copyState === 'copying') return
    setCopyError(null)
    setCopyState('copying')
    try {
      await copyTextToClipboard(report)
      setCopyState('copied')
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopyState('idle'), 2500)
    } catch (error) {
      setCopyState('idle')
      setCopyError(error?.message || 'Could not copy the report. Please try again.')
    }
  }, [report, copyState])

  if (!session) return null

  const classLabel = formatClassName(session.department, session.year, session.section, session.batch)
  const ready = phase === 'ready'

  const unavailable = (() => {
    if (phase === 'checking' || phase === 'loading') {
      return (
        <div className="flex items-center gap-2 text-muted-2 text-sm" role="status">
          <span className="cf-spinner" aria-hidden="true" />
          {phase === 'checking' ? 'Checking your access to this session…' : 'Loading the attendance summary…'}
        </div>
      )
    }
    if (phase === 'denied') {
      return (
        <StatusMessage variant="warning">
          This session belongs to a different account, so its attendance cannot be shown here.
          {message ? ` ${message}` : ''}
        </StatusMessage>
      )
    }
    if (phase === 'error') {
      return (
        <StatusMessage variant="danger">
          Could not load the attendance summary.{message ? ` ${message}` : ''}
        </StatusMessage>
      )
    }
    return null
  })()

  return (
    <div className="cf-card p-3 md:p-4 mt-4 reveal reveal-2">
      <div className="cf-card-header">
        <div>
          <h3 className="section-title">Attendance Summary</h3>
          <p className="text-muted-2 text-sm mb-0">
            {classLabel} · Period {session.period} · {session.subject_code} - {session.subject_name}
          </p>
        </div>
      </div>

      {!ready && unavailable}

      {ready && (
        <>
          <div className="stat-strip">
            <StatChip icon={<CheckIcon size={18} />} label="Present" value={presentCount} tone="green" />
            <StatChip icon={<XIcon size={18} />} label="Absent" value={absentCount} tone="amber" />
            <StatChip icon={<ClockIcon size={18} />} label="OD" value={odCount} tone="violet" />
            <StatChip
              icon={<UsersIcon size={18} />}
              label="Total strength"
              value={totalStrength}
              tone="violet"
            />
          </div>

          <div className="mt-3">
            <button
              type="button"
              className="btn-cf-outline inline-flex items-center gap-2"
              aria-expanded={open}
              aria-controls="staff-report-panel"
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronRightIcon
                size={16}
                className={`staff-report-chevron${open ? ' is-open' : ''}`}
              />
              {open ? 'Hide Attendance Report' : 'View Attendance Report'}
            </button>
          </div>

          <div
            id="staff-report-panel"
            className={`staff-report-panel${open ? ' is-open' : ''}`}
            aria-hidden={!open}
          >
            <div className="staff-report-inner">
              {saveError && (
                <div className="mt-3">
                  <StatusMessage variant="danger">{saveError}</StatusMessage>
                </div>
              )}
              {copyState === 'copied' && (
                <div className="mt-3">
                  <StatusMessage variant="success">Attendance report copied successfully.</StatusMessage>
                </div>
              )}
              {copyError && (
                <div className="mt-3">
                  <StatusMessage variant="danger">{copyError}</StatusMessage>
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-2 text-sm mb-0">
                  {presentCount} present · {absentCount} absent · {odCount} OD ·{' '}
                  {unmarkedCount} not marked
                </p>
                <button
                  type="button"
                  className="btn-cf-primary inline-flex items-center gap-2"
                  onClick={handleCopyReport}
                  disabled={!report || copyState === 'copying'}
                >
                  {copyState === 'copied' ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                  {copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied!' : 'Copy Report'}
                </button>
              </div>

              <AttendanceReportTable
                students={students}
                attendanceMap={attendanceMap}
                loading={false}
                savingId={savingId}
                onToggle={toggle}
                emptyText="No students found for this class."
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
