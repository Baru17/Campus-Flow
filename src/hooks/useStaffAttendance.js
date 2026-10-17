import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getAdvisorAssignment,
  getAttendance,
  getClassStudents,
  patchAttendance,
} from '../api/classAdvisorApi'

/*
 * Attendance data for the staff dashboard's selected class.
 *
 * The class-advisor endpoints are the only place the roster, the saved statuses and
 * the strength live, and the server restricts them to a Class Advisor whose assigned
 * class matches the session. So this hook resolves the caller's assignment first and
 * only reaches for data when the requested class is the advisor's own; otherwise it
 * reports the exact reason (`denied`, `no-assignment`, `mismatch`) instead of numbers
 * it cannot stand behind.
 *
 * Two sources, chosen so a strength is available even before an OTP exists:
 *   - a live session  -> `/attendance` (roster + saved statuses for that date/period)
 *   - no session yet  -> `/students`  (the authoritative roster, so `0 / strength`)
 *
 * Nothing is hardcoded and no record is counted twice: counts are derived once from the
 * roster (a register number appears at most once per class) and the status map.
 */

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
}

function sameClass(assignment, target) {
  if (!assignment || !target) return false
  return (
    normalize(assignment.department) === normalize(target.department) &&
    Number(assignment.year) === Number(target.year) &&
    normalize(assignment.section) === normalize(target.section) &&
    String(assignment.batch ?? '') === String(target.batch ?? '')
  )
}

function toStatusMap(rows) {
  const map = {}
  for (const row of rows || []) {
    if (row.status) map[row.register_no] = row.status
  }
  return map
}

export default function useStaffAttendance({ session, staffId, selection }) {
  const [phase, setPhase] = useState('idle')
  const [message, setMessage] = useState(null)
  const [students, setStudents] = useState([])
  const [attendanceMap, setAttendanceMap] = useState({})
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
      setSaveError(null)
      return undefined
    }

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
        if (!sameClass(assignment, target)) {
          setPhase('mismatch')
          return
        }

        setPhase('loading')

        if (target.sessionId) {
          const data = await getAttendance(target.date, target.period)
          if (cancelled) return
          if (data && data.session_id && data.session_id !== target.sessionId) {
            setPhase('different-session')
            return
          }
          if (data && data.session_id === target.sessionId) {
            setStudents(Array.isArray(data.students) ? data.students : [])
            setAttendanceMap(toStatusMap(data.students))
            setPhase('ready')
            return
          }
          // Session not readable yet (or gone): fall back to the roster for strength.
          const roster = await getClassStudents()
          if (cancelled) return
          setStudents(Array.isArray(roster) ? roster : [])
          setAttendanceMap({})
          setPhase('ready')
          return
        }

        const roster = await getClassStudents()
        if (cancelled) return
        setStudents(Array.isArray(roster) ? roster : [])
        setAttendanceMap({})
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
  }, [staffId, target, reloadKey])

  const toggle = useCallback(
    async (registerNo, nextStatus) => {
      if (!target?.sessionId) return
      setSaveError(null)
      setSavingId(registerNo)
      try {
        await patchAttendance(target.sessionId, registerNo, nextStatus)
        const data = await getAttendance(target.date, target.period)
        if (data && data.session_id === target.sessionId) {
          setStudents(Array.isArray(data.students) ? data.students : [])
          setAttendanceMap(toStatusMap(data.students))
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

  const totalStrength = students.length
  const unmarkedCount = Math.max(totalStrength - presentCount - absentCount, 0)
  const percentage = totalStrength ? Math.round((presentCount / totalStrength) * 100) : 0

  return {
    phase,
    message,
    students,
    attendanceMap,
    savingId,
    saveError,
    presentCount,
    absentCount,
    unmarkedCount,
    totalStrength,
    percentage,
    // Only a live session can be edited, and only after the class check above passed.
    canEdit: Boolean(target?.sessionId) && phase === 'ready',
    toggle,
    refresh,
  }
}
