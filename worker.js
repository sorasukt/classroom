const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        await ensureSchema(env.DB);
        return await handleApi(request, env, ctx, url);
      }
      if (url.pathname.startsWith("/share/")) {
        await ensureSchema(env.DB);
        return await renderSharedSummary(env, url.pathname.split("/").pop());
      }
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "strict-origin-when-cross-origin",
          "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    } catch (error) {
      console.error(error);
      return json({ error: "ระบบไม่สามารถดำเนินการได้ในขณะนี้" }, 500);
    }
  },
};

async function handleApi(request, env, ctx, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });
  if (path === "/api/auth/login" && method === "GET") return beginAuth(url, env);
  if (path === "/api/auth/callback" && method === "GET") return finishAuth(request, url, env);
  if (path === "/api/auth/logout" && method === "GET") return logout(url, env);

  const auth = await authorize(request, env);
  if (!auth) return json({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  if (path === "/api/session" && method === "GET") return json({ user: auth });

  if (path === "/api/bootstrap" && method === "GET") return bootstrap(env.DB);
  if (path === "/api/dashboard" && method === "GET") return dashboard(env.DB);
  if (path === "/api/classrooms" && method === "GET") return listClassrooms(env.DB);
  if (path === "/api/classrooms" && method === "POST") return createClassroom(request, env.DB);
  if (/^\/api\/classrooms\/\d+$/.test(path) && method === "DELETE") {
    return deleteClassroom(env.DB, Number(path.split("/").pop()));
  }
  if (path === "/api/students" && method === "GET") return listStudents(env.DB, url);
  if (path === "/api/students" && method === "POST") return createStudent(request, env.DB);
  if (/^\/api\/students\/\d+$/.test(path) && method === "DELETE") {
    return deleteStudent(env.DB, Number(path.split("/").pop()));
  }
  if (/^\/api\/students\/\d+\/history$/.test(path) && method === "GET") {
    return studentHistory(env.DB, Number(path.split("/")[3]));
  }
  if (path === "/api/attendance" && method === "GET") return getAttendance(env.DB, url);
  if (path === "/api/attendance" && method === "POST") return saveAttendance(request, env.DB);
  if (path === "/api/lessons" && method === "GET") return listLessons(env.DB, url);
  if (path === "/api/lessons" && method === "POST") return saveLesson(request, env.DB);
  if (/^\/api\/lessons\/\d+$/.test(path) && method === "DELETE") {
    return deleteLesson(env.DB, Number(path.split("/").pop()));
  }
  if (path === "/api/share" && method === "POST") return createShare(request, env.DB, url.origin);
  if (path === "/api/export.csv" && method === "GET") return exportCsv(env, ctx, url);

  return json({ error: "ไม่พบรายการที่ร้องขอ" }, 404);
}

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS classrooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      room TEXT NOT NULL DEFAULT '',
      schedule_days TEXT NOT NULL DEFAULT '',
      start_time TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classroom_id INTEGER NOT NULL,
      student_no TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_students_classroom ON students(classroom_id);
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classroom_id INTEGER NOT NULL,
      session_date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(classroom_id, session_date),
      FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('present','late','absent','leave')),
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, student_id),
      FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_date ON attendance_sessions(session_date);
    CREATE TABLE IF NOT EXISTS lesson_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classroom_id INTEGER NOT NULL,
      lesson_date TEXT NOT NULL,
      topic TEXT NOT NULL,
      objectives TEXT NOT NULL DEFAULT '',
      materials TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_classroom_date ON lesson_plans(classroom_id, lesson_date);
    CREATE TABLE IF NOT EXISTS share_links (
      token TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
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
  if (error) return authError(error, url.origin);
  const stateCookie = getCookie(request, "classroom_auth_state");
  const [savedState, signature] = stateCookie.split(".");
  if (!code || !state || !savedState || !signature || !timingSafeEqual(state, savedState) || !timingSafeEqual(signature, await sign(savedState, await sessionSigningSecret(env)))) {
    return authError("ไม่สามารถยืนยันคำขอเข้าสู่ระบบได้", url.origin);
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
  if (!tokenResponse.ok) return authError("Auth0 ไม่สามารถยืนยันตัวตนได้", url.origin);
  const tokens = await tokenResponse.json();
  const profileResponse = await fetch(`${config.issuer}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  if (!profileResponse.ok) return authError("ไม่สามารถอ่านข้อมูลบัญชี Auth0 ได้", url.origin);
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
      location: url.origin,
      "set-cookie": `classroom_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
      "cache-control": "no-store",
    },
  });
}

function logout(url, env) {
  const config = authConfig(env);
  const target = config.ok
    ? `${config.issuer}/v2/logout?${new URLSearchParams({ client_id: env.AUTH0_CLIENT_ID, returnTo: url.origin })}`
    : url.origin;
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
  const cookie = request.headers.get("cookie") || "";
  const value = cookie.match(/(?:^|;\s*)classroom_session=([^;]+)/)?.[1];
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

async function sessionSigningSecret(env) {
  const material = new TextEncoder().encode(`sorasukt-classroom-session-v1\0${env.AUTH0_CLIENT_SECRET}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  return decodeURIComponent(cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1] || "");
}

function authError(message, origin) {
  const safe = encodeURIComponent(String(message).slice(0, 200));
  return Response.redirect(`${origin}/?auth_error=${safe}`, 302);
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

async function createClassroom(request, db) {
  const body = await readBody(request);
  const name = clean(body.name, 100);
  if (!name) return json({ error: "กรุณากรอกชื่อห้องเรียน" }, 400);
  const result = await db.prepare(`INSERT INTO classrooms(name, code, room, schedule_days, start_time) VALUES(?,?,?,?,?) RETURNING *`)
    .bind(name, clean(body.code, 30), clean(body.room, 60), normalizeDays(body.schedule_days), clean(body.start_time, 5)).first();
  return json(result, 201);
}

async function deleteClassroom(db, id) {
  await db.prepare("DELETE FROM classrooms WHERE id=?").bind(id).run();
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

async function createStudent(request, db) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const name = clean(body.name, 120);
  if (!classroomId || !name) return json({ error: "ข้อมูลนักเรียนไม่ครบถ้วน" }, 400);
  const result = await db.prepare("INSERT INTO students(classroom_id, student_no, name, note) VALUES(?,?,?,?) RETURNING *")
    .bind(classroomId, clean(body.student_no, 20), name, clean(body.note, 250)).first();
  return json(result, 201);
}

async function deleteStudent(db, id) {
  await db.prepare("DELETE FROM students WHERE id=?").bind(id).run();
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

async function saveAttendance(request, db) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const date = validDate(body.date);
  if (!classroomId || !date || !Array.isArray(body.records)) return json({ error: "ข้อมูลการเช็คชื่อไม่ถูกต้อง" }, 400);
  const session = await db.prepare(`INSERT INTO attendance_sessions(classroom_id, session_date, note) VALUES(?,?,?)
    ON CONFLICT(classroom_id,session_date) DO UPDATE SET note=excluded.note RETURNING id`).bind(classroomId, date, clean(body.note, 250)).first();
  const valid = new Set(["present", "late", "absent", "leave"]);
  const records = body.records.filter((r) => positiveInt(r.student_id) && valid.has(r.status));
  if (records.length) {
    await db.batch(records.map((r) => db.prepare(`INSERT INTO attendance(session_id, student_id, status, note, updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(session_id,student_id) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=CURRENT_TIMESTAMP`)
      .bind(session.id, positiveInt(r.student_id), r.status, clean(r.note, 250))));
  }
  return json({ ok: true, saved: records.length });
}

async function listLessons(db, url) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const result = await db.prepare("SELECT * FROM lesson_plans WHERE classroom_id=? ORDER BY lesson_date DESC, id DESC").bind(classroomId).all();
  return json(result.results);
}

async function saveLesson(request, db) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const lessonDate = validDate(body.lesson_date);
  const topic = clean(body.topic, 180);
  if (!classroomId || !lessonDate || !topic) return json({ error: "กรุณากรอกวันที่และหัวข้อบทเรียน" }, 400);
  const fields = [classroomId, lessonDate, topic, clean(body.objectives, 3000), clean(body.materials, 2000), clean(body.notes, 3000)];
  const id = positiveInt(body.id);
  if (id) {
    const result = await db.prepare(`UPDATE lesson_plans SET classroom_id=?,lesson_date=?,topic=?,objectives=?,materials=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *`)
      .bind(...fields, id).first();
    if (!result) return json({ error: "ไม่พบแผนการสอน" }, 404);
    return json(result);
  }
  const result = await db.prepare(`INSERT INTO lesson_plans(classroom_id,lesson_date,topic,objectives,materials,notes) VALUES(?,?,?,?,?,?) RETURNING *`).bind(...fields).first();
  return json(result, 201);
}

async function deleteLesson(db, id) {
  await db.prepare("DELETE FROM lesson_plans WHERE id=?").bind(id).run();
  return json({ ok: true });
}

async function createShare(request, db, origin) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const date = validDate(body.date) || bangkokDate();
  if (!classroomId) return json({ error: "ไม่พบห้องเรียน" }, 400);
  const classroom = await db.prepare("SELECT name FROM classrooms WHERE id=?").bind(classroomId).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const records = await db.prepare(`SELECT s.name, s.student_no, COALESCE(a.status,'') status
    FROM students s LEFT JOIN attendance_sessions ss ON ss.classroom_id=s.classroom_id AND ss.session_date=?
    LEFT JOIN attendance a ON a.session_id=ss.id AND a.student_id=s.id WHERE s.classroom_id=? ORDER BY CAST(s.student_no AS INTEGER),s.name`).bind(date, classroomId).all();
  const counts = { present: 0, late: 0, absent: 0, leave: 0, unmarked: 0 };
  records.results.forEach((row) => counts[row.status || "unmarked"]++);
  const payload = { classroom: classroom.name, date, counts, records: records.results };
  const token = crypto.randomUUID().replaceAll("-", "");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("INSERT INTO share_links(token,payload,expires_at) VALUES(?,?,?)").bind(token, JSON.stringify(payload), expires).run();
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
  if (env.EXPORTS) ctx.waitUntil(env.EXPORTS.put(`exports/${filename}`, csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } }));
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
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

const APP_HTML = String.raw`<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#f5f5f7">
  <title>/sorasukt · Classroom</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600&family=Kanit:wght@500;600&display=swap" rel="stylesheet">
  <style>
    :root{--ink:#161514;--paper:#fff;--card:#fff;--surface:#fafafa;--line:#e6e6e4;--muted:#7a7873;--red:#ff3b30;--red-soft:#fff0ee;--shadow:0 1px 0 rgba(0,0,0,.04),0 8px 20px -14px rgba(0,0,0,.16);--radius:14px}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:"IBM Plex Sans Thai",sans-serif;-webkit-font-smoothing:antialiased}button,input,select,textarea{font:inherit}button{cursor:pointer}.shell{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:232px;background:var(--surface);color:var(--ink);border-right:1px solid var(--line);padding:24px 16px;z-index:20}.brand{display:flex;align-items:center;gap:10px;padding:0 8px 28px;font-family:Kanit;font-size:16px}.brand b{color:var(--red)}.logo{display:grid;place-items:center;width:34px;height:34px;background:#fff;border:2px solid var(--ink);border-radius:6px;box-shadow:1px 1px 0 var(--ink);font:700 18px Kanit}.nav{display:grid;gap:2px}.nav button{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:0;border-radius:10px;background:transparent;color:var(--muted);text-align:left;font-size:14px}.nav button.active{background:var(--ink);color:#fff}.nav button:hover:not(.active){background:#f0efec;color:var(--ink)}.content{margin-left:232px;padding:32px 40px 80px;max-width:1212px}.topbar{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:24px}.eyebrow{margin:0 0 3px;color:var(--red);font-size:12px;font-weight:600}.title{font:600 clamp(24px,4vw,28px) Kanit;margin:0;line-height:1.2}.subtitle{margin:4px 0 0;color:var(--muted);font-size:13.5px}.actions{display:flex;gap:8px;flex-wrap:wrap}.button{border:1px solid var(--ink);border-radius:9px;background:var(--ink);color:#fff;padding:9px 16px;font-size:13.5px;font-weight:500}.button.secondary{background:#fff;color:var(--ink);border-color:var(--line)}.button.danger{background:#fff;color:var(--red);border-color:#ffd6d2}.button.icon{width:40px;height:40px;padding:0;display:grid;place-items:center}.grid{display:grid;gap:14px}.metrics{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:28px}.metric,.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--radius)}.metric{padding:16px;background:var(--surface)}.metric small{color:var(--muted);font-size:12px}.metric strong{font:600 26px Kanit;display:block;margin-top:2px}.metric .unit{font:500 14px "IBM Plex Sans Thai";color:var(--muted)}.panel{padding:18px;margin-bottom:20px}.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}.panel h2{font:600 16px Kanit;margin:0}.class-grid{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}.class-card{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:14px;padding:18px;background:#fff;text-align:left;transition:.12s}.class-card:hover{border-color:#c9c7c2}.tile{position:relative;flex:0 0 44px;height:44px;display:grid;place-items:center;border:2px solid var(--ink);border-radius:6px;background:#fff;font:700 19px Kanit;box-shadow:1.5px 1.5px 0 var(--ink)}.tile sup{position:absolute;right:3px;bottom:1px;font:600 7px Kanit;color:var(--muted)}.class-card h3{font:600 16px Kanit;margin:0 0 3px}.class-card p{margin:0;color:var(--muted);font-size:12.5px}.today-list{display:grid;gap:8px}.today-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:10px}.time{font:600 13px Kanit;color:var(--muted);width:48px}.grow{flex:1}.grow b{display:block}.muted{color:var(--muted)}.page{display:none}.page.active{display:block}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}.field{display:grid;gap:5px}.field label{font-size:12.5px;color:var(--muted);font-weight:600}.input{min-height:40px;border:1px solid var(--line);border-radius:8px;padding:8px 11px;background:#fff;color:var(--ink);outline:none}.input:focus{border-color:var(--red);box-shadow:0 0 0 2px #ffd6d2}.select-wide{min-width:220px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}.table{width:100%;border-collapse:collapse;background:#fff}.table th,.table td{padding:10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}.table th{font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);background:var(--surface)}.table tr:last-child td{border:0}.name-cell button{border:0;background:none;padding:0;color:var(--ink);font-weight:600;text-decoration:underline;text-decoration-color:#ccc;text-underline-offset:3px}.status-group{display:flex;gap:6px}.status{border:1px solid var(--line);border-radius:8px;background:#fff;padding:6px 11px;font-size:12.5px;color:var(--muted)}.status.selected{background:var(--ink);color:#fff;border-color:var(--ink)}.status[data-value="late"].selected{background:var(--red-soft);color:var(--red);border-color:#ffd6d2}.status[data-value="absent"].selected{background:var(--red);color:#fff;border-color:var(--red)}.badge{display:inline-flex;padding:4px 9px;border-radius:999px;background:#eee;font-size:12px}.badge.red{background:var(--red-soft);color:var(--red)}.empty{padding:40px 24px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:14px}.modal{position:fixed;inset:0;background:#14131266;display:none;place-items:center;padding:18px;z-index:100}.modal.open{display:grid}.modal-card{width:min(560px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 20px 50px -12px #0006}.modal-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:16px}.modal h2{font:600 18px Kanit;margin:0}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}.form-grid .full{grid-column:1/-1}.days{display:flex;gap:6px;flex-wrap:wrap}.day{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 10px}.day.selected{background:var(--ink);color:#fff}.close{border:0;background:#eee;border-radius:50%;width:34px;height:34px}.toast{position:fixed;left:50%;bottom:22px;z-index:200;background:var(--ink);color:#fff;border-radius:9px;padding:10px 18px;transform:translate(-50%,70px);opacity:0;transition:.2s}.toast.show{transform:translate(-50%,-4px);opacity:1}.login{position:fixed;inset:0;background:#f5f5f3;display:none;place-items:center;padding:20px;z-index:300}.login.open{display:grid}.login-card{width:min(400px,100%);background:#fff;border:1px solid var(--line);border-radius:16px;padding:30px}.login-card .tile{margin-bottom:20px}.login-card h1{font:600 26px Kanit;margin:0}.login-card form{display:grid;gap:12px;margin-top:22px}.history-list,.lesson-list{display:grid;gap:8px}.history-row,.lesson-card{display:grid;grid-template-columns:1fr auto;gap:10px;padding:12px;border:1px solid var(--line);border-radius:12px}.history-row p,.lesson-card p{margin:0}.lesson-body{grid-column:1/-1;color:var(--muted);font-size:13px;display:grid;gap:6px}.stats-mini{grid-template-columns:repeat(5,1fr);margin-bottom:18px}.stats-mini div{text-align:center;padding:11px 6px;border:1px solid var(--line);border-radius:12px}.stats-mini b{display:block;font:600 20px Kanit}.bottom-nav{display:none}.spinner{width:18px;height:18px;border:2px solid #ccc;border-top-color:#111;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
    @media(max-width:800px){.sidebar{display:none}.content{margin:0;padding:20px 16px calc(90px + env(safe-area-inset-bottom));max-width:none}.topbar{display:block}.actions{margin-top:16px}.metrics{grid-template-columns:1fr 1fr}.panel{padding:16px}.bottom-nav{position:fixed;display:grid;grid-template-columns:repeat(5,1fr);inset:auto 0 0;z-index:50;background:#fafafaf2;border-top:1px solid var(--line);padding:7px 4px calc(7px + env(safe-area-inset-bottom));backdrop-filter:blur(18px)}.bottom-nav button{border:0;background:none;color:var(--muted);padding:5px 2px;font-size:10.5px}.bottom-nav button.active{color:var(--ink);font-weight:600}.bottom-nav span{display:block;font-size:18px}.form-grid{grid-template-columns:1fr}.status-group{min-width:300px}.stats-mini{grid-template-columns:repeat(2,1fr)}.stats-mini div:last-child{grid-column:1/-1}}
    @media(max-width:430px){.metrics{grid-template-columns:1fr}.metrics .metric:last-child{grid-column:auto}.class-grid{grid-template-columns:1fr}.select-wide{width:100%}.button{flex:1}.toolbar .field{width:100%}}
  </style>
</head>
<body>
<div class="shell">
  <aside class="sidebar"><div class="brand"><span class="logo">/</span><span>/sorasukt <b>Classroom</b></span></div><nav class="nav" id="desktopNav"></nav></aside>
  <main class="content">
    <section class="page active" data-page="dashboard"><header class="topbar"><div><p class="eyebrow" id="todayLabel">วันนี้</p><h1 class="title">ภาพรวมชั้นเรียน</h1><p class="subtitle">สิ่งสำคัญสำหรับการสอนของคุณในวันนี้</p></div><div class="actions"><button class="button secondary" onclick="openModal('classroomModal')">+ ห้องเรียน</button><button class="button" onclick="goAttendance()">เช็คชื่อวันนี้</button><button class="button secondary" onclick="logout()">ออกจากระบบ</button></div></header><div class="grid metrics" id="metrics"></div><section class="panel"><div class="panel-head"><h2>คาบเรียนวันนี้</h2><span class="muted" id="todayCount"></span></div><div class="today-list" id="todayClasses"></div></section><section class="panel"><div class="panel-head"><h2>ห้องเรียน</h2><button class="button secondary" onclick="navigate('classrooms')">ดูทั้งหมด</button></div><div class="grid class-grid" id="dashboardClasses"></div></section></section>
    <section class="page" data-page="classrooms"><header class="topbar"><div><p class="eyebrow">จัดการข้อมูล</p><h1 class="title">ห้องเรียนและนักเรียน</h1><p class="subtitle">เพิ่มรายชื่อ ดูสถิติ และเปิดประวัติรายบุคคล</p></div><button class="button" onclick="openModal('classroomModal')">+ สร้างห้องเรียน</button></header><div class="grid class-grid" id="allClasses"></div><section class="panel" id="studentPanel" style="margin-top:20px;display:none"><div class="panel-head"><div><h2 id="studentPanelTitle">รายชื่อนักเรียน</h2><span class="muted" id="studentCount"></span></div><button class="button" onclick="openStudentModal()">+ นักเรียน</button></div><div class="table-wrap"><table class="table"><thead><tr><th>เลขที่</th><th>ชื่อ-นามสกุล</th><th>มา</th><th>สาย</th><th>ขาด</th><th>ลา</th><th>เข้าเรียน</th><th></th></tr></thead><tbody id="studentRows"></tbody></table></div></section></section>
    <section class="page" data-page="attendance"><header class="topbar"><div><p class="eyebrow">บันทึกประจำวัน</p><h1 class="title">เช็คชื่อ</h1><p class="subtitle">แตะสถานะเพื่อบันทึก มา สาย ขาด หรือลา</p></div><div class="actions"><button class="button secondary" onclick="shareDaily()">แชร์ LINE</button><button class="button danger" onclick="saveAttendance()">บันทึกการเช็คชื่อ</button></div></header><div class="toolbar"><div class="field"><label>ห้องเรียน</label><select class="input select-wide" id="attendanceClass" onchange="loadAttendance()"></select></div><div class="field"><label>วันที่</label><input class="input" type="date" id="attendanceDate" onchange="loadAttendance()"></div><div class="field"><label>&nbsp;</label><button class="button secondary" onclick="markAllPresent()">ทำเครื่องหมาย “มา” ทั้งหมด</button></div></div><section class="panel"><div class="panel-head"><h2 id="attendanceTitle">รายชื่อ</h2><span class="muted" id="attendanceSummary"></span></div><div class="table-wrap"><table class="table"><thead><tr><th>เลขที่</th><th>ชื่อ-นามสกุล</th><th>สถานะ</th></tr></thead><tbody id="attendanceRows"></tbody></table></div></section></section>
    <section class="page" data-page="lessons"><header class="topbar"><div><p class="eyebrow">เตรียมการสอน</p><h1 class="title">แผนการสอน</h1><p class="subtitle">บันทึกหัวข้อ จุดประสงค์ สื่อ และหมายเหตุของแต่ละคาบ</p></div><button class="button" onclick="openLessonModal()">+ เพิ่มแผนการสอน</button></header><div class="toolbar"><div class="field"><label>ห้องเรียน</label><select class="input select-wide" id="lessonClass" onchange="loadLessons()"></select></div></div><div class="lesson-list" id="lessonList"></div></section>
    <section class="page" data-page="reports"><header class="topbar"><div><p class="eyebrow">ข้อมูลย้อนหลัง</p><h1 class="title">รายงานและส่งออก</h1><p class="subtitle">ดาวน์โหลดรายชื่อและประวัติทั้งหมดเป็น CSV สำหรับ Excel</p></div></header><section class="panel"><div class="panel-head"><h2>ส่งออก CSV</h2><span class="badge">UTF-8 + BOM</span></div><div class="toolbar"><div class="field"><label>ห้องเรียน</label><select class="input select-wide" id="reportClass"></select></div><div class="field"><label>ตั้งแต่วันที่</label><input class="input" type="date" id="reportFrom"></div><div class="field"><label>ถึงวันที่</label><input class="input" type="date" id="reportTo"></div></div><button class="button" onclick="downloadCsv()">ดาวน์โหลดไฟล์ CSV</button></section><section class="panel"><div class="panel-head"><h2>การแชร์ข้อมูล</h2></div><p class="muted">ลิงก์สรุปรายวันจะแสดงเฉพาะจำนวนและรายชื่อนักเรียนที่ต้องติดตาม โดยมีอายุ 30 วัน ไม่แสดงข้อมูลสถิติย้อนหลังทั้งหมด</p><button class="button secondary" onclick="navigate('attendance')">ไปที่หน้าเช็คชื่อและแชร์</button></section></section>
  </main>
</div>
<nav class="bottom-nav" id="mobileNav"></nav>
<div class="modal" id="classroomModal"><form class="modal-card" onsubmit="createClassroom(event)"><div class="modal-head"><h2>สร้างห้องเรียน</h2><button type="button" class="close" onclick="closeModal('classroomModal')">×</button></div><div class="form-grid"><div class="field full"><label>ชื่อห้องเรียน</label><input class="input" name="name" placeholder="เช่น ภาษาอังกฤษ ม.2/1" required></div><div class="field"><label>รหัสวิชา/ห้อง</label><input class="input" name="code" placeholder="EN2-1"></div><div class="field"><label>สถานที่</label><input class="input" name="room" placeholder="ห้อง 421"></div><div class="field"><label>เวลาเริ่ม</label><input class="input" name="start_time" type="time"></div><div class="field full"><label>วันที่เรียน</label><div class="days" id="dayPicker"></div><input type="hidden" name="schedule_days"></div><button class="button full" type="submit">บันทึกห้องเรียน</button></div></form></div>
<div class="modal" id="studentModal"><form class="modal-card" onsubmit="createStudent(event)"><div class="modal-head"><h2>เพิ่มนักเรียน</h2><button type="button" class="close" onclick="closeModal('studentModal')">×</button></div><div class="form-grid"><div class="field"><label>เลขที่</label><input class="input" name="student_no" inputmode="numeric"></div><div class="field"><label>ชื่อ-นามสกุล</label><input class="input" name="name" required></div><div class="field full"><label>หมายเหตุ (ถ้ามี)</label><input class="input" name="note"></div><button class="button full">เพิ่มรายชื่อ</button></div></form></div>
<div class="modal" id="historyModal"><div class="modal-card"><div class="modal-head"><div><h2 id="historyName">ประวัติรายบุคคล</h2><span class="muted" id="historyClass"></span></div><button class="close" onclick="closeModal('historyModal')">×</button></div><div class="grid stats-mini" id="historyStats"></div><div class="history-list" id="historyList"></div></div></div>
<div class="modal" id="lessonModal"><form class="modal-card" onsubmit="saveLesson(event)"><div class="modal-head"><h2 id="lessonModalTitle">เพิ่มแผนการสอน</h2><button type="button" class="close" onclick="closeModal('lessonModal')">×</button></div><input type="hidden" name="id"><div class="form-grid"><div class="field"><label>วันที่สอน</label><input class="input" type="date" name="lesson_date" required></div><div class="field"><label>หัวข้อบทเรียน</label><input class="input" name="topic" placeholder="เช่น Giving Directions" required></div><div class="field full"><label>จุดประสงค์การเรียนรู้</label><textarea class="input" name="objectives" rows="3" placeholder="นักเรียนสามารถ..."></textarea></div><div class="field full"><label>สื่อ/อุปกรณ์</label><textarea class="input" name="materials" rows="2" placeholder="สไลด์ ใบงาน วิดีโอ..."></textarea></div><div class="field full"><label>หมายเหตุ</label><textarea class="input" name="notes" rows="2"></textarea></div><button class="button full">บันทึกแผนการสอน</button></div></form></div>
<div class="login" id="login"><div class="login-card"><span class="tile">/</span><h1>/sorasukt Classroom</h1><p class="muted">เข้าสู่ระบบอย่างปลอดภัยด้วยบัญชี Auth0 ของคุณ</p><button class="button" style="width:100%;margin-top:20px" onclick="beginLogin()">เข้าสู่ระบบด้วย Auth0</button><p class="muted" id="loginError"></p></div></div>
<div class="toast" id="toast"></div>
<script>
const state={classrooms:[],selectedClass:0,students:[],attendance:[],lessons:[]};
const navItems=[['dashboard','●','หน้าหลัก'],['classrooms','■','ห้องเรียน'],['attendance','✓','เช็คชื่อ'],['lessons','✎','แผนการสอน'],['reports','▤','รายงาน']];
const statusLabels={present:'มา',late:'สาย',absent:'ขาด',leave:'ลา'};
document.getElementById('desktopNav').innerHTML=navItems.map(([id,icon,label])=>'<button data-nav="'+id+'" onclick="navigate(\''+id+'\')"><span>'+icon+'</span>'+label+'</button>').join('');
document.getElementById('mobileNav').innerHTML=navItems.map(([id,icon,label])=>'<button data-nav="'+id+'" onclick="navigate(\''+id+'\')"><span>'+icon+'</span>'+label+'</button>').join('');
document.getElementById('dayPicker').innerHTML=['อา','จ','อ','พ','พฤ','ศ','ส'].map((d,i)=>'<button type="button" class="day" data-day="'+i+'" onclick="this.classList.toggle(\'selected\')">'+d+'</button>').join('');
document.getElementById('attendanceDate').value=localDate();document.getElementById('reportTo').value=localDate();const f=new Date();f.setDate(f.getDate()-30);document.getElementById('reportFrom').value=f.toLocaleDateString('en-CA');

async function api(path,options={}){const response=await fetch(path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});const data=await response.json();if(response.status===401){document.getElementById('login').classList.add('open');throw new Error('กรุณาเข้าสู่ระบบ')}if(!response.ok)throw new Error(data.error||'เกิดข้อผิดพลาด');return data}
async function init(){const authError=new URLSearchParams(location.search).get('auth_error');if(authError){document.getElementById('loginError').textContent=authError;history.replaceState({},'',location.pathname)}try{await api('/api/session');await api('/api/bootstrap');await Promise.all([loadDashboard(),loadClassrooms()]);document.getElementById('login').classList.remove('open');navigate('dashboard')}catch(e){if(!String(e.message).includes('เข้าสู่ระบบ')){document.getElementById('login').classList.add('open');document.getElementById('loginError').textContent=e.message}}}
function beginLogin(){location.href='/api/auth/login'}
function logout(){location.href='/api/auth/logout'}
function navigate(page){document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.dataset.page===page));document.querySelectorAll('[data-nav]').forEach(x=>x.classList.toggle('active',x.dataset.nav===page));if(page==='attendance'&&!state.attendance.length)loadAttendance();if(page==='lessons')loadLessons();window.scrollTo({top:0})}
async function loadDashboard(){const d=await api('/api/dashboard');document.getElementById('todayLabel').textContent=new Intl.DateTimeFormat('th-TH',{dateStyle:'full'}).format(new Date(d.date+'T12:00:00+07:00'));document.getElementById('metrics').innerHTML=metric('ห้องเรียนทั้งหมด',d.classrooms,'ห้อง')+metric('นักเรียนทั้งหมด',d.students,'คน')+metric('อัตราเข้าเรียน 14 วัน',d.attendanceRate,'%')+metric('แผนการสอน',d.lessons,'แผน');document.getElementById('todayCount').textContent=d.todayClasses.length+' คาบ';document.getElementById('todayClasses').innerHTML=d.todayClasses.length?d.todayClasses.map(c=>'<div class="today-row"><span class="time">'+esc(c.start_time||'—')+'</span><span class="tile">'+esc(tileLetter(c.name))+'<sup>'+c.student_count+'</sup></span><div class="grow"><b>'+esc(c.name)+'</b><span class="muted">'+esc(c.room||'ไม่ระบุห้อง')+'</span></div><button class="button secondary" onclick="openAttendance('+c.id+')">เช็คชื่อ</button></div>').join(''):'<div class="empty">วันนี้ยังไม่มีคาบเรียนในตาราง</div>'}
function metric(label,value,unit){return '<article class="metric"><small>'+label+'</small><strong>'+value+' <span class="unit">'+unit+'</span></strong></article>'}
async function loadClassrooms(){state.classrooms=await api('/api/classrooms');const html=state.classrooms.length?state.classrooms.map(classCard).join(''):'<div class="empty">ยังไม่มีห้องเรียน เริ่มต้นด้วยการสร้างห้องแรก</div>';document.getElementById('dashboardClasses').innerHTML=html;document.getElementById('allClasses').innerHTML=html;const options=state.classrooms.map(c=>'<option value="'+c.id+'">'+esc(c.name)+'</option>').join('');['attendanceClass','lessonClass','reportClass'].forEach(id=>{const el=document.getElementById(id);const old=el.value;el.innerHTML=options;if(old)el.value=old});if(!state.selectedClass&&state.classrooms[0])state.selectedClass=state.classrooms[0].id}
function classCard(c){return '<button class="class-card" onclick="selectClass('+c.id+')"><span class="tile">'+esc(tileLetter(c.name))+'<sup>'+c.student_count+'</sup></span><span><h3>'+esc(c.name)+'</h3><p>'+esc(c.code||'ไม่มีรหัส')+' · '+esc(c.room||'ไม่ระบุห้อง')+'</p><p>'+scheduleText(c)+'</p></span></button>'}
function tileLetter(name){return Array.from(String(name).trim())[0]||'C'}
function scheduleText(c){const names=['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'];const days=String(c.schedule_days||'').split(',').filter(Boolean).map(x=>names[+x]).join(' ');return (days||'ยังไม่กำหนดวัน')+(c.start_time?' · '+c.start_time:'')}
async function selectClass(id){state.selectedClass=id;navigate('classrooms');await loadStudents(id);document.getElementById('studentPanel').scrollIntoView({behavior:'smooth'})}
async function loadStudents(id=state.selectedClass){const c=state.classrooms.find(x=>x.id==id);state.students=await api('/api/students?classroom_id='+id);document.getElementById('studentPanel').style.display='block';document.getElementById('studentPanelTitle').textContent=c?.name||'รายชื่อนักเรียน';document.getElementById('studentCount').textContent=state.students.length+' คน';document.getElementById('studentRows').innerHTML=state.students.length?state.students.map(s=>'<tr><td>'+esc(s.student_no||'—')+'</td><td class="name-cell"><button onclick="showHistory('+s.id+')">'+esc(s.name)+'</button></td><td>'+num(s.present_count)+'</td><td>'+num(s.late_count)+'</td><td>'+num(s.absent_count)+'</td><td>'+num(s.leave_count)+'</td><td><span class="badge '+((s.attendance_rate||0)<80?'red':'')+'">'+(s.attendance_rate??0)+'%</span></td><td><button class="status" onclick="deleteStudent('+s.id+')">ลบ</button></td></tr>').join(''):'<tr><td colspan="8" class="empty">ยังไม่มีรายชื่อนักเรียน</td></tr>'}
function openStudentModal(){if(!state.selectedClass)return toast('กรุณาเลือกห้องเรียนก่อน');openModal('studentModal')}
async function createStudent(e){e.preventDefault();const body=Object.fromEntries(new FormData(e.target));body.classroom_id=state.selectedClass;try{await api('/api/students',{method:'POST',body:JSON.stringify(body)});e.target.reset();closeModal('studentModal');await loadStudents();await loadClassrooms();toast('เพิ่มนักเรียนแล้ว')}catch(err){toast(err.message)}}
async function deleteStudent(id){if(!confirm('ลบนักเรียนและประวัติการเช็คชื่อทั้งหมดหรือไม่?'))return;await api('/api/students/'+id,{method:'DELETE'});await loadStudents();await loadClassrooms();toast('ลบข้อมูลแล้ว')}
async function createClassroom(e){e.preventDefault();const form=new FormData(e.target);const body=Object.fromEntries(form);body.schedule_days=[...document.querySelectorAll('#dayPicker .selected')].map(x=>x.dataset.day).join(',');try{await api('/api/classrooms',{method:'POST',body:JSON.stringify(body)});e.target.reset();document.querySelectorAll('#dayPicker .selected').forEach(x=>x.classList.remove('selected'));closeModal('classroomModal');await Promise.all([loadClassrooms(),loadDashboard()]);toast('สร้างห้องเรียนแล้ว')}catch(err){toast(err.message)}}
function goAttendance(){navigate('attendance');loadAttendance()}
function openAttendance(id){document.getElementById('attendanceClass').value=id;navigate('attendance');loadAttendance()}
async function loadAttendance(){const id=document.getElementById('attendanceClass').value||state.classrooms[0]?.id;if(!id){document.getElementById('attendanceRows').innerHTML='<tr><td colspan="3" class="empty">กรุณาสร้างห้องเรียนก่อน</td></tr>';return}const date=document.getElementById('attendanceDate').value||localDate();const data=await api('/api/attendance?classroom_id='+id+'&date='+date);state.attendance=data.students.map(s=>({...s}));document.getElementById('attendanceTitle').textContent=data.classroom.name;renderAttendance()}
function renderAttendance(){const counts={present:0,late:0,absent:0,leave:0,unmarked:0};state.attendance.forEach(s=>counts[s.status||'unmarked']++);document.getElementById('attendanceSummary').textContent='มา '+counts.present+' · สาย '+counts.late+' · ขาด '+counts.absent+' · ลา '+counts.leave+' · ยังไม่บันทึก '+counts.unmarked;document.getElementById('attendanceRows').innerHTML=state.attendance.length?state.attendance.map(s=>'<tr><td>'+esc(s.student_no||'—')+'</td><td><b>'+esc(s.name)+'</b>'+(s.status&&s.status!=='present'?'<br><button class="status" style="margin-top:6px" onclick="shareIndividual('+s.id+')">แจ้งผ่าน LINE</button>':'')+'</td><td><div class="status-group">'+Object.entries(statusLabels).map(([value,label])=>'<button class="status '+(s.status===value?'selected':'')+'" data-value="'+value+'" onclick="setStatus('+s.id+',\''+value+'\')">'+label+'</button>').join('')+'</div></td></tr>').join(''):'<tr><td colspan="3" class="empty">ห้องเรียนนี้ยังไม่มีนักเรียน</td></tr>'}
function setStatus(id,status){const student=state.attendance.find(x=>x.id===id);if(student)student.status=status;renderAttendance()}
function markAllPresent(){state.attendance.forEach(s=>s.status='present');renderAttendance()}
async function saveAttendance(){const body={classroom_id:+document.getElementById('attendanceClass').value,date:document.getElementById('attendanceDate').value,records:state.attendance.map(s=>({student_id:s.id,status:s.status,note:s.attendance_note||''}))};try{const r=await api('/api/attendance',{method:'POST',body:JSON.stringify(body)});toast('บันทึกแล้ว '+r.saved+' คน');loadDashboard();return true}catch(err){toast(err.message);return false}}
async function shareDaily(){if(!document.getElementById('attendanceClass').value)return toast('กรุณาเลือกห้องเรียน');if(state.attendance.some(s=>!s.status))return toast('กรุณาบันทึกสถานะให้ครบทุกคนก่อนแชร์');try{if(!await saveAttendance())return;const result=await api('/api/share',{method:'POST',body:JSON.stringify({classroom_id:+document.getElementById('attendanceClass').value,date:document.getElementById('attendanceDate').value})});window.open(result.lineUrl,'_blank','noopener')}catch(err){toast(err.message)}}
function shareIndividual(id){const student=state.attendance.find(x=>x.id===id);const classroom=state.classrooms.find(x=>x.id==document.getElementById('attendanceClass').value);if(!student)return;const message='แจ้งการเข้าเรียน: '+student.name+'\nห้องเรียน: '+(classroom?.name||'')+'\nวันที่: '+thaiDate(document.getElementById('attendanceDate').value)+'\nสถานะ: '+statusLabels[student.status];window.open('https://line.me/R/share?text='+encodeURIComponent(message),'_blank','noopener')}
async function showHistory(id){openModal('historyModal');document.getElementById('historyList').innerHTML='<div class="empty"><span class="spinner"></span></div>';try{const d=await api('/api/students/'+id+'/history');document.getElementById('historyName').textContent=d.student.name;document.getElementById('historyClass').textContent=d.student.classroom_name+' · เลขที่ '+(d.student.student_no||'—');const s=d.stats||{};document.getElementById('historyStats').innerHTML=[['มา',s.present],['สาย',s.late],['ขาด',s.absent],['ลา',s.leave],['เข้าเรียน',(s.rate??0)+'%']].map(x=>'<div><b>'+num(x[1])+'</b><span class="muted">'+x[0]+'</span></div>').join('');document.getElementById('historyList').innerHTML=d.history.length?d.history.map(h=>'<div class="history-row"><p><b>'+thaiDate(h.session_date)+'</b><br><span class="muted">'+esc(h.note||'ไม่มีหมายเหตุ')+'</span></p><span class="badge '+(h.status==='absent'||h.status==='late'?'red':'')+'">'+statusLabels[h.status]+'</span></div>').join(''):'<div class="empty">ยังไม่มีประวัติการเช็คชื่อ</div>'}catch(err){toast(err.message)}}
async function loadLessons(){const id=document.getElementById('lessonClass').value||state.classrooms[0]?.id;const list=document.getElementById('lessonList');if(!id){list.innerHTML='<div class="empty">กรุณาสร้างห้องเรียนก่อนเพิ่มแผนการสอน</div>';return}try{state.lessons=await api('/api/lessons?classroom_id='+id);list.innerHTML=state.lessons.length?state.lessons.map(l=>'<article class="lesson-card"><div><span class="eyebrow">'+thaiDate(l.lesson_date)+'</span><h3>'+esc(l.topic)+'</h3></div><div><button class="status" onclick="editLesson('+l.id+')">แก้ไข</button> <button class="status" onclick="deleteLesson('+l.id+')">ลบ</button></div><div class="lesson-body">'+(l.objectives?'<p><b>จุดประสงค์</b><br>'+esc(l.objectives)+'</p>':'')+(l.materials?'<p><b>สื่อ/อุปกรณ์</b><br>'+esc(l.materials)+'</p>':'')+(l.notes?'<p><b>หมายเหตุ</b><br>'+esc(l.notes)+'</p>':'')+'</div></article>').join(''):'<div class="empty"><h3>ยังไม่มีแผนการสอน</h3><p>เพิ่มแผนแรกสำหรับห้องเรียนนี้ได้เลย</p></div>'}catch(err){toast(err.message)}}
function openLessonModal(){const classroomId=document.getElementById('lessonClass').value||state.classrooms[0]?.id;if(!classroomId)return toast('กรุณาสร้างห้องเรียนก่อน');const form=document.querySelector('#lessonModal form');form.reset();form.elements.id.value='';form.elements.lesson_date.value=localDate();document.getElementById('lessonModalTitle').textContent='เพิ่มแผนการสอน';openModal('lessonModal')}
function editLesson(id){const lesson=state.lessons.find(x=>x.id===id);if(!lesson)return;const form=document.querySelector('#lessonModal form');['id','lesson_date','topic','objectives','materials','notes'].forEach(name=>form.elements[name].value=lesson[name]||'');document.getElementById('lessonModalTitle').textContent='แก้ไขแผนการสอน';openModal('lessonModal')}
async function saveLesson(e){e.preventDefault();const body=Object.fromEntries(new FormData(e.target));body.classroom_id=+document.getElementById('lessonClass').value;try{await api('/api/lessons',{method:'POST',body:JSON.stringify(body)});closeModal('lessonModal');await Promise.all([loadLessons(),loadDashboard()]);toast('บันทึกแผนการสอนแล้ว')}catch(err){toast(err.message)}}
async function deleteLesson(id){if(!confirm('ลบแผนการสอนนี้หรือไม่?'))return;try{await api('/api/lessons/'+id,{method:'DELETE'});await Promise.all([loadLessons(),loadDashboard()]);toast('ลบแผนการสอนแล้ว')}catch(err){toast(err.message)}}
function downloadCsv(){const id=document.getElementById('reportClass').value;if(!id)return toast('กรุณาเลือกห้องเรียน');const query=new URLSearchParams({classroom_id:id,from:document.getElementById('reportFrom').value,to:document.getElementById('reportTo').value});location.href='/api/export.csv?'+query}
function openModal(id){document.getElementById(id).classList.add('open')}function closeModal(id){document.getElementById(id).classList.remove('open')}
function toast(message){const el=document.getElementById('toast');el.textContent=message;el.classList.add('show');clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('show'),2600)}
function esc(v){const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML}function num(v){return Number(v)||0}function localDate(){return new Date().toLocaleDateString('en-CA')}function thaiDate(v){return new Intl.DateTimeFormat('th-TH',{dateStyle:'long'}).format(new Date(v+'T12:00:00+07:00'))}
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open')}));init();
</script>
</body></html>`;
