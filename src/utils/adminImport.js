import * as XLSX from 'xlsx'
import { ALLOWED_SECTIONS, isAdvisorFlag } from './sectionValidation'
import { DEPARTMENTS } from '../constants'

const HEADER_ALIASES = {
  student_id: ['studentid', 'studentidno', 'id'],
  register_no: ['registerno', 'regno', 'registernumber', 'regnumber', 'rollno', 'rollnumber'],
  student_name: ['studentname', 'fullname', 'name'],
  year: ['year', 'currentyear', 'academicyear'],
  section: ['section', 'sec'],
  email: ['email', 'emailid'],
  staff_id: ['staffid', 'staffidno', 'employeeid'],
  staff_name: ['staffname', 'fullname', 'name'],
  semester: ['semester', 'sem'],
  subject_code: ['subjectcode', 'code'],
  subject_name: ['subjectname', 'subject'],
  department: ['department', 'dept'],
  hod_name: ['hodname', 'hod', 'headofdepartment', 'headofdepartmentname'],
  coordinator_name: [
    'coordinatorname',
    'coordinator',
    'contestcoordinator',
    'contestcoordinatorname',
  ],
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
  semester: 'semester',
  subject_code: 'subject_code',
  subject_name: 'subject_name',
  department: 'department',
  hod_name: 'hod_name',
  coordinator_name: 'coordinator_name',
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
  const optional = options.optional || new Set()
  const missingColumns = required.filter((col) => !optional.has(col) && !presentHeaders.has(col))

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
      value.email = email

      if (!studentId) reason = 'Missing student_id'
      else if (!registerNo) reason = 'Missing register_no'
      else if (!studentName) reason = 'Missing student_name'
      else if (!Number.isInteger(year) || year < 1 || year > 4)
        reason = `Invalid year: ${trimString(raw.year) || '(empty)'}`
      else if (!section) reason = 'Missing section'
      // The student table has `email TEXT NOT NULL UNIQUE`, so a blank email is a
      // hard error rather than something to fill in later.
      else if (!email) reason = 'Missing email'
      else if (!email.includes('@')) reason = 'Invalid email'
      else if (!ALLOWED_SECTIONS.includes(section))
        reason = `Invalid section "${section}". Use one of ${ALLOWED_SECTIONS.join(', ')}`

      if (studentId) {
        const key = studentId.toLowerCase()
        seenStudentIds.set(key, (seenStudentIds.get(key) || 0) + 1)
      }
      if (registerNo) {
        const key = registerNo.toLowerCase()
        seenRegisterNos.set(key, (seenRegisterNos.get(key) || 0) + 1)
      }
      if (email) {
        seenEmails.set(email, (seenEmails.get(email) || 0) + 1)
      }
    } else {
      const staffName = trimString(raw.staff_name)
      const email = trimString(raw.email).toLowerCase()
      const isAdvisor = isAdvisorFlag(raw.class_advisor)
      const advisorYear = trimString(raw.advisor_year)
      const advisorSection = trimString(raw.advisor_section).toUpperCase()
      const advisorBatch = trimString(raw.advisor_batch)

      value.staff_name = staffName
      value.email = email
      // Always forwarded, so the server sees an explicit yes or no rather than
      // having to infer it from whether the advisor columns happen to be filled in.
      value.class_advisor = isAdvisor
      // Only meaningful for an advisor, and stripped otherwise so a stray value on a
      // non-advisor row cannot promote them to one.
      if (isAdvisor) {
        if (advisorYear) value.advisor_year = Number(advisorYear)
        if (advisorSection) value.advisor_section = advisorSection
        if (advisorBatch) value.advisor_batch = advisorBatch
      }

      if (!staffName) reason = 'Missing staff_name'
      else if (!email || !email.includes('@')) reason = 'Missing or invalid email'
      else if (isAdvisor) {
        // An advisor is scoped to a cohort, a year and a section, and the attendance
        // routes resolve tables from all three, so they are required together.
        if (!advisorBatch) reason = 'A class advisor needs advisor_batch'
        else if (!advisorYear) reason = 'A class advisor needs advisor_year'
        else if (!advisorSection) reason = 'A class advisor needs advisor_section'
        else if (!Number.isInteger(Number(advisorYear)) || Number(advisorYear) < 1 || Number(advisorYear) > 4)
          reason = `Invalid advisor year: ${advisorYear}`
        else if (!ALLOWED_SECTIONS.includes(advisorSection))
          reason = `Invalid advisor section "${advisorSection}". Use one of ${ALLOWED_SECTIONS.join(', ')}`
      } else if (advisorYear && (!Number.isInteger(Number(advisorYear)) || Number(advisorYear) < 1 || Number(advisorYear) > 4))
        // A non-advisor with a bad year is still worth flagging, so a column-mapping
        // mistake in the spreadsheet surfaces here rather than being silently dropped.
        reason = `Invalid advisor year: ${advisorYear}`
      else if (advisorSection && !ALLOWED_SECTIONS.includes(advisorSection))
        reason = `Invalid advisor section "${advisorSection}". Use one of ${ALLOWED_SECTIONS.join(', ')}`

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

/*
 * Expected columns per entity, kept next to the upload UI so the two cannot drift.
 * These mirror the columns the admin API validates server-side; the browser copy is
 * for preview only and is never the authority.
 *
 * `class_advisor` is optional on staff because most staff teach without holding a
 * class, and every `advisor_*` column is optional for the same reason. They become
 * required together once `class_advisor` is set, which is checked per row.
 */
export const STUDENT_COLUMNS = [
  'student_id',
  'register_no',
  'student_name',
  'year',
  'section',
  'email',
]
export const STAFF_COLUMNS = ['staff_name', 'email', 'class_advisor', 'advisor_year', 'advisor_section', 'advisor_batch']
export const SUBJECT_COLUMNS = ['subject_code', 'subject_name']

/*
 * Heads of department and contest coordinators.
 *
 * Both files are three columns: a name, an address, and the department the person
 * belongs to. Every column is required, unlike a staff file where the advisor
 * columns are optional, because there is nothing optional about a directory entry.
 */
export const HOD_COLUMNS = ['hod_name', 'email', 'department']
export const COORDINATOR_COLUMNS = ['coordinator_name', 'email', 'department']

/*
 * Columns that may be absent from a staff file. `class_advisor` is absent for the
 * common case of someone who teaches without holding a class, and the `advisor_*`
 * columns are only meaningful for one who does.
 */
const STUDENT_OPTIONAL = new Set([])
const STAFF_OPTIONAL = new Set(['class_advisor', 'advisor_year', 'advisor_section', 'advisor_batch'])

export function validateStudentRows(rows) {
  return validateRows(rows, STUDENT_COLUMNS, {
    kind: 'student',
    idColumn: 'student_id',
    optional: STUDENT_OPTIONAL,
  })
}

export function validateStaffRows(rows) {
  return validateRows(rows, STAFF_COLUMNS, {
    kind: 'staff',
    idColumn: 'email',
    optional: STAFF_OPTIONAL,
  })
}

export function validateSubjectRows(rows) {
  const present = new Set(rows[0] ? Object.keys(rows[0]) : [])
  const missingColumns = SUBJECT_COLUMNS.filter((key) => !present.has(key))
  if (missingColumns.length) return { missingColumns, total: 0, validRows: [], invalidRows: [] }
  const seen = new Set(),
    validRows = [],
    invalidRows = []
  rows.forEach((raw, index) => {
    const subject_code = trimString(raw.subject_code).toUpperCase()
    const subject_name = trimString(raw.subject_name)
    let reason = ''
    if (!subject_code) reason = 'Missing subject_code'
    else if (!subject_name) reason = 'Missing subject_name'
    else if (seen.has(subject_code)) reason = `Duplicate subject code ${subject_code} in upload`
    else seen.add(subject_code)
    if (reason) invalidRows.push({ rowNumber: index + 2, reason })
    else validRows.push({ subject_code, subject_name })
  })
  return { missingColumns: [], total: rows.length, validRows, invalidRows }
}

/**
 * Validates a directory file: a name, an address, and a department.
 *
 * Used for both heads of department and contest coordinators, parameterised by the
 * column the name arrives in. Those two tables hold the same three facts under
 * different column names, and the checks below are identical -- required name, an
 * address with an `@` in it, and a department from the shared `DEPARTMENTS` list --
 * so writing them once means the two screens cannot drift apart.
 *
 * The name is passed as `nameKey` rather than hard-coded, because the row the
 * validator returns and the reason string it reports both have to name the column
 * the admin's spreadsheet actually used.
 *
 * Duplicates are handled exactly as they are for staff: an address repeated inside
 * one file is a data error, the first occurrence wins, and the repeat is reported
 * rather than offered for insertion. That is also what keeps a file from creating
 * two accounts for one person, since the account name is the address.
 */
function validateDirectoryRows(rows, { nameKey, required }) {
  const present = new Set(rows[0] ? Object.keys(rows[0]) : [])
  const missingColumns = required.filter((key) => !present.has(key))
  if (missingColumns.length) {
    return {
      missingColumns,
      total: 0,
      validRows: [],
      invalidRows: [],
      duplicateEmails: [],
    }
  }

  const seenEmails = new Set()
  const emailCounts = new Map()
  const validRows = []
  const invalidRows = []

  rows.forEach((raw, index) => {
    const rowNumber = index + 2 // 1-indexed + header row
    const name = trimString(raw[nameKey])
    const email = trimString(raw.email).toLowerCase()
    const department = trimString(raw.department).toUpperCase()

    const value = { [nameKey]: name, email, department }

    let reason = ''
    if (!name) reason = `Missing ${nameKey}`
    else if (name.length > 120) reason = `${nameKey} must be 120 characters or fewer`
    else if (!email || !email.includes('@')) reason = 'Missing or invalid email'
    else if (!department) reason = 'Missing department'
    else if (!DEPARTMENTS.includes(department))
      reason = `Invalid department "${department}". Use one of ${DEPARTMENTS.join(', ')}`
    else if (seenEmails.has(email)) reason = `Duplicate email ${email} in upload`

    // Counted on every row, valid or not, so the summary tile can name a repeated
    // address even when the second occurrence was already reported as invalid for
    // some other reason. One pass, because a 2000-row file is a legitimate upload.
    if (email) emailCounts.set(email, (emailCounts.get(email) || 0) + 1)

    if (reason) {
      invalidRows.push({ rowNumber, [nameKey]: name, reason })
    } else {
      seenEmails.add(email)
      validRows.push(value)
    }
  })

  return {
    missingColumns: [],
    total: rows.length,
    validRows,
    invalidRows,
    duplicateEmails: [...emailCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([email]) => email),
  }
}

export function validateHodRows(rows) {
  return validateDirectoryRows(rows, { nameKey: 'hod_name', required: HOD_COLUMNS })
}

export function validateContestCoordinatorRows(rows) {
  return validateDirectoryRows(rows, { nameKey: 'coordinator_name', required: COORDINATOR_COLUMNS })
}
