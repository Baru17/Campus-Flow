-- ------------------------------------------------------------------
-- Phase 1: Staff Auth provisioning support
-- Phase 2: Staff RLS policy hardening
-- Phase 3: New student batch RLS reliability
-- Phase 10: semester_subjects write protection
-- Phase 11: academic_batches write protection
-- Phase 13: updated_at trigger on academic_batches
--
-- All changes are non-destructive and additive only.
-- ------------------------------------------------------------------

-- --------------------------------------------------
-- 1. STAFF: Ensure RLS is enabled and self-read policy exists
-- --------------------------------------------------

alter table if exists public.staff enable row level security;

drop policy if exists "staff_select_own" on public.staff;

create policy "staff_select_own"
  on public.staff
  for select
  to authenticated
  using (auth_user_id = auth.uid());

-- --------------------------------------------------
-- 2. SEMESTER_SUBJECTS: Read-only for authenticated users
--    Write access must only come through admin-subjects
--    Edge Function using service role.
-- --------------------------------------------------

alter table if exists public.semester_subjects enable row level security;

drop policy if exists "authenticated_read_semester_subjects" on public.semester_subjects;

create policy "authenticated_read_semester_subjects"
  on public.semester_subjects
  for select
  to authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policies exist.
-- Only the service-role admin-subjects Edge Function can modify.

-- --------------------------------------------------
-- 3. ACADEMIC_BATCHES: Read-only for authenticated users
--    Write access must only come through admin-subjects
--    Edge Function using service role.
-- --------------------------------------------------

alter table if exists public.academic_batches enable row level security;

drop policy if exists "authenticated_read_academic_batches" on public.academic_batches;

create policy "authenticated_read_academic_batches"
  on public.academic_batches
  for select
  to authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policies exist.
-- Only the service-role admin-subjects Edge Function can modify.

-- --------------------------------------------------
-- 4. ACADEMIC_BATCHES: updated_at trigger
--    Automatically updates updated_at when current_semester changes.
-- --------------------------------------------------

create or replace function public.trigger_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.academic_batches;

create trigger set_updated_at
  before update on public.academic_batches
  for each row
  execute function public.trigger_set_updated_at();

-- --------------------------------------------------
-- 5. Staff table: Ensure auth_user_id column exists
--    and has the correct comment.
-- --------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'staff' and column_name = 'auth_user_id'
  ) then
    alter table public.staff add column auth_user_id bigint;
  end if;
end $$;

-- --------------------------------------------------
-- 6. Ensure existing batch student tables have RLS policies.
--    This catches any batch tables created before the
--    ensureBatchTables() policy creation was reliable.
-- --------------------------------------------------

do $$
declare
  tbl text;
  policy_name text;
begin
  for tbl in
    select tablename from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename ~ '_students_[0-9]{4}_[0-9]{4}$'
  loop
    policy_name := replace(tbl, '.', '_') || '_select_own';
    -- PostgreSQL does not support CREATE POLICY IF NOT EXISTS.
    -- Check pg_policies before creating.
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = tbl
        and policyname = policy_name
    ) then
      execute format(
        'create policy "%s" on public.%I for select to authenticated using (auth_user_id = auth.uid())',
        policy_name, tbl
      );
    end if;
    -- Ensure RLS is enabled.
    execute format('alter table public.%I enable row level security', tbl);
  end loop;
end $$;

-- --------------------------------------------------
-- 7. Legacy student tables: Ensure RLS policies exist.
-- --------------------------------------------------

do $$
declare
  tbl text;
  policy_name text;
begin
  for tbl in
    select tablename from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename in ('it_students', 'cse_students', 'ece_students', 'eee_students')
  loop
    policy_name := replace(tbl, '.', '_') || '_select_own';
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = tbl
        and policyname = policy_name
    ) then
      execute format(
        'create policy "%s" on public.%I for select to authenticated using (auth_user_id = auth.uid())',
        policy_name, tbl
      );
    end if;
    execute format('alter table public.%I enable row level security', tbl);
  end loop;
end $$;
