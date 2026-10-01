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
import { ChevronLeftIcon, CompassIcon, PlusIcon, EditIcon } from '../components/Icons'

/*
 * Contest coordinator management.
 *
 * The same page as heads of department, with a different name on each column and a
 * different noun throughout. A contest coordinator is a person, an address and a
 * department, exactly as a head of department is, in a single department-keyed
 * table -- so both pages share the add dialog and the edit dialog rather than
 * duplicating them, and differ only in the words and the column they are about.
 *
 * The coordinator id is database-generated and immutable, so it is displayed but
 * never offered as an input.
 */
export default function AdminContestCoordinatorManagement() {
  const navigate = useNavigate()
  const { logout } = useAdminAuth()

  const [coordinators, setCoordinators] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

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

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return coordinators
    return coordinators.filter((coordinator) =>
      [
        coordinator.coordinator_name,
        coordinator.email,
        coordinator.department,
        coordinator.coordinator_id,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term))
    )
  }, [coordinators, search])

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
      <main className="container-cf py-4 lg:py-5 page-enter">
        <button
          type="button"
          onClick={() => navigate('/admin/dashboard')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          <ChevronLeftIcon size={16} />
          Back to dashboard
        </button>

        <DashboardHero
          icon={<CompassIcon size={26} />}
          title="Contest Coordinators"
          subtitle="Maintain the contest coordinator for each department, and their login accounts."
        />

        {error && <StatusMessage variant="danger">{error}</StatusMessage>}

        {notice && (
          <StatusMessage variant="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </StatusMessage>
        )}

        <section className="cf-card mt-4 p-4">
          <div className="cf-card-header">
            <div>
              <h2 className="section-title">Contest coordinators</h2>
              <p className="text-muted-2 text-sm mb-0">
                {loading
                  ? 'Loading records…'
                  : `${filtered.length} record${filtered.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="cf-input-group-custom w-full max-w-[220px]">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search coordinators…"
                  className="cf-input"
                  aria-label="Search contest coordinators"
                />
              </div>
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                <PlusIcon size={16} />
                Add Coordinator
              </button>
            </div>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="advisor-table">
              <thead>
                <tr>
                  <th className="advisor-table-num">#</th>
                  <th>Coordinator ID</th>
                  <th>Coordinator Name</th>
                  <th>Email</th>
                  <th>Department</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td className="advisor-table-empty" colSpan="6">
                      <span className="cf-spinner" role="status" aria-hidden="true" />
                      Loading records…
                    </td>
                  </tr>
                ) : filtered.length ? (
                  filtered.map((coordinator, index) => (
                    <tr key={coordinator.coordinator_id}>
                      <td className="advisor-table-num">{index + 1}</td>
                      <td className="advisor-table-reg">{coordinator.coordinator_id}</td>
                      <td className="font-bold">{coordinator.coordinator_name}</td>
                      <td className="advisor-table-reg">{coordinator.email}</td>
                      <td>{coordinator.department}</td>
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
                  ))
                ) : (
                  <tr>
                    <td className="advisor-table-empty" colSpan="6">
                      {search ? 'No coordinators match your search.' : 'No coordinators yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

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