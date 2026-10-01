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
import { ChevronLeftIcon, GraduationIcon, PlusIcon, EditIcon } from '../components/Icons'

/*
 * Head of department management.
 *
 * Structured exactly like the staff and subject pages: a list with a search box, an
 * Add button that opens the upload/manual dialog, and an Edit action per row.
 *
 * There is no department step, unlike the staff page, and the reason is the storage.
 * Staff are listed per department because the page asks for one before it can
 * filter; `hods` holds one person per department, so the whole directory fits on a
 * single screen and the department is a column rather than a step. That is also
 * what lets an admin see at a glance that a department already has a head of
 * department, which a filtered picker could not show.
 *
 * The `hod_id` column is database-generated and immutable, so it is displayed but
 * never offered as an input.
 */
export default function AdminHodManagement() {
  const navigate = useNavigate()
  const { logout } = useAdminAuth()

  const [hods, setHods] = useState([])
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

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return hods
    return hods.filter((hod) =>
      [hod.hod_name, hod.email, hod.department, hod.hod_id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term))
    )
  }, [hods, search])

  const handleLogout = async () => {
    await logout()
    navigate('/admin', { replace: true })
  }

  return (
    <div className="app-shell">
      <Navbar title="HOD Management" subtitle="Administrative Dashboard" onLogout={handleLogout} />
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
          icon={<GraduationIcon size={26} />}
          title="Heads of Department"
          subtitle="Maintain the head of department for each department, and their login accounts."
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
              <h2 className="section-title">Heads of department</h2>
              <p className="text-muted-2 text-sm mb-0">
                {loading ? 'Loading records…' : `${filtered.length} record${filtered.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="cf-input-group-custom w-full max-w-[220px]">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search HODs…"
                  className="cf-input"
                  aria-label="Search heads of department"
                />
              </div>
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                <PlusIcon size={16} />
                Add HOD
              </button>
            </div>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="advisor-table">
              <thead>
                <tr>
                  <th className="advisor-table-num">#</th>
                  <th>HOD ID</th>
                  <th>HOD Name</th>
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
                  filtered.map((hod, index) => (
                    <tr key={hod.hod_id}>
                      <td className="advisor-table-num">{index + 1}</td>
                      <td className="advisor-table-reg">{hod.hod_id}</td>
                      <td className="font-bold">{hod.hod_name}</td>
                      <td className="advisor-table-reg">{hod.email}</td>
                      <td>{hod.department}</td>
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
                  ))
                ) : (
                  <tr>
                    <td className="advisor-table-empty" colSpan="6">
                      {search ? 'No HODs match your search.' : 'No HODs yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

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