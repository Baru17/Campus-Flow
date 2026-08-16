import * as XLSX from 'xlsx'
import { formatYearLabel } from './format'

const TABLE_BORDER = {
  top: { style: 'thin', color: { rgb: 'B7C1CF' } },
  bottom: { style: 'thin', color: { rgb: 'B7C1CF' } },
  left: { style: 'thin', color: { rgb: 'B7C1CF' } },
  right: { style: 'thin', color: { rgb: 'B7C1CF' } },
}

const HEADER_FILL = { patternType: 'solid', fgColor: { rgb: 'EFF3FA' } }

const HEADER_ROW = 14

function parseDate(date) {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return { label: date, file: '' }
  }
  const dd = String(parsed.getDate()).padStart(2, '0')
  const mm = String(parsed.getMonth() + 1).padStart(2, '0')
  return {
    label: `${dd}.${mm}.${parsed.getFullYear()}`,
    file: `${dd}-${mm}-${parsed.getFullYear()}`,
  }
}

function sanitizePart(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Build the attendance report worksheet for the Class Advisor dashboard.
 * Uses only the already-loaded students + attendanceMap — no extra fetches.
 */
export function buildAttendanceWorkbook({ department, year, section, date, subjectCode, period, students, attendanceMap }) {
  const yearLabel = formatYearLabel(year)
  const dates = parseDate(date)

  const total = students.length
  const present = students.filter((s) => attendanceMap[s.register_no] === 'PRESENT').length
  const absent = students.filter((s) => attendanceMap[s.register_no] === 'ABSENT').length
  const percentage = total ? Math.round((present / total) * 100) : 0

  const rows = [
    ['Campus-Flow Attendance Report'],
    [],
    [`Date: ${dates.label}`],
    [`Department: ${department}`],
    [`Year: ${yearLabel}`],
    [`Section: ${section}`],
    [`Subject: ${subjectCode}`],
    [`Hour: ${period}`],
    [],
    [`Total Students: ${total}`],
    [`Present: ${present}`],
    [`Absent: ${absent}`],
    [`Attendance Percentage: ${percentage}%`],
    [],
    ['#', 'Register No', 'Student Name', 'Status'],
    ...students.map((student, index) => [
      index + 1,
      student.register_no,
      student.student_name,
      attendanceMap[student.register_no] || 'NOT MARKED',
    ]),
  ]

  const ws = XLSX.utils.aoa_to_sheet(rows)

  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }]
  ws['A1'].s = { font: { bold: true, sz: 14, color: { rgb: '1D4ED8' } } }

  for (let r = 2; r <= 12; r++) {
    if (r === 8) continue
    ws[XLSX.utils.encode_cell({ r, c: 0 })].s = { font: { bold: true } }
  }

  for (let r = HEADER_ROW; r < HEADER_ROW + 1 + total; r++) {
    for (let c = 0; c < 4; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      cell.s =
        r === HEADER_ROW
          ? { font: { bold: true }, fill: HEADER_FILL, border: TABLE_BORDER, alignment: { vertical: 'center' } }
          : { border: TABLE_BORDER }
    }
  }

  for (let r = 0; r < total; r++) {
    const status = attendanceMap[students[r].register_no]
    if (status !== 'PRESENT' && status !== 'ABSENT') continue
    const cell = ws[XLSX.utils.encode_cell({ r: HEADER_ROW + 1 + r, c: 3 })]
    cell.s = {
      ...cell.s,
      font: {
        bold: true,
        color: { rgb: status === 'PRESENT' ? '16A34A' : 'DC2626' },
      },
    }
  }

  ws['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 32 }, { wch: 14 }]
  ws['!freeze'] = { xSplit: 0, ySplit: HEADER_ROW + 1 }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Attendance')
  return wb
}

/**
 * Windows-safe file name, e.g. IT_III_YEAR_A_E&ST_Attendance_16-08-2026.xlsx
 */
export function buildAttendanceFileName({ department, year, section, subjectCode, date }) {
  const yearPart = formatYearLabel(year).toUpperCase().replace(/\s+/g, '_')
  const dates = parseDate(date)
  return `${sanitizePart(department)}_${yearPart}_${sanitizePart(section)}_${sanitizePart(
    subjectCode,
  )}_Attendance_${dates.file}.xlsx`
}

/**
 * Build the workbook, name the file and trigger the browser download.
 */
export function downloadAttendanceExcel(params) {
  const wb = buildAttendanceWorkbook(params)
  const fileName = buildAttendanceFileName(params)
  XLSX.writeFile(wb, fileName)
}