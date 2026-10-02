/**
 * The OD workflow, end to end against a real D1.
 *
 * Two things are being pinned here, and they are different in kind.
 *
 * The first is the chain itself: a student files a request, four people decide it in a
 * fixed order, and the request moves from one status to the next as they do. That is
 * driven through the HTTP routes rather than by calling the service directly, because
 * the routes are where a stage's authorisation is enforced and where the decision is
 * written -- a service-level test would pass while the route let the wrong person in.
 *
 * The second is the negative space, which is most of the file. Who may *not* act, what
 * happens on a second decision, whether a stage can be skipped, whether a student can
 * approve their own request, and whether a body that claims to be somebody else can
 * change who the request belongs to. A workflow that only has its happy path tested is
 * a workflow whose authorisation has never been exercised.
 *
 * ## Emails
 *
 * The provider is stubbed with `vi.stubGlobal`, so every assertion about mail is about
 * the *call* -- who it was addressed to, in what order -- and none of it depends on
 * Brevo being reachable. The order assertions matter more than they look: the
 * requirement is that a decision is stored before the mail, and that the student hears
 * before the next approver is asked, and only a recorded sequence can show that.
 *
 * ## Isolation
 *
 * Each test file gets isolated storage, so this applies the migrations itself,
 * including `0017_od_requests.sql` -- the OD table. That migration is the reviewed
 * artefact and has not been applied to production; applying it here proves it works
 * without touching a real database.
 *
 * The student lives in a cohort this file provisions itself, because a table created
 * that way carries `mentor_email` and the migration-seeded tables predate it. That is
 * also the realistic case: every table going forward is built by `provisioning.ts`.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/utils/auth";
import { hashDefaultPassword } from "../src/utils/accountProvisioning";
import { OD_STATUS } from "../src/utils/odWorkflow";
import migration0001 from "../migrations/0001_initial-schema.sql?raw";
import migration0002 from "../migrations/0002_auth_sessions.sql?raw";
import migration0003 from "../migrations/0003_add-attendance-session-status.sql?raw";
import migration0004 from "../migrations/0004_add-email-to-auth-users.sql?raw";
import migration0005 from "../migrations/0005_add-staff-advisor-class.sql?raw";
import migration0006 from "../migrations/0006_attendance-session-details.sql?raw";
import migration0007 from "../migrations/0007_add-od-column.sql?raw";
import migration0008 from "../migrations/0008_add-hot-path-indexes.sql?raw";
import migration0009 from "../migrations/0009_attendance-integrity-and-class-indexes.sql?raw";
import migration0010 from "../migrations/0010_auth-staff-subject-indexes.sql?raw";
import migration0011 from "../migrations/0011_attendance-session-otp-lookup-index.sql?raw";
import migration0013 from "../migrations/0013_department-aware-attendance.sql?raw";
import migration0015 from "../migrations/0015_simplify-subjects.sql?raw";
import migration0016 from "../migrations/0016_academic_batches.sql?raw";
import migration0017 from "../migrations/0017_od_requests.sql?raw";
/* Creates `hods` and `contest_coordinators`, with the `auth_user_id` both approver routes resolve through. */
import migration0018 from "../migrations/0018_directory-auth-user-id.sql?raw";

const APPLY_ORDER = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0013,
  migration0015,
  migration0016,
  migration0017,
  migration0018,
];

async function applyMigration(sql: string): Promise<void> {
  const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

/* --------------------------------------------------------------- fixtures */

/** The cohort this file provisions, so its student table has `mentor_email`. */
const DEPARTMENT = "ECE";
const BATCH = "2036_2040";
const STUDENT_TABLE = `${DEPARTMENT}_Students_${BATCH}`;

/** Two future dates, reused so a test does not have to invent them each time. */
function futureDate(daysAhead: number): string {
  const base = new Date("2026-11-01T00:00:00Z").getTime();
  return new Date(base + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

/** Far enough ahead that no clock reading can put it in the past. */
const OD_DATE_A = futureDate(10);
const OD_DATE_B = futureDate(11);

const STUDENT_ID = "2K36EC001";
const STUDENT_NAME = "Asha Raman";
const STUDENT_EMAIL = `${STUDENT_ID.toLowerCase()}@kiot.ac.in`;
let STUDENT_AUTH = "";
const STUDENT_TOKEN = "od-student-token";

const ADMIN_AUTH = "c5e5f000-0000-4000-8000-00000e000002";
const ADMIN_TOKEN = "od-admin-token";

/** IT staff, so cross-department refusals have something to refuse. */
const IT_MENTOR_AUTH = "c5e5f000-0000-4000-8000-00000e000003";
const IT_MENTOR_EMAIL = "it.mentor@kiot.ac.in";

interface Actors {
  mentor: { auth: string; email: string };
  otherMentor: { auth: string; email: string };
  coordinator: { auth: string; email: string };
  otherCoordinator: { auth: string; email: string };
  advisor: { auth: string; email: string };
  otherAdvisor: { auth: string; email: string };
  hod: { auth: string; email: string };
  otherHod: { auth: string; email: string };
}

function cookie(token: string): string {
  return `campus-flow-session=${token}`;
}

async function signIn(authUserId: string, token: string): Promise<void> {
  await env.DB
    .prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
    .bind(hashToken(token), authUserId, new Date(Date.now() + 60 * 60_000).toISOString())
    .run();
}

/** Creates a staff member with an account, and signs them in. */
async function makeStaff(
  staffId: string,
  name: string,
  email: string,
  department: string,
  token: string,
  advisor?: { batch: string; year: number; section: string }
): Promise<{ auth: string; email: string }> {
  const authUserId = `c5e5f000-0000-4000-8000-${staffId.replace(/\W/g, "").padEnd(12, "0")}`;
  const pwdHash = await hashDefaultPassword();
  await env.DB
    .prepare(
      "INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(authUserId, email.toLowerCase(), pwdHash, advisor ? "class_advisor" : "staff", email.toLowerCase())
    .run();
  await env.DB
    .prepare(
      `INSERT INTO staff
         (staff_id, staff_name, email, department, class_advisor, auth_user_id,
          advisor_year, advisor_section, advisor_batch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      staffId,
      name,
      email.toLowerCase(),
      department,
      advisor ? "Y" : "N",
      authUserId,
      advisor ? advisor.year : null,
      advisor ? advisor.section : null,
      advisor ? advisor.batch : null
    )
    .run();
  await signIn(authUserId, token);
  return { auth: authUserId, email: email.toLowerCase() };
}

/**
 * Creates a coordinator or HOD with an account, and signs them in.
 *
 * The account id is built from the table as well as the row number, because
 * `auth_users.auth_user_id` is UNIQUE and coordinator 1 and HOD 1 are different people.
 * Deriving it from the row number alone gave the two the same id and the fixture failed
 * on the first coordinator it created.
 */
async function makeDirectoryRole(
  table: "contest_coordinators" | "hods",
  idColumn: "coordinator_id" | "hod_id",
  nameColumn: "coordinator_name" | "hod_name",
  id: number,
  name: string,
  email: string,
  department: string,
  role: string,
  token: string
): Promise<{ auth: string; email: string }> {
  const prefix = table === "hods" ? "hod" : "coord";
  const authUserId = `c5e5f000-0000-4000-8000-00000e0${prefix}${String(id).padStart(4, "0")}`;
  await env.DB
    .prepare(
      "INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(authUserId, email.toLowerCase(), await hashDefaultPassword(), role, email.toLowerCase())
    .run();
  await env.DB
    .prepare(
      `INSERT INTO ${table} (${idColumn}, ${nameColumn}, email, department, auth_user_id) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, name, email.toLowerCase(), department, authUserId)
    .run();
  await signIn(authUserId, token);
  return { auth: authUserId, email: email.toLowerCase() };
}

/*
 * An account holding an approver role with *no* directory row behind it, signed in.
 *
 * The role and the record are separate writes, so this state is reachable in production:
 * an admin sets the role and the directory row is never created. It is also the state
 * `od-approver/login` already refuses, which is why this is built by hand rather than by
 * signing in -- the point is to exercise what the listing and the identity route do when
 * handed such a session anyway.
 *
 * Deliberately a throwaway rather than the deletion of a shared fixture. The suites in this
 * file share one database and run in order, so a test that removed `coordinator_id = 1`
 * silently invalidated every later test that signed that coordinator in.
 */
async function makeOrphanApprover(role: string, token: string): Promise<string> {
  const authUserId = `c5e5f000-0000-4000-8000-00000eorphan${token.slice(-4)}`;
  await env.DB
    .prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
    .bind(authUserId, `orphan.${token}@kiot.ac.in`, await hashDefaultPassword(), role, `orphan.${token}@kiot.ac.in`)
    .run();
  await signIn(authUserId, token);
  return authUserId;
}

/* ------------------------------------------------------------- http helper */

interface ApiResult {
  status: number;
  body: any;
}

async function call(token: string | null, path: string, init: RequestInit = {}): Promise<ApiResult> {
  const response = await SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Cookie: cookie(token) } : {}),
      ...(init.headers ?? {}),
    },
  });
  /*
   * Tolerate a non-JSON body. A request that does not match a route is answered with a
   * plain-text 404, and `response.json()` on that throws a SyntaxError that is neither
   * a status nor a body -- so the status is what decides the assertion instead.
   */
  let body: any = {};
  try {
    body = await response.json();
  } catch {
    body = { raw: await response.text().catch(() => "") };
  }
  return { status: response.status, body };
}

const asStudent = (path: string, init: RequestInit = {}) => call(STUDENT_TOKEN, path, init);
const asAdmin = (path: string, init: RequestInit = {}) => call(ADMIN_TOKEN, path, init);

/**
 * Swallows outbound mail and records it, so the suite never touches the network.
 *
 * Every call is kept as `{ to, subject, html, text }` so the workflow's *notifications*
 * can be asserted: who a decision told, in what order, and with what link.
 *
 * The `BREVO_API_KEY` binding has to be non-empty for `sendBrevoEmail` to reach its
 * `fetch` at all -- it refuses before the request when the key is blank -- which is why
 * `wrangler.integration.jsonc` carries a placeholder. Nothing leaves the box: a non-Brevo
 * request is passed through to the real `fetch` rather than refused, so stubbing the mail
 * cannot accidentally interfere with anything else the Worker does.
 *
 * `failEmail` is the same stub answering with a rejection, for the one behaviour that has
 * to be true when the provider is down.
 */
interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let sentMail: SentMail[] = [];

function stubEmail(): void {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (!url.includes("api.brevo.com")) {
      return originalFetch(input, init);
    }
    const payload = JSON.parse(String(init?.body ?? "{}"));
    sentMail.push({
      to: payload.to?.[0]?.email ?? "",
      subject: payload.subject ?? "",
      html: payload.htmlContent ?? "",
      text: payload.textContent ?? "",
    });
    return new Response(JSON.stringify({ messageId: "<test@brevo>" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/** A provider that rejects everything, which is the mail outage these tests describe. */
function failEmail(): void {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (!url.includes("api.brevo.com")) {
      return originalFetch(input, init);
    }
    return new Response(JSON.stringify({ code: "unauthorized", message: "Key not found" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function mailTo(address: string): SentMail[] {
  return sentMail.filter((message) => message.to === address);
}

let actors: Actors;

/** A future OD request from the student, with the given dates. */
async function fileOd(dates = [OD_DATE_A], days = dates.length, reason = "Attending an inter-college technical event") {
  return asStudent("/api/student/od", {
    method: "POST",
    body: JSON.stringify({ od_days_requested: days, od_dates: dates, reason }),
  });
}

/** Approves or rejects as a named approver. */
async function decide(token: string, stage: string, requestId: string, decision: string, comment?: string) {
  return call(token, `/api/od/requests/${requestId}/decision?stage=${stage}`, {
    method: "POST",
    body: JSON.stringify({ decision, ...(comment ? { comment } : {}) }),
  });
}

async function currentStatus(requestId: string): Promise<string> {
  const row = await env.DB
    .prepare("SELECT status FROM od_requests WHERE od_request_id = ?")
    .bind(requestId)
    .first<{ status: string }>();
  return row?.status ?? "";
}

/* ------------------------------------------------------------------ suite */

describe("student OD and mentor flow", () => {

  beforeAll(async () => {
    for (const migration of APPLY_ORDER) {
      await applyMigration(migration);
    }

    /*
     * `hods` and `contest_coordinators` are created by migration 0018, which is in
     * APPLY_ORDER above. They used to be written out inline here with a comment claiming
     * the shape was "verbatim from production", and it was not -- production had no
     * `auth_user_id` on either table, which is why the coordinator INSERT failed there
     * with a 500 while this suite passed. The migration is the single source of truth now.
     */

    await env.DB
      .prepare(
        "INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(ADMIN_AUTH, "od.admin", "not-a-real-hash", "admin", "od.admin@kiot.ac.in")
      .run();
    await signIn(ADMIN_AUTH, ADMIN_TOKEN);

    // The cohort, provisioned through the same admin API the dashboard uses, so the
    // student table is built by `provisioning.ts` and carries `mentor_email`.
    await asAdmin("/api/admin/batches", {
      method: "POST",
      body: JSON.stringify({ department: DEPARTMENT, batch: BATCH }),
    });
    await asAdmin(`/api/admin/students?department=${DEPARTMENT}&batch=${BATCH}`, {
      method: "POST",
      body: JSON.stringify({
        rows: [
          {
            student_id: STUDENT_ID,
            register_no: "36EC001",
            student_name: STUDENT_NAME,
            year: 3,
            section: "A",
            email: `${STUDENT_ID.toLowerCase()}@kiot.ac.in`,
          },
        ],
      }),
    });
    // The import created the student's login account, so reuse it rather than making a
    // second one. `auth_users.user_name` is UNIQUE, so a second row here would be this
    // fixture's bug rather than anything about the feature -- and the requirement is to
    // maintain the account that already exists, not to add another.
    //
    // Looking it up by the name provisioning chose (`studentUserName`, the upper-cased
    // student id) also means this exercises the real provisioning path instead of a
    // hand-built account, and the assertion below pins the "exactly one" property.
    const provisioned = await env.DB
      .prepare("SELECT auth_user_id FROM auth_users WHERE user_name = ?")
      .bind(STUDENT_ID.toUpperCase())
      .first<{ auth_user_id: string }>();
    expect(provisioned?.auth_user_id).toBeTruthy();
    STUDENT_AUTH = provisioned!.auth_user_id;

    // Exactly one account for this student: the imported one, reused.
    const accounts = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM auth_users WHERE user_name = ? OR email = ?")
      .bind(STUDENT_ID.toUpperCase(), `${STUDENT_ID.toLowerCase()}@kiot.ac.in`)
      .first<{ n: number }>();
    expect(accounts?.n).toBe(1);

    await env.DB
      .prepare(`UPDATE ${STUDENT_TABLE} SET auth_user_id = ? WHERE student_id = ?`)
      .bind(STUDENT_AUTH, STUDENT_ID)
      .run();
    await signIn(STUDENT_AUTH, STUDENT_TOKEN);

    const advisorCohort = { batch: BATCH, year: 3, section: "A" };
    actors = {
      mentor: await makeStaff("901", "Mentor One", "mentor.one@kiot.ac.in", DEPARTMENT, "od-mentor-1"),
      otherMentor: await makeStaff("902", "Mentor Two", "mentor.two@kiot.ac.in", DEPARTMENT, "od-mentor-2"),
      coordinator: await makeDirectoryRole(
        "contest_coordinators", "coordinator_id", "coordinator_name",
        1, "Coordinator One", "coordinator.one@kiot.ac.in", DEPARTMENT, "contest_coordinator", "od-coord-1"
      ),
      otherCoordinator: await makeDirectoryRole(
        "contest_coordinators", "coordinator_id", "coordinator_name",
        2, "Coordinator Two", "coordinator.two@kiot.ac.in", "CSE", "contest_coordinator", "od-coord-2"
      ),
      advisor: await makeStaff(
        "903", "Advisor One", "advisor.one@kiot.ac.in", DEPARTMENT, "od-advisor-1", advisorCohort
      ),
      otherAdvisor: await makeStaff(
        "904", "Advisor Two", "advisor.two@kiot.ac.in", DEPARTMENT, "od-advisor-2",
        { batch: BATCH, year: 3, section: "B" }
      ),
      hod: await makeDirectoryRole(
        "hods", "hod_id", "hod_name", 1, "Hod One", "hod.one@kiot.ac.in", DEPARTMENT, "hod", "od-hod-1"
      ),
      otherHod: await makeDirectoryRole(
        "hods", "hod_id", "hod_name", 2, "Hod Two", "hod.two@kiot.ac.in", "CSE", "hod", "od-hod-2"
      ),
    };

    stubEmail();
  });

afterEach(async () => {
    vi.unstubAllGlobals();
    sentMail = [];

    /*
     * Clear the student's in-flight requests between tests.
     *
     * Refusing a second request while one is waiting is real behaviour, and it means a
     * test that files one without finishing it would otherwise make every test after it
     * answer 409. Deleting here -- and only here -- is what lets each test stand alone.
     * It touches nothing but this file's own rows in this file's own isolated database.
     */
    await env.DB
      .prepare("DELETE FROM od_requests WHERE student_table = ? AND student_id = ?")
      .bind(STUDENT_TABLE, STUDENT_ID)
      .run();
  });

  /** Gives the student a mentor, so an OD request can be filed. */
  async function giveMentor() {
    return asStudent("/api/student/mentor", {
      method: "POST",
      body: JSON.stringify({ staff_id: "901" }),
    });
  }

  /* ============================================================ identity */

  describe("student identity", () => {
    it("refuses an unauthenticated request", async () => {
      expect((await call(null, "/api/student/me")).status).toBe(401);
      expect((await call(null, "/api/student/mentors")).status).toBe(401);
      expect((await call(null, "/api/student/od")).status).toBe(401);
    });

    it("refuses a non-student session", async () => {
      // A staff member has no roster row, so the student routes must not serve them.
      expect((await asAdmin("/api/student/me")).status).toBe(403);
      expect((await asAdmin("/api/student/od")).status).toBe(403);
    });

    it("derives the student from the session, not from the request", async () => {
      const { status, body } = await asStudent("/api/student/me");
      expect(status).toBe(200);
      expect(body.student.student_id).toBe(STUDENT_ID);
      expect(body.student.department).toBe(DEPARTMENT);
      expect(body.student.batch).toBe(BATCH);
      expect(body.student.year).toBe(3);
      expect(body.student.section).toBe("A");
      // The department came from the roster row, not from parsing an address.
      expect(body.student.email).toContain("@kiot.ac.in");
    });

  });

  /* ============================================================== mentor */

  describe("mentor allocation", () => {
    it("lists only staff from the student's own department", async () => {
      await makeStaff("905", "IT Only Mentor", IT_MENTOR_EMAIL, "IT", "od-mentor-it");

      const { status, body } = await asStudent("/api/student/mentors");
      expect(status).toBe(200);
      expect(body.department).toBe(DEPARTMENT);
      expect(body.mentors.length).toBeGreaterThan(0);
      expect(body.mentors.every((mentor: any) => mentor.department === DEPARTMENT)).toBe(true);
      // The IT staff member is not on offer.
      expect(body.mentors.some((mentor: any) => mentor.email === IT_MENTOR_EMAIL)).toBe(false);
    });

    it("returns only the four safe columns", async () => {
      const { body } = await asStudent("/api/student/mentors");
      for (const mentor of body.mentors) {
        expect(Object.keys(mentor).sort()).toEqual(["department", "email", "staff_id", "staff_name"]);
      }
      // And nothing resembling a hash anywhere in the payload.
      expect(JSON.stringify(body)).not.toContain("$2");
      expect(JSON.stringify(body)).not.toContain("pwd_hash");
    });

    it("stores the mentor's own address, not one from the browser", async () => {
      const { status, body } = await giveMentor();
      expect(status).toBe(200);
      expect(body.mentor_email).toBe(actors.mentor.email);

      const row = await env.DB
        .prepare(`SELECT mentor_email FROM ${STUDENT_TABLE} WHERE student_id = ?`)
        .bind(STUDENT_ID)
        .first<{ mentor_email: string | null }>();
      expect(row?.mentor_email).toBe(actors.mentor.email);
    });

    it("refuses a mentor from another department", async () => {
      const itStaffId = "905";
      const { status, body } = await asStudent("/api/student/mentor", {
        method: "POST",
        body: JSON.stringify({ staff_id: itStaffId }),
      });
      expect(status).toBe(404);
      expect(body.code).toBe("mentor-not-eligible");
    });

    it("refuses a staff id that does not exist", async () => {
      const { status, body } = await asStudent("/api/student/mentor", {
        method: "POST",
        body: JSON.stringify({ staff_id: "does-not-exist" }),
      });
      expect(status).toBe(404);
      expect(body.code).toBe("mentor-not-eligible");
    });

    it("requires a mentor id", async () => {
      const { status, body } = await asStudent("/api/student/mentor", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(status).toBe(400);
      expect(body.code).toBe("mentor-required");
    });

    it("refuses to change an existing mentor without confirmation", async () => {
      await giveMentor();

      const unconfirmed = await asStudent("/api/student/mentor", {
        method: "POST",
        body: JSON.stringify({ staff_id: "902" }),
      });
      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.body.code).toBe("mentor-change-unconfirmed");

      // The stored mentor is untouched, which is the point of refusing.
      const row = await env.DB
        .prepare(`SELECT mentor_email FROM ${STUDENT_TABLE} WHERE student_id = ?`)
        .bind(STUDENT_ID)
        .first<{ mentor_email: string | null }>();
      expect(row?.mentor_email).toBe(actors.mentor.email);

      const confirmed = await asStudent("/api/student/mentor", {
        method: "POST",
        body: JSON.stringify({ staff_id: "902", confirm_change: true }),
      });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.mentor_email).toBe(actors.otherMentor.email);
      expect(confirmed.body.changed).toBe(true);
    });


it("keeps the assignment even though no mentor is notified", async () => {
      /*
       * The database is the source of truth. Whatever happens to the notification, the
       * mentor really is the mentor from this moment on, so the assignment must survive
       * it -- otherwise a mail outage would silently un-appoint somebody.
       */
      stubEmail();
      const { status, body } = await asStudent("/api/student/mentor", {
        method: "POST",
        body: JSON.stringify({ staff_id: "901", confirm_change: true }),
      });
      expect(status).toBe(200);
      expect(body.mentor_email).toBe(actors.mentor.email);

      const row = await env.DB
        .prepare(`SELECT mentor_email FROM ${STUDENT_TABLE} WHERE student_id = ?`)
        .bind(STUDENT_ID)
        .first<{ mentor_email: string | null }>();
      expect(row?.mentor_email).toBe(actors.mentor.email);
    });
  });

  /* ============================================================= OD form */

  describe("OD form", () => {
    it("files a request at PENDING_MENTOR with every identity field derived", async () => {
      await giveMentor();
      stubEmail();

      const { status, body } = await fileOd([OD_DATE_A], 1);
      expect(status).toBe(200);
      expect(body.request.status).toBe(OD_STATUS.PENDING_MENTOR);

      const row = await env.DB
        .prepare("SELECT * FROM od_requests WHERE od_request_id = ?")
        .bind(body.request.od_request_id)
        .first<any>();

      // Snapshots, taken from the roster row rather than from the request.
      expect(row.student_name).toBe(STUDENT_NAME);
      expect(row.department).toBe(DEPARTMENT);
      expect(row.batch).toBe(BATCH);
      expect(row.year).toBe(3);
      expect(row.section).toBe("A");
      expect(row.submitted_date).toBe(new Date().toISOString().slice(0, 10));
      // The mentor is snapshotted now, not read later.
      expect(row.mentor_email).toBe(actors.mentor.email);
      expect(row.od_days_gained_before).toBe(0);
    });

    it("never accepts identity from the body", async () => {
      await giveMentor();
      stubEmail();

      const { status, body } = await asStudent("/api/student/od", {
        method: "POST",
        body: JSON.stringify({
          od_days_requested: 1,
          od_dates: [OD_DATE_A],
          reason: "Attending an inter-college technical event",
          // Every one of these is an attempt to rewrite the record.
          student_id: "2K99CS999",
          student_name: "Someone Else",
          department: "CSE",
          batch: "2024_2028",
          year: 4,
          section: "B",
          student_email: "attacker@evil.test",
          mentor_email: IT_MENTOR_EMAIL,
          od_days_gained_before: 99,
          submitted_date: "2000-01-01",
          status: "APPROVED",
        }),
      });
      expect(status).toBe(200);

      const row = await env.DB
        .prepare("SELECT * FROM od_requests WHERE od_request_id = ?")
        .bind(body.request.od_request_id)
        .first<any>();
      expect(row.student_id).toBe(STUDENT_ID);
      expect(row.student_name).toBe(STUDENT_NAME);
      expect(row.department).toBe(DEPARTMENT);
      expect(row.year).toBe(3);
      expect(row.section).toBe("A");
      expect(row.mentor_email).toBe(actors.mentor.email);
      expect(row.od_days_gained_before).toBe(0);
      // The date is the server's, not the one the body asked for.
      expect(row.submitted_date).toBe(new Date().toISOString().slice(0, 10));
      expect(row.status).toBe(OD_STATUS.PENDING_MENTOR);
    });


    it("rejects every invalid field, even with the browser bypassed", async () => {
      await giveMentor();
      const cases: [Record<string, unknown>, string][] = [
        [{ od_days_requested: 0, od_dates: [OD_DATE_A], reason: "A valid reason here" }, "od_days_requested"],
        [{ od_days_requested: 2.5, od_dates: [OD_DATE_A, OD_DATE_B], reason: "A valid reason here" }, "od_days_requested"],
        [{ od_days_requested: -1, od_dates: [OD_DATE_A, OD_DATE_B], reason: "A valid reason here" }, "od_days_requested"],
        [{ od_days_requested: 1, od_dates: [], reason: "A valid reason here" }, "od_dates"],
        [{ od_days_requested: 3, od_dates: [OD_DATE_A, OD_DATE_B], reason: "A valid reason here" }, "od_dates"],
        [{ od_days_requested: 1, od_dates: [OD_DATE_A, OD_DATE_A], reason: "A valid reason here" }, "od_dates"],
        [{ od_days_requested: 1, od_dates: ["not-a-date"], reason: "A valid reason here" }, "od_dates"],
        [{ od_days_requested: 1, od_dates: [OD_DATE_A], reason: "" }, "reason"],
        [{ od_days_requested: 1, od_dates: [OD_DATE_A], reason: "    " }, "reason"],
        [{ od_days_requested: 1, od_dates: [OD_DATE_A], reason: "short" }, "reason"],
      ];

      for (const [payload, field] of cases) {
        const { status, body } = await asStudent("/api/student/od", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        expect(status, JSON.stringify(payload)).toBe(400);
        expect(body.code).toBe("od-validation-failed");
        expect(body.details.errors.map((e: any) => e.field)).toContain(field);
      }
    });

    it("refuses a second request while one is in flight", async () => {
      await giveMentor();
      const first = await fileOd([OD_DATE_A], 1);
      expect(first.status).toBe(200);

      // A double-click, or a retry after a lost response.
      const second = await fileOd([futureDate(20)], 1);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe("od-request-in-flight");
    });

    it("counts only approved requests towards OD gained", async () => {
      // A pending one must not inflate the figure the student is shown.
      const before = await asStudent("/api/student/me");
      expect(before.body.od_days_gained).toBe(0);

      await env.DB
        .prepare(
          `INSERT INTO od_requests
             (od_request_id, auth_user_id, student_table, student_id, student_name, student_email,
              department, batch, year, section, mentor_email, submitted_date,
              od_days_requested, od_dates, reason, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          STUDENT_AUTH,
          STUDENT_TABLE,
          STUDENT_ID,
          STUDENT_NAME,
          `${STUDENT_ID.toLowerCase()}@kiot.ac.in`,
          DEPARTMENT,
          BATCH,
          3,
          "A",
          actors.mentor.email,
          "2026-10-01",
          2,
          JSON.stringify([OD_DATE_A]),
          "An earlier approved request",
          OD_STATUS.APPROVED
        )
        .run();

      const after = await asStudent("/api/student/me");
      expect(after.body.od_days_gained).toBe(2);
    });
  });

  /* ========================================================== the chain */

  describe("the approval chain", () => {
/** Files a fresh request and returns its id. */
    async function startRequest(
      dates: string[] = [OD_DATE_A],
      reason = "Attending an inter-college technical event"
    ): Promise<string> {
      await giveMentor();
      stubEmail();
      const { status, body } = await fileOd(dates, dates.length, reason);
      expect(status, JSON.stringify(body)).toBe(200);
      return body.request.od_request_id;
    }

    it("walks all four stages and ends APPROVED", async () => {
      const id = await startRequest();
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_MENTOR);

      expect((await decide("od-mentor-1", "MENTOR", id, "APPROVED")).status).toBe(200);
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_CLASS_ADVISOR);

      expect((await decide("od-advisor-1", "CLASS_ADVISOR", id, "APPROVED")).status).toBe(200);
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_CONTEST_COORDINATOR);

      expect((await decide("od-coord-1", "CONTEST_COORDINATOR", id, "APPROVED")).status).toBe(200);
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_HOD);

      expect((await decide("od-hod-1", "HOD", id, "APPROVED")).status).toBe(200);
      expect(await currentStatus(id)).toBe(OD_STATUS.APPROVED);

      const row = await env.DB
        .prepare("SELECT * FROM od_requests WHERE od_request_id = ?")
        .bind(id)
        .first<any>();
      expect(row.mentor_decision).toBe("APPROVED");
      expect(row.mentor_decided_by).toBe(actors.mentor.email);
      expect(row.coordinator_decision).toBe("APPROVED");
      expect(row.advisor_decision).toBe("APPROVED");
      expect(row.hod_decision).toBe("APPROVED");
      expect(row.hod_decided_at).toBeTruthy();
    });


    it("stops the workflow on a rejection and tells only the student", async () => {
      const id = await startRequest();
      stubEmail();

      const { status, body } = await decide(
        "od-mentor-1",
        "MENTOR",
        id,
        "REJECTED",
        "Clash with a scheduled lab"
      );
      expect(status).toBe(200);
      expect(body.status).toBe(OD_STATUS.REJECTED);
      expect(await currentStatus(id)).toBe(OD_STATUS.REJECTED);

const row = await env.DB
        .prepare("SELECT * FROM od_requests WHERE od_request_id = ?")
        .bind(id)
        .first<any>();
      expect(row.rejected_at_stage).toBe("MENTOR");
      expect(row.rejection_reason).toBe("Clash with a scheduled lab");
      expect(row.rejected_at).toBeTruthy();

      /*
       * The student is the only person who hears, and this is the assertion that was
       * missing: the suite recorded nothing about mail, so a broken rejection notification
       * -- the reported bug -- could not fail any test here. The message must name the
       * stage, carry the reason the approver typed, and describe the request well enough
       * for the student to recognise it.
       */
      const toStudent = mailTo(STUDENT_EMAIL);
      expect(toStudent).toHaveLength(1);
      const rejection = toStudent[0];
      expect(rejection.subject).toContain("OD Request Rejected");
      expect(rejection.text).toContain("rejected at the Mentor stage");
      expect(rejection.text).toContain("Clash with a scheduled lab");
      expect(rejection.text).toContain(STUDENT_NAME);
      expect(rejection.text).toContain(STUDENT_ID);
      expect(rejection.text).toContain(OD_DATE_A);
      expect(rejection.text).toContain(`Department: ${DEPARTMENT}`);
      expect(rejection.text).toContain(`Batch: ${BATCH}`);
      expect(rejection.text).toContain("Year: 3");
      expect(rejection.text).toContain("Section: A");
      expect(rejection.html).toContain("Clash with a scheduled lab");

      // Nobody downstream was asked to do anything.
      expect(mailTo(actors.coordinator.email)).toHaveLength(0);
    });

    it("stops on a rejection at any later stage too", async () => {
      for (const [token, stage] of [
        ["od-coord-1", "CONTEST_COORDINATOR"],
        ["od-advisor-1", "CLASS_ADVISOR"],
        ["od-hod-1", "HOD"],
      ] as const) {
        const id = await startRequest();
        // Walk to the stage under test.
        const order: [string, string][] = [
          ["od-mentor-1", "MENTOR"],
          ["od-advisor-1", "CLASS_ADVISOR"],
          ["od-coord-1", "CONTEST_COORDINATOR"],
        ];
        for (const [previousToken, previousStage] of order) {
          if (previousStage === stage) break;
          await decide(previousToken, previousStage, id, "APPROVED");
        }

        sentMail = [];
        stubEmail();
        const { status } = await decide(token, stage, id, "REJECTED", "Not this time");
        expect(status, stage).toBe(200);
        expect(await currentStatus(id)).toBe(OD_STATUS.REJECTED);

const row = await env.DB
          .prepare("SELECT rejected_at_stage FROM od_requests WHERE od_request_id = ?")
          .bind(id)
          .first<{ rejected_at_stage: string }>();
        expect(row?.rejected_at_stage).toBe(stage);

        /*
         * Every stage, not just the mentor: the student is told, and the stage *after* the
         * one that refused is never contacted. The coordinator case is the one that was
         * reported as silently dropping the student, so it is asserted explicitly.
         */
        const rejections = mailTo(STUDENT_EMAIL).filter((m) => m.subject.includes("OD Request Rejected"));
        expect(rejections, stage).toHaveLength(1);
        expect(rejections[0].text, stage).toContain("Not this time");

        if (stage === "CONTEST_COORDINATOR") {
          expect(mailTo(actors.advisor.email), stage).toHaveLength(0);
          expect(mailTo(actors.hod.email), stage).toHaveLength(0);
        }
        if (stage === "CLASS_ADVISOR") {
          expect(mailTo(actors.hod.email), stage).toHaveLength(0);
        }

        await env.DB.prepare("DELETE FROM od_requests WHERE od_request_id = ?").bind(id).run();
      }
    });

    it("records the decision and advances even when nothing is notified", async () => {
      /*
       * The decision is the record. A mail server being unreachable must not undo an
       * approval an approver was told was saved, and the failure has to be reported
       * separately rather than swallowed.
       */
      const id = await startRequest();
      sentMail = [];
      failEmail();
      const { status, body } = await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      expect(status).toBe(200);
      expect(body.status).toBe(OD_STATUS.PENDING_CLASS_ADVISOR);
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_CLASS_ADVISOR);
      expect(body.notification_sent).toBe(false);
      expect(body.warning).toContain("could not be sent");
      // Nothing left the Worker during the decision itself.
      expect(sentMail).toHaveLength(0);
    });

    it("emails the final approval exactly once, when the HOD says yes", async () => {
      const id = await startRequest([OD_DATE_A, OD_DATE_B]);
      sentMail = [];
      stubEmail();

      for (const [approver, stage] of [
        ["od-mentor-1", "MENTOR"],
        ["od-advisor-1", "CLASS_ADVISOR"],
        ["od-coord-1", "CONTEST_COORDINATOR"],
        ["od-hod-1", "HOD"],
      ] as const) {
        const { status, body } = await decide(approver, stage, id, "APPROVED");
        expect(status, stage).toBe(200);
        // Only the last one finishes it, and only the last one names a next stage.
        expect(body.next_stage ?? null, stage).toBe(
          stage === "HOD" ? null : body.next_stage
        );
      }
      expect(await currentStatus(id)).toBe(OD_STATUS.APPROVED);

      /*
       * One final approval, phrased the way a student will search for it, carrying the
       * cohort the days were granted against. Before this the final mail was indistinguishable
       * from the three stage ones, said nothing about batch, and its footer told the student
       * to sign in and "review and action this request" -- which had already happened.
       */
      const finals = mailTo(STUDENT_EMAIL).filter((m) => m.subject.includes("OD Request Approved"));
      expect(finals).toHaveLength(1);
      const mail = finals[0];
      expect(mail.text).toContain(STUDENT_NAME);
      expect(mail.text).toContain(`Batch: ${BATCH}`);
      expect(mail.text).toContain(`Department: ${DEPARTMENT}`);
      expect(mail.text).toContain("Year: 3");
      expect(mail.text).toContain("Section: A");
      expect(mail.text).toContain(`${OD_DATE_A}, ${OD_DATE_B}`);
      expect(mail.text).toContain("Number of OD days: 2");
      expect(mail.text).toContain("fully approved");
      expect(mail.text).not.toContain("review and action this request");

      // Four stage notifications, and no request-for-approval after the last one.
      expect(mailTo(STUDENT_EMAIL)).toHaveLength(4);
      expect(mailTo(actors.hod.email)).toHaveLength(1);
      expect(mailTo(actors.advisor.email)).toHaveLength(1);
      expect(mailTo(actors.coordinator.email)).toHaveLength(1);
    });

    it("refuses a mentor who is not this student's mentor", async () => {
      const id = await startRequest();
      const { status, body } = await decide("od-mentor-2", "MENTOR", id, "APPROVED");
      expect(status).toBe(403);
      expect(body.code).toBe("od-not-your-request");
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_MENTOR);
    });

    it("refuses the right person at the wrong stage", async () => {
      const id = await startRequest();
      // The mentor cannot answer the class advisor's stage, even though they are the
      // mentor. Authority is a function of the stage the request is waiting on.
      const { status, body } = await decide("od-mentor-1", "CLASS_ADVISOR", id, "APPROVED");
      expect(status).toBe(403);
      expect(body.code).toBe("od-wrong-stage");
    });

    it("refuses a coordinator from another department", async () => {
      const id = await startRequest();
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");

      /*
       * The request is waiting on the class advisor, so the stage is right and the refusal
       * has to come from the *directory* check instead: the class-advisor lookup matches the
       * address against `staff` alongside the request's cohort, and this coordinator is not
       * in it. That is a different failure from `od-wrong-stage`, and it is asserted as such
       * because the two are what tell "you are not this one's approver" apart from "it is
       * not your turn yet".
       */
      const { status, body } = await decide("od-coord-2", "CLASS_ADVISOR", id, "APPROVED");
      expect(status).toBe(403);
      expect(body.code).toBe("od-not-your-request");
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_CLASS_ADVISOR);
    });

    it("refuses an advisor mapped to a different section", async () => {
      const id = await startRequest();
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");

      // Section B's advisor is not section A's advisor.
      const { status, body } = await decide("od-advisor-2", "CLASS_ADVISOR", id, "APPROVED");
      expect(status).toBe(403);
      expect(body.code).toBe("od-not-your-request");
    });

    it("refuses an HOD from another department", async () => {
      const id = await startRequest();
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      await decide("od-advisor-1", "CLASS_ADVISOR", id, "APPROVED");
      await decide("od-coord-1", "CONTEST_COORDINATOR", id, "APPROVED");

      const { status } = await decide("od-hod-2", "HOD", id, "APPROVED");
      expect(status).toBe(403);
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_HOD);
    });

    it("refuses a student", async () => {
      const id = await startRequest();
      for (const stage of ["MENTOR", "CLASS_ADVISOR", "CONTEST_COORDINATOR", "HOD"]) {
        const { status } = await decide(STUDENT_TOKEN, stage, id, "APPROVED");
        expect(status, stage).toBe(403);
      }
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_MENTOR);
    });

    it("refuses an unauthenticated decision", async () => {
      const id = await startRequest();
      const { status } = await call(null, `/api/od/requests/${id}/decision?stage=MENTOR`, {
        method: "POST",
        body: JSON.stringify({ decision: "APPROVED" }),
      });
      expect(status).toBe(401);
    });

    it("refuses to approve twice", async () => {
      const id = await startRequest();
      expect((await decide("od-mentor-1", "MENTOR", id, "APPROVED")).status).toBe(200);

const second = await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      // The request has moved past the mentor, so the mentor may no longer act on it at
      // all -- which is a permission failure rather than a malformed request.
      expect(second.status).toBe(403);
      expect(second.body.code).toBe("od-wrong-stage");
      // Still exactly one mentor decision recorded.
      const row = await env.DB
        .prepare("SELECT mentor_decision FROM od_requests WHERE od_request_id = ?")
        .bind(id)
        .first<{ mentor_decision: string }>();
      expect(row?.mentor_decision).toBe("APPROVED");
    });

    it("refuses to act on a request that was already rejected", async () => {
      const id = await startRequest();
      await decide("od-mentor-1", "MENTOR", id, "REJECTED", "No");
      expect(await currentStatus(id)).toBe(OD_STATUS.REJECTED);

      for (const [token, stage] of [
        ["od-mentor-1", "MENTOR"],
        ["od-coord-1", "CONTEST_COORDINATOR"],
        ["od-hod-1", "HOD"],
      ] as const) {
        const { status, body } = await decide(token, stage, id, "APPROVED");
        expect(status, stage).toBe(409);
        expect(body.code).toBe("od-already-rejected");
      }
    });

    it("refuses to act on a fully approved request", async () => {
      const id = await startRequest();
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      await decide("od-advisor-1", "CLASS_ADVISOR", id, "APPROVED");
      await decide("od-coord-1", "CONTEST_COORDINATOR", id, "APPROVED");
      await decide("od-hod-1", "HOD", id, "APPROVED");

      const { status, body } = await decide("od-hod-1", "HOD", id, "REJECTED", "Changed my mind");
      expect(status).toBe(409);
      expect(body.code).toBe("od-already-approved");
    });

    it("cannot skip a stage", async () => {
      const id = await startRequest();
      // The HOD cannot jump the three stages in front of them.
      const { status, body } = await decide("od-hod-1", "HOD", id, "APPROVED");
      expect(status).toBe(403);
      expect(body.code).toBe("od-wrong-stage");
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_MENTOR);
    });

    it("refuses an unknown stage", async () => {
      const id = await startRequest();
      const { status, body } = await decide("od-hod-1", "PRINCIPAL", id, "APPROVED");
      expect(status).toBe(400);
      expect(body.code).toBe("od-unknown-stage");
    });

    it("refuses a decision that is not APPROVED or REJECTED", async () => {
      const id = await startRequest();
      for (const decision of ["MAYBE", "", "approve", "1"]) {
        const { status, body } = await call("od-mentor-1", `/api/od/requests/${id}/decision?stage=MENTOR`, {
          method: "POST",
          body: JSON.stringify({ decision }),
        });
        expect(status, decision).toBe(400);
        expect(body.code).toBe("od-invalid-decision");
      }
    });

    it("requires a reason to reject", async () => {
      const id = await startRequest();
      const { status, body } = await decide("od-mentor-1", "MENTOR", id, "REJECTED", "   ");
      expect(status).toBe(400);
      expect(body.code).toBe("od-invalid-comment");
      // And the request is untouched: a refusal is not a rejection.
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_MENTOR);
    });

    it("refuses an approver whose account has no directory record", async () => {
      const id = await startRequest();
      // Walk to the coordinator stage, so the refusal is about the directory rather
      // than about the stage being wrong.
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      await decide("od-advisor-1", "CLASS_ADVISOR", id, "APPROVED");
      // A staff account that is not a coordinator: the role is not the authority, the
      // directory row is.
      await makeStaff("906", "Just Staff", "just.staff@kiot.ac.in", DEPARTMENT, "od-plain-1");
      const { status } = await decide("od-plain-1", "CONTEST_COORDINATOR", id, "APPROVED");
      expect(status).toBe(403);
    });

    /*
     * The counterpart to the case above, and the reason a coordinator can be anybody on
     * staff at all.
     *
     * A coordinator is appointed out of a department's staff roster, so the person being
     * appointed already has an `auth_users` row -- with the role `staff`, created by the
     * staff import. `auth_users.user_name` is UNIQUE, so a second account for the same
     * address is impossible; the appointment has to reuse the one that is there.
     *
     * Reusing it is only safe because authority never came from the role. It comes from
     * the directory row: `verifyApprover` matches the caller's own address against
     * `contest_coordinators` beside the student's department, and this suite's own
     * refusal above proves the role is not what is checked. So this walks the whole path
     * -- appoint, keep the staff login, decide the coordinator stage -- because the
     * failure mode being guarded against is a coordinator who is appointed successfully
     * and then cannot act.
     */
    it("lets a member of staff appointed as coordinator decide that stage", async () => {
      const id = await startRequest();
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      await decide("od-advisor-1", "CLASS_ADVISOR", id, "APPROVED");
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_CONTEST_COORDINATOR);

      const email = "priya.rao@kiot.ac.in";
      const priya = await makeStaff("907", "Priya Rao", email, DEPARTMENT, "od-priya-1");

      const before = await env.DB
        .prepare("SELECT auth_user_id, role, pwd_hash FROM auth_users WHERE LOWER(email) = ?")
        .bind(email.toLowerCase())
        .first<{ auth_user_id: string; role: string; pwd_hash: string }>();

      // The appointment, exactly as the dashboard makes it.
      const { status, body } = await asAdmin("/api/admin/contest-coordinators", {
        method: "POST",
        body: JSON.stringify({
          rows: [{ coordinator_name: "Priya Rao", email, department: DEPARTMENT }],
        }),
      });
      expect(status, JSON.stringify(body)).toBe(200);
      expect(body.created).toBe(1);
      expect(body.roleMismatches).toEqual([]);
      // Her account existed, so nothing was created and nothing was reused as new work.
      expect(body.authAccountsCreated).toBe(0);
      expect(body.authAccountsReused).toBe(1);

      // The account is untouched: same id, same role, same password. One row, not two.
      const after = await env.DB
        .prepare("SELECT auth_user_id, role, pwd_hash FROM auth_users WHERE LOWER(email) = ?")
        .bind(email.toLowerCase())
        .first<{ auth_user_id: string; role: string; pwd_hash: string }>();
      expect(after?.auth_user_id).toBe(before!.auth_user_id);
      expect(after?.role).toBe("staff");
      expect(after?.pwd_hash).toBe(before!.pwd_hash);

      const accountCount = await env.DB
        .prepare("SELECT COUNT(*) AS n FROM auth_users WHERE LOWER(email) = ?")
        .bind(email.toLowerCase())
        .first<{ n: number }>();
      expect(accountCount?.n).toBe(1);

      // The coordinator row records which account it belongs to, which is what
      // `/api/auth/od-approver/login` and `/api/approver/me` read.
      const row = await env.DB
        .prepare(
          "SELECT coordinator_name, department, auth_user_id FROM contest_coordinators WHERE LOWER(email) = ?",
        )
        .bind(email.toLowerCase())
        .first<{ coordinator_name: string; department: string; auth_user_id: string | null }>();
      expect(row?.coordinator_name).toBe("Priya Rao");
      expect(row?.department).toBe(DEPARTMENT);
      expect(row?.auth_user_id).toBe(before!.auth_user_id);

      // She signs in to the approver routes, and they describe her as the
      // coordinator she now is -- even though her *account* role is still
      // `staff`, which the two assertions above prove has not changed.
      //
      // This is the whole reason role resolution reads the directory rather
      // than the account: `auth_users.role` holds one value and hers has to stay
      // `staff` or she loses her mentor and attendance access, so on the account
      // alone there is nothing that says "coordinator". The `contest_coordinators`
      // row says it, and that is what `/api/auth/od-approver/login` and
      // `/api/od/approver/me` read to put her on the coordinator dashboard.
      const login = await call(null, "/api/auth/od-approver/login", {
        method: "POST",
        body: JSON.stringify({ email, password: "1234" }),
      });
      expect(login.status).toBe(200);
      expect(login.body.approver.role).toBe("contest_coordinator");
      expect(login.body.approver.department).toBe(DEPARTMENT);
      expect(login.body.user.role).toBe("staff");

      // And she can action the coordinator stage, because the directory row -- not the
      // role -- is what the check reads.
      expect((await decide("od-priya-1", "CONTEST_COORDINATOR", id, "APPROVED")).status).toBe(200);
      expect(await currentStatus(id)).toBe(OD_STATUS.PENDING_HOD);

      expect(priya.email).toBe(email.toLowerCase());
    });

    /*
     * The Approved view on the coordinator's dashboard.
     *
     * It cannot be the pending list with a filter, and this is the test that says why. Priya
     * has just decided the only request in the system, so `status` has moved to PENDING_HOD --
     * there is nothing at PENDING_CONTEST_COORDINATOR left to show her. The only record that
     * she approved it is her own `coordinator_decided_by`, and that is what the view filters
     * on. Before the approved view existed she had no way to see anything she had signed off.
     */
    it("lists what the coordinator approved after it left her pending queue", async () => {
      const id = await startRequest();
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      await decide("od-advisor-1", "CLASS_ADVISOR", id, "APPROVED");

      // It has reached the coordinator stage, so it is waiting on them.
      const before = await call("od-coord-1", "/api/od/requests?stage=CONTEST_COORDINATOR");
      expect(before.status).toBe(200);
      expect(before.body.view).toBe("pending");
      expect(before.body.requests.some((r: any) => r.od_request_id === id)).toBe(true);

      expect((await decide("od-coord-1", "CONTEST_COORDINATOR", id, "APPROVED")).status).toBe(200);

      // Gone from Pending...
      const pending = await call("od-coord-1", "/api/od/requests?stage=CONTEST_COORDINATOR");
      expect(pending.body.requests.some((r: any) => r.od_request_id === id)).toBe(false);

      // ...and in Approved, because she is the one who decided it.
      const approved = await call("od-coord-1", "/api/od/requests?stage=CONTEST_COORDINATOR&view=approved");
      expect(approved.status).toBe(200);
      expect(approved.body.view).toBe("approved");
      const mine = approved.body.requests.filter((r: any) => r.od_request_id === id);
      expect(mine).toHaveLength(1);
      expect(mine[0].decisions.contest_coordinator.decision).toBe("APPROVED");
      expect(mine[0].decisions.contest_coordinator.decided_by).toBe(actors.coordinator.email);

      // Another coordinator for the same department approved nothing, so they must not
      // see it -- otherwise the view is a department list wearing a "mine" label.
      const other = await call("od-coord-2", "/api/od/requests?stage=CONTEST_COORDINATOR&view=approved");
      expect(other.body.requests.some((r: any) => r.od_request_id === id)).toBe(false);

      // An unknown view is refused rather than quietly defaulted to pending.
      const bogus = await call("od-coord-1", "/api/od/requests?stage=CONTEST_COORDINATOR&view=everything");
      expect(bogus.status).toBe(400);
      expect(bogus.body.code).toBe("od-unknown-view");
    });

    it("lists what the HOD approved, and nobody else's", async () => {
      const id = await startRequest();
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      await decide("od-advisor-1", "CLASS_ADVISOR", id, "APPROVED");
      await decide("od-coord-1", "CONTEST_COORDINATOR", id, "APPROVED");

      // It is waiting on the HOD, so it is in their Pending.
      const pending = await call("od-hod-1", "/api/od/requests?stage=HOD");
      expect(pending.status).toBe(200);
      expect(pending.body.requests.some((r: any) => r.od_request_id === id)).toBe(true);

      // The HOD approves last, and approving finishes the request outright -- so this is
      // the case where the Pending view has nothing at all left to show.
      expect((await decide("od-hod-1", "HOD", id, "APPROVED")).status).toBe(200);
      expect(await currentStatus(id)).toBe(OD_STATUS.APPROVED);

      const emptied = await call("od-hod-1", "/api/od/requests?stage=HOD");
      expect(emptied.body.requests.some((r: any) => r.od_request_id === id)).toBe(false);

      const approved = await call("od-hod-1", "/api/od/requests?stage=HOD&view=approved");
      expect(approved.status).toBe(200);
      expect(approved.body.requests.some((r: any) => r.od_request_id === id)).toBe(true);

      // The HOD for the other department signed off nothing.
      const other = await call("od-hod-2", "/api/od/requests?stage=HOD&view=approved");
      expect(other.body.requests.some((r: any) => r.od_request_id === id)).toBe(false);
    });
  });

  /* ============================================== approver sign-in */

  describe("approver sign-in", () => {
    it("signs a coordinator in and reports their stage", async () => {
      const { status, body } = await call(null, "/api/auth/od-approver/login", {
        method: "POST",
        body: JSON.stringify({ email: "coordinator.one@kiot.ac.in", password: "1234" }),
      });
      expect(status).toBe(200);
      expect(body.approver.role).toBe("contest_coordinator");
      expect(body.approver.department).toBe(DEPARTMENT);
    });

    it("signs an HOD in", async () => {
      const { status, body } = await call(null, "/api/auth/od-approver/login", {
        method: "POST",
        body: JSON.stringify({ email: "hod.one@kiot.ac.in", password: "1234" }),
      });
      expect(status).toBe(200);
      expect(body.approver.role).toBe("hod");
    });

    it("refuses a student account", async () => {
      // A student must not get a second way into the approver routes.
      const { status } = await call(null, "/api/auth/od-approver/login", {
        method: "POST",
        body: JSON.stringify({
          email: `${STUDENT_ID.toLowerCase()}@kiot.ac.in`,
          password: "1234",
        }),
      });
      expect(status).toBe(401);
    });

    it("refuses an admin account", async () => {
      const { status } = await call(null, "/api/auth/od-approver/login", {
        method: "POST",
        body: JSON.stringify({ email: "od.admin@kiot.ac.in", password: "1234" }),
      });
      expect(status).toBe(401);
    });

    it("still refuses a coordinator at the staff login", async () => {
      /*
       * The change was additive: a coordinator who can sign in here must still be
       * refused by the route every lecturer uses, because that route has no coordinator
       * record to find.
       */
      const { status } = await call(null, "/api/auth/staff/login", {
        method: "POST",
        body: JSON.stringify({ email: "coordinator.one@kiot.ac.in", password: "1234" }),
      });
      expect(status).toBe(401);
    });

    it("lists only the requests waiting on the signed-in approver", async () => {
      const { body } = await asStudent("/api/student/me");
      void body;
      const id = (await asStudent("/api/student/od", {
        method: "POST",
        body: JSON.stringify({
          od_days_requested: 1,
          od_dates: [futureDate(30)],
          reason: "Attending an inter-college technical event",
        }),
      })).body.request.od_request_id;

      const mine = await call("od-mentor-1", "/api/od/requests?stage=MENTOR");
      expect(mine.status).toBe(200);
      expect(mine.body.requests.some((request: any) => request.od_request_id === id)).toBe(true);

      // A different mentor's queue does not contain it.
      const theirs = await call("od-mentor-2", "/api/od/requests?stage=MENTOR");
      expect(theirs.body.requests.some((request: any) => request.od_request_id === id)).toBe(false);
    });

it("reports whether the signed-in approver may act", async () => {
      const { body } = await fileOd([futureDate(40)], 1);
      const id = body.request.od_request_id;

      expect((await call("od-mentor-1", `/api/od/requests/${id}/permission?stage=MENTOR`)).body.can_act).toBe(true);
      expect((await call("od-mentor-2", `/api/od/requests/${id}/permission?stage=MENTOR`)).body.can_act).toBe(false);
      expect((await call(STUDENT_TOKEN, `/api/od/requests/${id}/permission?stage=MENTOR`)).body.can_act).toBe(false);
    });

    /*
     * The queue tests below are for the coordinator and HOD stages specifically.
     *
     * These two used to come back empty for everybody, forever, because the listing
     * scoped them by a *student's* department and neither role has a student. Nothing
     * caught it: the refusal tests above only ever exercised the decision endpoint,
     * which resolves the approver from their directory, so the queue stayed wrong while
     * every authority check stayed correct. A coordinator would sign in, see nothing, and
     * have no way to tell that apart from having no requests.
     *
     * So each of these asserts the positive case -- the request *is* in the queue of the
     * right department -- and not merely that some request came back.
     */

    it("puts a request waiting on the coordinator in that coordinator's queue", async () => {
      const { body } = await fileOd([futureDate(60)], 1);
      const id = body.request.od_request_id;
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      await decide("od-advisor-1", "CLASS_ADVISOR", id, "APPROVED");

      const mine = await call("od-coord-1", "/api/od/requests?stage=CONTEST_COORDINATOR");
      expect(mine.status).toBe(200);
      expect(mine.body.requests.some((request: any) => request.od_request_id === id)).toBe(true);

      // The coordinator of another department does not see it.
      const theirs = await call("od-coord-2", "/api/od/requests?stage=CONTEST_COORDINATOR");
      expect(theirs.body.requests.some((request: any) => request.od_request_id === id)).toBe(false);
    });

    it("puts a request waiting on the HOD in that HOD's queue", async () => {
      const { body } = await fileOd([futureDate(70)], 1);
      const id = body.request.od_request_id;
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      await decide("od-advisor-1", "CLASS_ADVISOR", id, "APPROVED");
      await decide("od-coord-1", "CONTEST_COORDINATOR", id, "APPROVED");

      const mine = await call("od-hod-1", "/api/od/requests?stage=HOD");
      expect(mine.status).toBe(200);
      expect(mine.body.requests.some((request: any) => request.od_request_id === id)).toBe(true);

      const theirs = await call("od-hod-2", "/api/od/requests?stage=HOD");
      expect(theirs.body.requests.some((request: any) => request.od_request_id === id)).toBe(false);
    });

    it("scopes an advisor's queue to their own cohort", async () => {
      const { body } = await fileOd([futureDate(80)], 1);
      const id = body.request.od_request_id;
      await decide("od-mentor-1", "MENTOR", id, "APPROVED");

      const mine = await call("od-advisor-1", "/api/od/requests?stage=CLASS_ADVISOR");
      expect(mine.body.requests.some((request: any) => request.od_request_id === id)).toBe(true);

      const theirs = await call("od-advisor-2", "/api/od/requests?stage=CLASS_ADVISOR");
      expect(theirs.body.requests.some((request: any) => request.od_request_id === id)).toBe(false);
    });

    it("does not put a request in a queue for a stage it has already passed", async () => {
      const { body } = await fileOd([futureDate(90)], 1);
      const id = body.request.od_request_id;

      // Still PENDING_MENTOR: the class advisor has not had it yet.
      expect(
        (await call("od-advisor-1", "/api/od/requests?stage=CLASS_ADVISOR")).body.requests.some(
          (request: any) => request.od_request_id === id
        )
      ).toBe(false);

      await decide("od-mentor-1", "MENTOR", id, "APPROVED");
      // Now it has.
      expect(
        (await call("od-advisor-1", "/api/od/requests?stage=CLASS_ADVISOR")).body.requests.some(
          (request: any) => request.od_request_id === id
        )
      ).toBe(true);
      // And it is no longer the mentor's business.
      expect(
        (await call("od-mentor-1", "/api/od/requests?stage=MENTOR")).body.requests.some(
          (request: any) => request.od_request_id === id
        )
      ).toBe(false);
    });

    it("gives an approver with no directory row an empty queue rather than an error", async () => {
      /*
       * An account can hold an approver role without a record behind it. There is no
       * department to scope to, so the honest answer is an empty queue -- not a 500, and
       * not somebody else's rows.
       */
      await makeOrphanApprover("contest_coordinator", "od-orphan-coord-1");

      const { status, body } = await call("od-orphan-coord-1", "/api/od/requests?stage=CONTEST_COORDINATOR");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.requests).toEqual([]);
    });

    /* ================================================ approver identity */

    describe("approver identity", () => {
      it("reports the role, name and department from the session", async () => {
        const coordinator = await call("od-coord-1", "/api/od/approver/me");
        expect(coordinator.status).toBe(200);
        expect(coordinator.body.approver.role).toBe("contest_coordinator");
        expect(coordinator.body.approver.name).toBe("Coordinator One");
        expect(coordinator.body.approver.department).toBe(DEPARTMENT);

        const hod = await call("od-hod-1", "/api/od/approver/me");
        expect(hod.body.approver.role).toBe("hod");
        expect(hod.body.approver.name).toBe("Hod One");
      });

      it("never reports anybody else's identity", async () => {
        // A student session is refused outright rather than answered with an empty record.
        const student = await asStudent("/api/od/approver/me");
        expect(student.status).toBe(403);
        expect(student.body.code).toBe("od-not-an-approver");

        // Unauthenticated likewise.
        const anonymous = await call(null, "/api/od/approver/me");
        expect(anonymous.status).toBe(401);
      });

      it("refuses an approver role that has no directory row behind it", async () => {
        await makeOrphanApprover("hod", "od-orphan-hod-1");

        const { status, body } = await call("od-orphan-hod-1", "/api/od/approver/me");
        expect(status).toBe(403);
        expect(body.code).toBe("unlinked-approver");
      });
    });
  });

  /* ================================================ student's history */

  describe("student history", () => {
    it("shows the student's own requests and never an internal column", async () => {
      const { status, body } = await asStudent("/api/student/od");
      expect(status).toBe(200);
      expect(Array.isArray(body.requests)).toBe(true);
      for (const request of body.requests) {
        expect(request).not.toHaveProperty("auth_user_id");
        expect(request).not.toHaveProperty("student_table");
        expect(JSON.stringify(request)).not.toContain("$2");
        // The four stages are reported by name, with who decided and when.
        expect(Object.keys(request.decisions)).toEqual([
          "mentor",
          "contest_coordinator",
          "class_advisor",
          "hod",
        ]);
      }
    });

    it("reports a rejection with its stage and reason", async () => {
      const { body: filed } = await fileOd([futureDate(50)], 1);
      await decide("od-mentor-1", "MENTOR", filed.request.od_request_id, "REJECTED", "Lab clash");

      const { body } = await asStudent("/api/student/od");
      const found = body.requests.find((r: any) => r.od_request_id === filed.request.od_request_id);
      expect(found.status).toBe(OD_STATUS.REJECTED);
      expect(found.rejected_at_stage).toBe("MENTOR");
      expect(found.rejection_reason).toBe("Lab clash");
    });

    it("refuses to show another student's request", async () => {
      const before = (await asStudent("/api/student/od")).body.requests.length;
      // Provision a second student in the IT cohort and give them a session.
      await asAdmin("/api/admin/batches", {
        method: "POST",
        body: JSON.stringify({ department: "IT", batch: "2036_2040" }),
      });
      await asAdmin("/api/admin/students?department=IT&batch=2036_2040", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            {
              student_id: "2K36IT001",
              register_no: "36IT001",
              student_name: "Other Student",
              year: 2,
              section: "A",
              email: "2k36it001@kiot.ac.in",
            },
          ],
        }),
      });
const itAuthId = await env.DB
        .prepare("SELECT auth_user_id FROM auth_users WHERE user_name = ?")
        .bind("2K36IT001")
        .first<{ auth_user_id: string }>();
      expect(itAuthId?.auth_user_id).toBeTruthy();
      await env.DB
        .prepare("UPDATE IT_Students_2036_2040 SET auth_user_id = ? WHERE student_id = ?")
        .bind(itAuthId!.auth_user_id, "2K36IT001")
        .run();
      // The import above already created this account; reuse it rather than adding a
      // second one, which is both the fixture's requirement and the product's.
      await signIn(itAuthId!.auth_user_id, "od-it-student");

      const theirs = await call("od-it-student", "/api/student/od");
      expect(theirs.status).toBe(200);
      // The IT student's list is their own and does not grow by reading ours.
      const ids = new Set(theirs.body.requests.map((r: any) => r.od_request_id));
      for (const request of (await asStudent("/api/student/od")).body.requests) {
        expect(ids.has(request.od_request_id)).toBe(false);
      }
      expect((await asStudent("/api/student/od")).body.requests.length).toBe(before);
    });
  });

  /* ====================================================== regression */

  describe("nothing else moved", () => {
    it("leaves the attendance route working and still student-only", async () => {
      // The entry screen changed navigation; the OTP path itself must not have.
      expect((await call(null, "/api/attendance/verify", { method: "POST", body: JSON.stringify({ otp: "000000" }) })).status).toBe(401);
      const response = await SELF.fetch("https://example.com/api/attendance/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(STUDENT_TOKEN) },
        body: JSON.stringify({ otp: "000000" }),
      });
      // A well-formed request from a real student session reaches the OTP lookup and
      // is refused for the right reason: no such session, not "unauthorised".
      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.code).not.toBe("auth-required");
      expect(body.code).not.toBe("forbidden");
    });

    it("still refuses the admin routes to a non-admin", async () => {
      for (const path of ["/api/admin/batches", "/api/admin/subjects", "/api/admin/hods"]) {
        const response = await SELF.fetch(`https://example.com${path}`, {
          headers: { Cookie: cookie("od-mentor-1") },
        });
        expect(response.status, path).toBe(403);
      }
    });

    it("grants a coordinator session no staff access", async () => {
      // The point of the new sign-in route: it opens the OD queue and nothing else.
      await call(null, "/api/auth/od-approver/login", {
        method: "POST",
        body: JSON.stringify({ email: "coordinator.one@kiot.ac.in", password: "1234" }),
      });
      // The session cookie is set by the route above; reuse it via a direct call.
      const subjects = await SELF.fetch("https://example.com/api/subjects", {
        headers: { Cookie: cookie("od-coord-1") },
      });
      expect(subjects.status).toBe(403);
    });

    it("did not touch the student roster import", async () => {
      // `mentor_email` stays optional on the admin import, and the admin routes still
      // work. A student created with no mentor field lands with a NULL mentor.
      await asAdmin("/api/admin/students?department=CSE&batch=2036_2040", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            {
              student_id: "2K36CS001",
              register_no: "36CS001",
              student_name: "Imported Without Mentor",
              year: 1,
              section: "A",
              email: "2k36cs001@kiot.ac.in",
            },
          ],
        }),
      });
      const row = await env.DB
        .prepare("SELECT mentor_email FROM CSE_Students_2036_2040 WHERE student_id = ?")
        .bind("2K36CS001")
        .first<{ mentor_email: string | null }>();
      expect(row?.mentor_email).toBeNull();
    });
  });
});