-- Ensure every IT batch student table has the two policies students and
-- class advisors need:
--   it_students_select_own       - a student can read their own row
--                                  (required by getCurrentStudent after login)
--   advisor_read_class_students - the active class advisor of that
--                                  year/section can read all rows of the batch
-- Idempotent: safe to run multiple times.
-- NOTE: Postgres has no CREATE POLICY IF NOT EXISTS, hence drop-then-create.

drop policy if exists "it_students_select_own" on public.it_students_2026_2030;
create policy "it_students_select_own"
  on public.it_students_2026_2030 for select to authenticated
  using (auth_user_id = auth.uid());

drop policy if exists "it_students_select_own" on public.it_students_2025_2029;
create policy "it_students_select_own"
  on public.it_students_2025_2029 for select to authenticated
  using (auth_user_id = auth.uid());

drop policy if exists "it_students_select_own" on public.it_students_2024_2028;
create policy "it_students_select_own"
  on public.it_students_2024_2028 for select to authenticated
  using (auth_user_id = auth.uid());

drop policy if exists "it_students_select_own" on public.it_students_2023_2027;
create policy "it_students_select_own"
  on public.it_students_2023_2027 for select to authenticated
  using (auth_user_id = auth.uid());

drop policy if exists "advisor_read_class_students" on public.it_students_2026_2030;
create policy "advisor_read_class_students"
  on public.it_students_2026_2030 for select to authenticated
  using (
    exists (
      select 1 from class_advisors ca
      join staff s on s.staff_id = ca.staff_id
      where s.auth_user_id = auth.uid()
        and ca.is_active = true
        and ca.department = 'IT'
        and ca.year = it_students_2026_2030.year
        and ca.section = it_students_2026_2030.section
    )
  );

drop policy if exists "advisor_read_class_students" on public.it_students_2025_2029;
create policy "advisor_read_class_students"
  on public.it_students_2025_2029 for select to authenticated
  using (
    exists (
      select 1 from class_advisors ca
      join staff s on s.staff_id = ca.staff_id
      where s.auth_user_id = auth.uid()
        and ca.is_active = true
        and ca.department = 'IT'
        and ca.year = it_students_2025_2029.year
        and ca.section = it_students_2025_2029.section
    )
  );

drop policy if exists "advisor_read_class_students" on public.it_students_2024_2028;
create policy "advisor_read_class_students"
  on public.it_students_2024_2028 for select to authenticated
  using (
    exists (
      select 1 from class_advisors ca
      join staff s on s.staff_id = ca.staff_id
      where s.auth_user_id = auth.uid()
        and ca.is_active = true
        and ca.department = 'IT'
        and ca.year = it_students_2024_2028.year
        and ca.section = it_students_2024_2028.section
    )
  );

drop policy if exists "advisor_read_class_students" on public.it_students_2023_2027;
create policy "advisor_read_class_students"
  on public.it_students_2023_2027 for select to authenticated
  using (
    exists (
      select 1 from class_advisors ca
      join staff s on s.staff_id = ca.staff_id
      where s.auth_user_id = auth.uid()
        and ca.is_active = true
        and ca.department = 'IT'
        and ca.year = it_students_2023_2027.year
        and ca.section = it_students_2023_2027.section
    )
  );
