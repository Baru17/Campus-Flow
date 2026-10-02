import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import AddContestCoordinatorModal from '../components/admin/AddContestCoordinatorModal'
import {
  createAdminContestCoordinators,
  fetchAdminContestCoordinators,
  updateAdminContestCoordinator,
} from '../api/adminApi'
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
 * ## What is different from the HOD page, and why
 *
 * A head of department is *appointed* to a department, so their name, address and
 * department are all the admin's to supply and the CSV dialog is the right tool. A
 * contest coordinator is not: they are somebody already on a department's staff roster,
 * and letting an admin type a third address beside the one on their staff record is how
 * you end up with a coordinator the OD workflow -- which authorises on
 * `contest_coordinators.email` -- can never match.
 *
 * So this page adds and edits by choosing a staff member, not by filling in a form.
 * `AddContestCoordinatorModal` asks for a department, then a person from that
 * department, then shows their staff record read-only, and posts only `staff_id`. The
 * server derives the same three values from the same row.
 *
 * ## The list
 *
 * Reads name, email and department from the staff record where one matches, so what
 * is shown here is the staff member's current identity rather than a copy that could
 * have drifted. A row with no matching staff record is flagged instead of hidden: it
 * is a coordinator who predates this flow, or whose staff email has since changed, and
 * an admin needs to see it in order to fix it.
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
          subtitle="Appoint existing staff members as contest coordinators. Their name, email and department come from the staff record."
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
                        <td className="font-bold">
                          {coordinator.coordinator_name}
                          {/*
                            A coordinator whose address matches no staff record: created
                            before this flow existed, or whose staff email has since been
                            edited. Shown rather than hidden, because an admin has to be
                            able to see it in order to re-point it at the right person --
                            and because the values on this row then come from the
                            coordinator table alone, not from staff.
                          */}
                          {coordinator.unlinked ? (
                            <span className="mt-1 block text-xs font-semibold text-amber-700">
                              No matching staff record — re-select this coordinator
                            </span>
                          ) : null}
                        </td>
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
          <AddContestCoordinatorModal
            title="Add Contest Coordinator"
            submitLabel="Add Coordinator"
            onSubmit={createAdminContestCoordinators}
            onClose={() => setShowAdd(false)}
            onSaved={(result) => {
              setShowAdd(false)
              load()
              setNotice(
                `Added ${result.coordinator?.coordinator_name || 'coordinator'}${
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
          <AddContestCoordinatorModal
            title="Change Staff Member"
            submitLabel="Save Coordinator"
            record={editing}
            onSubmit={(selection) => updateAdminContestCoordinator(editing.coordinator_id, selection)}
            onClose={() => setEditing(null)}
            onSaved={(result) => {
              setEditing(null)
              load()
              setNotice(`Updated ${result.coordinator?.coordinator_name || editing.coordinator_name}.`)
            }}
          />
        )}
      </main>
    </div>
  )
}