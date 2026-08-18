import { useState } from 'react'

const PREVIEW_LIMIT = 6

export default function ImportPreviewTable({ rows, columns }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? rows : rows.slice(0, PREVIEW_LIMIT)

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="advisor-table">
        <thead>
          <tr>
            <th className="advisor-table-num">#</th>
            {columns.map((col) => (
              <th key={col.key}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + 1} className="advisor-table-empty">
                No valid rows to preview.
              </td>
            </tr>
          )}
          {visible.map((row, index) => (
            <tr key={index}>
              <td className="advisor-table-num">{index + 1}</td>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={
                    col.monospace ? 'advisor-table-reg' : col.bold ? 'font-bold' : undefined
                  }
                >
                  {row[col.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > PREVIEW_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll((show) => !show)}
          className="block w-full border-t border-slate-200 bg-slate-50 py-2 text-center text-xs font-bold text-blue-600 hover:bg-slate-100"
        >
          {showAll ? 'Show less' : `Show all ${rows.length} rows`}
        </button>
      )}
    </div>
  )
}