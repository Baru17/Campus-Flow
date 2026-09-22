import dotenv from 'dotenv'
dotenv.config({ path: '.env.admin' })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// The administrator account used by the Administrative Dashboard.
const ADMIN_EMAIL = 'admin@kiot.ac.in'
const ADMIN_PASSWORD = '1234'

async function main() {
  console.log(`Checking for existing admin Auth user: ${ADMIN_EMAIL}`)

  const { data: existingUsers } = await supabase.auth.admin.listUsers({ perPage: 1000 })

  const existing = (existingUsers?.users || []).find(
    (user) => user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()
  )

  if (existing) {
    console.log('Admin Auth user already exists. Updating role metadata...')

    const { data, error } = await supabase.auth.admin.updateUserById(existing.id, {
      app_metadata: {
        ...(existing.app_metadata || {}),
        role: 'admin',
      },
      email_confirm: true,
    })

    if (error) {
      console.log(`❌ Failed to update admin role: ${error.message}`)
      process.exit(1)
    }

    console.log(`✅ Admin role confirmed for ${data.user.email}`)
    console.log(`   Sign in with password: ${ADMIN_PASSWORD}`)
    console.log('   The password is NOT changed if the account already exists.')
    return
  }

  console.log('Creating admin Auth user...')

  const { data, error } = await supabase.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    app_metadata: {
      role: 'admin',
    },
  })

  if (error) {
    console.log(`❌ Failed to create admin user: ${error.message}`)
    process.exit(1)
  }

  console.log('==============================')
  console.log('ADMIN AUTH SETUP COMPLETE')
  console.log('==============================')
  console.log(`Email:    ${data.user.email}`)
  console.log(`Password: ${ADMIN_PASSWORD}`)
  console.log(`Role:     admin (app_metadata)`)
  console.log('Confirmed: yes')
}

main().catch((error) => {
  console.error('\n❌ Script failed:')
  console.error(error)
  process.exit(1)
})
