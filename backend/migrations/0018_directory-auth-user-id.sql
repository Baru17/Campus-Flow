-- Migration number: 0018
-- Create HOD and Contest Coordinator directory tables if needed,
-- then add permanent authentication links.

CREATE TABLE IF NOT EXISTS hods (
    hod_id INTEGER PRIMARY KEY AUTOINCREMENT,
    hod_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contest_coordinators (
    coordinator_id INTEGER PRIMARY KEY AUTOINCREMENT,
    coordinator_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE hods
ADD COLUMN auth_user_id TEXT;

ALTER TABLE contest_coordinators
ADD COLUMN auth_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_hods_auth_user_id
ON hods(auth_user_id);

CREATE INDEX IF NOT EXISTS idx_contest_coordinators_auth_user_id
ON contest_coordinators(auth_user_id);

UPDATE hods
SET auth_user_id = (
    SELECT au.auth_user_id
    FROM auth_users au
    WHERE LOWER(au.user_name) = LOWER(hods.email)
       OR LOWER(au.email) = LOWER(hods.email)
    ORDER BY au.auth_user_id
    LIMIT 1
)
WHERE auth_user_id IS NULL;

UPDATE contest_coordinators
SET auth_user_id = (
    SELECT au.auth_user_id
    FROM auth_users au
    WHERE LOWER(au.user_name) = LOWER(contest_coordinators.email)
       OR LOWER(au.email) = LOWER(contest_coordinators.email)
    ORDER BY au.auth_user_id
    LIMIT 1
)
WHERE auth_user_id IS NULL;