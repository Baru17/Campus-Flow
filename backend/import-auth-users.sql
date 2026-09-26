-- ============================================
-- 1. Link auth_user_id to staff
-- ============================================

UPDATE staff
SET auth_user_id = 'ccf167fa-636f-42d3-9e70-ac8ff904cba0'
WHERE staff_id = 1;

UPDATE staff
SET auth_user_id = '8018e501-623f-406a-b7be-b0da41937451'
WHERE staff_id = 2;

UPDATE staff
SET auth_user_id = '44cdd341-b3d0-49a2-b055-da624cf343a3'
WHERE staff_id = 3;

UPDATE staff
SET auth_user_id = '5e80e3cc-d1ab-49bb-9dc4-a1a472e7437b'
WHERE staff_id = 4;


-- ============================================
-- 2. 2024-2028 students
-- Login: Student ID OR Email
-- Password: 1234
-- ============================================

INSERT INTO auth_users
(auth_user_id, user_name, pwd_hash, role, email)
SELECT
    auth_user_id,
    student_id,
    '$2b$10$eJgXZEaTL7caYZ8shks6/.iOEnuMp.x20h6k/xka2VDPFAwgWv2Oe',
    'student',
    email
FROM IT_Students_2024_2028;


-- ============================================
-- 3. 2025-2029 students
-- Login: Student ID OR Email
-- Password: 1234
-- ============================================

INSERT INTO auth_users
(auth_user_id, user_name, pwd_hash, role, email)
SELECT
    auth_user_id,
    student_id,
    '$2b$10$eJgXZEaTL7caYZ8shks6/.iOEnuMp.x20h6k/xka2VDPFAwgWv2Oe',
    'student',
    email
FROM IT_Students_2025_2029;


-- ============================================
-- 4. Staff / Class Advisors
-- Login: Staff ID OR Email
-- Password: 1234
-- ============================================

INSERT INTO auth_users
(auth_user_id, user_name, pwd_hash, role, email)
SELECT
    auth_user_id,
    CAST(staff_id AS TEXT),
    '$2b$10$eJgXZEaTL7caYZ8shks6/.iOEnuMp.x20h6k/xka2VDPFAwgWv2Oe',
    'class_advisor',
    email
FROM staff;


-- ============================================
-- 5. Admin
-- Login: admin@kiot.ac.in
-- Password: 1234
-- ============================================

INSERT INTO auth_users
(auth_user_id, user_name, pwd_hash, role, email)
VALUES (
    '2fe0513b-7ec9-4436-9625-a5f5dcadde64',
    'admin@kiot.ac.in',
    '$2b$10$eJgXZEaTL7caYZ8shks6/.iOEnuMp.x20h6k/xka2VDPFAwgWv2Oe',
    'admin',
    'admin@kiot.ac.in'
);
