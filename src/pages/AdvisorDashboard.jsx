import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatChip from '../components/StatChip'
import DropdownField from '../components/DropdownField'
import LoadingButton from '../components/LoadingButton'
import StatusMessage from '../components/StatusMessage'
import {
  getAdvisorAssignment,
  getClassStudents,
  getAttendance,
  patchAttendance,
  getReport,
  getAttendanceTable,
} from '../api/classAdvisorApi'
import { downloadAttendanceExcel } from '../utils/attendanceExcel'
import { formatClassName } from '../utils/format'
import { PERIODS } from '../constants'
import { useClock } from '../hooks/useClock'
import { useStaffAuth } from '../hooks/useStaffAuth'
import {
  CheckIcon,
  CalendarIcon,
  ClockIcon,
  CompassIcon,
  CopyIcon,
  DownloadIcon,
  GraduationIcon,
  SearchIcon,
  ShieldIcon,
  UsersIcon,
  XIcon,
} from '../components/Icons'

function todayISO() {
  return new Date().toISOString().split('T')[0]
}

export default function AdvisorDashboard() {
  const clock = useClock()
  const navigate = useNavigate()
  const { staff, loading, logout } = useStaffAuth()

  const [advisor, setAdvisor] = useState(null)
  const [advisorLoading, setAdvisorLoading] = useState(false)
  const [advisorError, setAdvisorError] = useState(null)

  const [students, setStudents] = useState([])
  const [studentsLoading, setStudentsLoading] = useState(false)
  const [studentsError, setStudentsError] = useState(null)

  const [date, setDate] = useState(todayISO())
  const [period, setPeriod] = useState('')
  const [subjectCode, setSubjectCode] = useState('')
  const [subjectName, setSubjectName] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [attendanceMap, setAttendanceMap] = useState({})
  const [odMap, setOdMap] = useState({})
  const [attendanceLoading, setAttendanceLoading] = useState(false)
  const [attendanceError, setAttendanceError] = useState(null)

  const [query, setQuery] = useState('')
  const [savingId, setSavingId] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [excelStatus, setExcelStatus] = useState(null)

  useEffect(() => {
    if (!loading && !staff) {
      navigate('/role-selection', { replace: true })
    }
  }, [loading, staff, navigate])

  useEffect(() => {
    if (!staff) return
    let cancelled = false
    setAdvisorLoading(true)
    setAdvisorError(null)
    getAdvisorAssignment(staff.staff_id)
      .then((assignment) => {
        if (!cancelled) setAdvisor(assignment)
      })
      .catch((err) => {
        if (!cancelled) setAdvisorError(err.message)
      })
      .finally(() => {
        if (!cancelled) setAdvisorLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [staff])

  useEffect(() => {
    if (!advisor) return
    let cancelled = false
    setStudentsLoading(true)
    setStudentsError(null)
    getClassStudents(advisor.department, advisor.year, advisor.section)
      .then((rows) => {
        if (!cancelled) setStudents(rows)
      })
      .catch((err) => {
        if (!cancelled) setStudentsError(err.message)
      })
      .finally(() => {
        if (!cancelled) setStudentsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [advisor])

  const attendanceTable = advisor ? getAttendanceTable(advisor.department, advisor.year) : null

  useEffect(() => {
    if (!advisor || !date || !period) return
    let cancelled = false
    setAttendanceLoading(true)
    setAttendanceError(null)
    setSubjectCode('')
    setSubjectName('')
    setSessionId('')
    setAttendanceMap({})
    setOdMap({})

    getAttendance(date, period, advisor)
      .then((data) => {
        if (!cancelled && data) {
          if (data.session_id) {
            setSubjectCode(data.subject_code || '')
            setSubjectName(data.subject_name || '')
            setSessionId(data.session_id || '')
            const map = {}
            const od = {}
            for (const s of data.students) {
              if (s.status) map[s.register_no] = s.status
              if (s.od === 'YES') od[s.register_no] = true
            }
            setAttendanceMap(map)
            setOdMap(od)
          }
        } else if (!cancelled) {
          setAttendanceMap({})
        }
      })
      .catch((err) => {
        if (!cancelled) setAttendanceError(err.message)
      })
      .finally(() => {
        if (!cancelled) setAttendanceLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [advisor, attendanceTable, date, period])

  const handleLogout = async () => {
    await logout()
    navigate('/role-selection', { replace: true })
  }

  const handleToggle = async (registerNo, nextStatus) => {
    setSaveError(null)
    setSavingId(registerNo)
    try {
      await patchAttendance(sessionId, registerNo, nextStatus)
      const refreshed = await getAttendance(date, period)
      if (refreshed?.session_id) {
        setSessionId(refreshed.session_id)
        setSubjectCode(refreshed.subject_code || '')
        setSubjectName(refreshed.subject_name || '')
        const nextAttendance = {}
        const nextOd = {}
        for (const student of refreshed.students) {
          if (student.status) nextAttendance[student.register_no] = student.status
          if (student.od === 'YES') nextOd[student.register_no] = true
        }
        setAttendanceMap(nextAttendance)
        setOdMap(nextOd)
      }
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSavingId(null)
    }
  }

  const handleCopyReport = async () => {
    setSaveError(null)
    if (!sessionId || !date || !period) return
    try {
      const data = await getReport(date, period)
      if (data && data.report) {
        try {
          await navigator.clipboard.writeText(data.report)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          setSaveError('Could not copy the report. Please try again.')
        }
      }
    } catch (err) {
      setSaveError(err.message)
    }
  }

  const handleDownload = async () => {
    setExcelStatus(null)
    if (students.length === 0) {
      setExcelStatus({ type: 'danger', text: 'No students are loaded for this class.' })
      return
    }
    if (attendanceLoading) {
      setExcelStatus({ type: 'danger', text: 'Attendance is still loading. Please wait.' })
      return
    }
    if (!subjectName) {
      setExcelStatus({ type: 'danger', text: 'No subject loaded for this session.' })
      return
    }
    try {
      downloadAttendanceExcel({
        department: advisor.department,
        year: advisor.year,
        section: advisor.section,
        date,
        subjectCode,
        period,
        students,
        attendanceMap,
      })
      setExcelStatus({ type: 'success', text: 'Excel downloaded successfully.' })
    } catch {
      setExcelStatus({ type: 'danger', text: 'Could not generate the Excel file. Please try again.' })
    } finally {
      setDownloading(false)
    }
  }

  const filteredStudents = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return students
    return students.filter(
      (s) =>
        s.student_name.toLowerCase().includes(q) || s.register_no.toLowerCase().includes(q),
    )
  }, [students, query])

  const presentCount = useMemo(
    () => students.filter((s) => attendanceMap[s.register_no] === 'PRESENT').length,
    [students, attendanceMap],
  )
  const absentCount = useMemo(
    () => students.filter((s) => attendanceMap[s.register_no] === 'ABSENT').length,
    [students, attendanceMap],
  )
  const odCount = useMemo(
    () => students.filter((student) => odMap[student.register_no]).length,
    [students, odMap],
  )
  const notMarkedCount = Math.max(students.length - presentCount - absentCount, 0)
  const attendancePercentage = students.length
    ? Math.round((presentCount / students.length) * 100)
    : 0

  const canLoadAttendance = Boolean(date && period && sessionId)

  if (loading) {
    return (
      <div className="app-shell">
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Checking your session…</p>
          </div>
        </div>
      </div>
    )
  }

  if (!staff) return null

  if (advisorLoading || (!advisor && !advisorError)) {
    return (
      <div className="app-shell">
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Resolving your advisor assignment…</p>
          </div>
        </div>
      </div>
    )
  }

  if (!advisor && !advisorLoading) {
    return (
      <div className="app-shell">
        <Navbar
          title="Class Advisor"
          subtitle={staff ? staff.staff_name : ''}
          onLogout={handleLogout}
        />
        <main className="container-cf py-4 lg:py-5 page-enter">
          <div className="cf-empty">
            <span className="cf-empty-icon">
              <ShieldIcon size={30} />
            </span>
            <h3 className="section-title mb-0">No class advisor assignment</h3>
            <p className="text-muted-2 mb-0">
              {advisorError ||
                'Your account is not assigned as a Class Advisor. Please contact the administrator.'}
            </p>
          </div>
        </main>
      </div>
    )
  }

  const classLabel = advisor ? formatClassName(advisor.department, advisor.year, advisor.section) : '—'
  const advisorLabel = staff ? `${staff.staff_name} · ${classLabel}` : classLabel

  return (
    <div className="app-shell">
      <Navbar title="Class Advisor" subtitle={advisorLabel} onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5 page-enter">
        {advisor && (
          <>
            <DashboardHero
              icon={<GraduationIcon size={26} />}
              title="Class Advisor Dashboard"
              subtitle={`${clock.greeting}, ${staff.staff_name} — attendance report for ${classLabel}.`}
              right={
                <div className="live-clock">
                  <div className="time">{clock.time}</div>
                  <div className="date">{clock.date}</div>
                </div>
              }
            />

            <div className="stat-strip stagger">
              <StatChip
                icon={<UsersIcon size={18} />}
                label="Total strength"
                value={students.length}
                tone="violet"
              />
              <StatChip
                icon={<CheckIcon size={18} />}
                label="Present"
                value={presentCount}
                tone="green"
              />
              <StatChip
                icon={<XIcon size={18} />}
                label="Absent"
                value={absentCount}
                tone="amber"
              />
              <StatChip
                icon={<CheckIcon size={18} />}
                label="OD"
                value={odCount}
                tone="primary"
              />
              <StatChip
                icon={<CompassIcon size={18} />}
                label="Attendance"
                value={`${attendancePercentage}%`}
                tone="primary"
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-12">
                <div className="cf-card cf-card-hover p-3 md:p-4">
                  <div className="cf-card-header">
                    <div>
                      <h2 className="section-title">Attendance Report</h2>
                      <p className="text-muted-2 text-sm mb-0">
                        Pick a date and hour to view or edit attendance. The subject loads automatically.
                      </p>
                    </div>
                    <span className="cf-icon-badge">
                      <CalendarIcon size={22} />
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <label htmlFor="advisorDate" className="cf-form-label">
                        <CalendarIcon size={14} className="text-muted-2" />
                        Date
                      </label>
                      <input
                        id="advisorDate"
                        type="date"
                        className="cf-select"
                        value={date}
                        max={todayISO()}
                        onChange={(e) => {
                          setDate(e.target.value)
                          setAttendanceError(null)
                        }}
                      />
                    </div>
                    <DropdownField
                      label="Hour / Period"
                      name="period"
                      value={period}
                      onChange={setPeriod}
                      options={PERIODS}
                      placeholder="Select hour"
                      icon={<ClockIcon size={15} />}
                    />
                    <div className="sm:col-span-2">
                      {subjectCode && (
                        <div className="cf-select" style={{ pointerEvents: 'none', opacity: 0.85 }}>
                          <span className="text-sm font-medium">
                            {subjectCode} — {subjectName}
                          </span>
                        </div>
                      )}
                      {!subjectCode && (
                        <div className="cf-select" style={{ opacity: 0.6 }}>
                          <span className="text-sm text-muted-2">Select date and period to load subject</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {attendanceError && (
                    <div className="mt-3">
                      <StatusMessage variant="danger">{attendanceError}</StatusMessage>
                    </div>
                  )}
                  {studentsError && (
                    <div className="mt-3">
                      <StatusMessage variant="danger">{studentsError}</StatusMessage>
                    </div>
                  )}
                  {saveError && (
                    <div className="mt-3">
                      <StatusMessage variant="danger">{saveError}</StatusMessage>
                    </div>
                  )}
                </div>
              </div>

              {canLoadAttendance && (
                <>
                  <div className="lg:col-span-12">
                    <div className="cf-card p-3 md:p-4">
                      <div className="cf-card-header">
                        <div>
                          <h3 className="section-title">
                            {classLabel} · {subjectCode || '—'} · Hour {period}
                          </h3>
                          <p className="text-muted-2 text-sm mb-0">
                            {presentCount} present · {absentCount} absent · {notMarkedCount} not marked
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <LoadingButton
                            variant="outline"
                            onClick={handleDownload}
                            loading={downloading}
                            loadingText="Downloading…"
                            disabled={students.length === 0 || attendanceLoading}
                            className="inline-flex items-center gap-2"
                          >
                            <DownloadIcon size={16} />
                            Download Excel
                          </LoadingButton>
                          <LoadingButton
                            variant="primary"
                            onClick={handleCopyReport}
                            loading={false}
                            disabled={!sessionId}
                            className="inline-flex items-center gap-2"
                          >
                            {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                            {copied ? 'Copied!' : 'Copy Report'}
                          </LoadingButton>
                        </div>
                      </div>

                      {excelStatus && (
                        <div className="mb-3">
                          <StatusMessage variant={excelStatus.type}>{excelStatus.text}</StatusMessage>
                        </div>
                      )}

                      <div className="mt-3">
                        <div className="relative">
                          <span className="auth-input-icon" aria-hidden="true">
                            <SearchIcon size={16} />
                          </span>
                          <input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search by student name or register number…"
                            className="auth-input"
                            aria-label="Search students"
                          />
                        </div>
                      </div>

                      <div className="mt-4 overflow-x-auto">
                        <table className="advisor-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Register No</th>
                              <th>Student Name</th>
                              <th>Status</th>
                              <th className="text-right">Edit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {attendanceLoading || studentsLoading ? (
                              <tr>
                                <td colSpan={5} className="advisor-table-empty">
                                  <span className="cf-spinner" role="status" aria-hidden="true" />
                                  Loading attendance…
                                </td>
                              </tr>
                            ) : filteredStudents.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="advisor-table-empty">
                                  {query
                                    ? 'No students match your search.'
                                    : 'No students found for this class.'}
                                </td>
                              </tr>
                            ) : (
                              filteredStudents.map((student, index) => {
                                const status = attendanceMap[student.register_no]
                                return (
                                  <tr key={student.register_no}>
                                    <td className="advisor-table-num">{index + 1}</td>
                                    <td className="advisor-table-reg">{student.register_no}</td>
                                    <td>{student.student_name}</td>
                                    <td>
                                      {status === 'PRESENT' ? (
                                        <span className="cf-status-pill active">
                                          <span className="dot" aria-hidden="true" /> Present
                                        </span>
                                      ) : status === 'ABSENT' ? (
                                        <span className="cf-status-pill expired">
                                          <span className="dot" aria-hidden="true" /> Absent
                                        </span>
                                      ) : (
                                        <span className="cf-status-pill idle">
                                          <span className="dot" aria-hidden="true" /> Not marked
                                        </span>
                                      )}
                                    </td>
                                    <td className="text-right">
                                      {savingId === student.register_no ? (
                                        <span className="cf-spinner" role="status" aria-hidden="true" />
                                      ) : (
                                        <div className="advisor-edit-group">
                                          <button
                                            type="button"
                                            className={`advisor-edit-btn ${
                                              status === 'PRESENT' ? 'is-active is-present' : ''
                                            }`}
                                            onClick={() => handleToggle(student.register_no, 'PRESENT')}
                                            disabled={Boolean(savingId)}
                                          >
                                            Present
                                          </button>
                                          <button
                                            type="button"
                                            className={`advisor-edit-btn ${
                                              status === 'ABSENT' ? 'is-active is-absent' : ''
                                            }`}
                                            onClick={() => handleToggle(student.register_no, 'ABSENT')}
                                            disabled={Boolean(savingId)}
                                          >
                                            Absent
                                          </button>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {!canLoadAttendance && (
                <div className="lg:col-span-12">
                  <div className="cf-empty">
                    <span className="cf-empty-icon">
                      <ShieldIcon size={30} />
                    </span>
                    <h3 className="section-title mb-0">Select a date and hour</h3>
                    <p className="text-muted-2 mb-0">
                      Choose the attendance slot you want to view or report on. The subject will load automatically.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}