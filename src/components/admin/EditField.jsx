/**
 * One labelled control in an edit dialog.
 *
 * The three edit dialogs are a handful of inputs each, and they need the same
 * three things: a label bound to its control, the error text under the field it
 * belongs to, and a way to show a value that cannot be changed. Doing that inline
 * three times is how a form ends up with an error rendered beside the wrong input.
 *
 * Errors are addressed by field name, which is what both the browser validators in
 * `utils/adminImport` and the server's `adminValidation` return, so a message from
 * either end lands in the same place.
 */
import { AlertIcon } from '../Icons'

export default function EditField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  options = null,
  error = null,
  hint = null,
  readOnly = false,
  placeholder = '',
  autoComplete = undefined,
  inputMode = undefined,
}) {
  return (
    <div>
      <label htmlFor={id} className="cf-form-label">
        {label}
        {readOnly && (
          <span className="text-xs font-medium text-slate-400">cannot be changed</span>
        )}
      </label>

      {options ? (
        <select
          id={id}
          value={value ?? ''}
          disabled={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
          className="cf-select w-full text-sm"
        >
          {options.map((option) => (
            <option key={option.value ?? option} value={option.value ?? option}>
              {option.label ?? option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={readOnly ? 'text' : type}
          value={value ?? ''}
          readOnly={readOnly}
          disabled={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
          className={`cf-input w-full text-sm ${readOnly ? 'bg-slate-100 text-slate-500' : ''}`}
        />
      )}

      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}

      {error && (
        <p role="alert" className="mt-1 flex items-center gap-1 text-xs font-semibold text-red-600">
          <AlertIcon size={12} className="shrink-0" />
          {error}
        </p>
      )}
    </div>
  )
}
