import dotenv from 'dotenv'
dotenv.config({ path: '.env.admin' })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// The ONLY real IT staff that get development auth accounts right now.
const TARGET_STAFF_IDS = new Set([1, 3, 4])

const INITIAL_PASSWORD = '1234'

async function main() {
  console.log('Fetching staff from public.staff...')

  const { data: staff, error: staffError } = await supabase
    .from('staff')
    .select('staff_id, staff_name, email, department, auth_user_id')
    .order('staff_id')

  if (staffError) {
    throw staffError
  }

  const candidates = (staff || []).filter(
    (s) => s.department === 'IT' && TARGET_STAFF_IDS.has(Number(s.staff_id))
  )

  console.log(`Found ${candidates.length} IT staff to provision (of ${staff.length} total).\n`)

  let created = 0
  let linked = 0
  let skipped = 0
  let failed = 0

  for (const member of candidates) {
    const label = `${member.staff_name} (${member.staff_id})`
    try {
      if (!member.email) {
        console.log(`❌ ${label}: no email`)
        failed++
        continue
      }

      if (member.auth_user_id) {
        console.log(`⏭️ ${label}: already linked`)
        skipped++
        continue
      }

      const { data: authData, error: createError } =
        await supabase.auth.admin.createUser({
          email: member.email,
          password: INITIAL_PASSWORD,
          email_confirm: true,
          user_metadata: {
            staff_id: member.staff_id,
            role: 'staff',
            department: member.department
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
                user.email?.toLowerCase() === member.email.toLowerCase()
            )

            if (data.users.length < 1000) break

            page++
          }

          if (!existingUser) {
            console.log(
              `❌ ${label}: Auth user reported as existing, but could not be found`
            )
            failed++
            continue
          }

          const { error: linkError } = await supabase
            .from('staff')
            .update({ auth_user_id: existingUser.id })
            .eq('staff_id', member.staff_id)

          if (linkError) throw linkError

          console.log(`🔗 ${label}: linked existing Auth user`)
          linked++
          continue
        }

        throw createError
      }

      const { error: linkError } = await supabase
        .from('staff')
        .update({ auth_user_id: authData.user.id })
        .eq('staff_id', member.staff_id)

      if (linkError) {
        // User was created, but linking failed.
        console.log(`⚠️ ${label}: Auth created but DB linking failed`)
        console.log(linkError.message)
        failed++
        continue
      }

      console.log(`✅ ${label}: ${member.email}`)
      created++
      linked++
    } catch (error) {
      console.log(`❌ ${label}: ${error.message}`)
      failed++
    }
  }

  console.log('\n==============================')
  console.log('STAFF AUTH SETUP COMPLETE')
  console.log('==============================')
  console.log(`Candidates: ${candidates.length}`)
  console.log(`Created:    ${created}`)
  console.log(`Linked:     ${linked}`)
  console.log(`Skipped:    ${skipped}`)
  console.log(`Failed:     ${failed}`)
}

main().catch((error) => {
  console.error('\n❌ Script failed:')
  console.error(error)
  process.exit(1)
})