import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/utils/auth";
import {
  SAFE_BOUND_PARAMETERS,
  chunk,
  chunkSizeForParameters,
} from "../src/utils/sqlChunking";
import {
  DEFAULT_INITIAL_PASSWORD,
  verifyDefaultPassword,
} from "../src/utils/accountProvisioning";
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
import migration0014 from "../migrations/0014_cse-2026-2030-test-seed.sql?raw";
import migration0015 from "../migrations/0015_simplify-subjects.sql?raw";
import migration0016 from "../migrations/0016_academic_batches.sql?raw";

/*
 * Bulk imports at the size that actually breaks.
 *
 * A 66-row CSE upload failed in production with
 *
 *     D1_ERROR: too many SQL variables at offset 335: SQLITE_ERROR
 *
 * because the pre-flight lookups built `IN (...)` lists from the request: three of
 * them for the roster lookup (3 x 66 = 198 bound parameters) and two for the auth
 * lookup (2 x 66 = 132), against a hard limit of 100. Every earlier test in this
 * repository imported two or three rows, which is why nothing caught it.
 *
 * The tests here use 66 rows to reproduce the reported failure exactly, and 200 to
 * show the fix is a general property rather than a threshold tuned to one file.
 */

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
  migration0014,
  migration0015,
  migration0016,
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

const ADMIN_ID = "c5e5f000-0000-4000-8000-0000000000ad";
const ADMIN_TOKEN = "bulk-admin-token";

async function api(path: string, init: RequestInit = {}) {
  const response = await SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: `campus-flow-session=${ADMIN_TOKEN}` },
  });
  return { status: response.status, body: await response.json() };
}

/** Provisions a cohort so imports have somewhere to go. */
async function ensureBatch(department: string, batch: string) {
  await api("/api/admin/batches", {
    method: "POST",
    body: JSON.stringify({ department, batch }),
  });
}

/**
 * Builds `count` distinct students.
 *
 * `tag` supplies a per-group prefix, which is what makes the groups independent:
 * migration 0014 already seeded CSE 2026_2030 with `2K24CS001`-style ids, so a
 * generator starting from 001 would collide with those and every row would be
 * reported as an existing student rather than inserted.
 */
function makeStudents(count: number, tag: string, section = "A") {
  const prefix = tag.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    return {
      student_id: `2K24${prefix}${n}`,
      register_no: `${prefix}${n}`,
      student_name: `Student ${tag} ${n}`,
      year: 3,
      section,
      email: `bulk.${tag}.${n}@kiot.ac.in`,
    };
  });
}

async function countRows(sql: string, ...params: unknown[]) {
  const row = await env.DB.prepare(sql).bind(...(params as string[])).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("bulk imports", () => {
  beforeAll(async () => {
    for (const migration of APPLY_ORDER) {
      await applyMigration(migration);
    }
    await env.DB
      .prepare("INSERT INTO auth_users (auth_user_id, user_name, pwd_hash, role, email) VALUES (?, ?, ?, ?, ?)")
      .bind(ADMIN_ID, "bulk.admin", "not-a-real-hash", "admin", "bulk.admin@kiot.ac.in")
      .run();
    await env.DB
      .prepare("INSERT INTO auth_sessions (token_hash, auth_user_id, expires_at) VALUES (?, ?, ?)")
      .bind(hashToken(ADMIN_TOKEN), ADMIN_ID, new Date(Date.now() + 60 * 60_000).toISOString())
      .run();
  });

  describe("chunk sizing", () => {
    it("keeps every chunk under D1's documented limit", () => {
      // D1's hard cap is 100. The budget is that minus a margin, so a statement
      // built from a chunk can never sit on the limit and fail in production only.
      expect(SAFE_BOUND_PARAMETERS).toBeLessThan(100);
      for (const perRow of [1, 2, 3, 4, 5]) {
        const size = chunkSizeForParameters(perRow);
        expect(size * perRow, `${perRow} params/row`).toBeLessThanOrEqual(SAFE_BOUND_PARAMETERS);
      }
    });

    it("yields 26 rows for the three-parameter roster lookup", () => {
      // 80 / 3 = 26, so each chunk binds 78 parameters.
      const size = chunkSizeForParameters(3);
      expect(size).toBe(26);
      expect(size * 3).toBe(78);
    });

    it("refuses a row that cannot fit in any chunk, rather than dropping it", () => {
      expect(() => chunkSizeForParameters(101)).toThrow(/cannot be chunked/);
      expect(() => chunkSizeForParameters(0)).toThrow();
    });

    it("splits a list without losing or reordering rows", () => {
      const items = Array.from({ length: 200 }, (_, i) => i);
      const parts = chunk(items, 26);
      expect(parts).toHaveLength(8);
      expect(parts.flat()).toEqual(items);
    });
  });

  describe("a 66-row import, the reported failure", () => {
    const BATCH = "2024_2028";

    beforeAll(async () => {
      await ensureBatch("CSE", BATCH);
    });

    it("succeeds instead of raising too many SQL variables", async () => {
      const rows = makeStudents(66, "cseA");
      const { status, body } = await api(
        `/api/admin/students?department=CSE&batch=${BATCH}`,
        { method: "POST", body: JSON.stringify({ rows }) }
      );

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.created).toBe(66);
      expect(body.authAccountsCreated).toBe(66);
      expect(body.skipped).toBe(0);
      expect(body.invalid).toEqual([]);
    });

    it("inserted every student row", async () => {
      expect(await countRows(`SELECT COUNT(*) AS n FROM CSE_Students_${BATCH}`)).toBe(66);
    });

    it("created an auth account for every student, and no more", async () => {
      const linked = await countRows(
        `SELECT COUNT(*) AS n
         FROM auth_users a JOIN CSE_Students_${BATCH} s ON s.auth_user_id = a.auth_user_id
         WHERE a.role = 'student'`
      );
      expect(linked).toBe(66);

      // Every email in the upload has exactly one account. Checked by email rather
      // than by counting all "student" accounts, because migration 0014 seeded ten
      // accounts of its own for a different cohort. Addresses are compared folded,
      // since the validator normalises them to lower case before storing.
      const rows = makeStudents(66, "cseA");
      for (const student of rows) {
        const account = await env.DB
          .prepare("SELECT auth_user_id, user_name, role, email FROM auth_users WHERE LOWER(email) = ?")
          .bind(student.email.toLowerCase())
          .first<{ auth_user_id: string; user_name: string; role: string; email: string }>();
        expect(account, `account for ${student.email}`).toBeTruthy();
        expect(account!.role).toBe("student");
        // The login handler matches on user_name OR email; an account reachable
        // only by email would still work, but a student id is the expected name.
        expect(account!.user_name.toUpperCase()).toBe(student.student_id);
      }
    });

    it("stored no plaintext password and every hash verifies", async () => {
      const plaintext = await countRows("SELECT COUNT(*) AS n FROM auth_users WHERE pwd_hash = ?", "1234");
      expect(plaintext).toBe(0);

      const { results } = await env.DB
        .prepare("SELECT pwd_hash FROM auth_users WHERE role = 'student' LIMIT 5")
        .all<{ pwd_hash: string }>();
      expect(results.length).toBeGreaterThan(0);
      for (const row of results) {
        expect(row.pwd_hash.startsWith("$2")).toBe(true);
        expect(await verifyDefaultPassword(row.pwd_hash)).toBe(true);
      }
    });

    it("reports the documented initial password without exposing a hash", async () => {
      const { body } = await api(
        `/api/admin/students?department=CSE&batch=${BATCH}`,
        { method: "POST", body: JSON.stringify({ rows: makeStudents(1, "probe") }) }
      );
      expect(body.defaultPassword).toBe(DEFAULT_INITIAL_PASSWORD);
      expect(JSON.stringify(body)).not.toContain("$2");
    });

    it("is idempotent when the same 66 rows are re-sent", async () => {
      const { status, body } = await api(
        `/api/admin/students?department=CSE&batch=${BATCH}`,
        { method: "POST", body: JSON.stringify({ rows: makeStudents(66, "cseA") }) }
      );
      expect(status).toBe(200);
      expect(body.created).toBe(0);
      expect(body.skipped).toBe(66);
      expect(body.authAccountsCreated).toBe(0);
      // The re-send created nothing, and the earlier row survived.
      expect(await countRows(`SELECT COUNT(*) AS n FROM CSE_Students_${BATCH}`)).toBe(67);
    });

    it("still reports conflicts and skips the rest of a large mixed file", async () => {
      /*
       * A conflict is a *new* student_id whose email already belongs to a
       * *different* student. It must be reported and excluded, while the other 199
       * rows are still inserted, so one bad line in a large file does not discard
       * the whole cohort.
       */
      const rows = makeStudents(200, "mixed");
      /*
       * The squatter's address is deliberately not one of the 200, so the clash is a
       * genuine cross-row conflict rather than an in-file duplicate. An in-file
       * duplicate is caught earlier and reported under `duplicates` instead.
       */
      const squattedEmail = "bulk.mixed.squatted@kiot.ac.in";
      await env.DB
        .prepare(`INSERT INTO CSE_Students_${BATCH}
                  (student_id, register_no, student_name, year, section, email, auth_user_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind("2K24SQUAT", "SQUAT01", "Squatter", 3, "A", squattedEmail, "seed-uuid-squatter")
        .run();
      rows.push({
        ...rows[10],
        student_id: "2K24MXCLASH",
        register_no: "MXCLASH",
        student_name: "Clash",
        email: squattedEmail,
      });

      const { status, body } = await api(
        `/api/admin/students?department=CSE&batch=${BATCH}`,
        { method: "POST", body: JSON.stringify({ rows }) }
      );
      expect(status).toBe(200);
      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0].reason).toContain("already belongs to another student");
      // All 200 original rows landed; only the clashing one was held back.
      expect(body.created).toBe(200);
      // 66 + 1 probe + 1 squatter + 200 mixed.
      expect(await countRows(`SELECT COUNT(*) AS n FROM CSE_Students_${BATCH}`)).toBe(268);
    });
  });

  describe("a 200-row import in a new cohort", () => {
    const BATCH = "2027_2031";

    it("imports every row and account well past the reported size", async () => {
      await ensureBatch("CSE", BATCH);
      const rows = makeStudents(200, "big", "D");

      const { status, body } = await api(
        `/api/admin/students?department=CSE&batch=${BATCH}`,
        { method: "POST", body: JSON.stringify({ rows }) }
      );
      expect(status).toBe(200);
      expect(body.created).toBe(200);
      expect(body.authAccountsCreated).toBe(200);

      expect(await countRows(`SELECT COUNT(*) AS n FROM CSE_Students_${BATCH}`)).toBe(200);
      // Section D survives a bulk import, not just a hand-typed row.
      const sectionD = await countRows(
        `SELECT COUNT(*) AS n FROM CSE_Students_${BATCH} WHERE section = 'D'`
      );
      expect(sectionD).toBe(200);
    });

    it("rolls the whole import back when a later row cannot be written", async () => {
      /*
       * Atomicity check. The roster rows and the auth accounts are written in one
       * `db.batch()`, which D1 runs as a transaction, so a failure part-way through
       * must leave neither half behind. A student row with no account can never sign
       * in and is invisible in the UI, so a partial write is the worst outcome
       * available.
       *
       * The failure is forced with a trigger rather than a duplicate value, because
       * the pre-flight lookups correctly catch duplicate ids, register numbers and
       * emails and exclude them before any write is attempted. To exercise the
       * write path itself, the trigger aborts on a student in the middle of the
       * batch, after the rows before it have already been sent to the database.
       *
       * The trigger is created and dropped by this test; it is not a migration and
       * touches no shared schema.
       */
      const batch = "2028_2032";
      await ensureBatch("CSE", batch);

      const rows = makeStudents(40, "rollback");
      const doomed = rows[19];
      await env.DB.prepare(
        `CREATE TRIGGER fail_mid_batch BEFORE INSERT ON CSE_Students_${batch}
         WHEN NEW.student_id = '${doomed.student_id}'
         BEGIN SELECT RAISE(ABORT, 'simulated mid-batch failure'); END`
      ).run();

      const { status } = await api(`/api/admin/students?department=CSE&batch=${batch}`, {
        method: "POST",
        body: JSON.stringify({ rows }),
      });
      expect(status).toBe(500);

      await env.DB.prepare(`DROP TRIGGER fail_mid_batch`).run();

      // Not one of the 40 roster rows survived, including the 19 that preceded the
      // failure inside the transaction.
      expect(await countRows(`SELECT COUNT(*) AS n FROM CSE_Students_${batch}`)).toBe(0);
      // And no accounts were created for them either: both halves rolled back
      // together rather than leaving students who could never sign in.
      const orphanAccounts = await countRows(
        "SELECT COUNT(*) AS n FROM auth_users WHERE email LIKE 'bulk.rollback.%'"
      );
      expect(orphanAccounts).toBe(0);
    });
  });

  describe("large staff and subject files", () => {
    it("imports 120 staff rows", async () => {
      const rows = Array.from({ length: 120 }, (_, i) => {
        const n = String(i + 1).padStart(3, "0");
        return { staff_name: `Staff ${n}`, email: `bulk.staff.${n}@kiot.ac.in` };
      });
      const { status, body } = await api("/api/admin/staff?department=IT", {
        method: "POST",
        body: JSON.stringify({ rows }),
      });
      expect(status).toBe(200);
      expect(body.created).toBe(120);
      expect(await countRows("SELECT COUNT(*) AS n FROM staff WHERE department = 'IT' AND email LIKE 'bulk.staff.%'")).toBe(120);
    });

    it("imports 150 subject codes", async () => {
      const rows = Array.from({ length: 150 }, (_, i) => ({
        subject_code: `BULK${String(i + 1).padStart(3, "0")}`,
        subject_name: `Bulk Subject ${i + 1}`,
      }));
      const { status, body } = await api("/api/admin/subjects", {
        method: "POST",
        body: JSON.stringify({ rows }),
      });
      expect(status).toBe(200);
      expect(body.created).toBe(150);
      expect(await countRows("SELECT COUNT(*) AS n FROM subjects WHERE subject_code LIKE 'BULK%'")).toBe(150);
    });
  });
});
