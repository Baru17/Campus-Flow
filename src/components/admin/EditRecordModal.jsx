/**
 * The frame every admin edit dialog shares.
 *
 * Students, staff and subjects differ only in their fields, so the frame is
 * factored out rather than copy-pasted three times: the save button's disabled
 * and loading behaviour, the double-submit guard and the "keep the dialog open on
 * failure" rule are properties of *saving*, not of any one entity, and having them
 * written once means all three cannot drift.
 *
 * The shell deliberately does not own the form values or the request. It calls
 * `onSave` and renders whatever error comes back, so the entity dialogs keep using
 * the same API functions and the same validators as the create flows.
 *
 * A failure keeps the dialog open on purpose. The values the admin typed are the
 * expensive part of an edit, and closing on an error would throw them away to
 * punish a duplicate register number.
 */
import { AlertIcon, XIcon } from '../Icons'

export default function EditRecordModal({
  title,
  subtitle,
  children,
  onClose,
  onSave,
  saving = false,
  error = null,
  saveLabel = 'Save Changes',
  disabled = false,
}) {
  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="admin-modal max-w-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {/* Inert while saving, so a half-applied request cannot be abandoned. */}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="admin-modal-close"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {children}

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              <div>
                {typeof error === 'string' ? error : error.message}
                {/*
                  Field errors are shown next to their input as well, but repeating
                  them here means a message is never lost off-screen on a long form.
                */}
                {Array.isArray(error?.details?.errors) && error.details.errors.length > 1 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-red-600">
                    {error.details.errors
                      .filter((e) => e.message)
                      .map((e) => (
                        <li key={`${e.field}-${e.message}`}>{e.message}</li>
                      ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn-cf-outline px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            // Disabled while saving *and* while the form is invalid, so an
            // unclickable Save is always a form the admin can see the problem on.
            disabled={saving || disabled}
            className="btn-cf-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
          >
            {saving && <span className="cf-spinner" role="status" aria-hidden="true" />}
            {saving ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
