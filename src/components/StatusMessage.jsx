import { InfoIcon, AlertIcon, ErrorIcon, CheckIcon } from './Icons'

const ICONS = {
  info: InfoIcon,
  success: CheckIcon,
  warning: AlertIcon,
  danger: ErrorIcon,
}

export default function StatusMessage({ variant = 'info', children, dismissible = false, onDismiss }) {
  if (!children) return null
  const Icon = ICONS[variant] || InfoIcon
  return (
    <div className={`cf-alert cf-alert-${variant}`} role="alert">
      <span className="cf-alert-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <div className="flex-1">{children}</div>
      {dismissible && onDismiss && (
        <button type="button" className="cf-close" onClick={onDismiss} aria-label="Close" />
      )}
    </div>
  )
}