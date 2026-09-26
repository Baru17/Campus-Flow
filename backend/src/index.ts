import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import auth from "./api/auth";
import attendance, { finalizeSession } from "./api/attendance";
import { requireAuth, requireClassAdvisor } from "./middleware/auth";

type Bindings = {
  DB: D1Database;
  ALLOWED_ORIGINS?: string;
  NODE_ENV?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const LOCAL_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "https://backend.bdharan06.workers.dev",
];

const PAGES_PROJECT_HOSTS = ["campus-flow-cdl.pages.dev"];

function isAllowedOrigin(origin: string, configured: string): boolean {
  if (!origin) {
    return true;
  }
  if (LOCAL_ORIGINS.includes(origin)) {
    return true;
  }
  const configuredOrigins = configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (configuredOrigins.includes(origin)) {
    return true;
  }
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== "https:") {
      return false;
    }
    return PAGES_PROJECT_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

app.use("/*", cors({
  origin: (origin: string, c: Context) =>
    isAllowedOrigin(origin, c.env.ALLOWED_ORIGINS ?? "") ? origin : null,
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "Cookie"],
}));

app.route("/api/auth", auth);
app.route("/api/attendance", attendance);

app.get("/api/class-advisors", requireAuth, requireClassAdvisor, async (c) => {
  const staffId = c.req.query("staff_id");
  const authUser = (c as any).get("authUser") as { auth_user_id: string };

  if (!staffId) {
    return c.json({ data: null, error: { code: "missing_staff_id" } }, 400);
  }

  const assignment = await c.env.DB
    .prepare(
      `SELECT staff_id, staff_name, email, department, advisor_year AS year,
              advisor_section AS section, class_advisor
       FROM staff
       WHERE staff_id = ? AND auth_user_id = ? AND advisor_year IS NOT NULL
         AND advisor_section IS NOT NULL
       LIMIT 1`
    )
    .bind(staffId, authUser.auth_user_id)
    .first();

  return c.json({ data: assignment || null, error: null });
});

app.get("/api/class-advisors/students", requireAuth, requireClassAdvisor, async (c) => {
  const authUser = (c as any).get("authUser") as { auth_user_id: string };
  const advisor = await c.env.DB
    .prepare("SELECT department, advisor_year, advisor_section FROM staff WHERE auth_user_id = ? LIMIT 1")
    .bind(authUser.auth_user_id)
    .first() as { department: string; advisor_year: number; advisor_section: string } | null;

  if (!advisor?.department || !advisor.advisor_year || !advisor.advisor_section) {
    return c.json({ data: null, error: { code: "advisor_assignment_not_found" } }, 404);
  }

  const studentTables: Record<string, string> = {
    "IT:2": "IT_Students_2025_2029",
    "IT:3": "IT_Students_2024_2028",
  };
  const table = studentTables[`${advisor.department.toUpperCase()}:${advisor.advisor_year}`];
  if (!table) {
    return c.json({ data: null, error: { code: "student_table_not_found" } }, 404);
  }

  const { results } = await c.env.DB
    .prepare(
      `SELECT student_id, register_no, student_name, year, section, email
       FROM ${table}
       WHERE year = ? AND section = ?
       ORDER BY register_no`
    )
    .bind(advisor.advisor_year, advisor.advisor_section)
    .all();

  return c.json({ data: results, error: null });
});

app.get("/api/class-advisors/subjects", requireAuth, requireClassAdvisor, async (c) => {
  const authUser = (c as any).get("authUser") as { auth_user_id: string };
  const advisor = await c.env.DB
    .prepare("SELECT advisor_year FROM staff WHERE auth_user_id = ? LIMIT 1")
    .bind(authUser.auth_user_id)
    .first() as { advisor_year: number } | null;

  if (!advisor?.advisor_year) {
    return c.json({ data: null, error: { code: "advisor_assignment_not_found" } }, 404);
  }

  const { results } = await c.env.DB
    .prepare(
      `SELECT id, id AS subject_id, subject_code, subject_name, year
       FROM subjects
       WHERE year = ?
       ORDER BY subject_name`
    )
    .bind(advisor.advisor_year)
    .all();

  return c.json({ data: results, error: null });
});

app.get("/api/class-advisors/attendance", requireAuth, requireClassAdvisor, async (c) => {
  const authUser = (c as any).get("authUser") as { auth_user_id: string };
  const date = c.req.query("date");
  const periodParam = c.req.query("period");
  const period = Number(periodParam);

  if (!date || !Number.isInteger(period) || period <= 0) {
    return c.json({ success: false, message: "Date and period are required" }, 400);
  }

  const advisor = await c.env.DB
    .prepare("SELECT advisor_year, advisor_section, department FROM staff WHERE auth_user_id = ? LIMIT 1")
    .bind(authUser.auth_user_id)
    .first() as { advisor_year: number; advisor_section: string; department: string } | null;

  if (!advisor?.advisor_year || !advisor.advisor_section) {
    return c.json({ success: false, message: "Advisor assignment not found" }, 404);
  }

  const attendanceTable = advisor.advisor_year === 3 ? "IT_Attendance_2024_2028" : "IT_Attendance_2025_2029";
  const studentTable = advisor.advisor_year === 3 ? "IT_Students_2024_2028" : "IT_Students_2025_2029";

  const session = await c.env.DB
    .prepare(
      `SELECT * FROM attendance_session
       WHERE year = ? AND section = ? AND period = ? AND attendance_date = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(advisor.advisor_year, advisor.advisor_section, period, date)
    .first() as {
      session_id: string;
      subject_code: string;
      subject_name: string;
      year: number;
      section: string;
      period: number;
      attendance_date: string;
      attendance_table: string;
      status: string;
      created_by: string;
      expire_at: string;
      finalized_at: string | null;
    } | null;

  if (!session) {
    return c.json({ success: false, message: "No attendance session found for this date and period." });
  }

  const students = await c.env.DB
    .prepare(
      `SELECT student_id, register_no, student_name, year, section, email
       FROM ${studentTable}
       WHERE year = ? AND section = ?
       ORDER BY register_no`
    )
    .bind(advisor.advisor_year, advisor.advisor_section)
    .all();

  const existingRows = await c.env.DB
    .prepare(
      `SELECT register_no, status, od FROM ${attendanceTable}
       WHERE session_id = ?`
    )
    .bind(session.session_id)
    .all();

  const attendanceMap: Record<string, { status: string; od: string }> = {};
  for (const row of existingRows.results as { register_no: string; status: string; od: string }[]) {
    attendanceMap[row.register_no] = { status: row.status, od: row.od };
  }

  const studentList = students.results as { student_id: string; register_no: string; student_name: string; year: number; section: string; email: string }[];

  return c.json({
    success: true,
    data: {
      session_id: session.session_id,
      subject_code: session.subject_code,
      subject_name: session.subject_name,
      date: session.attendance_date,
      period: session.period,
      year: session.year,
      section: session.section,
      status: session.status,
      attendance_table: session.attendance_table,
      students: studentList.map((s) => ({
        student_id: s.student_id,
        register_no: s.register_no,
        student_name: s.student_name,
        year: s.year,
        section: s.section,
        email: s.email,
        status: attendanceMap[s.register_no]?.status || null,
        od: attendanceMap[s.register_no]?.od || "NO",
      })),
    },
  });
});

app.patch("/api/class-advisors/attendance/:sessionId", requireAuth, requireClassAdvisor, async (c) => {
  const sessionId = c.req.param("sessionId");
  const authUser = (c as any).get("authUser") as { auth_user_id: string };
  const body = await c.req.json<{
    register_no?: string;
    status?: string;
  }>();

  const { register_no, status } = body;

  if (!register_no || !status || !["PRESENT", "ABSENT"].includes(status.toUpperCase())) {
    return c.json({ success: false, error: "register_no and valid status (PRESENT/ABSENT) are required" }, 400);
  }

  const session = await c.env.DB
    .prepare(
      `SELECT * FROM attendance_session WHERE session_id = ? LIMIT 1`
    )
    .bind(sessionId)
    .first() as {
      session_id: string;
      year: number;
      section: string;
      attendance_table: string;
      status: string;
      created_by: string;
    } | null;

  if (!session) {
    return c.json({ success: false, error: "Session not found" }, 404);
  }

  const advisor = await c.env.DB
    .prepare("SELECT advisor_year, advisor_section FROM staff WHERE auth_user_id = ? LIMIT 1")
    .bind(authUser.auth_user_id)
    .first() as { advisor_year: number; advisor_section: string } | null;

  if (!advisor || advisor.advisor_year !== session.year || advisor.advisor_section !== session.section) {
    return c.json({ success: false, error: "You can only edit attendance for your assigned class" }, 403);
  }

  const attendanceTable = session.attendance_table;

  const existing = await c.env.DB
    .prepare(
      `SELECT id, status FROM ${attendanceTable} WHERE session_id = ? AND register_no = ? LIMIT 1`
    )
    .bind(sessionId, register_no)
    .first() as { id: number; status: string } | null;

  const newStatus = status.toUpperCase();

  if (existing) {
    await c.env.DB
      .prepare(
        `UPDATE ${attendanceTable} SET status = ?, marked_at = ? WHERE id = ?`
      )
      .bind(newStatus, new Date().toISOString(), existing.id)
      .run();
  } else {
    const student = await c.env.DB
      .prepare(
        `SELECT register_no, section FROM ${attendanceTable.replace("_Attendance_", "_Students_")}
         WHERE register_no = ? AND year = ? AND section = ? LIMIT 1`
      )
      .bind(register_no, session.year, session.section)
      .first() as { register_no: string; section: string } | null;

    if (!student) {
      return c.json({ success: false, error: "Student does not belong to this class" }, 403);
    }

    const attendanceId = crypto.randomUUID();
    const sessionData = await c.env.DB
      .prepare(
        `SELECT subject_code, subject_name, period, attendance_date FROM attendance_session WHERE session_id = ?`
      )
      .bind(sessionId)
      .first() as { subject_code: string; subject_name: string; period: number; attendance_date: string } | null;

    if (!sessionData) {
      return c.json({ success: false, error: "Session not found" }, 404);
    }

    await c.env.DB
      .prepare(
        `INSERT INTO ${attendanceTable} (attendance_id, register_no, section, attendance_date, period, subject_code, subject_name, marked_at, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(attendanceId, register_no, student.section, sessionData.attendance_date, sessionData.period, sessionData.subject_code, sessionData.subject_name, new Date().toISOString(), sessionId, newStatus)
      .run();
  }

  const updated = await c.env.DB
    .prepare(
      `SELECT register_no, status, od FROM ${attendanceTable} WHERE session_id = ? AND register_no = ? LIMIT 1`
    )
    .bind(sessionId, register_no)
    .first() as { register_no: string; status: string; od: string } | null;

  return c.json({ success: true, attendance: updated });
});

app.get("/api/class-advisors/attendance/report", requireAuth, requireClassAdvisor, async (c) => {
  const authUser = (c as any).get("authUser") as { auth_user_id: string };
  const date = c.req.query("date");
  const periodParam = c.req.query("period");
  const period = Number(periodParam);

  if (!date || !Number.isInteger(period) || period <= 0) {
    return c.json({ success: false, message: "Date and period are required" }, 400);
  }

  const advisor = await c.env.DB
    .prepare("SELECT advisor_year, advisor_section, department FROM staff WHERE auth_user_id = ? LIMIT 1")
    .bind(authUser.auth_user_id)
    .first() as { advisor_year: number; advisor_section: string; department: string } | null;

  if (!advisor?.advisor_year || !advisor.advisor_section) {
    return c.json({ success: false, message: "Advisor assignment not found" }, 404);
  }

  const year = advisor.advisor_year;
  const section = advisor.advisor_section;
  const department = advisor.department;

  const attendanceTable = year === 3 ? "IT_Attendance_2024_2028" : "IT_Attendance_2025_2029";
  const studentTable = year === 3 ? "IT_Students_2024_2028" : "IT_Students_2025_2029";

  const session = await c.env.DB
    .prepare(
      `SELECT * FROM attendance_session
       WHERE year = ? AND section = ? AND period = ? AND attendance_date = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(year, section, period, date)
    .first() as {
      session_id: string;
      subject_code: string;
      subject_name: string;
      year: number;
      section: string;
      period: number;
      attendance_date: string;
      status: string;
    } | null;

  if (!session) {
    return c.json({ success: false, message: "No attendance session found for this date and period." });
  }

  const students = await c.env.DB
    .prepare(
      `SELECT student_id, register_no, student_name FROM ${studentTable}
       WHERE year = ? AND section = ?
       ORDER BY register_no`
    )
    .bind(year, section)
    .all();

  const attendanceRows = await c.env.DB
    .prepare(
      `SELECT register_no, status, od FROM ${attendanceTable}
       WHERE session_id = ?`
    )
    .bind(session.session_id)
    .all();

  const attendanceMap: Record<string, { status: string; od: string }> = {};
  for (const row of attendanceRows.results as { register_no: string; status: string; od: string }[]) {
    attendanceMap[row.register_no] = { status: row.status, od: row.od };
  }

  const studentList = students.results as { student_id: string; register_no: string; student_name: string }[];

  const totalStrength = studentList.length;
  const presentCount = studentList.filter((s) => attendanceMap[s.register_no]?.status === "PRESENT").length;
  const absentCount = studentList.filter((s) => attendanceMap[s.register_no]?.status === "ABSENT").length;
  const odCount = studentList.filter((s) => attendanceMap[s.register_no]?.od === "YES").length;
  const absentStudents = studentList.filter((s) => attendanceMap[s.register_no]?.status === "ABSENT");
  const odStudents = studentList.filter((s) => attendanceMap[s.register_no]?.od === "YES");
  const percentage = totalStrength ? Math.round((presentCount / totalStrength) * 100) : 0;

  const dateLabel = date;
  const subjectName = session.subject_name;

  const absenteesList = absentStudents.length > 0
    ? absentStudents.map((s, i) => `${i + 1}. ${s.student_name.toUpperCase()} (${s.register_no})`).join("\n")
    : "Nil";

  const odList = odStudents.length > 0
    ? odStudents.map((s, i) => `${i + 1}. ${s.student_name.toUpperCase()} (${s.register_no})`).join("\n")
    : "Nil";

  const report = [
    "Good Morning Sir,",
    `Date: ${dateLabel}`,
    "",
    `B. Tech - ${department} - ${section}`,
    `Total Strength: ${totalStrength}`,
    `Present: ${presentCount}/${totalStrength}`,
    `Absent: ${absentCount}`,
    `OD: ${odCount}`,
    `Hour: ${subjectName}`,
    "",
    "Absentees:",
    "",
    absenteesList,
    "",
    "OD:",
    odList,
    "",
    `Attendance Percentage: ${percentage}%`,
  ].join("\n");

  return c.json({
    success: true,
    data: {
      report,
      subject_code: session.subject_code,
      subject_name: session.subject_name,
      date: session.attendance_date,
      period: session.period,
      year: session.year,
      section: session.section,
      total_strength: totalStrength,
      present: presentCount,
      absent: absentCount,
      od: odCount,
      percentage,
      absentees: absentStudents.map((s) => ({ name: s.student_name, register_no: s.register_no })),
      od_students: odStudents.map((s) => ({ name: s.student_name, register_no: s.register_no })),
    },
  });
});

app.get("/api/health", (c) => {
  return c.json({
    success: true,
    message: "Campus-Flow backend is running",
  });
});

app.get("/api/db-test", async (c) => {
  const result = await c.env.DB
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all();

  return c.json({
    success: true,
    tables: result.results,
  });
});

app.get("/api/subjects", async (c) => {
  const year = c.req.query("year");

  if (!year) {
    return c.json(
      {
        success: false,
        message: "Year is required",
      },
      400
    );
  }

  const { results } = await c.env.DB
    .prepare(
      "SELECT id, subject_code, subject_name, year FROM subjects WHERE year = ? ORDER BY subject_name"
    )
    .bind(Number(year))
    .all();

  return c.json({
    success: true,
    subjects: results,
  });
});

export default app;
export async function scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
  const db = env.DB;
  const now = new Date().toISOString();

  const activeSessions = await db
    .prepare(
      `SELECT session_id, year, section, attendance_table FROM attendance_session WHERE status = 'ACTIVE' AND expire_at <= ?`
    )
    .bind(now)
    .all() as { results: { session_id: string; year: number; section: string; attendance_table: string }[] };

  for (const session of activeSessions.results) {
    await finalizeSession(db, session.session_id);
  }

  await db
    .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
    .bind(now)
    .run();
}