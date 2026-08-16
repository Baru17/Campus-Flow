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
-- Each advisor can only:
--   * read their own assignment in class_advisors
--   * read the students of their assigned class in it_students
--   * read / insert / update attendance records for those students in
--     it_attendance_3
--
-- Run this in the Supabase Dashboard -> SQL Editor, or via
-- `supabase db push`.
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
-- 2. it_students: advisor reads the students of their assigned class.
-- ------------------------------------------------------------------

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

-- ------------------------------------------------------------------
-- 3. it_attendance_3: advisor manages attendance for their class.
-- ------------------------------------------------------------------

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