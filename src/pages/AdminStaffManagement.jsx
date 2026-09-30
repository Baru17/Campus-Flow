import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import AddStaffModal from '../components/admin/AddStaffModal'
import { createAdminBatch, fetchAdminBatches, fetchAdminStaff } from '../api/adminApi'
import { useAdminAuth } from '../hooks/useAdminAuth'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
  StaffIcon,
  PlusIcon,
} from '../components/Icons'

const PAGE_SIZE = 15

const SORTABLE_COLUMNS = [
  { key: 'staff_name', label: 'Name' },
  { key: 'email', label: 'Email' },
]

export default function AdminStaffManagement() {
  const navigate = useNavigate()
  const { logout } = useAdminAuth()

  const [departments, setDepartments] = useState([])
  const [batchesByDepartment, setBatchesByDepartment] = useState({})
  const [metaLoading, setMetaLoading] = useState(true)
  const [metaError, setMetaError] = useState(null)

  const [department, setDepartment] = useState('')
  // Staff live in one table, but a class advisor belongs to a specific cohort, so
  // the batch is chosen up front and carried into the import.
  const [batch, setBatch] = useState('')

  const [showNewBatch, setShowNewBatch] = useState(false)
  const [newBatch, setNewBatch] = useState('')
  const [newBatchError, setNewBatchError] = useState(null)
  const [creatingBatch, setCreatingBatch] = useState(false)

  const [staff, setStaff] = useState([])
  const [staffLoading, setStaffLoading] = useState(false)
  const [staffError, setStaffError] = useState(null)

  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('staff_name')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(1)
  const [showAdd, setShowAdd] = useState(false)

  const loadMeta = useCallback(async () => {
    setMetaLoading(true)
    setMetaError(null)
    try {
      const data = await fetchAdminBatches()
      setDepartments(data.departments || [])
      setBatchesByDepartment(data.batchesByDepartment || {})
    } catch (err) {
      setMetaError(err)
    } finally {
      setMetaLoading(false)
    }
  }, [])

  useEffect(() => {
    loadMeta()
  }, [loadMeta])

  const departmentBatches = useMemo(() => {
    if (!department) return []
    return batchesByDepartment[department] || []
  }, [department, batchesByDepartment])

  const selectedBatch = useMemo(() => {
    if (!department || !batch) return null
    return departmentBatches.find((b) => b.key === batch) || null
  }, [department, batch, departmentBatches])

  /*
   * The staff list is per department, not per batch: `staff` is a single table and
   * a batch only scopes who the person advises. Loading it on department change
   * alone means switching between two cohorts of the same department does not
   * refetch an unchanged list.
   */
  useEffect(() => {
    if (!department) {
      setStaff([])
      setStaffError(null)
      return undefined
    }
    let cancelled = false
    setStaffLoading(true)
    setStaffError(null)
    fetchAdminStaff(department)
      .then((data) => {
        if (!cancelled) setStaff(data.staff || [])
      })
      .catch((err) => {
        if (!cancelled) setStaffError(err)
      })
      .finally(() => {
        if (!cancelled) setStaffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [department])

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

  const handleCreateBatch = async (event) => {
    event.preventDefault()
    if (creatingBatch) return
    setCreatingBatch(true)
    setNewBatchError(null)
    try {
      const data = await createAdminBatch(department, newBatch)
      setShowNewBatch(false)
      setNewBatch('')
      await loadMeta()
      setBatch(data.batch)
    } catch (err) {
      setNewBatchError(err)
    } finally {
      setCreatingBatch(false)
    }
  }

  const handleDepartmentSelect = (dept) => {
    setDepartment(dept)
    setBatch('')
    setSearch('')
    setPage(1)
  }

  const handleBack = () => {
    if (batch) {
      setBatch('')
      return
    }
    setDepartment('')
    setSearch('')
    setPage(1)
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    let rows = staff
    if (term) {
      rows = staff.filter((s) =>
        [s.staff_name, s.email, s.department, s.class_advisor, s.advisor_batch]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term))
      )
    }
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      return String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true }) * dir
    })
  }, [staff, search, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

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
              Choose the department whose staff records you want to manage.
            </p>
          </div>
          <span className="cf-icon-badge violet">
            <StaffIcon size={22} />
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
                <p className="mt-0.5 text-sm text-slate-500">Manage {dept} staff</p>
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
      <div className="mb-4 flex items-center gap-2">
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
              Staff are stored per department; the batch decides which cohort an advisor handles.
            </p>
          </div>
          <span className="cf-icon-badge violet">
            <StaffIcon size={22} />
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {departmentBatches.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setBatch(b.key)}
              className="admin-option-card admin-option-card-compact group text-left"
            >
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-extrabold tracking-tight text-slate-900 group-hover:text-blue-700">
                  {b.label}
                </h3>
                <p className="mt-0.5 text-sm text-slate-500">Add {department} staff for {b.label}</p>
              </div>
              <ChevronRightIcon
                size={20}
                className="shrink-0 text-slate-300 transition-all group-hover:translate-x-1 group-hover:text-blue-500"
              />
            </button>
          ))}

          <button
            type="button"
            onClick={() => {
              setShowNewBatch(true)
              setNewBatchError(null)
            }}
            className="admin-option-card admin-option-card-compact group text-left border-dashed"
          >
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-extrabold tracking-tight text-blue-700 group-hover:text-blue-800">
                New batch
              </h3>
              <p className="mt-0.5 text-sm text-slate-500">
                Create the cohort&apos;s tables, then add {department} staff to it.
              </p>
            </div>
            <PlusIcon size={20} className="shrink-0 text-slate-300 transition-all group-hover:text-blue-500" />
          </button>
        </div>
      </div>

      {showNewBatch && (
        <div className="cf-card mt-4 p-4 md:p-6 page-enter">
          <div className="cf-card-header">
            <div>
              <h2 className="section-title">Create a new batch — {department}</h2>
              <p className="text-muted-2 text-sm mb-0">
                Use the format
                <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 text-xs">YYYY_YYYY</code>
                (e.g. 2024_2028).
              </p>
            </div>
            <span className="cf-icon-badge violet">
              <PlusIcon size={22} />
            </span>
          </div>

          <form onSubmit={handleCreateBatch} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label htmlFor="staff-new-batch-input" className="cf-label">
                Batch
              </label>
              <input
                id="staff-new-batch-input"
                type="text"
                value={newBatch}
                onChange={(e) => {
                  setNewBatch(e.target.value)
                  setNewBatchError(null)
                }}
                placeholder="2024_2028"
                className="cf-input"
                autoFocus
                disabled={creatingBatch}
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowNewBatch(false)
                  setNewBatch('')
                  setNewBatchError(null)
                }}
                className="btn-cf-outline px-4 py-2 text-sm"
                disabled={creatingBatch}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-cf-primary px-4 py-2 text-sm inline-flex items-center gap-2"
                disabled={creatingBatch || !newBatch.trim()}
              >
                {creatingBatch ? (
                  <>
                    <span className="cf-spinner" role="status" aria-hidden="true" />
                    Creating…
                  </>
                ) : (
                  <>
                    <PlusIcon size={16} />
                    Create batch
                  </>
                )}
              </button>
            </div>
          </form>

          {newBatchError && (
            <StatusMessage variant="danger" className="mt-3">
              {newBatchError.message}
            </StatusMessage>
          )}
        </div>
      )}
    </div>
  )

  const renderStaffStep = () => {
    const heading = selectedBatch ? `${department} → ${selectedBatch.label}` : `${department} — Staff`

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
            Add Staff
          </button>
        </div>

        <div className="cf-card p-3 md:p-4">
          <div className="cf-card-header">
            <div>
              <h2 className="section-title">{heading}</h2>
              <p className="text-muted-2 text-sm mb-0">
                {staffLoading
                  ? 'Loading staff…'
                  : `${filtered.length} staff member${filtered.length === 1 ? '' : 's'} found`}
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
                placeholder="Search staff…"
                className="cf-input pl-10"
                aria-label="Search staff"
              />
            </div>
          </div>

          {staffError && <StatusMessage variant="danger">{staffError.message}</StatusMessage>}

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
                  <th>Department</th>
                  <th>Class advisor</th>
                </tr>
              </thead>
              <tbody>
                {staffLoading && (
                  <tr>
                    <td colSpan={SORTABLE_COLUMNS.length + 3} className="advisor-table-empty">
                      <span className="cf-spinner" role="status" aria-hidden="true" />
                      Loading staff…
                    </td>
                  </tr>
                )}
                {!staffLoading && !staffError && paged.length === 0 && (
                  <tr>
                    <td colSpan={SORTABLE_COLUMNS.length + 3} className="advisor-table-empty">
                      {search ? 'No staff match your search.' : 'No staff found in this department yet.'}
                    </td>
                  </tr>
                )}
                {!staffLoading &&
                  paged.map((member, index) => (
                    <tr key={member.staff_id ?? `${member.email}-${index}`}>
                      <td className="advisor-table-num">{(safePage - 1) * PAGE_SIZE + index + 1}</td>
                      <td className="font-bold">{member.staff_name}</td>
                      <td className="advisor-table-reg">{member.email}</td>
                      <td>{member.department || department}</td>
                      <td>
                        {member.class_advisor === 'Y' ? (
                          <span className="inline-flex rounded-full border border-emerald-100 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700">
                            {member.advisor_batch || 'Advisor'}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
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
      <Navbar title="Staff Management" subtitle="Administrative Dashboard" onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5">
        <DashboardHero
          icon={<StaffIcon size={26} />}
          title="Staff Management"
          subtitle="Browse staff by department, or import new staff records."
        />

        {metaLoading && (
          <div className="cf-empty">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Loading staff records…</p>
          </div>
        )}

        {metaError && <StatusMessage variant="danger">{metaError.message}</StatusMessage>}

        {!metaLoading && !metaError && !department && renderDepartmentStep()}
        {!metaLoading && !metaError && department && !batch && renderBatchStep()}
        {!metaLoading && !metaError && department && batch && renderStaffStep()}

        {showAdd && (
          <AddStaffModal
            department={department}
            batch={selectedBatch}
            batches={departmentBatches}
            onClose={() => setShowAdd(false)}
            onImported={() => {
              setShowAdd(false)
            }}
          />
        )}
      </main>
    </div>
  )
}
