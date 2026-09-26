import { YEAR_LABELS } from '../constants'

export function formatYearLabel(year) {
  return YEAR_LABELS[year] || `${year} Year`
}

export function formatClassName(department, year, section) {
  const parts = [department, formatYearLabel(year), section ? `Section ${section}` : '']
  return parts.filter(Boolean).join(' ')
}

export function formatDate(date) {
  const d = date ? new Date(date) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
