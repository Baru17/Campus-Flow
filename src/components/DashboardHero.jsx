export default function DashboardHero({ icon, title, subtitle, right }) {
  return (
    <div className="cf-hero-row">
      <div className="cf-hero-left">
        {icon && <span className="cf-icon-badge lg">{icon}</span>}
        <div className="min-w-0">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      {right && <div>{right}</div>}
    </div>
  )
}