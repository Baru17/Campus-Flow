-- ------------------------------------------------------------------
-- Class Advisor access policies.
--
-- Class Advisors sign in with their staff account and manage the
-- attendance of the class they are assigned to in public.class_advisors.
--
-- Resolved identity chain:
--   auth.uid() -> public.staff (auth_user_id) -> public.class_advisors (staff_id)
--   -> (department, year, section)
--
-- The project now uses batch tables (it_students_2026_2030, etc.)
-- instead of public.it_students and public.it_attendance_3.
-- Legacy table references are wrapped in existence checks so this
-- migration works whether or not the legacy tables still exist.
-- ------------------------------------------------------------------

-- ------------------------------------------------------------------
-- 1. class_advisors: advisor reads their own assignment.
-- ------------------------------------------------------------------

alter table public.class_advisors enable row level security;

drop policy if exists "advisor_read_own_assignment" on public.class_advisors;

create policy "advisor_read_own_assignment"
  on public.class_advisors
  for select
  to authenticated
  using (
    staff_id in (
      select staff_id
      from public.staff
      where auth_user_id = auth.uid()
    )
  );

-- ------------------------------------------------------------------
-- 2. Legacy it_students: advisor reads the students of their assigned class.
--    Only runs if the legacy table still exists.
--    Batch-table advisor access is handled by 20260823000000.
-- ------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name = 'it_students'
  ) then
    drop policy if exists "advisor_read_class_students" on public.it_students;

    create policy "advisor_read_class_students"
      on public.it_students
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.class_advisors ca
          join public.staff s on s.staff_id = ca.staff_id
          where s.auth_user_id = auth.uid()
            and ca.is_active = true
            and ca.department = 'IT'
            and ca.year = it_students.year
            and ca.section = it_students.section
        )
      );
  end if;
end $$;

-- ------------------------------------------------------------------
-- 3. Legacy it_attendance_3: advisor manages attendance for their class.
--    Only runs if the legacy table still exists.
-- ------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name = 'it_attendance_3'
  ) then
    alter table public.it_attendance_3 enable row level security;

    drop policy if exists "advisor_manage_attendance" on public.it_attendance_3;

    create policy "advisor_manage_attendance"
      on public.it_attendance_3
      for all
      to authenticated
      using (
        exists (
          select 1
          from public.class_advisors ca
          join public.staff s on s.staff_id = ca.staff_id
          join public.it_students st on st.register_no = it_attendance_3.register_no
          where s.auth_user_id = auth.uid()
            and ca.is_active = true
            and ca.department = 'IT'
            and ca.year = 3
            and st.year = ca.year
            and st.section = ca.section
        )
      )
      with check (
        exists (
          select 1
          from public.class_advisors ca
          join public.staff s on s.staff_id = ca.staff_id
          join public.it_students st on st.register_no = it_attendance_3.register_no
          where s.auth_user_id = auth.uid()
            and ca.is_active = true
            and ca.department = 'IT'
            and ca.year = 3
            and st.year = ca.year
            and st.section = ca.section
        )
      );
  end if;
end $$;
