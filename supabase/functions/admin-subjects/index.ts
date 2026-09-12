import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ADMIN_EMAIL = "admin@kiot.ac.in";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

async function admin(req: Request) {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const { data } = await supabase.auth.getUser(header.slice(7));
  const user = data.user;
  return user && String(user.email).toLowerCase() === ADMIN_EMAIL && user.app_metadata?.role === "admin" ? user : null;
}
const clean = (value: unknown) => String(value ?? "").trim();

async function importSubjects(rows: unknown[]) {
  if (!rows.length || rows.length > 1000) return json({ success: false, error: "Provide between 1 and 1000 subject rows." }, 400);
  const invalid_rows: { row: number; reason: string }[] = [], seen = new Set<string>();
  const valid: { semester: number; subject_code: string; subject_name: string }[] = [];
  rows.forEach((raw: any, index) => {
    const semester = Number(raw?.semester), subject_code = clean(raw?.subject_code).toUpperCase(), subject_name = clean(raw?.subject_name);
    const key = `${semester}:${subject_code}`;
    if (!Number.isInteger(semester) || semester < 1 || semester > 8) invalid_rows.push({ row: index + 2, reason: "Semester must be an integer from 1 to 8" });
    else if (!subject_code) invalid_rows.push({ row: index + 2, reason: "Missing subject_code" });
    else if (!subject_name) invalid_rows.push({ row: index + 2, reason: "Missing subject_name" });
    else if (seen.has(key)) invalid_rows.push({ row: index + 2, reason: "Duplicate semester + subject_code in upload" });
    else { seen.add(key); valid.push({ semester, subject_code, subject_name }); }
  });
  const { data, error } = await supabase.from("semester_subjects").upsert(valid, { onConflict: "semester,subject_code", ignoreDuplicates: true }).select("id");
  if (error) return json({ success: false, error: "Could not import subjects", details: error.message }, 500);
  return json({ success: true, inserted: data?.length || 0, skipped_duplicate: valid.length - (data?.length || 0), invalid_rows, total: rows.length });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Only POST requests are allowed" }, 405);
  if (!(await admin(req))) return json({ success: false, error: "Unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  if (body.action === "list") {
    let q = supabase.from("semester_subjects").select("id, semester, subject_code, subject_name, created_at").order("semester").order("subject_code");
    if (body.semester) q = q.eq("semester", Number(body.semester));
    const { data, error } = await q; return error ? json({ success: false, error: error.message }, 500) : json({ success: true, subjects: data || [] });
  }
  if (body.action === "batches") { const { data, error } = await supabase.from("academic_batches").select("department,batch_code,current_semester").order("department").order("batch_code"); return error ? json({ success: false, error: error.message }, 500) : json({ success: true, batches: data || [] }); }
  if (body.action === "set-semester") {
    const semester = Number(body.current_semester), department = clean(body.department).toUpperCase(), batch_code = clean(body.batch_code);
    if (!department || !/^\d{4}_\d{4}$/.test(batch_code) || !Number.isInteger(semester) || semester < 1 || semester > 8) return json({ success: false, error: "Department, batch and a semester from 1 to 8 are required." }, 400);
    const { error } = await supabase.from("academic_batches").upsert({ department, batch_code, current_semester: semester, updated_at: new Date().toISOString() }, { onConflict: "department,batch_code" });
    return error ? json({ success: false, error: error.message }, 500) : json({ success: true });
  }
  if (body.action === "import") return importSubjects(Array.isArray(body.rows) ? body.rows : []);
  return json({ success: false, error: "Unknown action" }, 400);
});
