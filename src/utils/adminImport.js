import * as XLSX from 'xlsx'

const HEADER_ALIASES = {
  student_id: ['studentid', 'studentidno', 'id'],
  register_no: ['registerno', 'regno', 'registernumber', 'regnumber', 'rollno', 'rollnumber'],
  student_name: ['studentname', 'fullname', 'name'],
  year: ['year', 'currentyear', 'academicyear'],
  section: ['section', 'sec'],
  email: ['email', 'emailid'],
  staff_id: ['staffid', 'staffidno', 'employeeid'],
  staff_name: ['staffname', 'fullname', 'name'],
}

const KEY_TO_CANONICAL = {
  student_id: 'student_id',
  register_no: 'register_no',
  student_name: 'student_name',
  year: 'year',
  section: 'section',
  email: 'email',
  staff_id: 'staff_id',
  staff_name: 'staff_name',
}

/**
 * Normalize a header cell (e.g. "Student ID", "register no.") to the
 * canonical database column key (e.g. "student_id"). Unknown headers are
 * ignored by import validation.
 */
export function normalizeHeader(value) {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (!cleaned) return ''
  if (KEY_TO_CANONICAL[cleaned]) return KEY_TO_CANONICAL[cleaned]
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(cleaned)) return key
  }
  return ''
}

export function normalizeRowHeaders(row) {
  const out = {}
  for (const [header, value] of Object.entries(row || {})) {
    const key = normalizeHeader(header)
    if (key) out[key] = value
  }
  return out
}

/**
 * Read a CSV or XLSX file and return rows keyed by canonical column names.
 * Rejects unsupported file types and unreadable files.
 */
export function parseImportFile(file) {
  return new Promise((resolve) => {
    const name = String(file?.name || '')
    const ext = name.split('.').pop().toLowerCase()

    if (ext !== 'csv' && ext !== 'xlsx') {
      resolve({
        error: `Unsupported file type "${ext || 'unknown'}". Please upload a .csv or .xlsx file.`,
      })
      return
    }

    const reader = new FileReader()

    reader.onerror = () => {
      resolve({ error: 'Could not read the file. Please try again.' })
    }

    reader.onload = () => {
      try {
        let workbook
        if (ext === 'csv') {
          workbook = XLSX.read(String(reader.result || ''), { type: 'string' })
        } else {
          workbook = XLSX.read(new Uint8Array(reader.result), { type: 'array' })
        }

        const sheetName = workbook.SheetNames?.[0]
        const sheet = sheetName ? workbook.Sheets[sheetName] : null
        if (!sheet) {
          resolve({ error: 'The file does not contain any data.' })
          return
        }

        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }).map(normalizeRowHeaders)
        resolve({ rows })
      } catch {
        resolve({
          error: 'Could not read the file. Make sure it is a valid CSV or Excel (.xlsx) file.',
        })
      }
    }

    if (ext === 'csv') {
      reader.readAsText(file, 'utf-8')
    } else {
      reader.readAsArrayBuffer(file)
    }
  })
}

function trimString(value) {
  return String(value ?? '').trim()
}

/**
 * Validate parsed rows against a set of required columns.
 *
 * Returns:
 * - missingColumns: required columns absent from the header row
 * - total: number of rows in the file
 * - validRows: rows that pass field validation and are unique in-file
 * - invalidRows: rows that fail field validation (with reason)
 * - duplicateStudentIds / duplicateRegisterNos: values repeated in-file
 *   (students)
 * - duplicateEmails: values repeated in-file (staff)
 */
function validateRows(rows, required, options = {}) {
  const presentHeaders = new Set(rows[0] ? Object.keys(rows[0]) : [])
  const missingColumns = required.filter((col) => !presentHeaders.has(col))

  if (missingColumns.length > 0) {
    return {
      missingColumns,
      total: 0,
      validRows: [],
      invalidRows: [],
      duplicateStudentIds: [],
      duplicateRegisterNos: [],
      duplicateEmails: [],
    }
  }

  const total = rows.length
  const validRows = []
  const invalidRows = []
  const seenStudentIds = new Map()
  const seenRegisterNos = new Map()
  const seenEmails = new Map()

  const kind = options.kind || 'student'
  const idColumn = options.idColumn || 'student_id'

  rows.forEach((raw, index) => {
    const rowNumber = index + 2 // 1-indexed + header row

    const value = {}
    let reason = ''

    if (kind === 'student') {
      const studentId = trimString(raw.student_id).toUpperCase()
      const registerNo = trimString(raw.register_no)
      const studentName = trimString(raw.student_name)
      const section = trimString(raw.section).toUpperCase()
      const year = raw.year === '' || raw.year == null ? NaN : Number(raw.year)
      const email = trimString(raw.email).toLowerCase()

      value.student_id = studentId
      value.register_no = registerNo
      value.student_name = studentName
      value.year = Number.isInteger(year) ? year : ''
      value.section = section
      if (email) value.email = email

      if (!studentId) reason = 'Missing student_id'
      else if (!registerNo) reason = 'Missing register_no'
      else if (!studentName) reason = 'Missing student_name'
      else if (!Number.isInteger(year) || year < 1 || year > 4)
        reason = `Invalid year: ${trimString(raw.year) || '(empty)'}`
      else if (!section) reason = 'Missing section'

      if (studentId) {
        const key = studentId.toLowerCase()
        seenStudentIds.set(key, (seenStudentIds.get(key) || 0) + 1)
      }
      if (registerNo) {
        const key = registerNo.toLowerCase()
        seenRegisterNos.set(key, (seenRegisterNos.get(key) || 0) + 1)
      }
    } else {
      const staffName = trimString(raw.staff_name)
      const email = trimString(raw.email).toLowerCase()

      value.staff_name = staffName
      value.email = email

      if (!staffName) reason = 'Missing staff_name'
      else if (!email || !email.includes('@')) reason = 'Missing or invalid email'

      if (email) {
        seenEmails.set(email, (seenEmails.get(email) || 0) + 1)
      }
    }

    if (reason) {
      invalidRows.push({ rowNumber, [idColumn]: value[idColumn] || '', reason })
    } else {
      validRows.push(value)
    }
  })

  const duplicateStudentIds = [...seenStudentIds.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key.toUpperCase())
  const duplicateRegisterNos = [...seenRegisterNos.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
  const duplicateEmails = [...seenEmails.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)

  // Recompute valid rows excluding in-file duplicates so nothing duplicated
  // is ever offered for insertion.
  const dupSidSet = new Set(duplicateStudentIds.map((v) => v.toLowerCase()))
  const dupRegSet = new Set(duplicateRegisterNos.map((v) => v.toLowerCase()))
  const dupEmailSet = new Set(duplicateEmails)

  const finalValid = []
  for (const row of validRows) {
    if (kind === 'student') {
      const isDup =
        (row.student_id && dupSidSet.has(row.student_id.toLowerCase())) ||
        (row.register_no && dupRegSet.has(row.register_no.toLowerCase()))
      if (!isDup) finalValid.push(row)
    } else {
      if (!dupEmailSet.has(row.email)) finalValid.push(row)
    }
  }

  return {
    missingColumns: [],
    total,
    validRows: finalValid,
    invalidRows,
    duplicateStudentIds,
    duplicateRegisterNos,
    duplicateEmails,
  }
}

export function validateStudentRows(rows) {
  return validateRows(rows, ['student_id', 'register_no', 'student_name', 'year', 'section'], {
    kind: 'student',
    idColumn: 'student_id',
  })
}

export function validateStaffRows(rows) {
  return validateRows(rows, ['staff_name', 'email'], {
    kind: 'staff',
    idColumn: 'email',
  })
}
