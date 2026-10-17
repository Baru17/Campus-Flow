import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAdvisorAssignment, getAttendance, getReport, patchAttendance } from '../api/classAdvisorApi'
import AttendanceReportTable from './AttendanceReportTable'
import StatusMessage from './StatusMessage'
import {
  CheckIcon,
  ChevronRightIcon,
  CompassIcon,
  CopyIcon,
  XIcon,
} from './Icons'
import { formatClassName } from '../utils/format'
import { copyTextToClipboard } from '../utils/clipboard'

function normalizeDepartment(value) {
  return String(value ?? '').trim().toUpperCase()
}

function normalizeSection(value) {
  return String(value ?? '').trim().toUpperCase()
}

function assignmentCoversSession(assignment, session) {
  if (!assignment || !session) return false
  return (
    normalizeDepartment(assignment.department) === normalizeDepartment(session.department) &&
    Number(assignment.year) === Number(session.year) &&
    normalizeSection(assignment.section) === normalizeSection(session.section) &&
    String(assignment.batch ?? '') === String(session.batch ?? '')
  )
}

/*
 * The attendance summary for the staff member's own OTP session.
 *
 * It renders inline inside the session card, directly below the Subject row, and
 * only once the parent has decided the OTP has expired and finalization has settled.
 *
 * The read itself lives behind the Class Advisor endpoints on the server, so this
 * component never invents numbers: when the caller is not the Class Advisor of the
 * session's class it shows the exact reason the report cannot be opened instead of a
 * fabricated summary. The Copy Report action reuses the Class Advisor's own report
 * endpoint (`getReport`) and copies its text verbatim, so the format is identical.
 */
export default function StaffAttendanceReport({ session, staffId, enabled = true }) {
  const [phase, setPhase] = useState('checking')
  const [message, setMessage] = useState(null)
  const [students, setStudents] = useState([])
  const [attendanceMap, setAttendanceMap] = useState({})
  const [showAbsentees, setShowAbsentees] = useState(false)
  const [copyState, setCopyState] = useState('idle')
  const [copyError, setCopyError] = useState(null)
  const [savingId, setSavingId] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const copyTimer = useRef(null)

  const request = useMemo(
    () =>
      session
        ? {
            sessionId: session.session_id,
            date: session.attendance_date,
            period: session.period,
          }
        : null,
    [session],
  )

  const sessionKey = request?.sessionId

  const applyAttendanceData = useCallback((data) => {
    const nextMap = {}
    for (const student of data.students || []) {
      if (student.status) nextMap[student.register_no] = student.status
    }
    setAttendanceMap(nextMap)
    setStudents(Array.isArray(data.students) ? data.students : [])
  }, [])

  useEffect(() => {
    if (!enabled || !request || !staffId) return undefined
    let cancelled = false

    setPhase('checking')
    setMessage(null)

    ;(async () => {
      try {
        const assignment = await getAdvisorAssignment(staffId)
        if (cancelled) return
        if (!assignment) {
          setPhase('no-assignment')
          return
        }
        if (!assignmentCoversSession(assignment, session)) {
          setPhase('mismatch')
          return
        }

        setPhase('loading')
        const data = await getAttendance(request.date, request.period)
        if (cancelled) return
        if (!data || !data.session_id) {
          setPhase('no-session')
          return
        }
        if (data.session_id !== request.sessionId) {
          setPhase('different-session')
          return
        }
        applyAttendanceData(data)
        setPhase('ready')
      } catch (error) {
        if (cancelled) return
        setPhase(error?.status === 403 ? 'denied' : 'error')
        setMessage(error?.message || null)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [enabled, request, staffId, session, applyAttendanceData])

  // The summary belongs to one session; a new session starts collapsed and quiet.
  useEffect(() => {
    setShowAbsentees(false)
    setCopyState('idle')
    setCopyError(null)
    setSaveError(null)
  }, [sessionKey])

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  const presentCount = useMemo(
    () => students.filter((s) => attendanceMap[s.register_no] === 'PRESENT').length,
    [students, attendanceMap],
  )
  const absentCount = useMemo(
    () => students.filter((s) => attendanceMap[s.register_no] === 'ABSENT').length,
    [students, attendanceMap],
  )
  const absentStudents = useMemo(
    () => students.filter((s) => attendanceMap[s.register_no] === 'ABSENT'),
    [students, attendanceMap],
  )
  // Same calculation the Class Advisor report uses: present over total strength,
  // rounded, and 0 for an empty class so it can never read NaN or Infinity.
  const percentage = students.length ? Math.round((presentCount / students.length) * 100) : 0

  const handleCopyReport = useCallback(async () => {
    if (!request || copyState === 'copying') return
    setCopyError(null)
    setCopyState('copying')
    try {
      const data = await getReport(request.date, request.period)
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
  }, [request, copyState])

  const handleToggle = useCallback(
    async (registerNo, nextStatus) => {
      if (!request || !sessionKey) return
      setSaveError(null)
      setSavingId(registerNo)
      try {
        await patchAttendance(sessionKey, registerNo, nextStatus)
        const refreshed = await getAttendance(request.date, request.period)
        if (refreshed && refreshed.session_id === request.sessionId) {
          applyAttendanceData(refreshed)
        }
      } catch (error) {
        setSaveError(error?.message || 'Could not save the attendance change.')
      } finally {
        setSavingId(null)
      }
    },
    [request, sessionKey, applyAttendanceData],
  )

  if (phase === 'checking' || phase === 'loading') {
    return (
      <div className="flex items-center gap-2 text-muted-2 text-sm mt-2" role="status">
        <span className="cf-spinner" aria-hidden="true" />
        {phase === 'checking'
          ? 'Checking your access to this session report…'
          : 'Loading the attendance summary…'}
      </div>
    )
  }

  if (phase === 'denied') {
    return (
      <div className="mt-3">
        <StatusMessage variant="warning">
          This attendance report is restricted to the Class Advisor of this class on the
          server.{message ? ` (${message})` : ''} A staff account cannot read it, so no summary
          is shown. Ask an administrator to assign you as the Class Advisor, or open the Class
          Advisor dashboard.
        </StatusMessage>
      </div>
    )
  }

  if (phase === 'no-assignment') {
    return (
      <div className="mt-3">
        <StatusMessage variant="info">
          Your account is not assigned as a Class Advisor, so the attendance summary for this
          class cannot be read. The report stays available on the Class Advisor dashboard.
        </StatusMessage>
      </div>
    )
  }

  if (phase === 'mismatch') {
    return (
      <div className="mt-3">
        <StatusMessage variant="warning">
          This OTP was generated for {formatClassName(session.department, session.year, session.section, session.batch)},
          but the report can only be read for the Class Advisor&rsquo;s own assigned class. Sign in as the
          Class Advisor for this class to see the summary.
        </StatusMessage>
      </div>
    )
  }

  if (phase === 'different-session') {
    return (
      <div className="mt-3">
        <StatusMessage variant="warning">
          This slot now belongs to a newer attendance session, so the report for the session
          whose OTP you generated cannot be shown.
        </StatusMessage>
      </div>
    )
  }

  if (phase === 'no-session') {
    return (
      <div className="mt-3">
        <StatusMessage variant="info">
          No finalized attendance session was found for this slot.
        </StatusMessage>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="mt-3">
        <StatusMessage variant="danger">
          Could not load the attendance summary.{message ? ` ${message}` : ''}
        </StatusMessage>
      </div>
    )
  }

  return (
    <>
      <div className="cf-detail-row">
        <span className="cf-detail-label">
          <CheckIcon size={15} /> Present
        </span>
        <span className="cf-detail-value" data-testid="staff-report-present">
          {presentCount}
        </span>
      </div>
      <div className="cf-detail-row">
        <span className="cf-detail-label">
          <XIcon size={15} /> Absent
        </span>
        <span className="cf-detail-value" data-testid="staff-report-absent">
          {absentCount}
        </span>
      </div>
      <div className="cf-detail-row">
        <span className="cf-detail-label">
          <CompassIcon size={15} /> Overall Attendance
        </span>
        <span className="cf-detail-value">{percentage}%</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-cf-outline inline-flex items-center gap-2"
          aria-expanded={showAbsentees}
          aria-controls="staff-absent-panel"
          onClick={() => setShowAbsentees((open) => !open)}
        >
          <ChevronRightIcon
            size={16}
            className={`staff-absent-chevron${showAbsentees ? ' is-open' : ''}`}
          />
          {showAbsentees ? 'Hide Absent Students' : 'View Absent Students'}
        </button>
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

      <div
        id="staff-absent-panel"
        className={`staff-absent-panel${showAbsentees ? ' is-open' : ''}`}
        aria-hidden={!showAbsentees}
      >
        <div className="staff-absent-inner">
          <div className="staff-absent-card">
            {absentStudents.length === 0 ? (
              <p className="staff-absent-empty">No absent students for this session.</p>
            ) : (
              <ul className="staff-absent-list">
                {absentStudents.map((student) => (
                  <li key={student.register_no}>
                    <span className="staff-absent-name">{student.student_name}</span>
                    <span className="staff-absent-reg">{student.register_no}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {saveError && (
        <div className="mt-3">
          <StatusMessage variant="danger">{saveError}</StatusMessage>
        </div>
      )}

      {/*
        Present / Absent editing, exactly as on the Class Advisor dashboard.

        This is only reached in the `ready` phase, which requires the signed-in user
        to be the Class Advisor of this session's class -- the same rule the server
        enforces on the PATCH endpoint -- so the controls are only shown where the
        API actually allows the write.
      */}
      <div className="mt-4">
        <h4 className="section-title">Mark attendance</h4>
        <p className="text-muted-2 text-sm mb-0">
          {formatClassName(session.department, session.year, session.section, session.batch)} · Period{' '}
          {request.period} · {session.subject_code} - {session.subject_name}
        </p>
        <AttendanceReportTable
          students={students}
          attendanceMap={attendanceMap}
          loading={false}
          savingId={savingId}
          onToggle={handleToggle}
          emptyText="No students found for this class."
        />
      </div>
    </>
  )
}
