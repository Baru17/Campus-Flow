import { useCallback, useEffect, useRef, useState } from 'react'
import { getReport } from '../api/classAdvisorApi'
import AttendanceReportTable from './AttendanceReportTable'
import StatChip from './StatChip'
import StatusMessage from './StatusMessage'
import { CheckIcon, ChevronRightIcon, CopyIcon, UsersIcon, XIcon } from './Icons'
import { formatClassName } from '../utils/format'
import { copyTextToClipboard } from '../utils/clipboard'

/*
 * The staff dashboard's attendance summary and report.
 *
 * It is deliberately presentational: all fetching, permission gating and editing live
 * in `useStaffAttendance`, so the "Total: present / strength" line above the OTP section
 * and this panel read from one source and can never disagree.
 *
 * The summary shows Present, Absent and Total class strength, and keeps any students
 * with no recorded status out of both counts (they are reported as "not marked" rather
 * than being mislabelled absent). The report panel reuses the Class Advisor's own
 * `AttendanceReportTable` (same columns, same Present/Absent editing) and copies the
 * Class Advisor's report text verbatim through `getReport`, so there is only one format.
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

  const handleCopyReport = useCallback(async () => {
    if (!session || copyState === 'copying') return
    setCopyError(null)
    setCopyState('copying')
    try {
      const data = await getReport(session.attendance_date, session.period)
      if (!data || !data.report) {
        throw new Error('The report is not available for this session yet.')
      }
      await copyTextToClipboard(data.report)
      setCopyState('copied')
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopyState('idle'), 2500)
    } catch (error) {
      setCopyState('idle')
      setCopyError(error?.message || 'Could not copy the report. Please try again.')
    }
  }, [session, copyState])

  if (!session) return null

  const {
    phase,
    message,
    students,
    attendanceMap,
    presentCount,
    absentCount,
    unmarkedCount,
    totalStrength,
    percentage,
    savingId,
    saveError,
    toggle,
  } = attendance

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
          Attendance for this class is restricted to its Class Advisor on the server.{' '}
          {message || 'A staff account cannot read it.'} No summary or report is shown, and no
          numbers are guessed. Ask an administrator to assign you as the Class Advisor.
        </StatusMessage>
      )
    }
    if (phase === 'no-assignment') {
      return (
        <StatusMessage variant="info">
          Your account is not assigned as a Class Advisor, so this class&rsquo;s attendance
          report cannot be read. It stays available on the Class Advisor dashboard.
        </StatusMessage>
      )
    }
    if (phase === 'mismatch') {
      return (
        <StatusMessage variant="warning">
          This OTP was generated for {classLabel}, but the report can only be read for the
          Class Advisor&rsquo;s own assigned class.
        </StatusMessage>
      )
    }
    if (phase === 'different-session') {
      return (
        <StatusMessage variant="warning">
          This slot now belongs to a newer attendance session, so the report for the session
          whose OTP you generated cannot be shown.
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
            <StatChip
              icon={<UsersIcon size={18} />}
              label="Total strength"
              value={totalStrength}
              tone="violet"
            />
          </div>

          <p className="text-muted-2 text-sm mb-0 mt-2">
            Overall attendance: {percentage}%
            {unmarkedCount > 0
              ? ` · ${unmarkedCount} not marked yet`
              : ' · every student has a recorded status'}
          </p>
          <p className="text-muted-2 text-sm mb-0">
            Present + Absent = {presentCount + absentCount} of {totalStrength}
            {unmarkedCount > 0 ? ` (${unmarkedCount} still unmarked)` : ''}
          </p>

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
                  {presentCount} present · {absentCount} absent · {unmarkedCount} not marked
                </p>
                <button
                  type="button"
                  className="btn-cf-primary inline-flex items-center gap-2"
                  onClick={handleCopyReport}
                  disabled={copyState === 'copying'}
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
