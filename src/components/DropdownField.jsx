export default function DropdownField({
  label,
  name,
  value,
  onChange,
  options,
  placeholder = 'Select',
  disabled = false,
  icon,
}) {
  return (
    <div>
      <label htmlFor={name} className="cf-form-label">
        {icon && (
          <span aria-hidden="true" className="text-muted-2">
            {icon}
          </span>
        )}
        {label}
      </label>
      <select
        id={name}
        name={name}
        className="cf-select"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((option) => {
          const raw = typeof option === 'object' ? option.value : option
          const labelText = typeof option === 'object' ? option.label : option
          return (
            <option key={`${raw}`} value={raw}>
              {labelText}
            </option>
          )
        })}
      </select>
    </div>
  )
}
