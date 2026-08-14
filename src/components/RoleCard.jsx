import { ChevronRightIcon } from './Icons'

export default function RoleCard({ title, description, icon, onSelect, variant = 'staff', highlights = [] }) {
  return (
    <div
      className={`role-card role-card--${variant} h-full`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${title} — ${description}`}
    >
      <div className="role-content">
        <div className="role-header-row">
          <span className="role-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="role-tag">{variant === 'staff' ? 'Staff portal' : 'Student portal'}</span>
        </div>

        <div className="role-text-wrap">
          <h3 className="role-title mb-0">{title}</h3>
          <p className="role-desc mb-0">{description}</p>
        </div>

        <ul className="role-highlights" aria-label={`${title} features`}>
          {highlights.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <span className="role-cta" aria-hidden="true">
          Continue <ChevronRightIcon size={17} />
        </span>
      </div>
    </div>
  )
}