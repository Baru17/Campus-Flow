CREATE INDEX IF NOT EXISTS idx_auth_users_email
  ON auth_users(email);

CREATE INDEX IF NOT EXISTS idx_staff_auth_user_id
  ON staff(auth_user_id);

CREATE INDEX IF NOT EXISTS idx_subjects_year_name
  ON subjects(year, subject_name);