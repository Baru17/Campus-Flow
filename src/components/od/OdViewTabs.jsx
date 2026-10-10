import { useEffect, useState } from 'react'
import { fetchApprovedApprovals, fetchPendingApprovals } from '../../api/odApi'

/**
 * The Pending / Approved switch.
 *
 * A real tablist rather than two links, so the arrow keys move between them and the active
 * tab is announced as selected rather than only looking different. The count on each tab is
 * fetched separately from the list itself, so the number on the tab you are *not* looking
 * at is still true -- which matters most immediately after a decision, when Pending drops
 * by one and Approved rises by one.
 *
 * A failure here degrades to no count rather than an error: the list below is the thing the
 * page is for, and a count that could not be fetched is not worth an alert above it.
 *
 * Lifted out of `ApproverDashboard` and shared, because every role with a two-view OD
 * screen now wants the same switch: a Contest Coordinator and an HOD on their own
 * dashboards, and a mentor and a class advisor on the shared OD Management page. The counts
 * come from the same two endpoints for all four, keyed only on the stage it is given, so
 * the tab has no role of its own to configure.
 */
export default function OdViewTabs({ stage, view, onChange }) {
  const [counts, setCounts] = useState({})

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [pending, approved] = await Promise.all([
        fetchPendingApprovals(stage).catch(() => null),
        fetchApprovedApprovals(stage).catch(() => null),
      ])
      if (cancelled) return
      setCounts({
        pending: pending ? (pending.requests || []).length : undefined,
        approved: approved ? (approved.requests || []).length : undefined,
      })
    }

    load()
    return () => {
      cancelled = true
    }
  }, [stage])

  const tabs = [
    { id: 'pending', label: 'Pending', count: counts.pending },
    { id: 'approved', label: 'Approved', count: counts.approved },
  ]

  return (
    <div className="mb-1 flex flex-wrap justify-center gap-2" role="tablist" aria-label="OD request views">
      {tabs.map((tab) => {
        const active = view === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`od-tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`od-tabpanel-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition-colors ${
              active
                ? 'bg-blue-600 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {tab.label}
            {typeof tab.count === 'number' && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                  active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
