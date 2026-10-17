import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getAdvisorAssignment,
  getClassStudents,
  getSessionAttendance,
  patchSessionAttendance,
} from '../api/classAdvisorApi'

/*
 * Attendance data for the staff dashboard's selected class and OTP session.
 *
 * Two sources, and which one is used depends only on whether a session exists:
 *
 *   - Once an OTP session exists, everything -- the summary, the table and the
 *     copyable report text -- is read from and written to that session through
 *     `/api/attendance/session/:sessionId`. Those routes are gated on the staff
 *     role and on the caller having generated the session, so a plain staff
 *     account can view, edit and copy the report for its own session. The
 *     class-advisor-only endpoints are not in this path at all.
 *   - Before any session exists, the `Total: present/strength` line still needs a
 *     class strength, and the only roster readable without a session is the class
 *     advisor's. That path is tried and, when the caller is not the advisor of the
 *     selected class, the phase reports that no number is available rather than
 *     inventing one.
 *
 * Every count is derived from the roster the server returns, so the summary card
 * and the table can never disagree, and nothing can go negative.
 */

function toStatusMap(rows) {
  const map = {}
  for (const row of rows || []) {
    if (row.status) map[row.register_no] = row.status
  }
  return map
}

function sameClass(assignment, target) {
  return (
    assignment.department === target.department &&
    assignment.batch === target.batch &&
    Number(assignment.year) === Number(target.year) &&
    assignment.section === target.section
  )
}

export default function useStaffAttendance({ session, staffId, selection }) {
  const [phase, setPhase] = useState('idle')
  const [message, setMessage] = useState(null)
  const [students, setStudents] = useState([])
  const [attendanceMap, setAttendanceMap] = useState({})
  const [report, setReport] = useState(null)
  const [savingId, setSavingId] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  const refresh = useCallback(() => setReloadKey((key) => key + 1), [])

  const target = useMemo(() => {
    if (session) {
      return {
        sessionId: session.session_id,
        date: session.attendance_date,
        period: session.period,
        department: session.department,
        year: session.year,
        section: session.section,
        batch: session.batch,
      }
    }
    if (!selection) return null
    const { department, batch, year, section } = selection
    if (!department || !batch || !year || !section) return null
    return { sessionId: null, date: null, period: null, department, year, section, batch }
  }, [session, selection])

  useEffect(() => {
    if (!staffId || !target) {
      setPhase('idle')
      setMessage(null)
      setStudents([])
      setAttendanceMap({})
      setReport(null)
      setSaveError(null)
      return undefined
    }

    let cancelled = false
    setMessage(null)
    setSaveError(null)

    ;(async () => {
      /*
       * Session path. The route answers only for a session this caller generated,
       * so this works for any staff role and needs no class-advisor assignment.
       */
      if (target.sessionId) {
        setPhase('loading')
        try {
          const data = await getSessionAttendance(target.sessionId)
          if (cancelled) return
          if (!data) {
            setPhase('error')
            setMessage('The attendance report for this session is not available yet.')
            return
          }
          const roster = Array.isArray(data.students) ? data.students : []
          setStudents(roster)
          setAttendanceMap(toStatusMap(roster))
          setReport(typeof data.report === 'string' ? data.report : null)
          setPhase('ready')
        } catch (error) {
          if (cancelled) return
          setPhase(error?.status === 403 ? 'denied' : 'error')
          setMessage(error?.message || null)
        }
        return
      }

      /*
       * No session yet: best-effort class strength through the advisor roster.
       * A plain staff account has no such roster, which is not an error here --
       * it simply has no strength to show before its first session.
       */
      setPhase('checking')
      try {
        const assignment = await getAdvisorAssignment(staffId)
        if (cancelled) return
        if (!assignment || !sameClass(assignment, target)) {
          setStudents([])
          setAttendanceMap({})
          setReport(null)
          setPhase('no-assignment')
          return
        }
        const roster = await getClassStudents()
        if (cancelled) return
        setStudents(Array.isArray(roster) ? roster : [])
        setAttendanceMap({})
        setReport(null)
        setPhase('ready')
      } catch {
        if (cancelled) return
        setStudents([])
        setAttendanceMap({})
        setReport(null)
        setPhase('no-assignment')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [staffId, target, reloadKey])

  const toggle = useCallback(
    async (registerNo, nextStatus) => {
      if (!target?.sessionId) return
      setSaveError(null)
      setSavingId(registerNo)
      try {
        await patchSessionAttendance(target.sessionId, registerNo, nextStatus)
        const data = await getSessionAttendance(target.sessionId)
        if (data) {
          const roster = Array.isArray(data.students) ? data.students : []
          setStudents(roster)
          setAttendanceMap(toStatusMap(roster))
          setReport(typeof data.report === 'string' ? data.report : null)
        }
      } catch (error) {
        setSaveError(error?.message || 'Could not save the attendance change.')
      } finally {
        setSavingId(null)
      }
    },
    [target],
  )

  const presentCount = useMemo(
    () => students.filter((s) => attendanceMap[s.register_no] === 'PRESENT').length,
    [students, attendanceMap],
  )
  const absentCount = useMemo(
    () => students.filter((s) => attendanceMap[s.register_no] === 'ABSENT').length,
    [students, attendanceMap],
  )
  /*
   * OD is a status of its own, written by finalization for an approved day, so it
   * is neither PRESENT nor ABSENT. It is still *marked*, which is why it has to be
   * subtracted from the "not marked" figure too, and it earns the same attendance
   * credit as PRESENT wherever a percentage is shown.
   */
  const odCount = useMemo(
    () =>
      students.filter(
        (s) => attendanceMap[s.register_no] === 'OD' || s.od === 'YES',
      ).length,
    [students, attendanceMap],
  )

  const totalStrength = students.length
  const unmarkedCount = Math.max(totalStrength - presentCount - absentCount - odCount, 0)

  return {
    phase,
    message,
    students,
    attendanceMap,
    report,
    savingId,
    saveError,
    presentCount,
    absentCount,
    odCount,
    unmarkedCount,
    totalStrength,
    // A live session is editable by the staff member who generated it.
    canEdit: Boolean(target?.sessionId) && phase === 'ready',
    toggle,
    refresh,
  }
}
