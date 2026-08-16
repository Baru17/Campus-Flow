import { formatYearLabel } from './format'

const SEPARATOR = '-'.repeat(32)

function registerSuffix(registerNo) {
  return String(Number(String(registerNo || '').slice(-3)))
}

/**
 * Build the formatted attendance report copied by the Class Advisor.
 *
 * @param {object} params
 * @param {string} params.department  e.g. 'IT'
 * @param {number} params.year        e.g. 3
 * @param {string} params.section     e.g. 'A'
 * @param {string} params.date        e.g. '2026-08-14'
 * @param {string} params.subjectCode e.g. 'SS'
 * @param {Array<{student: {register_no, student_name}, status: string}>} params.records
 * @returns {string}
 */
export function buildAttendanceReport({ department, year, section, date, subjectCode, records = [] }) {
  const present = records.filter((record) => record.status === 'PRESENT').length
  const total = records.length
  const percentage = total ? Math.round((present / total) * 100) : 0
  const absentees = records.filter((record) => record.status !== 'PRESENT')

  const parsed = new Date(`${date}T00:00:00`)
  const dateLabel = Number.isNaN(parsed.getTime())
    ? date
    : [
        String(parsed.getDate()).padStart(2, '0'),
        String(parsed.getMonth() + 1).padStart(2, '0'),
        parsed.getFullYear(),
      ].join('.')

  const yearLabel = formatYearLabel(year).toUpperCase()
  const classLine = `${yearLabel} - ${section}`
  const summaryLine = `B.Tech ${department}  : ${present}/${total}`
  const percentageLine = `Percentage : ${percentage}%`

  const absenteesList = absentees
    .map(
      (record, index) =>
        `${index + 1}. ${String(record.student?.student_name || '').toUpperCase()} (${registerSuffix(
          record.student?.register_no,
        )})`,
    )
    .join('\n')

  return [
    'Good morning sir,',
    '',
    `Date : ${dateLabel}`,
    `Hour: ${subjectCode}`,
    '',
    classLine,
    summaryLine,
    SEPARATOR,
    percentageLine,
    '',
    'Absentees List',
    absenteesList,
    '',
    '',
    'Thank you sir',
  ].join('\n')
}