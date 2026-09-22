import dotenv from 'dotenv'
dotenv.config({ path: '.env.admin' })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Only these students get Auth accounts right now.
const TARGET_EMAILS = new Set([
  '2k24it121@kiot.ac.in',
  '2k24it122@kiot.ac.in',
  '2k24it123@kiot.ac.in',
  '2k24it124@kiot.ac.in',
  '2k24it125@kiot.ac.in',
  '2k24it126@kiot.ac.in',
  '2k24it127@kiot.ac.in',
  '2k24it128@kiot.ac.in'
])

const INITIAL_PASSWORD = '1234'

async function main() {
  console.log('Fetching IT students...')

  const { data: students, error: studentsError } = await supabase
    .from('it_students')
    .select('student_id, email, auth_user_id')
    .order('student_id')

  if (studentsError) {
    throw studentsError
  }

  const candidates = (students || []).filter((s) =>
    TARGET_EMAILS.has((s.email || '').toLowerCase())
  )

  console.log(
    `Found ${candidates.length} IT students to provision (of ${students?.length ?? 0} total).`
  )

  let created = 0
  let linked = 0
  let skipped = 0
  let failed = 0

  for (const student of candidates) {
    try {
      if (!student.email) {
        console.log(`⚠️ ${student.student_id}: no email`)
        failed++
        continue
      }

      if (student.auth_user_id) {
        console.log(`⏭️ ${student.student_id}: already linked`)
        skipped++
        continue
      }

      const { data: authData, error: createError } =
        await supabase.auth.admin.createUser({
          email: student.email,
          password: INITIAL_PASSWORD,
          email_confirm: true,
          user_metadata: {
            student_id: student.student_id,
            role: 'student',
            department: 'IT'
          }
        })

      if (createError) {
        // If the Auth user already exists, find it and link it.
        if (createError.message.toLowerCase().includes('already')) {
          let existingUser = null

          let page = 1

          while (!existingUser) {
            const { data, error } =
              await supabase.auth.admin.listUsers({
                page,
                perPage: 1000
              })

            if (error) throw error

            existingUser = data.users.find(
              (user) =>
                user.email?.toLowerCase() === student.email.toLowerCase()
            )

            if (data.users.length < 1000) break

            page++
          }

          if (!existingUser) {
            console.log(
              `❌ ${student.student_id}: Auth user reported as existing, but could not be found`
            )
            failed++
            continue
          }

          const { error: linkError } = await supabase
            .from('it_students')
            .update({ auth_user_id: existingUser.id })
            .eq('student_id', student.student_id)

          if (linkError) throw linkError

          console.log(`🔗 ${student.student_id}: linked existing Auth user`)
          linked++
          continue
        }

        throw createError
      }

      const { error: linkError } = await supabase
        .from('it_students')
        .update({ auth_user_id: authData.user.id })
        .eq('student_id', student.student_id)

      if (linkError) {
        // User was created, but linking failed.
        console.log(
          `⚠️ ${student.student_id}: Auth created but DB linking failed`
        )
        console.log(linkError.message)
        failed++
        continue
      }

      console.log(`✅ ${student.student_id}: ${student.email}`)
      created++
      linked++
    } catch (error) {
      console.log(`❌ ${student.student_id}: ${error.message}`)
      failed++
    }
  }

  console.log('\n==============================')
  console.log('IT STUDENT AUTH SETUP COMPLETE')
  console.log('==============================')
  console.log(`Total:   ${candidates.length}`)
  console.log(`Created: ${created}`)
  console.log(`Linked:  ${linked}`)
  console.log(`Skipped: ${skipped}`)
  console.log(`Failed:  ${failed}`)
}

main().catch((error) => {
  console.error('\n❌ Script failed:')
  console.error(error)
  process.exit(1)
})