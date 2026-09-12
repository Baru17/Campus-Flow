import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import ImportPreviewTable from '../components/admin/ImportPreviewTable'
import { adminSubjects } from '../api/adminApi'
import { parseImportFile, validateSubjectRows } from '../utils/adminImport'
import { useAdminAuth } from '../hooks/useAdminAuth'
import { BookIcon, ChevronLeftIcon, UploadIcon } from '../components/Icons'

const SEMESTERS = Array.from({ length: 8 }, (_, i) => i + 1)

export default function AdminSubjectManagement() {
  const navigate = useNavigate(); const { logout } = useAdminAuth()
  const [semester, setSemester] = useState(''), [subjects, setSubjects] = useState([]), [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(null), [validation, setValidation] = useState(null), [importing, setImporting] = useState(false), [result, setResult] = useState(null), [saving, setSaving] = useState('')
  const load = useCallback(async () => { setLoading(true); setError(null); try { const [s, b] = await Promise.all([adminSubjects('list', semester ? { semester: Number(semester) } : {}), adminSubjects('batches')]); setSubjects(s.subjects || []); setBatches(b.batches || []) } catch (err) { setError(err.message) } finally { setLoading(false) } }, [semester])
  useEffect(() => { load() }, [load])
  const chooseFile = async (event) => { setResult(null); const file = event.target.files?.[0]; if (!file) return; const parsed = await parseImportFile(file); if (parsed.error) { setError(parsed.error); return }; setValidation(validateSubjectRows(parsed.rows || [])) }
  const importRows = async () => { if (!validation?.validRows?.length) return; setImporting(true); setError(null); try { setResult(await adminSubjects('import', { rows: validation.validRows })); setValidation(null); await load() } catch (err) { setError(err.message) } finally { setImporting(false) } }
  const setBatchSemester = async (batch, value) => { const current_semester = Number(value); if (!current_semester) return; const id = `${batch.department}:${batch.batch_code}`; setSaving(id); setError(null); try { await adminSubjects('set-semester', { department: batch.department, batch_code: batch.batch_code, current_semester }); await load() } catch (err) { setError(err.message) } finally { setSaving('') } }
  const handleLogout = async () => { await logout(); navigate('/admin', { replace: true }) }
  return <div className="app-shell"><Navbar title="Subject & Semester Management" subtitle="Administrative Dashboard" onLogout={handleLogout} /><main className="container-cf py-4 lg:py-5 page-enter">
    <button type="button" onClick={() => navigate('/admin/dashboard')} className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-blue-600"><ChevronLeftIcon size={16} />Back to dashboard</button>
    <DashboardHero icon={<BookIcon size={26} />} title="Subjects & Semesters" subtitle="Maintain the central semester-wise master; semester changes never delete subjects or attendance." />
    {error && <StatusMessage variant="danger">{error}</StatusMessage>}
    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-5"><section className="cf-card p-4 xl:col-span-3"><div className="cf-card-header"><div><h2 className="section-title">Semester Subject Master</h2><p className="text-muted-2 text-sm mb-0">CSV/XLSX columns: semester, subject_code, subject_name.</p></div><label className="btn-cf-primary inline-flex cursor-pointer items-center gap-2 px-4 py-2 text-sm"><UploadIcon size={16} />Upload subjects<input className="hidden" type="file" accept=".csv,.xlsx" onChange={chooseFile} /></label></div>
      {validation && <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"><p className="font-bold">Import preview: {validation.validRows.length} valid, {validation.invalidRows.length} invalid.</p>{validation.missingColumns.length ? <p>Missing columns: {validation.missingColumns.join(', ')}</p> : <><ImportPreviewTable rows={validation.validRows} columns={[{ key: 'semester', label: 'Semester' }, { key: 'subject_code', label: 'Subject code', bold: true }, { key: 'subject_name', label: 'Subject name' }]} /><div className="mt-3 flex gap-2"><button className="btn-cf-outline px-3 py-1.5 text-sm" onClick={() => setValidation(null)}>Cancel</button><button className="btn-cf-primary px-3 py-1.5 text-sm" disabled={importing || !validation.validRows.length} onClick={importRows}>{importing ? 'Importing…' : 'Confirm import'}</button></div></>}</div>}
      {result && <StatusMessage variant="success">Inserted {result.inserted}; skipped duplicates {result.skipped_duplicate}; invalid rows {result.invalid_rows?.length || 0}.</StatusMessage>}
      <div className="mb-3 flex items-center gap-2"><label className="cf-form-label mb-0">Filter semester</label><select className="cf-select max-w-40" value={semester} onChange={(e) => setSemester(e.target.value)}><option value="">All</option>{SEMESTERS.map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
      <div className="overflow-x-auto"><table className="advisor-table"><thead><tr><th>Semester</th><th>Subject code</th><th>Subject name</th></tr></thead><tbody>{loading ? <tr><td className="advisor-table-empty" colSpan="3">Loading…</td></tr> : subjects.length ? subjects.map((s) => <tr key={s.id}><td>{s.semester}</td><td className="advisor-table-reg">{s.subject_code}</td><td>{s.subject_name}</td></tr>) : <tr><td className="advisor-table-empty" colSpan="3">No subjects found.</td></tr>}</tbody></table></div>
    </section><section className="cf-card p-4 xl:col-span-2"><h2 className="section-title">Batch current semester</h2><p className="text-muted-2 mb-3 text-sm">Set explicitly. This only changes which master subjects are offered next.</p><div className="space-y-3">{batches.map((batch) => { const id = `${batch.department}:${batch.batch_code}`; return <div key={id} className="rounded-xl border border-slate-200 p-3"><p className="font-bold text-slate-800">{batch.department} · {batch.batch_code.replace('_', '–')}</p><label className="mt-2 block text-xs font-semibold text-slate-500">Current semester</label><select className="cf-select mt-1" value={batch.current_semester || ''} disabled={saving === id} onChange={(e) => setBatchSemester(batch, e.target.value)}><option value="">Not configured</option>{SEMESTERS.map((n) => <option key={n} value={n}>{n}</option>)}</select></div> })}{!loading && !batches.length && <p className="text-sm text-slate-500">No batch tables were found. Upload students first.</p>}</div></section></div>
  </main></div>
}
