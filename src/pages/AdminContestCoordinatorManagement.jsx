import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import AddContestCoordinatorModal from '../components/admin/AddContestCoordinatorModal'
import EditDirectoryRecordModal from '../components/admin/EditDirectoryRecordModal'
import DeleteRecordButton from '../components/admin/DeleteRecordButton'
import DeleteRecordModal from '../components/admin/DeleteRecordModal'
import {
  createAdminContestCoordinators,
  deleteAdminContestCoordinator,
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
 * ## Adding is the one part that is not shared with the HOD page
 *
 * A head of department is appointed *to* a department: the admin supplies a name, an
 * address and a department, and there is no CSV dialog for it. A contest coordinator is
 * appointed *out of* a department's staff roster, so the only thing worth asking is
 * which staff member, and `AddContestCoordinatorModal` asks exactly that -- department,
 * then a searchable list of that department's staff showing name and email, then a
 * read-only summary of the person chosen.
 *
 * That is not a convenience. Every staff member already has an `auth_users` row with the
 * role `staff`, and the generic create route used to refuse an address whose account was
 * not already a coordinator -- so appointing anyone who was actually on staff, which is
 * the only kind of person a coordinator can be, failed with "already used by another
 * faculty" about the very person being appointed. The create route now reuses the
 * existing staff account for coordinators instead of refusing it (`reuseStaffAccount` in
 * `backend/src/api/admin.ts`), and this dialog only ever submits identity read from the
 * staff record, so the two halves cannot drift.
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
  /* The row the confirmation dialog is open for; `null` means it is closed. */
  const [deleting, setDeleting] = useState(null)
  const [notice, setNotice] = useState(null)
  /*
   * A refusal is not a success, so the notice is not styled as one. Kept beside
   * `notice` rather than folded into it so every existing `setNotice(text)` call
   * stays a plain string and only the branches that need another colour say so.
   */
  const [noticeVariant, setNoticeVariant] = useState('success')

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
          subtitle="Appoint an existing member of staff as each department's contest coordinator."
        />

        {notice && (
          <StatusMessage
            variant={noticeVariant}
            dismissible
            onDismiss={() => setNotice(null)}
          >
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

          <div className="cf-card admin-directory-card p-3 md:p-4">
            <div className="cf-card-header">
              <div>
                <h2 className="section-title">Contest coordinators</h2>
                <p className="text-muted-2 text-sm mb-0">
                  {loading
                    ? 'Loading coordinators…'
                    : `${filtered.length} coordinator${filtered.length === 1 ? '' : 's'} found`}
                </p>
              </div>
              <div className="cf-input-group-custom w-full sm:max-w-[260px]">
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
                          {/* One flex row so the actions column keeps a single width. */}
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setEditing(coordinator)}
                              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-blue-700 transition-colors hover:bg-blue-50"
                              aria-label={`Edit ${coordinator.coordinator_name}`}
                            >
                              <EditIcon size={14} />
                              Edit
                            </button>
                            <DeleteRecordButton
                              onClick={() => setDeleting(coordinator)}
                              name={`coordinator ${coordinator.coordinator_name}`}
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

        {showAdd && (
          <AddContestCoordinatorModal
            title="Add Contest Coordinator"
            submitLabel="Add Coordinator"
            onSubmit={createAdminContestCoordinators}
            onClose={() => setShowAdd(false)}
            onAdded={(result) => {
              setShowAdd(false)
              load()
              /*
               * Same reason the dialog distinguishes them: `created === 0` is not
               * evidence that the person is already a coordinator. The server also
               * returns `created: 0` when it refused the row outright -- an account
               * role conflict is the common one, because a coordinator is appointed
               * out of a department's staff roster and every member of staff already
               * holds a `staff` account. Asserting "already a coordinator" there
               * would tell the admin their appointment succeeded when no row was
               * written, so the server's own reason is what gets shown.
               */
              if ((result.created || 0) === 0) {
                const refusal = (result.roleMismatches || []).map((m) => m.reason).filter(Boolean)
                if (refusal.length > 0) {
                  setNoticeVariant('danger')
                  setNotice(`${refusal.join(' ')} No coordinator was added.`)
                  return
                }
                if ((result.skipped || 0) > 0) {
                  setNoticeVariant('info')
                  setNotice('That person is already a contest coordinator. Nothing changed.')
                  return
                }
                setNoticeVariant('danger')
                setNotice('No coordinator was added. Nothing changed.')
                return
              }
              setNoticeVariant('success')
              setNotice(
                `Added ${result.created} coordinator${
                  result.created === 1 ? '' : 's'
                }${
                  (result.authAccountsReused || 0) > 0
                    ? '. They keep their existing staff login, so there is no new password.'
                    : (result.authAccountsCreated || 0) > 0
                      ? ` and ${result.authAccountsCreated} login account${
                          result.authAccountsCreated === 1 ? '' : 's'
                        }.`
                      : '.'
                }`
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
              setNoticeVariant('success')
              setNotice(`Updated ${saved?.coordinator_name || editing.coordinator_name}.`)
            }}
          />
        )}
        {deleting && (
          <DeleteRecordModal
            title="Delete coordinator?"
            entityLabel="contest coordinator"
            name={deleting.coordinator_name}
            details={[
              deleting.coordinator_id != null
                ? `Coordinator ID ${deleting.coordinator_id}`
                : null,
              deleting.email,
              deleting.department,
            ]}
            warning={`${deleting.department || 'this'} department`}
            /*
              Said before the admin presses Delete rather than after, because this is
              the one case where the obvious expectation is wrong. A coordinator is
              appointed out of the staff roster, so the account belongs to them as a
              member of staff and stays: they keep their staff dashboard and stop
              resolving as a coordinator. OD requests they decided are kept.
            */
            note="Their staff login is kept, because a coordinator is appointed from the staff roster — only the appointment is removed, which frees the department for a new coordinator. OD requests they approved are kept."
            onConfirm={() => deleteAdminContestCoordinator(deleting.coordinator_id)}
            onClose={() => setDeleting(null)}
            onDeleted={() => {
              const removedName = deleting.coordinator_name
              const removedDepartment = deleting.department
              setDeleting(null)
              // `load` is the same fetch the page uses on mount, so the directory that
              // replaces the deleted entry is a fresh read of D1 -- which is also what
              // shows the department is free again.
              load()
              setNoticeVariant('success')
              setNotice(
                `Deleted ${removedName}${removedDepartment ? ` (${removedDepartment})` : ''}.`
              )
            }}
          />
        )}
      </main>
    </div>
  )
}