-- ------------------------------------------------------------------
-- Clean up duplicate student self-select RLS policies on IT batch
-- student tables.
--
-- Two migrations previously created select policies on the same
-- tables:
--   - 20260823000000 created "it_students_select_own"
--   - 20260912000000 created "it_students_2026_2030_select_own" etc.
--
-- This migration drops the redundant old-named policies so that each
-- table has exactly ONE student self-select policy.
--
-- advisor_read_class_students is preserved because it is not
-- redundant -- it uses a different condition and grants advisor
-- access.
-- ------------------------------------------------------------------

-- --------------------------------------------------
-- IT 2026_2030: drop redundant policy, keep intended one
-- --------------------------------------------------
drop policy if exists "it_students_select_own" on public.it_students_2026_2030;

-- Verify the intended policy exists
-- (created by 20260912000000 migration via DO block if it was not already present)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'it_students_2026_2030'
      and policyname = 'it_students_2026_2030_select_own'
  ) then
    create policy "it_students_2026_2030_select_own"
      on public.it_students_2026_2030
      for select to authenticated
      using (auth_user_id = auth.uid());
  end if;
end $$;

-- --------------------------------------------------
-- IT 2025_2029
-- --------------------------------------------------
drop policy if exists "it_students_select_own" on public.it_students_2025_2029;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'it_students_2025_2029'
      and policyname = 'it_students_2025_2029_select_own'
  ) then
    create policy "it_students_2025_2029_select_own"
      on public.it_students_2025_2029
      for select to authenticated
      using (auth_user_id = auth.uid());
  end if;
end $$;

-- --------------------------------------------------
-- IT 2024_2028
-- --------------------------------------------------
drop policy if exists "it_students_select_own" on public.it_students_2024_2028;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'it_students_2024_2028'
      and policyname = 'it_students_2024_2028_select_own'
  ) then
    create policy "it_students_2024_2028_select_own"
      on public.it_students_2024_2028
      for select to authenticated
      using (auth_user_id = auth.uid());
  end if;
end $$;

-- --------------------------------------------------
-- IT 2023_2027
-- --------------------------------------------------
drop policy if exists "it_students_select_own" on public.it_students_2023_2027;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'it_students_2023_2027'
      and policyname = 'it_students_2023_2027_select_own'
  ) then
    create policy "it_students_2023_2027_select_own"
      on public.it_students_2023_2027
      for select to authenticated
      using (auth_user_id = auth.uid());
  end if;
end $$;

-- --------------------------------------------------
-- Preserve advisor_read_class_students on all four tables.
-- These are NOT redundant and must not be dropped.
-- --------------------------------------------------

-- Ensure RLS remains enabled on all four tables.
do $$
declare tbl text;
begin
  for tbl in
    select unnest(array[
      'it_students_2026_2030',
      'it_students_2025_2029',
      'it_students_2024_2028',
      'it_students_2023_2027'
    ])
  loop
    execute format('alter table if exists public.%I enable row level security', tbl);
  end loop;
end $$;
