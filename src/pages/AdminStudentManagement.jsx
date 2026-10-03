import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import AddStudentsModal from '../components/admin/AddStudentsModal'
import EditStudentModal from '../components/admin/EditStudentModal'
import DeleteRecordButton from '../components/admin/DeleteRecordButton'
import DeleteRecordModal from '../components/admin/DeleteRecordModal'
import {
  deleteAdminStudent,
  fetchAdminBatches,
  fetchAdminStudents,
} from '../api/adminApi'
import { useAdminAuth } from '../hooks/useAdminAuth'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
  StudentIcon,
  UsersIcon,
  PlusIcon,
  EditIcon,
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

  const [departments, setDepartments] = useState([])
  const [batchesByDepartment, setBatchesByDepartment] = useState({})
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
  const [editing, setEditing] = useState(null)
  /*
   * The row the confirmation dialog is open for, not a boolean.
   *
   * The dialog has to name who is being removed -- name, id, cohort -- and that has to
   * be the row as it was when the admin pressed the trash, not a second lookup made
   * after the fact. Holding the record also makes the dialog's own lifecycle fall out:
   * `null` means closed.
   */
  const [deleting, setDeleting] = useState(null)
  const [notice, setNotice] = useState(null)

  /*
   * Bumped after a write so the roster is fetched again.
   *
   * The table is refetched rather than patched in place, because the row on screen
   * has to be what D1 actually holds: the server normalises what it stores (a
   * section is upper-cased, an email is lower-cased) and resolves duplicates and
   * immutability itself, so a locally edited value could differ from the stored
   * one. A reload is also the only way a student who moved out of the current
   * search or sort leaves the list.
   */
  const [reloadToken, setReloadToken] = useState(0)

  /*
   * Departments and their cohorts, from `GET /api/admin/batches`.
   *
   * The response is keyed `batches`, an object of department -> cohort list. It used
   * to be read as `batchesByDepartment`, which is not a key the API ever returned, so
   * the lookup always produced `{}`, every department showed zero cohorts, and the
   * batch step rendered an empty grid. The bug was invisible from the API tests,
   * which only ever assert the response, and from the page itself, which rendered
   * "no batches" exactly as it would for a department that genuinely has none.
   *
   * The explicit check below is the guard that class of mistake needs: a missing key
   * is now an error the admin can see, rather than a silent empty list that reads as
   * legitimate data.
   */
  const loadMeta = useCallback(async () => {
    setMetaLoading(true)
    setMetaError(null)
    try {
      const data = await fetchAdminBatches()
      const batches = data?.batches
      if (!batches || typeof batches !== 'object') {
        throw new Error(
          'The batch list came back in an unexpected format. Reload the page; if it persists, tell an administrator.'
        )
      }
      setDepartments(data.departments || [])
      setBatchesByDepartment(batches)
    } catch (err) {
      setMetaError(err)
    } finally {
      setMetaLoading(false)
    }
  }, [])

  useEffect(() => {
    loadMeta()
  }, [loadMeta])

  // All departments now use batches.
  const departmentBatches = useMemo(() => {
    if (!department) return []
    return batchesByDepartment[department] || []
  }, [department, batchesByDepartment])

  const selectedBatch = useMemo(() => {
    if (!department || !batch) return null
    return departmentBatches.find((b) => b.key === batch) || null
  }, [department, batch, departmentBatches])

  const studentsReady = Boolean(department) && Boolean(batch)

  useEffect(() => {
    if (!studentsReady) {
      setStudents([])
      setStudentsError(null)
      return undefined
    }
    let cancelled = false
    setStudentsLoading(true)
    setStudentsError(null)
    fetchAdminStudents(department, batch)
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
  }, [studentsReady, department, batch, reloadToken])

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
    if (batch) {
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
          {departments.map((dept) => (
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          <ChevronLeftIcon size={16} />
          Back to departments
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
          {departmentBatches.map((b) => (
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
                <p className="mt-0.5 text-sm text-slate-500">View {b.label} students</p>
              </div>
              <ChevronRightIcon
                size={20}
                className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-blue-500"
              />
            </button>
          ))}

          {departmentBatches.length === 0 && (
            <div className="col-span-full rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
              <p className="text-sm text-slate-500">
                {department} has no batches yet. Use &quot;Add Students&quot; to create the first
                cohort.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  const renderStudentsStep = () => {
    const heading = selectedBatch
      ? `${department} → ${selectedBatch.label}`
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
            Back to batches
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
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {studentsLoading && (
                  <tr>
                    <td colSpan={SORTABLE_COLUMNS.length + 3} className="advisor-table-empty">
                      <span className="cf-spinner" role="status" aria-hidden="true" />
                      Loading students…
                    </td>
                  </tr>
                )}
                {!studentsLoading && !studentsError && paged.length === 0 && (
                  <tr>
                    <td colSpan={SORTABLE_COLUMNS.length + 3} className="advisor-table-empty">
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
                      <td className="advisor-table-num">
                        {/*
                          Edit and delete sit in one flex row so the actions column
                          keeps a single width across every table on the page; the
                          trash is narrower than the labelled Edit button and would
                          otherwise push the row's right edge around.
                        */}
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setEditing(student)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-blue-700 transition-colors hover:bg-blue-50"
                            aria-label={`Edit ${student.student_id}`}
                          >
                            <EditIcon size={14} />
                            Edit
                          </button>
                          <DeleteRecordButton
                            onClick={() => setDeleting(student)}
                            name={`student ${student.student_id}`}
                          />
                        </div>
                      </td>
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

        {notice && (
          <StatusMessage variant="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </StatusMessage>
        )}

        {metaLoading && (
          <div className="cf-empty">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Loading student records…</p>
          </div>
        )}

        {metaError && <StatusMessage variant="danger">{metaError.message}</StatusMessage>}

        {!metaLoading && !metaError && !department && renderDepartmentStep()}
        {!metaLoading && !metaError && department && !batch && renderBatchStep()}
        {!metaLoading && !metaError && department && batch && renderStudentsStep()}

        {showAdd && (
          <AddStudentsModal
            department={department}
            batch={selectedBatch}
            onClose={() => setShowAdd(false)}
            onImported={(result) => {
              setShowAdd(false)
              // Always reload: the modal may have provisioned a brand new cohort, and
              // the browse list has to show it afterwards.
              loadMeta()
              // Land on the cohort that was just populated, whether it already existed
              // or was created as part of this import.
              if (result?.batch) {
                setBatch(result.batch)
                setSearch('')
                setPage(1)
              }
            }}
          />
        )}
        {editing && (
          <EditStudentModal
            student={editing}
            department={department}
            batch={batch}
            onClose={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null)
              // Reload rather than patch the row, so what is shown next is a fresh
              // read of D1 and not the values this form happened to submit.
              setReloadToken((token) => token + 1)
              setNotice(
                `Updated ${saved?.student_name || editing.student_name} (${saved?.student_id || editing.student_id}).`
              )
            }}
          />
        )}
        {deleting && (
          <DeleteRecordModal
            title="Delete student?"
            entityLabel="student"
            name={deleting.student_name}
            details={[
              [deleting.student_id, department, batch].filter(Boolean).join(' · '),
              deleting.register_no ? `Register No ${deleting.register_no}` : null,
              [deleting.section, formatYearLabel(deleting.year)].filter(Boolean).join(' · '),
            ]}
            warning={`${department} ${batch} roster`}
            note="Attendance already recorded for this student is kept, and so are their OD requests. Their login is removed with the record unless another record still uses it."
            onConfirm={() =>
              deleteAdminStudent(deleting.student_id, { department, batch })
            }
            onClose={() => setDeleting(null)}
            /*
              Reached only once the request has succeeded, because the dialog swallows
              a rejection and stays open on it. Refetching rather than splicing the row
              out of `students` for the same reason the edit dialog does: the row that
              disappears has to be the one D1 no longer holds, and a reload is also the
              only way the count above the table, the current search and the current
              page are all corrected together.
            */
            onDeleted={() => {
              const { student_name: removedName, student_id: removedId } = deleting
              setDeleting(null)
              setReloadToken((token) => token + 1)
              setNotice(`Deleted ${removedName} (${removedId}).`)
            }}
          />
        )}
      </main>
    </div>
  )
}
