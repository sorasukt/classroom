const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        if (request.method === "OPTIONS") return corsPreflight(request, env);
        return withCors(await handleApi(request, env, ctx, url), request, env);
      }
      if (url.pathname.startsWith("/share/")) {
        return await renderSharedSummary(env, url.pathname.split("/").pop());
      }
      return json({ error: "Classroom API", health: `${url.origin}/api/health` }, 404);
    } catch (error) {
      console.error(JSON.stringify({ message: "Classroom Worker failed", path: url.pathname, error: error?.message || error?.name || "unknown" }));
      const response = json({ error: "ระบบไม่สามารถดำเนินการได้ในขณะนี้", code: "WORKER_ERROR" }, 500);
      return url.pathname.startsWith("/api/") ? withCors(response, request, env) : response;
    }
  },
};

async function handleApi(request, env, ctx, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (path === "/api/health") return json({
    ok: Boolean(env.DB && env.EXPORTS),
    time: new Date().toISOString(),
    bindings: { d1: Boolean(env.DB), r2: Boolean(env.EXPORTS) },
  }, env.DB && env.EXPORTS ? 200 : 503);
  if (path === "/api/auth/login" && method === "GET") return beginAuth(url, env);
  if (path === "/api/auth/callback" && method === "GET") return finishAuth(request, url, env);
  if (path === "/api/auth/logout" && method === "GET") return logout(url, env);

  const auth = await authorize(request, env);
  if (!auth) return json({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (path === "/api/session" && method === "GET") return json({ user: auth });

  if (path === "/api/bootstrap" && method === "GET") return bootstrap(env.DB);
  if (path === "/api/dashboard" && method === "GET") return dashboard(env.DB);
  if (path === "/api/classrooms" && method === "GET") return listClassrooms(env.DB);
  if (path === "/api/classrooms" && method === "POST") return createClassroom(request, env, ctx);
  if (/^\/api\/classrooms\/\d+$/.test(path) && method === "DELETE") {
    return deleteClassroom(env, ctx, Number(path.split("/").pop()));
  }
  if (path === "/api/students" && method === "GET") return listStudents(env.DB, url);
  if (path === "/api/students" && method === "POST") return createStudent(request, env, ctx);
  if (/^\/api\/students\/\d+$/.test(path) && method === "DELETE") {
    return deleteStudent(env, ctx, Number(path.split("/").pop()));
  }
  if (/^\/api\/students\/\d+\/history$/.test(path) && method === "GET") {
    return studentHistory(env.DB, Number(path.split("/")[3]));
  }
  if (path === "/api/attendance" && method === "GET") return getAttendance(env.DB, url);
  if (path === "/api/attendance" && method === "POST") return saveAttendance(request, env, ctx);
  if (path === "/api/lessons" && method === "GET") return listLessons(env.DB, url);
  if (path === "/api/lessons" && method === "POST") return saveLesson(request, env, ctx);
  if (/^\/api\/lessons\/\d+$/.test(path) && method === "DELETE") {
    return deleteLesson(env, ctx, Number(path.split("/").pop()));
  }
  if (path === "/api/share" && method === "POST") return createShare(request, env, ctx, url.origin);
  if (path === "/api/export.csv" && method === "GET") return exportCsv(env, ctx, url);

  return json({ error: "ไม่พบรายการที่ร้องขอ" }, 404);
}

async function beginAuth(url, env) {
  const config = authConfig(env);
  if (!config.ok) return json({ error: config.error }, 503);
  const state = crypto.randomUUID().replaceAll("-", "");
  const signedState = `${state}.${await sign(state, await sessionSigningSecret(env))}`;
  const callback = `${url.origin}/api/auth/callback`;
  const target = new URL(`${config.issuer}/authorize`);
  target.search = new URLSearchParams({
    response_type: "code",
    client_id: env.AUTH0_CLIENT_ID,
    redirect_uri: callback,
    scope: "openid profile email",
    state,
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "set-cookie": `classroom_auth_state=${signedState}; Path=/api/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "cache-control": "no-store",
    },
  });
}

async function finishAuth(request, url, env) {
  const config = authConfig(env);
  if (!config.ok) return json({ error: config.error }, 503);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (error) return authError(error, env);
  const stateCookie = getCookie(request, "classroom_auth_state");
  const [savedState, signature] = stateCookie.split(".");
  if (!code || !state || !savedState || !signature || !timingSafeEqual(state, savedState) || !timingSafeEqual(signature, await sign(savedState, await sessionSigningSecret(env)))) {
    return authError("ไม่สามารถยืนยันคำขอเข้าสู่ระบบได้", env);
  }

  const tokenResponse = await fetch(`${config.issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/callback`,
    }),
  });
  if (!tokenResponse.ok) return authError("Auth0 ไม่สามารถยืนยันตัวตนได้", env);
  const tokens = await tokenResponse.json();
  const profileResponse = await fetch(`${config.issuer}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  if (!profileResponse.ok) return authError("ไม่สามารถอ่านข้อมูลบัญชี Auth0 ได้", env);
  const profile = await profileResponse.json();
  const session = {
    sub: clean(profile.sub, 180),
    name: clean(profile.name || profile.nickname || profile.email, 180),
    email: clean(profile.email, 254),
    picture: clean(profile.picture, 500),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  const encoded = base64UrlEncode(JSON.stringify(session));
  const value = `${encoded}.${await sign(encoded, await sessionSigningSecret(env))}`;
  return new Response(null, {
    status: 302,
    headers: {
      location: `${frontendUrl(env)}#session=${encodeURIComponent(value)}`,
      "set-cookie": "classroom_auth_state=; Path=/api/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      "cache-control": "no-store",
    },
  });
}

function logout(url, env) {
  const config = authConfig(env);
  const target = config.ok
    ? `${config.issuer}/v2/logout?${new URLSearchParams({ client_id: env.AUTH0_CLIENT_ID, returnTo: frontendUrl(env) })}`
    : frontendUrl(env);
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "set-cookie": "classroom_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      "cache-control": "no-store",
    },
  });
}

async function authorize(request, env) {
  if (!env.AUTH0_CLIENT_SECRET) return false;
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const cookie = request.headers.get("cookie") || "";
  const value = bearer || cookie.match(/(?:^|;\s*)classroom_session=([^;]+)/)?.[1];
  if (!value) return false;
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature || !timingSafeEqual(signature, await sign(encoded, await sessionSigningSecret(env)))) return false;
  try {
    const session = JSON.parse(base64UrlDecode(encoded));
    if (!session.sub || Number(session.exp) < Date.now() / 1000) return false;
    return session;
  } catch {
    return false;
  }
}

function authConfig(env) {
  const domain = String(env.AUTH0_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!domain || !env.AUTH0_CLIENT_ID || !env.AUTH0_CLIENT_SECRET) {
    return { ok: false, error: "ยังไม่ได้ตั้งค่า Auth0 สำหรับระบบ" };
  }
  return { ok: true, issuer: `https://${domain}` };
}

function frontendUrl(env) {
  return String(env.FRONTEND_URL || "https://sorasukt.github.io/classroom/").replace(/\/?$/, "/");
}

async function sessionSigningSecret(env) {
  const material = new TextEncoder().encode(`sorasukt-classroom-session-v1\0${env.AUTH0_CLIENT_SECRET}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  return decodeURIComponent(cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1] || "");
}

function authError(message, env) {
  const safe = encodeURIComponent(String(message).slice(0, 200));
  return Response.redirect(`${frontendUrl(env)}#auth_error=${safe}`, 302);
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = new Set([
    "https://sorasukt.github.io",
    "https://classroom.sorasukt.com",
    ...String(env.CORS_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean),
  ]);
  return allowed.has(origin) ? origin : "";
}

function withCors(response, request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsPreflight(request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-max-age": "86400",
    "vary": "Origin",
  } });
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let result = 0;
  for (let i = 0; i < x.length; i++) result |= x[i] ^ y[i];
  return result === 0;
}

async function bootstrap(db) {
  return json({ ok: true });
}

async function dashboard(db) {
  const today = bangkokDate();
  const weekday = new Date(`${today}T12:00:00+07:00`).getDay();
  const [counts, rate, todayClasses] = await Promise.all([
    db.prepare(`SELECT (SELECT COUNT(*) FROM classrooms) classrooms, (SELECT COUNT(*) FROM students) students, (SELECT COUNT(*) FROM lesson_plans) lessons`).first(),
    db.prepare(`SELECT ROUND(100.0 * SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id), 0), 1) rate
      FROM attendance a JOIN attendance_sessions s ON s.id=a.session_id WHERE s.session_date >= date(?, '-13 day')`).bind(today).first(),
    db.prepare(`SELECT c.*, COUNT(st.id) student_count FROM classrooms c LEFT JOIN students st ON st.classroom_id=c.id
      WHERE ',' || c.schedule_days || ',' LIKE '%,' || ? || ',%' GROUP BY c.id ORDER BY c.start_time`).bind(String(weekday)).all(),
  ]);
  return json({ ...counts, attendanceRate: rate?.rate ?? 0, todayClasses: todayClasses.results, date: today });
}

async function listClassrooms(db) {
  const result = await db.prepare(`SELECT c.*, COUNT(s.id) student_count FROM classrooms c LEFT JOIN students s ON s.classroom_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`).all();
  return json(result.results);
}

async function createClassroom(request, env, ctx) {
  const body = await readBody(request);
  const name = clean(body.name, 100);
  if (!name) return json({ error: "กรุณากรอกชื่อห้องเรียน" }, 400);
  const result = await env.DB.prepare(`INSERT INTO classrooms(name, code, room, schedule_days, start_time) VALUES(?,?,?,?,?) RETURNING *`)
    .bind(name, clean(body.code, 30), clean(body.room, 60), normalizeDays(body.schedule_days), clean(body.start_time, 5)).first();
  archiveMutation(env, ctx, "classroom.created", result);
  return json(result, 201);
}

async function deleteClassroom(env, ctx, id) {
  const existing = await env.DB.prepare("SELECT * FROM classrooms WHERE id=?").bind(id).first();
  if (!existing) return json({ error: "ไม่พบห้องเรียน" }, 404);
  await env.DB.prepare("DELETE FROM classrooms WHERE id=?").bind(id).run();
  archiveMutation(env, ctx, "classroom.deleted", existing);
  return json({ ok: true });
}

async function listStudents(db, url) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const result = await db.prepare(`SELECT s.*,
      SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) present_count,
      SUM(CASE WHEN a.status='late' THEN 1 ELSE 0 END) late_count,
      SUM(CASE WHEN a.status='absent' THEN 1 ELSE 0 END) absent_count,
      SUM(CASE WHEN a.status='leave' THEN 1 ELSE 0 END) leave_count,
      ROUND(100.0 * SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id),0),1) attendance_rate
    FROM students s LEFT JOIN attendance a ON a.student_id=s.id WHERE s.classroom_id=? GROUP BY s.id
    ORDER BY CASE WHEN s.student_no='' THEN 1 ELSE 0 END, CAST(s.student_no AS INTEGER), s.name`).bind(classroomId).all();
  return json(result.results);
}

async function createStudent(request, env, ctx) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const name = clean(body.name, 120);
  if (!classroomId || !name) return json({ error: "ข้อมูลนักเรียนไม่ครบถ้วน" }, 400);
  const result = await env.DB.prepare("INSERT INTO students(classroom_id, student_no, name, note) VALUES(?,?,?,?) RETURNING *")
    .bind(classroomId, clean(body.student_no, 20), name, clean(body.note, 250)).first();
  archiveMutation(env, ctx, "student.created", result);
  return json(result, 201);
}

async function deleteStudent(env, ctx, id) {
  const existing = await env.DB.prepare("SELECT * FROM students WHERE id=?").bind(id).first();
  if (!existing) return json({ error: "ไม่พบนักเรียน" }, 404);
  await env.DB.prepare("DELETE FROM students WHERE id=?").bind(id).run();
  archiveMutation(env, ctx, "student.deleted", existing);
  return json({ ok: true });
}

async function studentHistory(db, id) {
  const student = await db.prepare(`SELECT s.*, c.name classroom_name FROM students s JOIN classrooms c ON c.id=s.classroom_id WHERE s.id=?`).bind(id).first();
  if (!student) return json({ error: "ไม่พบนักเรียน" }, 404);
  const history = await db.prepare(`SELECT ss.session_date, a.status, a.note FROM attendance a JOIN attendance_sessions ss ON ss.id=a.session_id WHERE a.student_id=? ORDER BY ss.session_date DESC LIMIT 180`).bind(id).all();
  const stats = await db.prepare(`SELECT
      SUM(status='present') present, SUM(status='late') late, SUM(status='absent') absent, SUM(status='leave') leave,
      ROUND(100.0 * SUM(status IN ('present','late')) / NULLIF(COUNT(*),0),1) rate FROM attendance WHERE student_id=?`).bind(id).first();
  return json({ student, history: history.results, stats });
}

async function getAttendance(db, url) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  const date = validDate(url.searchParams.get("date")) || bangkokDate();
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const classroom = await db.prepare("SELECT * FROM classrooms WHERE id=?").bind(classroomId).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const students = await db.prepare(`SELECT s.*, COALESCE(a.status,'') status, COALESCE(a.note,'') attendance_note
    FROM students s LEFT JOIN attendance_sessions ss ON ss.classroom_id=s.classroom_id AND ss.session_date=?
    LEFT JOIN attendance a ON a.session_id=ss.id AND a.student_id=s.id WHERE s.classroom_id=?
    ORDER BY CASE WHEN s.student_no='' THEN 1 ELSE 0 END, CAST(s.student_no AS INTEGER), s.name`).bind(date, classroomId).all();
  return json({ classroom, date, students: students.results });
}

async function saveAttendance(request, env, ctx) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const date = validDate(body.date);
  if (!classroomId || !date || !Array.isArray(body.records)) return json({ error: "ข้อมูลการเช็คชื่อไม่ถูกต้อง" }, 400);
  const session = await env.DB.prepare(`INSERT INTO attendance_sessions(classroom_id, session_date, note) VALUES(?,?,?)
    ON CONFLICT(classroom_id,session_date) DO UPDATE SET note=excluded.note RETURNING id`).bind(classroomId, date, clean(body.note, 250)).first();
  const valid = new Set(["present", "late", "absent", "leave"]);
  const records = body.records.filter((r) => positiveInt(r.student_id) && valid.has(r.status));
  if (records.length) {
    await env.DB.batch(records.map((r) => env.DB.prepare(`INSERT INTO attendance(session_id, student_id, status, note, updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(session_id,student_id) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=CURRENT_TIMESTAMP`)
      .bind(session.id, positiveInt(r.student_id), r.status, clean(r.note, 250))));
  }
  const stored = await env.DB.prepare(`SELECT student_id,status,note,updated_at FROM attendance WHERE session_id=? ORDER BY student_id`).bind(session.id).all();
  const snapshot = { classroom_id: classroomId, session_id: session.id, date, note: clean(body.note, 250), records: stored.results };
  archiveMutation(env, ctx, "attendance.saved", snapshot);
  archiveAttendanceSnapshot(env, ctx, snapshot);
  return json({ ok: true, saved: records.length });
}

async function listLessons(db, url) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const result = await db.prepare("SELECT * FROM lesson_plans WHERE classroom_id=? ORDER BY lesson_date DESC, id DESC").bind(classroomId).all();
  return json(result.results);
}

async function saveLesson(request, env, ctx) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const lessonDate = validDate(body.lesson_date);
  const topic = clean(body.topic, 180);
  if (!classroomId || !lessonDate || !topic) return json({ error: "กรุณากรอกวันที่และหัวข้อบทเรียน" }, 400);
  const fields = [classroomId, lessonDate, topic, clean(body.objectives, 3000), clean(body.materials, 2000), clean(body.notes, 3000)];
  const id = positiveInt(body.id);
  if (id) {
    const result = await env.DB.prepare(`UPDATE lesson_plans SET classroom_id=?,lesson_date=?,topic=?,objectives=?,materials=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *`)
      .bind(...fields, id).first();
    if (!result) return json({ error: "ไม่พบแผนการสอน" }, 404);
    archiveMutation(env, ctx, "lesson.updated", result);
    return json(result);
  }
  const result = await env.DB.prepare(`INSERT INTO lesson_plans(classroom_id,lesson_date,topic,objectives,materials,notes) VALUES(?,?,?,?,?,?) RETURNING *`).bind(...fields).first();
  archiveMutation(env, ctx, "lesson.created", result);
  return json(result, 201);
}

async function deleteLesson(env, ctx, id) {
  const existing = await env.DB.prepare("SELECT * FROM lesson_plans WHERE id=?").bind(id).first();
  if (!existing) return json({ error: "ไม่พบแผนการสอน" }, 404);
  await env.DB.prepare("DELETE FROM lesson_plans WHERE id=?").bind(id).run();
  archiveMutation(env, ctx, "lesson.deleted", existing);
  return json({ ok: true });
}

async function createShare(request, env, ctx, origin) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const date = validDate(body.date) || bangkokDate();
  if (!classroomId) return json({ error: "ไม่พบห้องเรียน" }, 400);
  const classroom = await env.DB.prepare("SELECT name FROM classrooms WHERE id=?").bind(classroomId).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const records = await env.DB.prepare(`SELECT s.name, s.student_no, COALESCE(a.status,'') status
    FROM students s LEFT JOIN attendance_sessions ss ON ss.classroom_id=s.classroom_id AND ss.session_date=?
    LEFT JOIN attendance a ON a.session_id=ss.id AND a.student_id=s.id WHERE s.classroom_id=? ORDER BY CAST(s.student_no AS INTEGER),s.name`).bind(date, classroomId).all();
  const counts = { present: 0, late: 0, absent: 0, leave: 0, unmarked: 0 };
  records.results.forEach((row) => counts[row.status || "unmarked"]++);
  const payload = { classroom: classroom.name, date, counts, records: records.results };
  const token = crypto.randomUUID().replaceAll("-", "");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO share_links(token,payload,expires_at) VALUES(?,?,?)").bind(token, JSON.stringify(payload), expires).run();
  archiveMutation(env, ctx, "share.created", { token, expires_at: expires, ...payload });
  const shareUrl = `${origin}/share/${token}`;
  return json({ url: shareUrl, lineUrl: `https://line.me/R/share?text=${encodeURIComponent(`สรุปการเช็คชื่อ ${classroom.name} วันที่ ${formatThaiDate(date)}\n${shareUrl}`)}` });
}

async function renderSharedSummary(env, token) {
  if (!/^[a-f0-9]{32}$/.test(token || "")) return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT payload FROM share_links WHERE token=? AND expires_at>CURRENT_TIMESTAMP").bind(token).first();
  if (!row) return new Response("ลิงก์หมดอายุหรือไม่พบข้อมูล", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const data = JSON.parse(row.payload);
  const labels = { present: "มา", late: "สาย", absent: "ขาด", leave: "ลา", "": "ยังไม่บันทึก" };
  const attention = data.records.filter((r) => r.status !== "present").map((r) => `<li><b>${escapeHtml(r.student_no || "-")} ${escapeHtml(r.name)}</b><span class="${r.status}">${labels[r.status]}</span></li>`).join("");
  return new Response(`<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>สรุปการเช็คชื่อ</title><style>
  body{margin:0;background:#f5f5f7;color:#111;font-family:system-ui,sans-serif}.wrap{max-width:620px;margin:auto;padding:28px 18px}.card{background:#fff;border:1px solid #ddd;border-radius:24px;padding:24px;box-shadow:0 12px 35px #0000000d}h1{margin:0 0 4px;font-size:26px}.muted{color:#666}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:22px 0}.stat{border:1px solid #ddd;border-radius:14px;padding:12px;text-align:center}.stat b{font-size:24px;display:block}.red{color:#c8102e}ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;border-top:1px solid #eee;padding:12px 0}.late,.absent,.leave{color:#c8102e;font-weight:700}@media(max-width:460px){.grid{grid-template-columns:repeat(2,1fr)}}</style><body><main class="wrap"><section class="card"><p class="muted">สรุปการเช็คชื่อ</p><h1>${escapeHtml(data.classroom)}</h1><p>${formatThaiDate(data.date)}</p><div class="grid"><div class="stat"><b>${data.counts.present}</b>มา</div><div class="stat"><b>${data.counts.late}</b>สาย</div><div class="stat"><b class="red">${data.counts.absent}</b>ขาด</div><div class="stat"><b>${data.counts.leave}</b>ลา</div></div><h2>รายการที่ต้องติดตาม</h2>${attention ? `<ul>${attention}</ul>` : '<p class="muted">นักเรียนมาครบทุกคน</p>'}</section></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "private, no-store" } });
}

async function exportCsv(env, ctx, url) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  const from = validDate(url.searchParams.get("from")) || "1900-01-01";
  const to = validDate(url.searchParams.get("to")) || "2999-12-31";
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const classroom = await env.DB.prepare("SELECT name FROM classrooms WHERE id=?").bind(classroomId).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const rows = await env.DB.prepare(`SELECT s.student_no,s.name,ss.session_date,a.status,a.note
    FROM students s LEFT JOIN attendance a ON a.student_id=s.id LEFT JOIN attendance_sessions ss ON ss.id=a.session_id
    WHERE s.classroom_id=? AND (ss.session_date BETWEEN ? AND ? OR ss.session_date IS NULL)
    ORDER BY CAST(s.student_no AS INTEGER),s.name,ss.session_date`).bind(classroomId, from, to).all();
  const labels = { present: "มา", late: "สาย", absent: "ขาด", leave: "ลา" };
  const header = ["เลขที่", "ชื่อ-นามสกุล", "วันที่", "สถานะ", "หมายเหตุ"];
  const lines = [header, ...rows.results.map((r) => [r.student_no, r.name, r.session_date || "", labels[r.status] || "ยังไม่มีประวัติ", r.note || ""])];
  const csv = "\uFEFF" + lines.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const filename = `attendance-${classroomId}-${bangkokDate()}.csv`;
  if (env.EXPORTS) {
    const key = `exports/${filename}`;
    queueR2(ctx, env.EXPORTS.put(key, csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } }), key);
  }
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
}

function archiveMutation(env, ctx, type, payload) {
  if (!env.EXPORTS) return;
  const savedAt = new Date().toISOString();
  const key = `audit/${bangkokDate()}/${Date.now()}-${crypto.randomUUID()}-${type}.json`;
  queueR2(ctx, env.EXPORTS.put(key, JSON.stringify({ type, saved_at: savedAt, payload }, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  }), key);
}

function archiveAttendanceSnapshot(env, ctx, snapshot) {
  if (!env.EXPORTS) return;
  const key = `snapshots/attendance/${snapshot.classroom_id}/${snapshot.date}.json`;
  const body = JSON.stringify({ saved_at: new Date().toISOString(), ...snapshot }, null, 2);
  queueR2(ctx, env.EXPORTS.put(key, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  }), key);
}

function queueR2(ctx, promise, key) {
  const task = promise.catch((error) => console.error(`R2 archive failed: ${key}`, error));
  if (ctx?.waitUntil) ctx.waitUntil(task);
}

function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function clean(value, max) { return String(value ?? "").trim().slice(0, max); }
function positiveInt(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function normalizeDays(value) { return String(value ?? "").split(",").map(Number).filter((n) => n >= 0 && n <= 6).filter((n, i, a) => a.indexOf(n) === i).join(","); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : ""; }
function bangkokDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function formatThaiDate(value) { return new Intl.DateTimeFormat("th-TH", { dateStyle: "long", timeZone: "Asia/Bangkok" }).format(new Date(`${value}T12:00:00+07:00`)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
async function readBody(request) { try { return await request.json(); } catch { return {}; } }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS }); }
