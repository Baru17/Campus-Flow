import { useActiveStudentCount } from '../hooks/useActiveStudentCount'
import { UsersIcon } from './Icons'

/*
 * The live active-student count.
 *
 * Built out of the dashboard's own `stat-chip` so it sits in the existing stat strip
 * with no new layout, spacing or breakpoint to get wrong. It shows one number and one
 * indicator:
 *
 *   - a value, which is the last count the server actually returned, or a dash when
 *     there has never been one;
 *   - a status pill, which is where loading, liveness and failure are distinguished.
 *
 * It is a number and nothing else. No names, no register numbers, no list: the
 * endpoint it reads exposes no per-student rows, so there is nothing to show even if
 * this component wanted to.
 *
 * A failing poll never empties the card and never throws past it. The dashboard around
 * it keeps rendering exactly as it did before this card existed.
 */
export default function ActiveStudentsCard({ enabled = true }) {
  const { count, error } = useActiveStudentCount(enabled)

  const hasCount = count !== null
  const loading = !hasCount && !error
  const unavailable = !hasCount && Boolean(error)

  let pillVariant = 'active'
  let pillText = 'Live'
  let pillTitle = 'Refreshing every second'

  if (unavailable) {
    pillVariant = 'expired'
    pillText = 'Offline'
    pillTitle = error?.message || 'The active student count could not be loaded.'
  } else if (loading) {
    pillVariant = 'idle'
    pillText = 'Loading'
    pillTitle = 'Loading the active student count'
  } else if (error) {
    pillVariant = 'idle'
    pillText = 'Stale'
    pillTitle = `Showing the last count that loaded. ${error?.message || ''}`.trim()
  }

  return (
    <div className={`stat-chip stat-chip-${hasCount && !error ? 'green' : 'primary'}`}>
      <span className="stat-chip-icon" aria-hidden="true">
        <UsersIcon size={18} />
      </span>
      <div className="min-w-0">
        <div className="stat-chip-label">Active Students</div>
        <div className="stat-chip-value">{hasCount ? count : '—'}</div>
      </div>
      <span className={`cf-status-pill ${pillVariant} ms-auto shrink-0`} title={pillTitle}>
        <span className="dot" aria-hidden="true" />
        {pillText}
      </span>
    </div>
  )
}
