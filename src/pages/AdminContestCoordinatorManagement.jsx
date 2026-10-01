import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import AddDirectoryModal from '../components/admin/AddDirectoryModal'
import EditDirectoryRecordModal from '../components/admin/EditDirectoryRecordModal'
import {
  createAdminContestCoordinators,
  fetchAdminContestCoordinators,
  updateAdminContestCoordinator,
} from '../api/adminApi'
import { COORDINATOR_COLUMNS, validateContestCoordinatorRows } from '../utils/adminImport'
import { useAdminAuth } from '../hooks/useAdminAuth'
import {
  ChevronLeftIcon,
  CompassIcon,
  PlusIcon,
  EditIcon,
  SearchIcon,
} from '../components/Icons'

/*
 * Contest coordinator management.
 *
 * The same page shell as the head of department page and the staff page: the hero
 * under `<main>`, then a `page-enter` step holding one action row -- Back on the
 * left, Add on the right -- then the list card at `cf-card p-3 md:p-4`, with search
 * as an input group in the card header, sortable `advisor-table` headers, and
 * pagination at 15 rows.
 *
 * A contest coordinator is a person, an address and a department, exactly as a head
 * of department is, in a single department-keyed table -- so both pages share the
 * add dialog and the edit dialog rather than duplicating them, and differ only in
 * the words and the column they are about.
 *
 * The coordinator id is database-generated and immutable, so it is displayed but
 * never offered as an input.
 */
const PAGE_SIZE = 15

const SORTABLE_COLUMNS = [
  { key: 'coordinator_name', label: 'Name' },
  { key: 'email', label: 'Email' },
]

export default function AdminContestCoordinatorManagement() {
  const navigate = useNavigate()
  const { logout } = useAdminAuth()

  const [coordinators, setCoordinators] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('coordinator_name')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(1)

  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAdminContestCoordinators()
      setCoordinators(data.contest_coordinators || [])
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
    let rows = coordinators
    if (term) {
      rows = coordinators.filter((coordinator) =>
        [
          coordinator.coordinator_name,
          coordinator.email,
          coordinator.department,
          coordinator.coordinator_id,
        ]
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
  }, [coordinators, search, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const handleLogout = async () => {
    await logout()
    navigate('/admin', { replace: true })
  }

  return (
    <div className="app-shell">
      <Navbar
        title="Contest Coordinator Management"
        subtitle="Administrative Dashboard"
        onLogout={handleLogout}
      />
      <main className="container-cf py-4 lg:py-5">
        <DashboardHero
          icon={<CompassIcon size={26} />}
          title="Contest Coordinators"
          subtitle="Browse contest coordinators, or import new records with their login accounts."
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
              Add Coordinator
            </button>
          </div>

          <div className="cf-card p-3 md:p-4">
            <div className="cf-card-header">
              <div>
                <h2 className="section-title">Contest coordinators</h2>
                <p className="text-muted-2 text-sm mb-0">
                  {loading
                    ? 'Loading coordinators…'
                    : `${filtered.length} coordinator${filtered.length === 1 ? '' : 's'} found`}
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
                  placeholder="Search coordinators…"
                  className="cf-input pl-10"
                  aria-label="Search contest coordinators"
                />
              </div>
            </div>

            {error && <StatusMessage variant="danger">{error}</StatusMessage>}

            <div className="overflow-x-auto">
              <table className="advisor-table">
                <thead>
                  <tr>
                    <th className="advisor-table-num">#</th>
                    <th>Coordinator ID</th>
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
                        Loading coordinators…
                      </td>
                    </tr>
                  )}
                  {!loading && !error && paged.length === 0 && (
                    <tr>
                      <td colSpan={SORTABLE_COLUMNS.length + 4} className="advisor-table-empty">
                        {search ? 'No coordinators match your search.' : 'No coordinators yet.'}
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    paged.map((coordinator, index) => (
                      <tr key={coordinator.coordinator_id ?? `${coordinator.email}-${index}`}>
                        <td className="advisor-table-num">
                          {(safePage - 1) * PAGE_SIZE + index + 1}
                        </td>
                        <td className="advisor-table-reg">
                          {coordinator.coordinator_id ?? '—'}
                        </td>
                        <td className="font-bold">{coordinator.coordinator_name}</td>
                        <td className="advisor-table-reg">{coordinator.email}</td>
                        <td>{coordinator.department || '—'}</td>
                        <td className="advisor-table-num">
                          <button
                            type="button"
                            onClick={() => setEditing(coordinator)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-blue-700 transition-colors hover:bg-blue-50"
                            aria-label={`Edit ${coordinator.coordinator_name}`}
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
            title="Add Contest Coordinator"
            nameKey="coordinator_name"
            nameLabel="Coordinator name"
            rowLabel="Coordinator"
            pluralNoun="Coordinators"
            pluralUnit="coordinator"
            csvColumns={COORDINATOR_COLUMNS}
            validateRows={validateContestCoordinatorRows}
            onSubmit={createAdminContestCoordinators}
            onClose={() => setShowAdd(false)}
            onImported={(result) => {
              setShowAdd(false)
              load()
              setNotice(
                `Added ${result.created || 0} coordinator${result.created === 1 ? '' : 's'}${
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
            idField="coordinator_id"
            nameField="coordinator_name"
            idLabel="Coordinator ID"
            nameLabel="Coordinator name"
            title={`Edit coordinator — ${editing.coordinator_name}`}
            responseKey="contest_coordinator"
            onSubmit={updateAdminContestCoordinator}
            onClose={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null)
              load()
              setNotice(`Updated ${saved?.coordinator_name || editing.coordinator_name}.`)
            }}
          />
        )}
      </main>
    </div>
  )
}