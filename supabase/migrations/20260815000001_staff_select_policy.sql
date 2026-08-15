-- ------------------------------------------------------------------
-- Allow authenticated staff to read ONLY their own record in
-- public.staff.
--
-- The frontend resolves the signed-in staff member through their
-- Supabase Auth UUID (auth_user_id = auth.uid()) — never through a
-- browser-supplied staff ID or department — so each staff member can
-- only ever see their own row. No passwords or auth.users data are
-- exposed.
--
-- This is deliberately narrow: no broad anon/authenticated SELECT
-- policies are created, and department-specific tables (it_staff,
-- cse_staff, ...) are NOT used for authentication.
--
-- Run this in the Supabase Dashboard → SQL Editor, or via
-- `supabase db push`.
-- ------------------------------------------------------------------

alter table public.staff enable row level security;

drop policy if exists "staff_select_own" on public.staff;

create policy "staff_select_own"
  on public.staff
  for select
  to authenticated
  using (auth_user_id = auth.uid());