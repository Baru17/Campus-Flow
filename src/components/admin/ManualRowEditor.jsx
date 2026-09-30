/**
 * A small grid for typing records in by hand.
 *
 * Manual entry is required alongside upload because a single new student or a
 * corrected subject should not need a one-row spreadsheet. The grid is generic so
 * the student, staff and subject modals can share one implementation: each passes
 * a column description and an empty-row factory, and gets back plain objects keyed
 * by `key`.
 *
 * Validation is intentionally *not* performed here. The modals hand the rows to
 * the same validators the upload path uses, so a hand-typed row and an uploaded
 * row are checked by identical code, and the server re-checks both.
 */
import { PlusIcon, TrashIcon } from '../Icons'

export default function ManualRowEditor({
  columns,
  rows,
  onChange,
  makeEmptyRow,
  addLabel = 'Add another row',
  rowLabel = 'Row',
}) {
  const update = (index, key, value) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)))
  }

  const remove = (index) => {
    // The last remaining row is never removed: an empty grid gives the admin
    // nothing to fill in, and the disabled trash button is clearer than a
    // grid that silently disappears.
    if (rows.length <= 1) return
    onChange(rows.filter((_, i) => i !== index))
  }

  const add = () => onChange([...rows, makeEmptyRow()])

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="advisor-table">
          <thead>
            <tr>
              <th className="advisor-table-num">#</th>
              {columns.map((column) => (
                <th key={column.key}>
                  {column.label}
                  {column.required && (
                    <span className="ml-0.5 text-red-500" aria-hidden="true">
                      *
                    </span>
                  )}
                </th>
              ))}
              <th className="advisor-table-num">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td className="advisor-table-num">{index + 1}</td>
                {columns.map((column) => (
                  <td key={column.key}>
                    {column.type === 'select' ? (
                      <select
                        value={row[column.key] ?? ''}
                        onChange={(e) => update(index, column.key, e.target.value)}
                        className="cf-select w-full min-w-[6rem] text-sm"
                        aria-label={`${column.label} for ${rowLabel.toLowerCase()} ${index + 1}`}
                      >
                        {column.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={column.type === 'number' ? 'number' : 'text'}
                        inputMode={column.type === 'number' ? 'numeric' : undefined}
                        value={row[column.key] ?? ''}
                        onChange={(e) => update(index, column.key, e.target.value)}
                        placeholder={column.placeholder}
                        className="cf-input w-full min-w-[7rem] text-sm"
                        aria-label={`${column.label} for ${rowLabel.toLowerCase()} ${index + 1}`}
                      />
                    )}
                  </td>
                ))}
                <td className="advisor-table-num">
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    disabled={rows.length <= 1}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
                    aria-label={`Remove ${rowLabel.toLowerCase()} ${index + 1}`}
                  >
                    <TrashIcon size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={add}
        className="btn-cf-outline inline-flex items-center gap-2 px-3 py-1.5 text-sm"
      >
        <PlusIcon size={16} />
        {addLabel}
      </button>
    </div>
  )
}
