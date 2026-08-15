-- ------------------------------------------------------------------
-- Allow authenticated students to read their own record in
-- public.it_students.
--
-- The frontend resolves the signed-in student through their Supabase
-- Auth UUID (auth_user_id = auth.uid()) — never through a
-- browser-supplied student ID — so each student can only ever see
-- their own row. No passwords or auth.users data are exposed.
--
-- Run this in the Supabase Dashboard → SQL Editor, or via
-- `supabase db push`.
-- ------------------------------------------------------------------

alter table public.it_students enable row level security;

drop policy if exists "it_students_select_own" on public.it_students;

create policy "it_students_select_own"
  on public.it_students
  for select
  to authenticated
  using (auth_user_id = auth.uid());