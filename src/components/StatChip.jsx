export default function StatChip({ icon, label, value, tone = 'primary' }) {
  return (
    <div className={`stat-chip stat-chip-${tone}`}>
      <span className="stat-chip-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="stat-chip-label">{label}</div>
        <div className="stat-chip-value">{value}</div>
      </div>
    </div>
  )
}