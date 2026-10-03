/**
 * The confirmation every admin delete goes through.
 *
 * One dialog for all five directories -- students, staff, subjects, heads of
 * department and contest coordinators -- because the decision an admin is being asked
 * to make is the same one every time, and it has to be a *decision*:
 *
 *   - The frame is the one `EditRecordModal` already uses, `admin-modal-backdrop` over
 *     `admin-modal`, with the same close button, the same spinner and the same red
 *     error panel. A delete that looked different from an edit would be a second
 *     design language on a screen that currently has one.
 *   - The identity block is not decoration. "Delete student?" next to a Confirm button
 *     is a coin toss with a person's record on it; the name, the id and the cohort are
 *     what let the admin notice they are looking at the wrong row before it happens.
 *   - Nothing is deleted on a single click anywhere in this project. The trash icon
 *     only ever sets state; the request is made from here.
 *
 * ## Failure keeps the dialog open
 *
 * The same rule the edit dialogs follow, and for a sharper reason. A delete can be
 * refused for a reason the admin can act on -- a subject attendance already names, a
 * staff member who is currently a contest coordinator -- and the server says which in
 * a sentence written for that case. Closing on failure would throw that away and
 * leave a row on screen that no longer matches anything the admin was told.
 *
 * The dialog never pretends. It does not close, and the button goes live again, unless
 * the request succeeded.
 *
 * ## Double submission
 *
 * `deleting` disables both the confirm button and Cancel, and `handleConfirm` returns
 * immediately if it is already set. That matters more here than on a save: a second
 * identical DELETE is answered 404, so an unguarded double-click would report a
 * successful deletion and then a "not found", and the admin would be left not knowing
 * which of the two to believe.
 *
 * `onConfirm` and `onDeleted` are separate for the same reason. Only the request can
 * fail in a way the admin should be shown; the page's own bookkeeping -- closing this
 * dialog, refetching the list -- runs after it and must not be reported as a failed
 * deletion when the row is already gone.
 */
import { useState } from 'react'
import { AlertIcon, TrashIcon, XIcon } from '../Icons'

export default function DeleteRecordModal({
  /** Dialog heading, e.g. "Delete student?". */
  title,
  /** Singular noun for the record, used in the warning sentence. */
  entityLabel,
  /** The person's or entry's name, shown as the heading of the identity block. */
  name,
  /** Identifying facts beneath the name. Strings; empty entries are dropped. */
  details = [],
  /** What is about to happen, in the admin's terms. */
  warning,
  /** What the record's deletion does to the login, when it is not the default. */
  note = null,
  /** The request. Rejects with an `ApiError`; resolving means the row is gone. */
  onConfirm,
  /**
   * Called once the request has succeeded, so the caller can close the dialog and
   * refresh the list. Kept separate from `onConfirm` for the same reason
   * `EditDirectoryRecordModal` separates `onSubmit` from `onSaved`: a failure here
   * must not be reported to the admin as a failed deletion when the row is already
   * gone.
   */
  onDeleted,
  onClose,
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)

  const handleConfirm = async () => {
    // The guard as well as the disabled attribute: a click that lands between the
    // click and the re-render would otherwise go straight through.
    if (deleting) return
    setDeleting(true)
    setError(null)
    try {
      await onConfirm()
      onDeleted()
    } catch (err) {
      // Kept open on purpose; see the note at the top of this file.
      setError(err)
    } finally {
      setDeleting(false)
    }
  }

  const shownDetails = details.filter(Boolean)

  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="admin-modal max-w-lg">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-red-200 bg-red-50 text-red-600"
              aria-hidden="true"
            >
              <TrashIcon size={18} />
            </span>
            <div>
              <h2 className="text-lg font-extrabold tracking-tight text-slate-900">{title}</h2>
              {warning && <p className="mt-0.5 text-sm text-slate-500">{warning}</p>}
            </div>
          </div>
          {/* Inert while deleting, so a half-applied request cannot be abandoned. */}
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="admin-modal-close"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/*
            Who is about to be removed, rather than what is about to happen. The
            details arrive as whole sentences already ("Register No 24IT731"), so they
            are plain lines rather than a definition list -- there is no label/value
            pair to pair up, and inventing one would only make a screen reader announce
            an empty term before every value.
          */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-sm font-extrabold text-slate-900">{name}</p>
            {shownDetails.length > 0 && (
              <div className="mt-1.5 space-y-0.5 text-xs text-slate-600">
                {shownDetails.map((detail, index) => (
                  <p key={`${detail}-${index}`} className="advisor-table-reg">
                    {detail}
                  </p>
                ))}
              </div>
            )}
          </div>

          <p className="text-sm text-slate-600">
            This action will permanently delete this {entityLabel} record. It cannot be
            undone from the admin panel.
          </p>

          {note && <p className="text-xs text-slate-500">{note}</p>}

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              {/*
                The server's own sentence, not a generic one. A refusal here names the
                conflict -- a subject attendance references, an appointment to remove
                first -- and replacing it with "something went wrong" would throw away
                the only useful part of the response.
              */}
              <div>{typeof error === 'string' ? error : error.message}</div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="btn-cf-outline px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={deleting}
            className="btn-cf-danger inline-flex items-center gap-2 px-4 py-2 text-sm"
          >
            {deleting && <span className="cf-spinner" role="status" aria-hidden="true" />}
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
