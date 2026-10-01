import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import AddStaffModal from '../components/admin/AddStaffModal'
import EditStaffModal from '../components/admin/EditStaffModal'
import { fetchAdminBatches, fetchAdminStaff } from '../api/adminApi'
import { isAdvisorFlag } from '../utils/sectionValidation'
import { useAdminAuth } from '../hooks/useAdminAuth'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
  StaffIcon,
  PlusIcon,
  EditIcon,
} from '../components/Icons'

/*
 * Staff management is a two-step flow: choose a department, then see its staff.
 *
 * There is deliberately no batch step here. Students are stored in per-cohort
 * tables, so a batch is genuinely needed to find them, and the student page has
 * that extra step. Staff are not: `staff` is one table with a `department` column,
 * so a batch would filter nothing. A batch only appears on a staff record when the
 * person is a class advisor, and that is shown as a column in the list instead.
 *
 * An earlier version of this page had Department -> Batch -> Staff, which forced
 * the admin to name a cohort before they could see a colleague who did not advise
 * one at all.
 */

const PAGE_SIZE = 15

const SORTABLE_COLUMNS = [
  { key: 'staff_name', label: 'Name' },
  { key: 'email', label: 'Email' },
]

export default function AdminStaffManagement() {
  const navigate = useNavigate()
  const { logout } = useAdminAuth()

  const [departments, setDepartments] = useState([])
  const [metaLoading, setMetaLoading] = useState(true)
  const [metaError, setMetaError] = useState(null)

  const [department, setDepartment] = useState('')

  const [staff, setStaff] = useState([])
  const [staffLoading, setStaffLoading] = useState(false)
  const [staffError, setStaffError] = useState(null)

  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('staff_name')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(1)
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [notice, setNotice] = useState(null)

  /*
   * Bumped after a write so the department's staff are fetched again.
   *
   * A refetch rather than an in-place patch, because the stored row is not
   * necessarily what was submitted: the server clears an advisor's three fields
   * when the flag is turned off, normalises the email, and may move the person to
   * another department -- in which case they are no longer in this list at all.
   */
  const [reloadToken, setReloadToken] = useState(0)

  /*
   * Only the department list is needed from the batch endpoint here, to know which
   * departments have staff at all. The cohorts themselves are not a filter on
   * staff, so they are not requested.
   */
  const loadMeta = useCallback(async () => {
    setMetaLoading(true)
    setMetaError(null)
    try {
      const data = await fetchAdminBatches()
      setDepartments(data.departments || [])
    } catch (err) {
      setMetaError(err)
    } finally {
      setMetaLoading(false)
    }
  }, [])

  useEffect(() => {
    loadMeta()
  }, [loadMeta])

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
  }, [department, reloadToken])

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

  const handleDepartmentSelect = (dept) => {
    setDepartment(dept)
    setSearch('')
    setPage(1)
  }

  const handleBack = () => {
    setDepartment('')
    setSearch('')
    setPage(1)
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    let rows = staff
    if (term) {
      rows = staff.filter((s) =>
        [s.staff_name, s.email, s.department, s.staff_id, s.advisor_batch]
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
              Choose a department to see everyone on its staff list.
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
                <p className="mt-0.5 text-sm text-slate-500">View {dept} staff</p>
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

  const renderStaffStep = () => (
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
        {/* Separate from browsing: viewing never starts a write workflow. */}
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
            <h2 className="section-title">{department} — Staff</h2>
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
                <th>Staff ID</th>
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
                <th>Advisors</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {staffLoading && (
                <tr>
                  <td colSpan={SORTABLE_COLUMNS.length + 6} className="advisor-table-empty">
                    <span className="cf-spinner" role="status" aria-hidden="true" />
                    Loading staff…
                  </td>
                </tr>
              )}
              {!staffLoading && !staffError && paged.length === 0 && (
                <tr>
                  <td colSpan={SORTABLE_COLUMNS.length + 6} className="advisor-table-empty">
                    {search ? 'No staff match your search.' : 'No staff found in this department yet.'}
                  </td>
                </tr>
              )}
              {!staffLoading &&
                paged.map((member, index) => {
                  // The column has been written as 'Y', as '1' and as NULL by
                  // different migrations; isAdvisorFlag reads all of them.
                  const isAdvisor = isAdvisorFlag(member.class_advisor)
                  return (
                    <tr key={member.staff_id ?? `${member.email}-${index}`}>
                      <td className="advisor-table-num">
                        {(safePage - 1) * PAGE_SIZE + index + 1}
                      </td>
                      <td className="advisor-table-reg">{member.staff_id ?? '—'}</td>
                      <td className="font-bold">{member.staff_name}</td>
                      <td className="advisor-table-reg">{member.email}</td>
                      <td>{member.department || department}</td>
                      <td>
                        {isAdvisor ? (
                          <span className="inline-flex rounded-full border border-emerald-100 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700">
                            Advisor
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="text-xs text-slate-600">
                        {isAdvisor
                          ? [
                              member.advisor_batch,
                              member.advisor_year != null ? `Year ${member.advisor_year}` : null,
                              member.advisor_section ? `Section ${member.advisor_section}` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')
                          : '—'}
                      </td>
                      <td className="advisor-table-num">
                        <button
                          type="button"
                          onClick={() => setEditing(member)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-blue-700 transition-colors hover:bg-blue-50"
                          aria-label={`Edit ${member.staff_name}`}
                        >
                          <EditIcon size={14} />
                          Edit
                        </button>
                      </td>
                    </tr>
                  )
                })}
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

  return (
    <div className="app-shell">
      <Navbar title="Staff Management" subtitle="Administrative Dashboard" onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5">
        <DashboardHero
          icon={<StaffIcon size={26} />}
          title="Staff Management"
          subtitle="View staff by department, or add new staff members."
        />

        {notice && (
          <StatusMessage variant="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </StatusMessage>
        )}

        {metaLoading && (
          <div className="cf-empty">
            <span className="cf-spinner" role="status" aria-hidden="true" />
            <p className="text-sm text-slate-500">Loading staff records…</p>
          </div>
        )}

        {metaError && <StatusMessage variant="danger">{metaError.message}</StatusMessage>}

        {!metaLoading && !metaError && !department && renderDepartmentStep()}
        {!metaLoading && !metaError && department && renderStaffStep()}

        {showAdd && (
          <AddStaffModal
            department={department}
            onClose={() => setShowAdd(false)}
            onImported={() => {
              setShowAdd(false)
            }}
          />
        )}
        {editing && (
          <EditStaffModal
            member={editing}
            onClose={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null)
              // Refetch: the saved row is what D1 holds, and a department change
              // takes this person out of the list being viewed.
              setReloadToken((token) => token + 1)
              setNotice(
                `Updated ${saved?.staff_name || editing.staff_name}${
                  saved?.department && saved.department !== department
                    ? ` — now listed under ${saved.department}`
                    : ''
                }.`
              )
            }}
          />
        )}
      </main>
    </div>
  )
}
