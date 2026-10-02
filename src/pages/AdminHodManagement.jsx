import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import AddDirectoryModal from '../components/admin/AddDirectoryModal'
import EditDirectoryRecordModal from '../components/admin/EditDirectoryRecordModal'
import { createAdminHods, fetchAdminHods, updateAdminHod } from '../api/adminApi'
import { HOD_COLUMNS, validateHodRows } from '../utils/adminImport'
import { useAdminAuth } from '../hooks/useAdminAuth'
import {
  ChevronLeftIcon,
  GraduationIcon,
  PlusIcon,
  EditIcon,
  SearchIcon,
} from '../components/Icons'

/*
 * Head of department management.
 *
 * The page shell is the staff page's shell, unchanged: the hero sits directly
 * under `<main>`, and the step below it is a `page-enter` wrapper holding a single
 * action row -- Back on the left, Add on the right -- followed by the list card at
 * `cf-card p-3 md:p-4`. Search sits in the card header as an input group with its
 * icon, the table is an `advisor-table` with sortable headers, and it paginates at
 * 15 rows. That is deliberately the same set of decisions the student and staff
 * pages made, so this page is recognisably one of them.
 *
 * `page-enter` belongs on the step wrapper rather than on `<main>`, for the same
 * reason it does on those pages: the animation marks the content changing, and
 * putting it on the container fades the hero and the action row along with it.
 *
 * There is no department step, unlike the staff page, and the reason is the
 * storage. Staff are listed per department because the page asks for one before it
 * can filter; `hods` holds one person per department, so the whole directory fits on
 * a single screen and the department is a column rather than a step. That is also
 * what lets an admin see at a glance that a department already has a head of
 * department, which a filtered picker could not show.
 *
 * The `hod_id` column is database-generated and immutable, so it is displayed but
 * never offered as an input.
 */
const PAGE_SIZE = 15

const SORTABLE_COLUMNS = [
  { key: 'hod_name', label: 'Name' },
  { key: 'email', label: 'Email' },
]

export default function AdminHodManagement() {
  const navigate = useNavigate()
  const { logout } = useAdminAuth()

  const [hods, setHods] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('hod_name')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(1)

  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAdminHods()
      setHods(data.hods || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

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
    let rows = hods
    if (term) {
      rows = hods.filter((hod) =>
        [hod.hod_name, hod.email, hod.department, hod.hod_id]
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
  }, [hods, search, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const handleLogout = async () => {
    await logout()
    navigate('/admin', { replace: true })
  }

  return (
    <div className="app-shell">
      <Navbar title="HOD Management" subtitle="Administrative Dashboard" onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5">
        <DashboardHero
          icon={<GraduationIcon size={26} />}
          title="Heads of Department"
          subtitle="Browse heads of department, or import new records with their login accounts."
        />

        {notice && (
          <StatusMessage variant="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </StatusMessage>
        )}

        <div className="page-enter">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => navigate('/admin/dashboard')}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
            >
              <ChevronLeftIcon size={16} />
              Back to dashboard
            </button>
            {/* Separate from browsing: viewing never starts a write workflow. */}
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
            >
              <PlusIcon size={16} />
              Add HOD
            </button>
          </div>

          <div className="cf-card p-3 md:p-4">
            <div className="cf-card-header">
              <div>
                <h2 className="section-title">Heads of department</h2>
                <p className="text-muted-2 text-sm mb-0">
                  {loading
                    ? 'Loading HODs…'
                    : `${filtered.length} HOD${filtered.length === 1 ? '' : 's'} found`}
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
                  placeholder="Search HODs…"
                  className="cf-input pl-10"
                  aria-label="Search heads of department"
                />
              </div>
            </div>

            {error && <StatusMessage variant="danger">{error}</StatusMessage>}

            <div className="overflow-x-auto">
              <table className="advisor-table">
                <thead>
                  <tr>
                    <th className="advisor-table-num">#</th>
                    <th>HOD ID</th>
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
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <td colSpan={SORTABLE_COLUMNS.length + 4} className="advisor-table-empty">
                        <span className="cf-spinner" role="status" aria-hidden="true" />
                        Loading HODs…
                      </td>
                    </tr>
                  )}
                  {!loading && !error && paged.length === 0 && (
                    <tr>
                      <td colSpan={SORTABLE_COLUMNS.length + 4} className="advisor-table-empty">
                        {search ? 'No HODs match your search.' : 'No HODs yet.'}
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    paged.map((hod, index) => (
                      <tr key={hod.hod_id ?? `${hod.email}-${index}`}>
                        <td className="advisor-table-num">
                          {(safePage - 1) * PAGE_SIZE + index + 1}
                        </td>
                        <td className="advisor-table-reg">{hod.hod_id ?? '—'}</td>
                        <td className="font-bold">{hod.hod_name}</td>
                        <td className="advisor-table-reg">{hod.email}</td>
                        <td>{hod.department || '—'}</td>
                        <td className="advisor-table-num">
                          <button
                            type="button"
                            onClick={() => setEditing(hod)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-blue-700 transition-colors hover:bg-blue-50"
                            aria-label={`Edit ${hod.hod_name}`}
                          >
                            <EditIcon size={14} />
                            Edit
                          </button>
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

        {showAdd && (
          <AddDirectoryModal
            title="Add HOD"
            nameKey="hod_name"
            nameLabel="HOD name"
            rowLabel="HOD"
            pluralNoun="HODs"
            pluralUnit="HOD"
            csvColumns={HOD_COLUMNS}
            validateRows={validateHodRows}
            onSubmit={createAdminHods}
            onClose={() => setShowAdd(false)}
            onImported={(result) => {
              setShowAdd(false)
              load()
              setNotice(
                `Added ${result.created || 0} HOD${result.created === 1 ? '' : 's'}${
                  result.authAccountsCreated > 0
                    ? ` and ${result.authAccountsCreated} login account${
                        result.authAccountsCreated === 1 ? '' : 's'
                      }`
                    : ''
                }.`
              )
            }}
          />
        )}

        {editing && (
          <EditDirectoryRecordModal
            record={editing}
            idField="hod_id"
            nameField="hod_name"
            idLabel="HOD ID"
            nameLabel="HOD name"
            title={`Edit HOD — ${editing.hod_name}`}
            responseKey="hod"
            onSubmit={updateAdminHod}
            onClose={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null)
              // `load` is the same fetch the page uses on mount, so the row that
              // replaces the edited one is a fresh read of D1.
              load()
              setNotice(`Updated ${saved?.hod_name || editing.hod_name}.`)
            }}
          />
        )}
      </main>
    </div>
  )
}