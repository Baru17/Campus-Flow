import { TrashIcon } from '../Icons'

/**
 * The trash control at the end of every admin management row.
 *
 * Factored out so the five tables cannot drift: the students, staff, subject, head of
 * department and coordinator rows all get the same size, the same red, the same
 * disabled treatment and the same accessible name. It is deliberately the compact
 * icon-only form already used by `ManualRowEditor` rather than a labelled button --
 * it sits beside an Edit button that already carries a word, and a second word per row
 * would widen the actions column until the table scrolled on a laptop.
 *
 * Icon-only is only acceptable because it is not the only way in: `title` gives the
 * same affordance on hover, and `aria-label` is built from the row's own identity so
 * a screen reader announces *whose* record this deletes rather than a bare "Delete"
 * repeated fifteen times down a column.
 *
 * Pressing it does not delete anything. It opens `DeleteRecordModal`, which is where
 * the request is made -- there is no single-click delete anywhere in this project.
 */
export default function DeleteRecordButton({ onClick, name, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Delete"
      aria-label={`Delete ${name}`}
      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
    >
      <TrashIcon size={14} />
    </button>
  )
}
