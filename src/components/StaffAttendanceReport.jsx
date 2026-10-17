import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAdvisorAssignment, getAttendance, patchAttendance } from '../api/classAdvisorApi'
import AttendanceReportTable from './AttendanceReportTable'
import StatusMessage from './StatusMessage'
import { CalendarIcon } from './Icons'
import { formatClassName } from '../utils/format'

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

export default function StaffAttendanceReport({ session, staffId, expired = true }) {
  const [phase, setPhase] = useState('checking')
  const [message, setMessage] = useState(null)
  const [students, setStudents] = useState([])
  const [attendanceMap, setAttendanceMap] = useState({})
  const [sessionId, setSessionId] = useState('')
  const [subjectCode, setSubjectCode] = useState('')
  const [subjectName, setSubjectName] = useState('')
  const [savingId, setSavingId] = useState(null)
  const [saveError, setSaveError] = useState(null)

  const request = useMemo(
    () =>
      session
        ? {
            sessionId: session.session_id,
            date: session.attendance_date,
            period: session.period,
            department: session.department,
            year: session.year,
            section: session.section,
            batch: session.batch,
          }
        : null,
    [session],
  )

  const applyData = useCallback((data) => {
    setSessionId(data.session_id || '')
    setSubjectCode(data.subject_code || '')
    setSubjectName(data.subject_name || '')
    const next = {}
    for (const student of data.students || []) {
      if (student.status) next[student.register_no] = student.status
    }
    setAttendanceMap(next)
    setStudents(Array.isArray(data.students) ? data.students : [])
  }, [])

  useEffect(() => {
    if (!expired || !request || !staffId) return undefined
    let cancelled = false
    setPhase('checking')
    setMessage(null)
    setSaveError(null)

    ;(async () => {
      let assignment = null
      try {
        assignment = await getAdvisorAssignment(staffId)
      } catch (error) {
        if (cancelled) return
        /*
         * The class-advisor endpoints are restricted to class_advisor on the server.
         * A plain staff account is refused here; report the exact limitation.
         */
        setPhase('denied')
        setMessage(error?.message || null)
        return
      }
      if (cancelled) return
      if (!assignment) {
        setPhase('no-assignment')
        return
      }
      if (!assignmentCoversSession(assignment, request)) {
        setPhase('mismatch')
        return
      }

      setPhase('loading')
      try {
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
        applyData(data)
        setPhase('ready')
      } catch (error) {
        if (cancelled) return
        setPhase('error')
        setMessage(error?.message || null)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [expired, request, staffId, applyData])

  const handleToggle = useCallback(
    async (registerNo, nextStatus) => {
      if (!request) return
      setSaveError(null)
      setSavingId(registerNo)
      try {
        await patchAttendance(sessionId, registerNo, nextStatus)
        const refreshed = await getAttendance(request.date, request.period)
        if (refreshed?.session_id === sessionId) {
          applyData(refreshed)
        }
      } catch (error) {
        setSaveError(error?.message || 'Unable to update attendance.')
      } finally {
        setSavingId(null)
      }
    },
    [request, sessionId, applyData],
  )

  if (!request) return null
  if (!expired) return null

  const classLabel = formatClassName(request.department, request.year, request.section, request.batch)

  const presentCount = students.filter((s) => attendanceMap[s.register_no] === 'PRESENT').length
  const absentCount = students.filter((s) => attendanceMap[s.register_no] === 'ABSENT').length
  const notMarkedCount = Math.max(students.length - presentCount - absentCount, 0)

  return (
    <div className="cf-card cf-card-hover p-3 md:p-4 mt-4 reveal reveal-2">
      <div className="cf-card-header">
        <div>
          <h3 className="section-title">Absentees Report</h3>
          <p className="text-muted-2 text-sm mb-0">
            {classLabel} · Period {request.period}
            {phase === 'ready' && subjectCode ? ` · ${subjectCode} - ${subjectName}` : ''}
          </p>
        </div>
        <span className="cf-icon-badge">
          <CalendarIcon size={22} />
        </span>
      </div>

      {(phase === 'checking' || phase === 'loading') && (
        <div className="flex items-center gap-2 text-muted-2 text-sm">
          <span className="cf-spinner" role="status" aria-hidden="true" />
          {phase === 'checking' ? 'Checking your access to this report…' : 'Loading the report…'}
        </div>
      )}

      {phase === 'denied' && (
        <StatusMessage variant="warning">
          This attendance report is restricted to the Class Advisor of this class on the server.
          {message ? ` (${message}) ` : ' '}A staff account cannot read it. Ask an administrator
          to assign you as Class Advisor, or view the report from the Class Advisor dashboard.
        </StatusMessage>
      )}

      {phase === 'no-assignment' && (
        <StatusMessage variant="info">
          Your account is not assigned as a Class Advisor. The report requires Class Advisor
          permission.
        </StatusMessage>
      )}

      {phase === 'mismatch' && (
        <StatusMessage variant="warning">
          This OTP session was generated for {classLabel}, but the report can only be opened for
          the Class Advisor’s own assigned class. Sign in as the Class Advisor for this class to
          view and edit the report.
        </StatusMessage>
      )}

      {phase === 'different-session' && (
        <StatusMessage variant="warning">
          The report for this slot now belongs to a different session. The generated session’s
          report cannot be loaded because a newer session exists for the same slot.
        </StatusMessage>
      )}

      {phase === 'no-session' && (
        <StatusMessage variant="info">
          No attendance session was found for this slot ({classLabel}, Period {request.period}).
        </StatusMessage>
      )}

      {phase === 'error' && (
        <StatusMessage variant="danger">
          Unable to load the report. {message || 'The server returned an error.'}
        </StatusMessage>
      )}

      {phase === 'ready' && (
        <>
          <p className="text-muted-2 text-sm mb-0 mt-1">
            {presentCount} present · {absentCount} absent · {notMarkedCount} not marked
          </p>
          {saveError && (
            <div className="mt-3">
              <StatusMessage variant="danger">{saveError}</StatusMessage>
            </div>
          )}
          <AttendanceReportTable
            students={students}
            attendanceMap={attendanceMap}
            loading={false}
            savingId={savingId}
            onToggle={handleToggle}
            emptyText="No students found for this class."
          />
        </>
      )}
    </div>
  )
}
