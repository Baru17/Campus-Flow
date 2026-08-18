import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import AddStudentsModal from '../components/admin/AddStudentsModal'
import { adminStudents } from '../api/adminApi'
import { useAdminAuth } from '../hooks/useAdminAuth'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
  StudentIcon,
  UsersIcon,
  PlusIcon,
} from '../components/Icons'
import { formatYearLabel } from '../utils/format'

const PAGE_SIZE = 15

const SORTABLE_COLUMNS = [
  { key: 'student_id', label: 'Student ID' },
  { key: 'register_no', label: 'Register No' },
  { key: 'student_name', label: 'Name' },
  { key: 'year', label: 'Year' },
  { key: 'section', label: 'Section' },
]

export default function AdminStudentManagement() {
  const navigate = useNavigate()
  const { logout } = useAdminAuth()

  const [meta, setMeta] = useState(null)
  const [metaLoading, setMetaLoading] = useState(true)
  const [metaError, setMetaError] = useState(null)

  const [department, setDepartment] = useState('')
  const [batch, setBatch] = useState('')

  const [students, setStudents] = useState([])
  const [studentsLoading, setStudentsLoading] = useState(false)
  const [studentsError, setStudentsError] = useState(null)

  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('register_no')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(1)
  const [showAdd, setShowAdd] = useState(false)

  const loadMeta = useCallback(async () => {
    setMetaLoading(true)
    setMetaError(null)
    try {
      const data = await adminStudents('meta')
      setMeta(data)
    } catch (err) {
      setMetaError(err)
    } finally {
      setMetaLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setMetaLoading(true)
    setMetaError(null)
    adminStudents('meta')
      .then((data) => {
        if (!cancelled) setMeta(data)
      })
      .catch((err) => {
        if (!cancelled) setMetaError(err)
      })
      .finally(() => {
        if (!cancelled) setMetaLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedBatch = useMemo(() => {
    if (department !== 'IT' || !meta) return null
    return (meta.it_batches || []).find((b) => b.key === batch) || null
  }, [department, batch, meta])

  const batchNeeded = department === 'IT'
  const studentsReady = Boolean(department) && (!batchNeeded || Boolean(batch))

  useEffect(() => {
    if (!studentsReady) {
      setStudents([])
      setStudentsError(null)
      return undefined
    }
    let cancelled = false
    setStudentsLoading(true)
    setStudentsError(null)
    adminStudents('list', { department, batch })
      .then((data) => {
        if (!cancelled) setStudents(data.students || [])
      })
      .catch((err) => {
        if (!cancelled) setStudentsError(err)
      })
      .finally(() => {
        if (!cancelled) setStudentsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [studentsReady, department, batch])

  const handleLogout = async () => {
    await logout()
    navigate('/admin', { replace: true })
  }

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
    setPage(1)
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    let rows = students
    if (term) {
      rows = students.filter((s) =>
        [s.student_id, s.register_no, s.student_name, String(s.section)]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term))
      )
    }
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true }) * dir
    })
  }, [students, search, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const handleDepartmentSelect = (dept) => {
    setDepartment(dept)
    setBatch('')
    setSearch('')
    setPage(1)
  }

  const handleBack = () => {
    if (batchNeeded && batch) {
      setBatch('')
      setSearch('')
      setPage(1)
    } else {
      setDepartment('')
      setBatch('')
      setSearch('')
      setPage(1)
    }
  }

  const renderDepartmentStep = () => (
    <div className="page-enter">
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate('/admin/dashboard')}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          <ChevronLeftIcon size={16} />
          Back to dashboard
        </button>
      </div>
      <div className="cf-card p-4 md:p-6">
        <div className="cf-card-header">
          <div>
            <h2 className="section-title">Select a department</h2>
            <p className="text-muted-2 text-sm mb-0">
              Choose the department whose students you want to manage.
            </p>
          </div>
          <span className="cf-icon-badge violet">
            <StudentIcon size={22} />
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {meta.departments.map((dept) => (
            <button
              key={dept}
              type="button"
              onClick={() => handleDepartmentSelect(dept)}
              className="admin-option-card admin-option-card-compact group text-left"
            >
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-extrabold tracking-tight text-slate-900 group-hover:text-blue-700">
                  {dept}
                </h3>
                <p className="mt-0.5 text-sm text-slate-500">Manage {dept} students</p>
              </div>
              <ChevronRightIcon
                size={20}
                className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-blue-500"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  const renderBatchStep = () => (
    <div className="page-enter">
      <div className="mb-4">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          <ChevronLeftIcon size={16} />
          Back to departments
        </button>
      </div>
      <div className="cf-card p-4 md:p-6">
        <div className="cf-card-header">
          <div>
            <h2 className="section-title">Select a batch — {department}</h2>
            <p className="text-muted-2 text-sm mb-0">
              {department} stores students in a separate table per batch.
            </p>
          </div>
          <span className="cf-icon-badge violet">
            <UsersIcon size={22} />
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {meta.it_batches.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => {
                setBatch(b.key)
                setSearch('')
                setPage(1)
              }}
              className="admin-option-card admin-option-card-compact group text-left"
            >
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-extrabold tracking-tight text-slate-900 group-hover:text-blue-700">
                  {b.label}
                </h3>
                <p className="mt-0.5 text-sm text-slate-500">Batch {b.label} students</p>
              </div>
              <ChevronRightIcon
                size={20}
                className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-blue-500"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  const renderStudentsStep = () => {
    const heading = department === 'IT'
      ? `${department} → ${selectedBatch ? selectedBatch.label : batch}`
      : department

    return (
      <div className="page-enter">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
          >
            <ChevronLeftIcon size={16} />
            Back to {batchNeeded ? 'batches' : 'departments'}
          </button>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
          >
            <PlusIcon size={16} />
            Add Students
          </button>
        </div>

        <div className="cf-card p-3 md:p-4">
          <div className="cf-card-header">
            <div>
              <h2 className="section-title">{heading}</h2>
              <p className="text-muted-2 text-sm mb-0">
                {studentsLoading ? 'Loading students…' : `${filtered.length} student${filtered.length === 1 ? '' : 's'} found`}
              </p>
            </div>
            <div className="cf-input-group-custom w-full max-w-[260px]">
              <span className="cf-input-icon" aria-hidden="true">
                <SearchIcon size={16} />
              </span>
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(1)
                }}
                placeholder="Search students…"
                className="cf-input pl-10"
                aria-label="Search students"
              />
            </div>
          </div>

          {studentsError && <StatusMessage variant="danger">{studentsError.message}</StatusMessage>}

          <div className="overflow-x-auto">
            <table className="advisor-table">
              <thead>
                <tr>
                  <th className="advisor-table-num">#</th>
                  {SORTABLE_COLUMNS.map((col) => (
                    <th key={col.key}>
                      <button
                        type="button"
                        onClick={() => handleSort(col.key)}
                        className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-blue-600"
                      >
                        {col.label}
                        {sortKey === col.key && (
                          <span aria-hidden="true">{sortDir === 'asc' ? '↑' : '↓'}</span>
                        )}
                      </button>
                    </th>
                  ))}
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {studentsLoading && (
                  <tr>
                    <td colSpan={SORTABLE_COLUMNS.length + 2} className="advisor-table-empty">
                      <span className="cf-spinner" role="status" aria-hidden="true" />
                      Loading students…
                    </td>
                  </tr>
                )}
                {!studentsLoading && !studentsError && paged.length === 0 && (
                  <tr>
                    <td colSpan={SORTABLE_COLUMNS.length + 2} className="advisor-table-empty">
                      {search ? 'No students match your search.' : 'No students found in this batch yet.'}
                    </td>
                  </tr>
                )}
                {!studentsLoading &&
                  paged.map((student, index) => (
                    <tr key={student.student_id || `${student.register_no}-${index}`}>
                      <td className="advisor-table-num">{(safePage - 1) * PAGE_SIZE + index + 1}</td>
                      <td className="font-bold">{student.student_id}</td>
                      <td className="advisor-table-reg">{student.register_no}</td>
                      <td>{student.student_name}</td>
                      <td>{formatYearLabel(student.year)}</td>
                      <td>
                        <span className="inline-flex rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700">
                          {student.section}
                        </span>
                      </td>
                      <td className="advisor-table-reg">{student.email || '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {filtered.length > PAGE_SIZE && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-500">
                Page {safePage} of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-cf-outline px-3 py-1.5 text-sm"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn-cf-outline px-3 py-1.5 text-sm"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Navbar title="Student Management" subtitle="Administrative Dashboard" onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5">
        <DashboardHero
          icon={<StudentIcon size={26} />}
          title="Student Management"
          subtitle="Browse students by department and batch, or import new records."
        />

        {metaLoading && (
          <div className="cf-empty">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Loading student records…</p>
          </div>
        )}

        {metaError && <StatusMessage variant="danger">{metaError.message}</StatusMessage>}

        {!metaLoading && !metaError && meta && !department && renderDepartmentStep()}
        {!metaLoading && !metaError && meta && department && batchNeeded && !batch && renderBatchStep()}
        {!metaLoading && !metaError && meta && department && (!batchNeeded || batch) && renderStudentsStep()}

        {showAdd && (
          <AddStudentsModal
            department={department}
            batch={selectedBatch}
            batches={meta?.it_batches || []}
            onClose={() => setShowAdd(false)}
            onImported={(result) => {
              setShowAdd(false)
              if (result?.batch) {
                setDepartment('IT')
                setBatch(result.batch)
                setSearch('')
                setPage(1)
                loadMeta()
              }
            }}
          />
        )}
      </main>
    </div>
  )
}
