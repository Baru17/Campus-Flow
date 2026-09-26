-- Migration number: 0001 	 2026-09-22T18:30:45.312Z

CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_code TEXT NOT NULL UNIQUE,
    subject_name TEXT NOT NULL,
    year INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS IT_Students_2024_2028 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL UNIQUE,
    register_no TEXT NOT NULL UNIQUE,
    student_name TEXT NOT NULL,
    year INTEGER NOT NULL,
    section TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    auth_user_id TEXT
);

CREATE TABLE IF NOT EXISTS IT_Students_2025_2029 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL UNIQUE,
    register_no TEXT NOT NULL UNIQUE,
    student_name TEXT NOT NULL,
    year INTEGER NOT NULL,
    section TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    auth_user_id TEXT
);

CREATE TABLE IF NOT EXISTS IT_Attendance_2024_2028 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id TEXT NOT NULL,
    register_no TEXT NOT NULL,
    section TEXT NOT NULL,
    attendance_date TEXT NOT NULL,
    period INTEGER NOT NULL,
    subject_code TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    marked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    session_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS IT_Attendance_2025_2029 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id TEXT NOT NULL,
    register_no TEXT NOT NULL,
    section TEXT NOT NULL,
    attendance_date TEXT NOT NULL,
    period INTEGER NOT NULL,
    subject_code TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    marked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    session_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id TEXT NOT NULL UNIQUE,
    staff_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL,
    class_advisor TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    auth_user_id TEXT
);

CREATE TABLE IF NOT EXISTS auth_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auth_user_id TEXT NOT NULL UNIQUE,
    user_name TEXT NOT NULL UNIQUE,
    pwd_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);