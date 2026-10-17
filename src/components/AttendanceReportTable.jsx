import { useMemo, useState } from 'react'
import { SearchIcon } from './Icons'

/*
 * Shared attendance report table used by the Class Advisor dashboard and the
 * staff OTP session report. It owns the search/filter and renders the list
 * with Present/Absent toggles.
 */
export default function AttendanceReportTable({
  students = [],
  attendanceMap = {},
  loading = false,
  savingId = null,
  onToggle,
  emptyText = 'No students found for this class.',
}) {
  const [query, setQuery] = useState('')

  const filteredStudents = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return students
    return students.filter(
      (s) =>
        s.student_name.toLowerCase().includes(q) || s.register_no.toLowerCase().includes(q),
    )
  }, [students, query])

  return (
    <>
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
            {loading ? (
              <tr>
                <td colSpan={5} className="advisor-table-empty">
                  <span className="cf-spinner" role="status" aria-hidden="true" />
                  Loading attendance…
                </td>
              </tr>
            ) : filteredStudents.length === 0 ? (
              <tr>
                <td colSpan={5} className="advisor-table-empty">
                  {query ? 'No students match your search.' : emptyText}
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
                      ) : status === 'OD' ? (
                        <span className="cf-status-pill od">
                          <span className="dot" aria-hidden="true" /> OD
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
                            onClick={() => onToggle?.(student.register_no, 'PRESENT')}
                            disabled={Boolean(savingId)}
                          >
                            Present
                          </button>
                          <button
                            type="button"
                            className={`advisor-edit-btn ${
                              status === 'ABSENT' ? 'is-active is-absent' : ''
                            }`}
                            onClick={() => onToggle?.(student.register_no, 'ABSENT')}
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
    </>
  )
}
