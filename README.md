# Campus-Flow

> **Smart Attendance. Simple. Secure. Automated.**

Campus-Flow is a secure, OTP-based attendance management system designed for college classrooms. It allows staff to create short-lived attendance sessions and enables students to mark their attendance using their Student ID and a time-limited OTP.

The system is designed to reduce manual attendance work while providing a simple, fast, and secure attendance experience.

## ✨ Features

* 🔐 Secure OTP-based attendance verification
* 👨‍🏫 Dedicated staff login and dashboard
* 🎓 Student attendance check-in
* ⏱️ Time-limited attendance sessions
* 🔢 Six-digit OTP verification
* 🧑‍🎓 Student ID-based attendance
* 📚 Department, year, section, subject, and period selection
* ✅ Automatic PRESENT attendance marking
* ❌ Automatic ABSENT marking after session expiration
* 🔄 Automatic session finalization using Cloudflare scheduled triggers
* 📊 Attendance session and attendance record management
* 📱 Responsive authentication interface
* 🎨 Modern responsive UI with glassmorphism and animated visual elements
* 🛡️ Backend-authoritative attendance validation

## 🏗️ System Architecture

```text
                     Campus-Flow
                          │
                          ▼
               React + Vite + Tailwind CSS
                          │
                          ▼
                   Cloudflare Client
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        Cloudflare Workers        D1 / KV
          (Pages)                (Database)
```

```text
Cloudflare Workers
       │
       │ HTTPS
       ▼
Cloudflare D1 / KV
```

## 🔑 Attendance Flow

### Staff Flow

```text
Staff Login
    ↓
Staff Dashboard
    ↓
Select Department
    ↓
Select Year
    ↓
Select Section
    ↓
Select Subject
    ↓
Select Period
    ↓
Generate OTP
    ↓
Attendance Session Created
    ↓
OTP displayed for a limited time
```

### Student Flow

```text
Student Login
    ↓
Enter Student ID
    ↓
Enter 6-digit OTP
    ↓
Backend validates Student + OTP
    ↓
Attendance marked PRESENT
    ↓
Attendance success screen
```

### Automatic Finalization

```text
OTP Session Expires
         ↓
Scheduled checks for active sessions
         ↓
HTTP request to finalize-session
         ↓
finalize-session identifies students
         ↓
Students without valid attendance
         ↓
Marked ABSENT
         ↓
Session deactivated
```

## 🔐 Security

Campus-Flow follows a backend-authoritative attendance model.

The frontend does **not**:

* Generate OTPs
* Decide whether an OTP is valid
* Decide whether an OTP has expired
* Directly insert attendance records
* Decide whether a student is PRESENT or ABSENT
* Store database passwords or private secrets

The frontend only sends the required data to the appropriate backend/database interfaces.

The service-role keys and other private credentials must remain server-side and must never be exposed in the React application.

## 📡 Backend API Contracts

### Generate OTP

```http
POST /generate-otp
```

Request:

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

The backend creates an attendance session and returns a six-digit OTP together with session information and its expiration time.

### Verify OTP

```http
POST /verify-otp
```

Request:

```json
{
  "student_id": "2K24IT001",
  "otp": "123456"
}
```

The backend resolves the student's details and active attendance session before marking attendance.

### Finalize Session

```http
POST /finalize-session
```

This endpoint is intended for automatic session finalization through the configured scheduled database workflow.

The frontend does not call this endpoint directly.

## 🗄️ Database

The system uses a Cloudflare D1 database.

Main database entities include:

* `it_students`
* `cse_students`
* `ece_students`
* `eee_students`
* `it_staff`
* `cse_staff`
* `ece_staff`
* `eee_staff`
* `staff`
* `subjects`
* `it_subjects`
* `cse_subjects`
* `ece_subjects`
* `eee_subjects`
* `attendance_sessions`
* `it_attendance`
* `cse_attendance`
* `ece_attendance`
* `eee_attendance`

The central `subjects` table is used for subject selection and is filtered by:

```text
department
year
section
```

## 🧑‍🎓 Student Identification

Students are identified using a unique `student_id`.

Example:

```text
2K24IT001
2K24IT002
2K24IT003
```

The database also stores the student's register number and name.

Example:

```text
Student ID:    2K24IT001
Register No:   611224205001
Name:          Student One
Year:          3
Section:       A
```

## 🛠️ Technology Stack

### Frontend

* React
* Vite
* Tailwind CSS
* JavaScript
* HTML5
* CSS3

### Backend

* Cloudflare Workers (Edge Functions)
* Cloudflare D1 / KV
* Cloudflare Scheduled Triggers

### Deployment

* Cloudflare Pages
* GitHub

## 🚀 Getting Started

### Prerequisites

Make sure you have:

* Node.js
* npm
* Git

### Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/Campus-Flow.git
cd Campus-Flow
```

### Install dependencies

```bash
npm install
```

### Configure environment variables

Create a `.env` file in the project root:

```env
VITE_API_BASE_URL=http://localhost:8787
```

> Never commit the `.env` file or any service-role/private key to GitHub.

### Start development server

```bash
npm run dev
```

The application will normally be available at:

```text
http://localhost:5173
```

### Run lint

```bash
npm run lint
```

### Create production build

```bash
npm run build
```

The production files are generated in:

```text
dist/
```

## ☁️ Deployment

Campus-Flow can be deployed using Cloudflare Pages.

Recommended configuration:

```text
Production branch: main
Build command:      npm run build
Build directory:    dist
```

The required frontend environment variables should be configured in the Cloudflare Pages project settings.

After deployment, Cloudflare provides a `*.pages.dev` URL and can automatically redeploy the project when new commits are pushed to the connected GitHub repository.

## 🧪 Testing

Campus-Flow should be tested at multiple levels:

### Functional Testing

* Staff login
* Student login
* Subject loading
* OTP generation
* OTP verification
* Successful attendance marking
* Invalid OTP handling
* Expired OTP handling
* Duplicate attendance handling
* Student-not-found handling
* Automatic session finalization

## 📁 Project Structure

```text
Campus-Flow/
│
├── public/
│
├── src/
│   ├── components/
│   │   ├── AttendanceSuccess.jsx
│   │   ├── BrandPanel.jsx
│   │   ├── OtpInput.jsx
│   │   ├── StaffLogin.jsx
│   │   └── StudentLogin.jsx
│   │
│   ├── pages/
│   │   ├── AuthPage.jsx
│   │   └── ...
│   │
│   ├── api/
│   │   └── supabase.js
│   │
│   └── ...
│
├── .env.example
├── .gitignore
├── BACKEND.md
├── index.html
├── package.json
├── package-lock.json
├── tailwind.config.js
├── vite.config.js
└── README.md
```

## 🎯 Project Goals

Campus-Flow aims to provide:

* Faster classroom attendance
* Reduced manual work for staff
* Secure student verification
* Automated attendance finalization
* Better attendance data management
* A scalable foundation for college-wide attendance management

## 🔮 Future Scope

Possible future improvements include:

* Staff authentication with a backend auth service
* Attendance analytics and reports
* Staff attendance history
* Student attendance history
* Export attendance reports
* Admin dashboard
* Multiple department management
* Role-based access control
* Improved monitoring and analytics
* Custom college deployment domains

## 👨‍💻 Development

Campus-Flow is developed as a college-focused software project with an emphasis on secure backend validation, responsive design, and automated attendance management.

## 📄 License

This project is currently intended for educational and project-development purposes.

---

**Campus-Flow — Smart Attendance. Simple. Secure. Automated.**
