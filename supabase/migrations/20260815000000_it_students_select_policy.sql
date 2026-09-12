-- ------------------------------------------------------------------
-- Allow authenticated students to read their own record.
--
-- The project now uses batch tables (it_students_2026_2030, etc.)
-- instead of a single public.it_students table. This migration
-- gracefully handles the case where public.it_students no longer
-- exists.
--
-- Student RLS on batch tables is handled by:
--   - 20260823000000_student_tables_select_own_policy.sql
--   - 20260912000000_staff_auth_rls_updated_at.sql
-- ------------------------------------------------------------------

-- Only enable RLS and create policy if the legacy table exists.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name = 'it_students'
  ) then
    alter table public.it_students enable row level security;

    drop policy if exists "it_students_select_own" on public.it_students;

    create policy "it_students_select_own"
      on public.it_students
      for select
      to authenticated
      using (auth_user_id = auth.uid());
  end if;
end $$;
