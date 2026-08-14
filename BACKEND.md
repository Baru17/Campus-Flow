# Campus-Flow Backend Reference

## 1. Backend Architecture

Campus-Flow uses Supabase as the backend:

- Supabase PostgreSQL database
- Supabase Edge Functions
- `pg_cron` for automatic scheduling
- `pg_net` for HTTP requests from PostgreSQL to Edge Functions

Architecture:

```text
React Frontend
      |
      | HTTPS
      v
Supabase Edge Functions
      |
      v
Supabase PostgreSQL
```

The frontend must use the existing backend logic. Do not recreate attendance logic in React.

---

## 2. Supported Departments

Current departments:

- IT
- CSE
- ECE
- EEE

Future roles are planned:

- Class Advisor
- HOD

Do not implement Class Advisor or HOD yet.

---

## 3. Important Database Tables

### Student Tables

- `it_students`
- `cse_students`
- `ece_students`
- `eee_students`

Students contain values including:

- `student_id`
- `register_no`
- `student_name`

Important:

`student_id` and `register_no` are different values.

Example:

```text
student_id: 2K24IT001
register_no: 24IT001
```

Do not interchange them.

### Staff Tables

Department-specific staff tables exist:

- IT staff data
- `cse_staff`
- `ece_staff`
- `eee_staff`

### Subject Tables

Subjects are department-specific.

The frontend must use the actual Supabase data rather than inventing production subjects.

### Attendance Sessions

`attendance_sessions`

Important fields include:

- `session_id`
- `staff_id`
- `subject_id`
- `department`
- `year`
- `section`
- `period`
- `otp`
- `created_at`
- `expires_at`
- `is_active`

### Attendance Tables

Department-specific attendance tables:

- `it_attendance`
- `cse_attendance`
- `ece_attendance`
- `eee_attendance`

Attendance records include:

- `attendance_id`
- `register_no`
- `attendance_date`
- `period`
- `subject_id`
- `status`
- `marked_at`
- `session_id`

Statuses:

- `PRESENT`
- `ABSENT`

The frontend must not directly insert or update attendance records when the existing Edge Functions handle those operations.

---

## 4. Current Attendance Workflow

### Staff

```text
Staff selects department
        ↓
Selects year
        ↓
Selects section
        ↓
Selects subject
        ↓
Selects period
        ↓
Generate OTP
        ↓
generate-otp Edge Function
        ↓
Attendance session created
        ↓
Secure 6-digit OTP generated
        ↓
OTP valid for 15 seconds
```

### Student

```text
Student enters student_id
        ↓
Student enters OTP
        ↓
verify-otp Edge Function
        ↓
Find student
        ↓
Find active session
        ↓
Validate OTP and expiry
        ↓
Check duplicate attendance
        ↓
Mark PRESENT
```

### Expired Session

```text
Session expires
        ↓
pg_cron runs every 10 seconds
        ↓
Finds active sessions where expires_at <= now()
        ↓
pg_net sends HTTP POST
        ↓
finalize-session
        ↓
Remaining students marked ABSENT
        ↓
Session deactivated
```

---

# 5. Edge Function: generate-otp

## Purpose

Creates an attendance session and generates a secure 6-digit OTP.

The OTP is generated on the backend using:

```text
crypto.getRandomValues()
```

OTP validity:

```text
15 seconds
```

The frontend must NEVER generate the OTP.

## HTTP Method

```text
POST
```

## Request Body

The frontend must send exactly these required fields:

```json
{
  "staff_id": 1,
  "subject_id": 1,
  "department": "IT",
  "year": 3,
  "section": "A",
  "period": 1
}
```

Required fields:

- `staff_id`
- `subject_id`
- `department`
- `year`
- `section`
- `period`

## Successful Response

HTTP status:

```text
200
```

Response structure:

```json
{
  "success": true,
  "message": "OTP generated successfully",
  "otp": "123456",
  "session": {
    "...": "..."
  },
  "expires_at": "2026-08-13T..."
}
```

The actual `session` object is the inserted `attendance_sessions` row.

The frontend primarily needs:

- `otp`
- `session`
- `expires_at`

## Errors

### Non-POST request

HTTP `405`

```json
{
  "error": "Only POST requests are allowed"
}
```

### Missing required fields

HTTP `400`

```json
{
  "error": "Missing required fields"
}
```

### Database/session creation failure

HTTP `500`

```json
{
  "error": "Failed to create attendance session",
  "details": "..."
}
```

### Unexpected server error

HTTP `500`

```json
{
  "error": "Internal server error"
}
```

---

# 6. Edge Function: verify-otp

## Purpose

Validates a student's OTP and marks attendance as `PRESENT`.

The function:

1. Finds the student across IT/CSE/ECE/EEE.
2. Determines the student's department.
3. Selects the correct department attendance table.
4. Finds active attendance sessions.
5. Checks session expiry.
6. Matches the submitted OTP.
7. Checks duplicate attendance.
8. Inserts `PRESENT` attendance.

## HTTP Method

```text
POST
```

## Request Body

The frontend sends only:

```json
{
  "student_id": "2K24IT001",
  "otp": "123456"
}
```

Required fields:

- `student_id`
- `otp`

Important:

The frontend does NOT need to send:

- department
- year
- section
- register number
- subject ID

The backend determines the appropriate session and attendance table.

## Student Identification

The function checks:

```text
it_students
cse_students
ece_students
eee_students
```

using:

```text
student_id
```

It then obtains the student's:

```text
register_no
student_name
department
```

Attendance is stored using:

```text
register_no
```

Therefore:

```text
student_id != register_no
```

## Successful Response

HTTP `200`

```json
{
  "success": true,
  "message": "Attendance marked successfully",
  "student": {
    "student_id": "2K24IT001",
    "register_no": "24IT001",
    "student_name": "Student One",
    "department": "IT"
  },
  "attendance": {
    "...": "..."
  }
}
```

## Error Responses

### Non-POST request

HTTP `405`

```json
{
  "error": "Only POST requests are allowed"
}
```

### Missing student ID or OTP

HTTP `400`

```json
{
  "error": "Student ID and OTP are required"
}
```

### Student not found

HTTP `404`

```json
{
  "error": "Student not found"
}
```

### No active session

HTTP `404`

```json
{
  "error": "No active attendance session"
}
```

### Invalid or expired OTP

HTTP `400`

```json
{
  "error": "Invalid or expired OTP"
}
```

### Duplicate attendance

HTTP `409`

```json
{
  "error": "Attendance already marked"
}
```

### Database/session error

HTTP `500`

The response contains an `error` field and may contain `details`.

### Unexpected server error

HTTP `500`

```json
{
  "error": "Internal server error"
}
```

---

# 7. Edge Function: finalize-session

## Purpose

Finalizes an expired attendance session.

It is responsible for:

- Finding students belonging to the session's department/year/section
- Checking which students do not have attendance for that session
- Marking those students `ABSENT`
- Deactivating the session
- Returning a finalization summary

The frontend should NOT manually mark absent students.

The function is primarily triggered automatically by `pg_cron` + `pg_net`.

## Request Body

The automatic HTTP request sends:

```json
{
  "session_id": 1
}
```

## Successful Response

Example tested response:

```json
{
  "success": true,
  "message": "Attendance session finalized successfully",
  "session": {
    "session_id": 1,
    "department": "IT",
    "year": 3,
    "section": "A",
    "period": 1,
    "subject_id": 1
  },
  "attendance_summary": {
    "total_students": 5,
    "present_students": 0,
    "absent_students": 5
  }
}
```

The exact deployed function implementation is authoritative.

---

# 8. pg_cron

`pg_cron` is NOT a database table.

It is a PostgreSQL extension used as a scheduler.

Current job:

```text
auto-finalize-expired-sessions
```

Schedule:

```text
10 seconds
```

The job looks for:

```text
is_active = true
AND
expires_at <= now()
```

When it finds an expired active session, it triggers the HTTP request to `finalize-session` through `pg_net`.

Conceptually:

```text
pg_cron
   |
   | checks every 10 seconds
   v
Expired active session?
   |
   | yes
   v
pg_net
```

---

# 9. pg_net

`pg_net` is NOT a database table.

It is a PostgreSQL extension that allows HTTP requests from the database.

For Campus-Flow:

```text
pg_cron
   ↓
pg_net HTTP POST
   ↓
finalize-session Edge Function
```

The request contains the expired session's `session_id`.

The frontend does not control this process.

---

# 10. Automatic Finalization Test

Automatic finalization has already been successfully tested.

Test:

- IT
- Year 3
- Section A
- Period 1
- 5 students
- No students submitted OTP

Result:

```text
Session finalization: SUCCESS
Students in session: 5
Students PRESENT: 0
Students ABSENT: 5
Session active after expiry: FALSE
Automatic trigger: pg_cron + pg_net
```

This confirms that the automatic expiry/finalization workflow is working.

---

# 11. OTP and Security Rules

The backend is the source of truth.

The frontend must NOT:

- Generate OTPs
- Decide whether an OTP is valid
- Decide whether an OTP has expired
- Directly mark PRESENT
- Directly mark ABSENT
- Bypass Edge Functions
- Insert attendance directly into attendance tables

The frontend may display a 15-second countdown for user experience, but the backend decides actual OTP validity.

Never put these in React:

- `SUPABASE_SERVICE_ROLE_KEY`
- database password
- Vault secrets
- private API keys

Only public frontend configuration may be used in client-side environment variables.

---

# 12. Current Frontend Scope

## Initial Roles

Only two roles are currently required:

```text
Staff
Student
```

Future:

```text
Class Advisor
HOD
```

Do not implement future roles yet.

## Staff Flow

The frontend should allow staff to:

1. Select department
2. Select year
3. Select section
4. Select subject
5. Select period
6. Generate OTP
7. Display the generated OTP
8. Display an animated 15-second countdown
9. Display `OTP Expired` after expiry

The Generate OTP action must call:

```text
generate-otp
```

## Student Flow

The frontend should allow students to:

1. Select department
2. Select year
3. Select section
4. Enter student ID
5. Enter OTP
6. Submit OTP
7. Display the backend attendance result

The Submit OTP action must call:

```text
verify-otp
```

The frontend must display appropriate user-friendly messages for:

- successful attendance
- wrong/expired OTP
- student not found
- duplicate attendance
- no active session
- server errors

---

# 13. Subject and Session Data

Currently there are only three known Edge Functions:

- `generate-otp`
- `verify-otp`
- `finalize-session`

There is currently no documented `getSubjects` or `getActiveSession` Edge Function.

Do NOT invent such functions.

Before implementing dynamic subject/session fetching, inspect the actual database access requirements and decide the safest existing approach.

Production subject data should come from the real backend/database.

Do not hard-code fake production data.

---

# 14. Scalability Requirement

Current test data contains only 5 students per tested class.

The final system must NOT be hard-coded for 5 students.

The design should support approximately 60 students in a class without changing the frontend logic.

After frontend completion, the system should be tested with approximately 60 students and concurrent OTP submissions.

Important distinction:

```text
60 students stored in database
```

and:

```text
60 students submitting OTP concurrently
```

are separate tests.

The first verifies data handling.

The second verifies backend/API concurrency and should be load-tested before production deployment.

---

# 15. OpenCode Instructions

Before writing frontend code:

1. Read this entire `BACKEND.md`.
2. Treat the existing Supabase backend as the source of truth.
3. Do not invent database tables.
4. Do not invent Edge Function request/response formats.
5. Use the exact contracts documented above.
6. Do not modify Edge Functions or database logic unless explicitly requested.
7. Never expose service-role keys or private secrets.
8. Do not generate OTPs in React.
9. Do not perform direct attendance writes from React.
10. Use the existing Edge Functions for attendance operations.
11. Keep API communication in a dedicated service/API layer.
12. Keep the frontend modular and scalable.
13. Do not hard-code the application for only 5 students.
14. Design it to support approximately 60 students.
15. Do not implement Class Advisor or HOD yet.
16. Use React + Bootstrap for the frontend.
17. Before integrating any undocumented API, ask for clarification instead of guessing.
18. Test each frontend phase before moving to the next phase.

This document describes the current deployed Campus-Flow backend and is the reference OpenCode should use while building the frontend.

## Subject Data Source

The frontend must use the central `subjects` table for subject selection.

Table:

`subjects`

Columns:

- `subject_id`
- `subject_code`
- `subject_name`
- `department`
- `year`
- `section`

Subjects should be fetched using:

- selected department
- selected year
- selected section

Example:

```text
department = IT
year = 3
section = A