export function buildAttendanceReport({ department, section, date, subjectCode, subjectName, totalStrength, present, absent, od, percentage, absentees, odStudents }) {
  const dateLabel = date || new Date().toISOString().slice(0, 10)

  const absenteesList = absentees && absentees.length > 0
    ? absentees.map((s, i) => `${i + 1}. ${s.name.toUpperCase()} (${s.register_no})`).join('\n')
    : 'Nil'

  const odList = odStudents && odStudents.length > 0
    ? odStudents.map((s, i) => `${i + 1}. ${s.name.toUpperCase()} (${s.register_no})`).join('\n')
    : 'Nil'

  return [
    'Good Morning Sir,',
    `Date: ${dateLabel}`,
    '',
    `B. Tech - ${department} - ${section}`,
    `Total Strength: ${totalStrength}`,
    `Present: ${present}/${totalStrength}`,
    `Absent: ${absent}`,
    `OD: ${od}`,
    `Hour: ${subjectName || subjectCode || ''}`,
    '',
    'Absentees:',
    '',
    absenteesList,
    '',
    'OD:',
    odList,
    '',
    `Attendance Percentage: ${percentage}%`,
  ].join('\n')
}
