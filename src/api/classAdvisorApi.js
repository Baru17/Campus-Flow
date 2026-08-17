import { supabase, BACKEND_CONFIGURED } from './supabase'
import { ApiError } from './attendanceApi'

const NOT_CONFIGURED_MESSAGE =
  'The attendance backend is not configured yet. Contact the administrator.'

function assertBackend() {
  if (!BACKEND_CONFIGURED || !supabase) {
    throw new ApiError(NOT_CONFIGURED_MESSAGE, { code: 'not-configured' })
  }
}

function normalizeDepartment(department) {
  return String(department || '').toUpperCase()
}

/**
 * The students table for a department.
 * IT uses one permanent table per batch:
 * 1st year  -> it_students_2026_2030
 * 2nd year  -> it_students_2025_2029
 * 3rd year  -> it_students_2024_2028
 * 4th year  -> it_students_2023_2027
 * Other departments use a single table.
 */
export function getStudentTable(department, year) {
  const dept = normalizeDepartment(department)

  if (dept === 'IT') {
    const itYear = Number(year)

    const batchTables = {
      1: 'it_students_2026_2030',
      2: 'it_students_2025_2029',
      3: 'it_students_2024_2028',
      4: 'it_students_2023_2027',
    }

    return batchTables[itYear] || null
  }

  const map = {
    CSE: 'cse_students',
    ECE: 'ece_students',
    EEE: 'eee_students',
  }

  return map[dept] || null
}
/**
 * The students table for a department.
 * IT uses one permanent table per batch:
 * 1st year  -> it_students_2026_2030
 * 2nd year  -> it_students_2025_2029
 * 3rd year  -> it_students_2024_2028
 * 4th year  -> it_students_2023_2027
 * Other departments use a single table.
 */
export function getAttendanceTable(department, year) {
  const dept = normalizeDepartment(department)

  if (dept === 'IT') {
    const itYear = Number(year)

    const batchTables = {
      1: 'it_attendance_2026_2030',
      2: 'it_attendance_2025_2029',
      3: 'it_attendance_2024_2028',
      4: 'it_attendance_2023_2027',
    }

    return batchTables[itYear] || null
  }

  const map = {
    CSE: 'cse_attendance',
    ECE: 'ece_attendance',
    EEE: 'eee_attendance',
  }

  return map[dept] || null
}

/**
 * Resolve the signed-in staff member's class advisor assignment.
 * Returns null when the staff member is not an active advisor.
 */
export async function getAdvisorAssignment(staffId) {
  assertBackend()
  if (!staffId) return null
  const { data, error } = await supabase
    .from('class_advisors')
    .select('advisor_id, staff_id, department, year, section, is_active')
    .eq('staff_id', staffId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) {
    throw new ApiError('Could not resolve your advisor assignment. Please try again.', {
      code: error.code,
    })
  }
  return data || null
}

/**
 * All students of the advisor's assigned class.
 */
export async function getClassStudents(department, year, section) {
  assertBackend()
  const table = getStudentTable(department, year)
  if (!table) return []
  const { data, error } = await supabase
    .from(table)
    .select('student_id, register_no, student_name')
    .eq('year', year)
    .eq('section', section)
    .order('register_no', { ascending: true })
  if (error) {
    throw new ApiError('Could not load class students. Please try again.', { code: error.code })
  }
  return data || []
}

/**
 * The distinct subject_ids that have attendance for a date + period.
 * Used to auto-select the subject for the selected hour.
 */
export async function getSlotSubjects(attendanceTable, date, period) {
  assertBackend()
  if (!attendanceTable || !date || !period) return []
  const { data, error } = await supabase
    .from(attendanceTable)
    .select('subject_id')
    .eq('attendance_date', date)
    .eq('period', period)
  if (error) {
    throw new ApiError('Could not load attendance slots. Please try again.', { code: error.code })
  }
  return [...new Set((data || []).map((row) => row.subject_id))]
}

/**
 * Attendance status per register_no for a date + period + subject.
 */
export async function getAttendanceRows(attendanceTable, date, period, subjectId) {
  assertBackend()
  if (!attendanceTable || !date || !period || !subjectId) return {}
  const { data, error } = await supabase
    .from(attendanceTable)
    .select('register_no, status')
    .eq('attendance_date', date)
    .eq('period', period)
    .eq('subject_id', subjectId)
  if (error) {
    throw new ApiError('Could not load attendance. Please try again.', { code: error.code })
  }
  return (data || []).reduce((map, row) => {
    map[row.register_no] = row.status
    return map
  }, {})
}

/**
 * Set a student's attendance status for a date + period + subject.
 * Updates an existing record or inserts a new one when missing.
 */
export async function upsertAttendanceStatus({ attendanceTable, registerNo, date, period, subjectId, status }) {
  assertBackend()
  if (!attendanceTable || !registerNo || !date || !period || !subjectId) {
    throw new ApiError('Missing attendance details.', { code: 'invalid-attendance' })
  }
  const nextStatus = String(status || '').toUpperCase() === 'PRESENT' ? 'PRESENT' : 'ABSENT'

  const { data: existing, error: findError } = await supabase
    .from(attendanceTable)
    .select('attendance_id')
    .eq('register_no', registerNo)
    .eq('attendance_date', date)
    .eq('period', period)
    .eq('subject_id', subjectId)
    .maybeSingle()

  if (findError) {
    throw new ApiError('Could not find the attendance record. Please try again.', {
      code: findError.code,
    })
  }

  const markedAt = new Date().toISOString()

  if (existing) {
    const { error: updateError } = await supabase
      .from(attendanceTable)
      .update({ status: nextStatus, marked_at: markedAt })
      .eq('attendance_id', existing.attendance_id)
    if (updateError) {
      throw new ApiError('Could not update attendance. Please try again.', {
        code: updateError.code,
      })
    }
  } else {
    const { error: insertError } = await supabase.from(attendanceTable).insert({
      register_no: registerNo,
      attendance_date: date,
      period,
      subject_id: subjectId,
      status: nextStatus,
      marked_at: markedAt,
    })
    if (insertError) {
      throw new ApiError('Could not mark attendance. Please try again.', {
        code: insertError.code,
      })
    }
  }

  return nextStatus
}