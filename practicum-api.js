const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const text = (value, max = 4000) => String(value ?? "").trim().slice(0, max);
const allowedDocs = new Set(["school_observation", "assistant_teacher_report", "daily_logbook"]);
const statuses = new Set(["draft", "submitted", "needs_revision", "approved"]);
const validDate = value => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
};
async function parseBody(request, max = 35000) {
  if (Number(request.headers.get("content-length") || 0) > max) throw new Error("PAYLOAD_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error("PAYLOAD_TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function isPracticumApi(path, method) {
  return (path === "/api/practicum/me" && method === "GET")
    || (path === "/api/practicum/portfolio" && ["GET", "POST"].includes(method))
    || (path === "/api/practicum/logbook" && ["GET", "POST"].includes(method))
    || (path === "/api/practicum/logbook/delete" && method === "POST");
}

export async function handlePracticumApi(request, env, { authorize }) {
  const auth = await authorize(request, env);
  if (!auth) return json({ error: "กรุณาเข้าสู่ระบบด้วยบัญชีมหาวิทยาลัย", code: "AUTH_REQUIRED" }, 401);
  if (String(auth.email || "").toLowerCase().split("@").pop() !== "lru.ac.th" || auth.emailVerified !== true) {
    return json({ error: "พื้นที่ฝึกปฏิบัตินี้สำหรับบัญชี @lru.ac.th ที่ยืนยันอีเมลแล้วเท่านั้น", code: "LRU_EMAIL_REQUIRED" }, 403);
  }
  if (!auth.sub) return json({ error: "ไม่พบบัญชีผู้ใช้", code: "INVALID_SESSION" }, 401);
  const url = new URL(request.url);
  if (request.method !== "GET" && request.headers.get("origin") !== url.origin) return json({ error: "คำขอไม่ถูกต้อง", code: "CSRF_REJECTED" }, 403);

  if (url.pathname === "/api/practicum/me") {
    return json({ user: { name: text(auth.name || auth.nickname || "", 120), email: auth.email }, scope: "student" });
  }
  if (url.pathname === "/api/practicum/portfolio" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT document_key,title,content_json,status,submitted_at,reviewed_at,reviewer_note,updated_at FROM practicum_portfolios WHERE user_sub=? ORDER BY document_key")
      .bind(auth.sub).all();
    return json({ documents: (result.results || []).map(row => ({ ...row, content: safeJson(row.content_json) })) });
  }
  if (url.pathname === "/api/practicum/portfolio" && request.method === "POST") {
    let body;
    try { body = await parseBody(request); } catch (error) { return json({ error: error.message === "PAYLOAD_TOO_LARGE" ? "ข้อมูลมีขนาดใหญ่เกินกำหนด" : "ข้อมูลไม่ถูกต้อง" }, error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400); }
    const key = text(body.document_key, 40);
    if (!allowedDocs.has(key)) return json({ error: "ไม่พบประเภทเอกสาร" }, 400);
    const title = text(body.title, 180);
    const content = body.content && typeof body.content === "object" && !Array.isArray(body.content) ? body.content : {};
    const serialized = JSON.stringify(content);
    if (serialized.length > 30000) return json({ error: "เอกสารมีขนาดใหญ่เกินกำหนด" }, 413);
    const existing = await env.DB.prepare("SELECT status FROM practicum_portfolios WHERE user_sub=? AND document_key=?").bind(auth.sub,key).first();
    const status = body.action === "submit" ? "submitted" : (existing?.status === "needs_revision" ? "draft" : "draft");
    await env.DB.prepare(`INSERT INTO practicum_portfolios(user_sub,document_key,title,content_json,status,submitted_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(user_sub,document_key) DO UPDATE SET title=excluded.title,content_json=excluded.content_json,status=excluded.status,
      submitted_at=CASE WHEN excluded.status='submitted' THEN CURRENT_TIMESTAMP ELSE practicum_portfolios.submitted_at END,updated_at=CURRENT_TIMESTAMP`)
      .bind(auth.sub,key,title,serialized,status, status === "submitted" ? new Date().toISOString() : null).run();
    return json({ ok: true, document_key: key, status });
  }
  if (url.pathname === "/api/practicum/logbook" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT id,work_date,time_in,time_out,activity,reflection,hours,status,mentor_note,created_at,updated_at FROM practicum_logs WHERE user_sub=? ORDER BY work_date DESC,id DESC")
      .bind(auth.sub).all();
    const logs = result.results || [];
    return json({ logs, total_hours: Math.round(logs.filter(x=>x.status!=="needs_revision").reduce((n,x)=>n+Number(x.hours||0),0)*100)/100 });
  }
  if (url.pathname === "/api/practicum/logbook/delete") {
    let body; try { body = await request.json(); } catch { return json({ error: "ข้อมูลไม่ถูกต้อง" }, 400); }
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ error: "รายการไม่ถูกต้อง" }, 400);
    const result = await env.DB.prepare("DELETE FROM practicum_logs WHERE id=? AND user_sub=? AND status IN ('draft','needs_revision')").bind(id,auth.sub).run();
    if (!result.meta?.changes) return json({ error: "ลบได้เฉพาะรายการฉบับร่างของตนเอง" }, 403);
    return json({ ok: true });
  }
  if (url.pathname === "/api/practicum/logbook" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "ข้อมูลไม่ถูกต้อง" }, 400); }
    if (body.action === "submit") {
      const logId = Number(body.id);
      if (!Number.isSafeInteger(logId) || logId < 1) return json({ error: "รายการไม่ถูกต้อง" }, 400);
      const old = await env.DB.prepare("SELECT status FROM practicum_logs WHERE id=? AND user_sub=?").bind(logId,auth.sub).first();
      if (!old || old.status !== "draft") return json({ error: "ส่งตรวจได้เฉพาะรายการฉบับร่างของตนเอง" }, 403);
      await env.DB.prepare("UPDATE practicum_logs SET status='submitted',updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_sub=?").bind(logId,auth.sub).run();
      return json({ ok: true, id: logId, status: "submitted" });
    }
    const workDate = text(body.work_date,10), timeIn=text(body.time_in,5), timeOut=text(body.time_out,5);
    const activity=text(body.activity,1800), reflection=text(body.reflection,1800);
    if (!validDate(workDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeIn) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOut) || !activity) return json({ error: "กรุณาตรวจวันที่ เวลา และกิจกรรมให้ครบถ้วน" },400);
    const [ih,im]=timeIn.split(":").map(Number),[oh,om]=timeOut.split(":").map(Number);
    const minutes=oh*60+om-(ih*60+im);
    if(minutes<=0) return json({error:"เวลาออกต้องอยู่หลังเวลาเข้าในวันเดียวกัน"},400);
    const hours=Math.round(minutes/60*100)/100;
    const rowId=Number(body.id||0);
    if(rowId) {
      const old=await env.DB.prepare("SELECT status FROM practicum_logs WHERE id=? AND user_sub=?").bind(rowId,auth.sub).first();
      if(!old || !["draft","needs_revision"].includes(old.status)) return json({error:"แก้ไขได้เฉพาะรายการฉบับร่างหรือที่ถูกส่งกลับ"},403);
      await env.DB.prepare("UPDATE practicum_logs SET work_date=?,time_in=?,time_out=?,activity=?,reflection=?,hours=?,status='draft',updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_sub=?")
        .bind(workDate,timeIn,timeOut,activity,reflection,hours,rowId,auth.sub).run();
      return json({ok:true,id:rowId,hours});
    }
    const result=await env.DB.prepare("INSERT INTO practicum_logs(user_sub,work_date,time_in,time_out,activity,reflection,hours,status) VALUES(?,?,?,?,?,?,?,'draft')")
      .bind(auth.sub,workDate,timeIn,timeOut,activity,reflection,hours).run();
    return json({ok:true,id:result.meta?.last_row_id,hours});
  }
  return json({ error: "ไม่พบเส้นทาง", code: "NOT_FOUND" }, 404);
}
function safeJson(value) { try { return JSON.parse(value || "{}"); } catch { return {}; } }
