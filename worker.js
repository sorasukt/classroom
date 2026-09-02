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
      return json({ error: "Classroom by /sorasukt API", health: `${url.origin}/api/health` }, 404);
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

  const session = await authorize(request, env);
  if (!session) return json({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const auth = await resolveSchoolAccess(env.DB, session);
  if (path === "/api/session" && method === "GET") return json({ user: auth });
  if (auth.schoolDomain && !auth.schoolAccess) {
    return json({ error: auth.schoolVerified ? "อีเมลนี้ยังไม่ได้รับสิทธิ์จาก Admin ของโรงเรียน" : "กรุณายืนยันอีเมลโรงเรียนก่อนเข้าใช้งาน", code: "SCHOOL_ACCESS_REQUIRED" }, 403);
  }

  if (path === "/api/bootstrap" && method === "GET") return bootstrap(env.DB, auth);
  if (path === "/api/dashboard" && method === "GET") return dashboard(env.DB, auth);
  if (path === "/api/classrooms" && method === "GET") return listClassrooms(env.DB, auth);
  if (path === "/api/classrooms" && method === "POST") return createClassroom(request, env, ctx, auth);
  if (/^\/api\/classrooms\/\d+$/.test(path) && method === "DELETE") {
    return deleteClassroom(env, ctx, Number(path.split("/").pop()), auth);
  }
  if (path === "/api/students" && method === "GET") return listStudents(env.DB, url, auth);
  if (path === "/api/students" && method === "POST") return createStudent(request, env, ctx, auth);
  if (/^\/api\/students\/\d+$/.test(path) && method === "DELETE") {
    return deleteStudent(env, ctx, Number(path.split("/").pop()), auth);
  }
  if (/^\/api\/students\/\d+\/history$/.test(path) && method === "GET") {
    return studentHistory(env.DB, Number(path.split("/")[3]), auth);
  }
  if (path === "/api/attendance" && method === "GET") return getAttendance(env.DB, url, auth);
  if (path === "/api/attendance" && method === "POST") return saveAttendance(request, env, ctx, auth);
  if (path === "/api/lessons" && method === "GET") return listLessons(env.DB, url, auth);
  if (path === "/api/lessons" && method === "POST") return saveLesson(request, env, ctx, auth);
  if (/^\/api\/lessons\/\d+$/.test(path) && method === "DELETE") {
    return deleteLesson(env, ctx, Number(path.split("/").pop()), auth);
  }
  if (path === "/api/share" && method === "POST") return createShare(request, env, ctx, url.origin, auth);
  if (path === "/api/reports/summary" && method === "GET") return reportSummary(env.DB, url, auth);
  if (path === "/api/export.csv" && method === "GET") return exportCsv(env, ctx, url, auth);
  if (path === "/api/branding" && method === "GET") return brandingContext(env.DB, auth);
  if (path === "/api/branding/logo" && method === "GET") return brandingLogo(env, url, auth);
  if (path === "/api/admin" && method === "GET") return adminContext(env.DB, auth);
  if (path === "/api/admin/settings" && method === "POST") return saveAdminSettings(request, env, ctx, auth);
  if (path === "/api/admin/logo" && method === "POST") return uploadSchoolLogo(request, env, ctx, auth);
  if (path === "/api/admin/logo" && method === "DELETE") return deleteSchoolLogo(env, ctx, url, auth);
  if (path === "/api/admin/student-template.csv" && method === "GET") return studentTemplate(auth);
  if (path === "/api/admin/import/students" && method === "POST") return importStudents(request, env, ctx, auth);
  if (path === "/api/admin/members" && method === "GET") return listSchoolMembers(env.DB, auth);
  if (path === "/api/admin/members" && method === "POST") return saveSchoolMember(request, env, ctx, auth);
  if (/^\/api\/admin\/members\/\d+$/.test(path) && method === "DELETE") {
    return deleteSchoolMember(env, ctx, Number(path.split("/").pop()), auth);
  }

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
  const session = buildAuthContext({
    sub: clean(profile.sub, 180),
    name: clean(profile.name || profile.nickname || profile.email, 180),
    email: clean(profile.email, 254),
    emailVerified: profile.email_verified === true,
    picture: clean(profile.picture, 500),
    roles: extractRoles(profile),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  });
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
    return buildAuthContext(session);
  } catch {
    return false;
  }
}

function extractRoles(profile) {
  const candidates = [
    profile?.["https://classroom.sorasukt.com/roles"],
    profile?.["https://sorasukt.com/roles"],
    profile?.roles,
  ];
  return [...new Set(candidates.flatMap((value) => Array.isArray(value) ? value : []).map((role) => clean(role, 80)).filter(Boolean))];
}

function buildAuthContext(session) {
  const email = clean(session?.email, 254).toLowerCase();
  const domain = email.includes("@") ? email.split("@").pop() : "";
  const schoolDomain = /^[a-z0-9.-]+\.ac\.th$/i.test(domain);
  const schoolVerified = !schoolDomain || session?.emailVerified === true;
  const roles = Array.isArray(session?.roles) ? session.roles.map((role) => clean(role, 80)).filter(Boolean) : [];
  const auth0Admin = roles.some((role) => role.toLowerCase() === "admin");
  const sub = clean(session?.sub, 180);
  return {
    ...session,
    sub,
    email,
    domain,
    schoolDomain,
    roles,
    auth0Admin,
    isAdmin: auth0Admin,
    schoolVerified,
    schoolAccess: !schoolDomain,
    canManageRoster: !schoolDomain || (schoolVerified && auth0Admin),
    tenantKey: schoolDomain && schoolVerified ? `school:${domain}` : `user:${sub}`,
  };
}

async function resolveSchoolAccess(db, auth) {
  if (!auth.schoolDomain) return { ...auth, schoolAccess: true, canManageRoster: true };
  if (!auth.schoolVerified) return { ...auth, schoolAccess: false, isAdmin: false, canManageRoster: false };
  if (auth.auth0Admin) {
    await db.prepare(`INSERT INTO school_members(tenant_key,email,role,active,created_by,updated_at) VALUES(?,?,'admin',1,?,CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_key,email) DO UPDATE SET role='admin',active=1,updated_at=CURRENT_TIMESTAMP`)
      .bind(auth.tenantKey, auth.email, auth.sub).run();
    return { ...auth, schoolAccess: true, isAdmin: true, canManageRoster: true, schoolRole: "admin" };
  }
  const member = await db.prepare("SELECT role,active FROM school_members WHERE tenant_key=? AND email=?").bind(auth.tenantKey, auth.email).first();
  const schoolAccess = Number(member?.active) === 1;
  const isAdmin = schoolAccess && member?.role === "admin";
  return { ...auth, schoolAccess, isAdmin, canManageRoster: isAdmin, schoolRole: schoolAccess ? member.role : "" };
}

function requireRosterAdmin(auth) {
  return auth.canManageRoster ? null : json({ error: "บัญชีโดเมนโรงเรียนต้องมี role Admin จึงจะเพิ่มหรือลบห้องเรียนและรายชื่อนักเรียนได้", code: "ADMIN_REQUIRED" }, 403);
}

function authConfig(env) {
  const domain = String(env.AUTH0_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!domain || !env.AUTH0_CLIENT_ID || !env.AUTH0_CLIENT_SECRET) {
    return { ok: false, error: "ยังไม่ได้ตั้งค่า Auth0 สำหรับระบบ" };
  }
  return { ok: true, issuer: `https://${domain}` };
}

function frontendUrl(env) {
  return String(env.FRONTEND_URL || "https://sorasukt.com/classroom/").replace(/\/?$/, "/");
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
    "https://sorasukt.com",
    "https://www.sorasukt.com",
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

async function bootstrap(db, auth) {
  await claimLegacyData(db, auth);
  return json({ ok: true, user: auth });
}

async function claimLegacyData(db, auth) {
  await db.prepare("INSERT OR IGNORE INTO system_meta(key,value) VALUES('legacy_tenant_owner',?)").bind(auth.tenantKey).run();
  const owner = await db.prepare("SELECT value FROM system_meta WHERE key='legacy_tenant_owner'").first();
  if (owner?.value === auth.tenantKey) {
    await db.prepare("UPDATE classrooms SET tenant_key=?,created_by=? WHERE tenant_key='' ").bind(auth.tenantKey, auth.sub).run();
  }
}

async function dashboard(db, auth) {
  const today = bangkokDate();
  const weekday = new Date(`${today}T12:00:00+07:00`).getDay();
  const [counts, rate, todayClasses] = await Promise.all([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM classrooms WHERE tenant_key=?) classrooms,
      (SELECT COUNT(*) FROM students s JOIN classrooms c ON c.id=s.classroom_id WHERE c.tenant_key=?) students,
      (SELECT COUNT(*) FROM lesson_plans l JOIN classrooms c ON c.id=l.classroom_id WHERE c.tenant_key=?) lessons`).bind(auth.tenantKey, auth.tenantKey, auth.tenantKey).first(),
    db.prepare(`SELECT ROUND(100.0 * SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id), 0), 1) rate
      FROM attendance a JOIN attendance_sessions s ON s.id=a.session_id JOIN classrooms c ON c.id=s.classroom_id
      WHERE c.tenant_key=? AND s.session_date >= date(?, '-13 day')`).bind(auth.tenantKey, today).first(),
    db.prepare(`SELECT c.*, COUNT(st.id) student_count FROM classrooms c LEFT JOIN students st ON st.classroom_id=c.id
      WHERE c.tenant_key=? AND ',' || c.schedule_days || ',' LIKE '%,' || ? || ',%' GROUP BY c.id ORDER BY c.start_time`).bind(auth.tenantKey, String(weekday)).all(),
  ]);
  return json({ ...counts, attendanceRate: rate?.rate ?? 0, todayClasses: todayClasses.results, date: today });
}

async function listClassrooms(db, auth) {
  const result = await db.prepare(`SELECT c.*, COUNT(s.id) student_count FROM classrooms c LEFT JOIN students s ON s.classroom_id=c.id
    WHERE c.tenant_key=? GROUP BY c.id ORDER BY c.created_at DESC`).bind(auth.tenantKey).all();
  return json(result.results);
}

async function createClassroom(request, env, ctx, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const name = clean(body.name, 100);
  if (!name) return json({ error: "กรุณากรอกชื่อห้องเรียน" }, 400);
  const result = await env.DB.prepare(`INSERT INTO classrooms(name, code, room, schedule_days, start_time, tenant_key, created_by) VALUES(?,?,?,?,?,?,?) RETURNING *`)
    .bind(name, clean(body.code, 30), clean(body.room, 60), normalizeDays(body.schedule_days), clean(body.start_time, 5), auth.tenantKey, auth.sub).first();
  archiveMutation(env, ctx, "classroom.created", result);
  return json(result, 201);
}

async function deleteClassroom(env, ctx, id, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const existing = await env.DB.prepare("SELECT * FROM classrooms WHERE id=? AND tenant_key=?").bind(id, auth.tenantKey).first();
  if (!existing) return json({ error: "ไม่พบห้องเรียน" }, 404);
  await env.DB.prepare("DELETE FROM classrooms WHERE id=? AND tenant_key=?").bind(id, auth.tenantKey).run();
  archiveMutation(env, ctx, "classroom.deleted", existing);
  return json({ ok: true });
}

async function listStudents(db, url, auth) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const result = await db.prepare(`SELECT s.*,
      SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) present_count,
      SUM(CASE WHEN a.status='late' THEN 1 ELSE 0 END) late_count,
      SUM(CASE WHEN a.status='absent' THEN 1 ELSE 0 END) absent_count,
      SUM(CASE WHEN a.status='leave' THEN 1 ELSE 0 END) leave_count,
      ROUND(100.0 * SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id),0),1) attendance_rate
    FROM students s JOIN classrooms c ON c.id=s.classroom_id LEFT JOIN attendance a ON a.student_id=s.id
    WHERE s.classroom_id=? AND c.tenant_key=? GROUP BY s.id
    ORDER BY CASE WHEN s.student_no='' THEN 1 ELSE 0 END, CAST(s.student_no AS INTEGER), s.name`).bind(classroomId, auth.tenantKey).all();
  return json(result.results);
}

async function createStudent(request, env, ctx, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const name = clean(body.name, 120);
  if (!classroomId || !name) return json({ error: "ข้อมูลนักเรียนไม่ครบถ้วน" }, 400);
  const classroom = await env.DB.prepare("SELECT id FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const result = await env.DB.prepare("INSERT INTO students(classroom_id, student_no, name, note) VALUES(?,?,?,?) RETURNING *")
    .bind(classroomId, clean(body.student_no, 20), name, clean(body.note, 250)).first();
  archiveMutation(env, ctx, "student.created", result);
  return json(result, 201);
}

async function deleteStudent(env, ctx, id, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const existing = await env.DB.prepare(`SELECT s.* FROM students s JOIN classrooms c ON c.id=s.classroom_id
    WHERE s.id=? AND c.tenant_key=?`).bind(id, auth.tenantKey).first();
  if (!existing) return json({ error: "ไม่พบนักเรียน" }, 404);
  await env.DB.prepare("DELETE FROM students WHERE id=?").bind(id).run();
  archiveMutation(env, ctx, "student.deleted", existing);
  return json({ ok: true });
}

async function studentHistory(db, id, auth) {
  const student = await db.prepare(`SELECT s.*, c.name classroom_name FROM students s JOIN classrooms c ON c.id=s.classroom_id
    WHERE s.id=? AND c.tenant_key=?`).bind(id, auth.tenantKey).first();
  if (!student) return json({ error: "ไม่พบนักเรียน" }, 404);
  const history = await db.prepare(`SELECT ss.session_date, a.status, a.note FROM attendance a JOIN attendance_sessions ss ON ss.id=a.session_id WHERE a.student_id=? ORDER BY ss.session_date DESC LIMIT 180`).bind(id).all();
  const stats = await db.prepare(`SELECT
      SUM(status='present') present, SUM(status='late') late, SUM(status='absent') absent, SUM(status='leave') leave,
      ROUND(100.0 * SUM(status IN ('present','late')) / NULLIF(COUNT(*),0),1) rate FROM attendance WHERE student_id=?`).bind(id).first();
  return json({ student, history: history.results, stats });
}

async function getAttendance(db, url, auth) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  const date = validDate(url.searchParams.get("date")) || bangkokDate();
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const classroom = await db.prepare("SELECT * FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const students = await db.prepare(`SELECT s.*, COALESCE(a.status,'') status, COALESCE(a.note,'') attendance_note
    FROM students s LEFT JOIN attendance_sessions ss ON ss.classroom_id=s.classroom_id AND ss.session_date=?
    LEFT JOIN attendance a ON a.session_id=ss.id AND a.student_id=s.id WHERE s.classroom_id=?
    ORDER BY CASE WHEN s.student_no='' THEN 1 ELSE 0 END, CAST(s.student_no AS INTEGER), s.name`).bind(date, classroomId).all();
  return json({ classroom, date, students: students.results });
}

async function reportSummary(db, url, auth) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  const to = validDate(url.searchParams.get("to")) || bangkokDate();
  const from = validDate(url.searchParams.get("from")) || shiftDate(to, -29);
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  if (from > to) return json({ error: "ช่วงวันที่ไม่ถูกต้อง" }, 400);
  const rangeDays = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) + 1;
  if (rangeDays > 366) return json({ error: "ดูรายงานได้ครั้งละไม่เกิน 366 วัน" }, 400);
  const classroom = await db.prepare("SELECT id,name FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const daily = await db.prepare(`SELECT ss.session_date date,
      SUM(a.status='present') present, SUM(a.status='late') late,
      SUM(a.status='absent') absent, SUM(a.status='leave') leave,
      COUNT(a.id) total,
      ROUND(100.0 * SUM(a.status IN ('present','late')) / NULLIF(COUNT(a.id),0),1) rate
    FROM attendance_sessions ss LEFT JOIN attendance a ON a.session_id=ss.id
    WHERE ss.classroom_id=? AND ss.session_date BETWEEN ? AND ?
    GROUP BY ss.id,ss.session_date ORDER BY ss.session_date`).bind(classroomId, from, to).all();
  const totals = daily.results.reduce((sum, row) => {
    for (const key of ["present", "late", "absent", "leave", "total"]) sum[key] += Number(row[key]) || 0;
    return sum;
  }, { present: 0, late: 0, absent: 0, leave: 0, total: 0 });
  totals.attended = totals.present + totals.late;
  totals.rate = totals.total ? Math.round(totals.attended * 1000 / totals.total) / 10 : 0;
  return json({ classroom, from, to, sessions: daily.results.length, totals, daily: daily.results });
}

async function saveAttendance(request, env, ctx, auth) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const date = validDate(body.date);
  if (!classroomId || !date || !Array.isArray(body.records)) return json({ error: "ข้อมูลการเช็คชื่อไม่ถูกต้อง" }, 400);
  const classroom = await env.DB.prepare("SELECT id FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const session = await env.DB.prepare(`INSERT INTO attendance_sessions(classroom_id, session_date, note) VALUES(?,?,?)
    ON CONFLICT(classroom_id,session_date) DO UPDATE SET note=excluded.note RETURNING id`).bind(classroomId, date, clean(body.note, 250)).first();
  const valid = new Set(["present", "late", "absent", "leave"]);
  const roster = await env.DB.prepare("SELECT id FROM students WHERE classroom_id=?").bind(classroomId).all();
  const allowedStudents = new Set(roster.results.map((student) => Number(student.id)));
  const records = body.records.filter((r) => allowedStudents.has(positiveInt(r.student_id)) && valid.has(r.status));
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

async function listLessons(db, url, auth) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const result = await db.prepare(`SELECT l.* FROM lesson_plans l JOIN classrooms c ON c.id=l.classroom_id
    WHERE l.classroom_id=? AND c.tenant_key=? ORDER BY l.lesson_date DESC, l.id DESC`).bind(classroomId, auth.tenantKey).all();
  return json(result.results);
}

async function saveLesson(request, env, ctx, auth) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const lessonDate = validDate(body.lesson_date);
  const topic = clean(body.topic, 180);
  if (!classroomId || !lessonDate || !topic) return json({ error: "กรุณากรอกวันที่และหัวข้อบทเรียน" }, 400);
  const classroom = await env.DB.prepare("SELECT id FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const fields = [classroomId, lessonDate, topic, clean(body.objectives, 3000), clean(body.materials, 2000), clean(body.notes, 3000)];
  const id = positiveInt(body.id);
  if (id) {
    const result = await env.DB.prepare(`UPDATE lesson_plans SET classroom_id=?,lesson_date=?,topic=?,objectives=?,materials=?,notes=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND EXISTS(SELECT 1 FROM classrooms c WHERE c.id=lesson_plans.classroom_id AND c.tenant_key=?) RETURNING *`)
      .bind(...fields, id, auth.tenantKey).first();
    if (!result) return json({ error: "ไม่พบแผนการสอน" }, 404);
    archiveMutation(env, ctx, "lesson.updated", result);
    return json(result);
  }
  const result = await env.DB.prepare(`INSERT INTO lesson_plans(classroom_id,lesson_date,topic,objectives,materials,notes) VALUES(?,?,?,?,?,?) RETURNING *`).bind(...fields).first();
  archiveMutation(env, ctx, "lesson.created", result);
  return json(result, 201);
}

async function deleteLesson(env, ctx, id, auth) {
  const existing = await env.DB.prepare(`SELECT l.* FROM lesson_plans l JOIN classrooms c ON c.id=l.classroom_id
    WHERE l.id=? AND c.tenant_key=?`).bind(id, auth.tenantKey).first();
  if (!existing) return json({ error: "ไม่พบแผนการสอน" }, 404);
  await env.DB.prepare("DELETE FROM lesson_plans WHERE id=?").bind(id).run();
  archiveMutation(env, ctx, "lesson.deleted", existing);
  return json({ ok: true });
}

async function createShare(request, env, ctx, origin, auth) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const date = validDate(body.date) || bangkokDate();
  if (!classroomId) return json({ error: "ไม่พบห้องเรียน" }, 400);
  const classroom = await env.DB.prepare("SELECT name FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
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

async function exportCsv(env, ctx, url, auth) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  const from = validDate(url.searchParams.get("from")) || "1900-01-01";
  const to = validDate(url.searchParams.get("to")) || "2999-12-31";
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const classroom = await env.DB.prepare("SELECT name FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
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

async function brandingContext(db, auth) {
  if (!auth.schoolDomain || !auth.schoolVerified || !auth.schoolAccess) {
    return json({ custom: false, organization_name: "", academic_year: "", term: "", logos: { horizontal: false, square: false } });
  }
  const settings = await db.prepare(`SELECT organization_name,academic_year,term,logo_horizontal_key,logo_square_key
    FROM tenant_settings WHERE tenant_key=?`).bind(auth.tenantKey).first();
  const custom = Boolean(settings?.organization_name);
  return json({
    custom,
    organization_name: settings?.organization_name || "",
    academic_year: settings?.academic_year || "",
    term: settings?.term || "",
    logos: {
      horizontal: custom && Boolean(settings?.logo_horizontal_key),
      square: custom && Boolean(settings?.logo_square_key),
    },
  });
}

async function brandingLogo(env, url, auth) {
  if (!auth.schoolDomain || !auth.schoolVerified || !auth.schoolAccess || !env.EXPORTS) return json({ error: "ไม่พบโลโก้" }, 404);
  const kind = url.searchParams.get("kind") === "square" ? "square" : "horizontal";
  const column = kind === "square" ? "logo_square_key" : "logo_horizontal_key";
  const settings = await env.DB.prepare(`SELECT organization_name,${column} logo_key FROM tenant_settings WHERE tenant_key=?`).bind(auth.tenantKey).first();
  if (!settings?.organization_name || !settings?.logo_key) return json({ error: "ไม่พบโลโก้" }, 404);
  const object = await env.EXPORTS.get(settings.logo_key);
  if (!object) return json({ error: "ไม่พบโลโก้" }, 404);
  const headers = new Headers({
    "content-type": object.httpMetadata?.contentType || "application/octet-stream",
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
  });
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function uploadSchoolLogo(request, env, ctx, auth) {
  const denied = requireSchoolAdmin(auth);
  if (denied) return denied;
  if (!env.EXPORTS) return json({ error: "ยังไม่ได้เชื่อมต่อพื้นที่เก็บไฟล์" }, 503);
  const settings = await env.DB.prepare("SELECT organization_name,logo_horizontal_key,logo_square_key FROM tenant_settings WHERE tenant_key=?").bind(auth.tenantKey).first();
  if (!settings?.organization_name) return json({ error: "กรุณาบันทึกข้อมูลสถานศึกษาก่อนอัปโหลดโลโก้" }, 400);
  const body = await readBody(request);
  const kind = body.kind === "square" ? "square" : body.kind === "horizontal" ? "horizontal" : "";
  const declaredMime = clean(body.mime, 80).toLowerCase();
  if (!kind) return json({ error: "ประเภทโลโก้ไม่ถูกต้อง" }, 400);
  let bytes;
  try { bytes = base64ToBytes(String(body.data || "")); } catch { return json({ error: "ไฟล์โลโก้ไม่ถูกต้อง" }, 400); }
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) return json({ error: "โลโก้ต้องมีขนาดไม่เกิน 2 MB" }, 400);
  const mime = detectImageMime(bytes);
  if (!mime || mime !== declaredMime) return json({ error: "รองรับเฉพาะ PNG, JPEG และ WebP" }, 400);
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[mime];
  const tenantHash = (await sha256Hex(auth.tenantKey)).slice(0, 24);
  const key = `branding/${tenantHash}/${kind}-${Date.now()}.${extension}`;
  await env.EXPORTS.put(key, bytes, { httpMetadata: { contentType: mime }, customMetadata: { tenant: tenantHash, kind } });
  const column = kind === "square" ? "logo_square_key" : "logo_horizontal_key";
  const oldKey = kind === "square" ? settings.logo_square_key : settings.logo_horizontal_key;
  await env.DB.prepare(`UPDATE tenant_settings SET ${column}=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_key=?`).bind(key, auth.sub, auth.tenantKey).run();
  if (oldKey && oldKey !== key) queueR2(ctx, env.EXPORTS.delete(oldKey), oldKey);
  archiveMutation(env, ctx, "school.logo.uploaded", { tenant_key: auth.tenantKey, kind, key, mime, bytes: bytes.length, updated_by: auth.sub });
  return json({ ok: true, kind });
}

async function deleteSchoolLogo(env, ctx, url, auth) {
  const denied = requireSchoolAdmin(auth);
  if (denied) return denied;
  const kind = url.searchParams.get("kind") === "square" ? "square" : url.searchParams.get("kind") === "horizontal" ? "horizontal" : "";
  if (!kind) return json({ error: "ประเภทโลโก้ไม่ถูกต้อง" }, 400);
  const column = kind === "square" ? "logo_square_key" : "logo_horizontal_key";
  const settings = await env.DB.prepare(`SELECT ${column} logo_key FROM tenant_settings WHERE tenant_key=?`).bind(auth.tenantKey).first();
  await env.DB.prepare(`UPDATE tenant_settings SET ${column}='',updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_key=?`).bind(auth.sub, auth.tenantKey).run();
  if (settings?.logo_key && env.EXPORTS) queueR2(ctx, env.EXPORTS.delete(settings.logo_key), settings.logo_key);
  archiveMutation(env, ctx, "school.logo.deleted", { tenant_key: auth.tenantKey, kind, deleted_by: auth.sub });
  return json({ ok: true });
}

async function adminContext(db, auth) {
  if (!auth.canManageRoster) return requireRosterAdmin(auth);
  const settings = await db.prepare("SELECT organization_name,academic_year,term,logo_horizontal_key,logo_square_key,updated_at FROM tenant_settings WHERE tenant_key=?").bind(auth.tenantKey).first();
  return json({
    user: auth,
    settings: settings || { organization_name: "", academic_year: "", term: "", updated_at: "" },
  });
}

async function saveAdminSettings(request, env, ctx, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const settings = {
    organization_name: clean(body.organization_name, 180),
    academic_year: clean(body.academic_year, 20),
    term: clean(body.term, 40),
  };
  await env.DB.prepare(`INSERT INTO tenant_settings(tenant_key,organization_name,academic_year,term,updated_by,updated_at)
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(tenant_key) DO UPDATE SET
    organization_name=excluded.organization_name,academic_year=excluded.academic_year,term=excluded.term,
    updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .bind(auth.tenantKey, settings.organization_name, settings.academic_year, settings.term, auth.sub).run();
  archiveMutation(env, ctx, "admin.settings.updated", { tenant_key: auth.tenantKey, ...settings, updated_by: auth.sub });
  return json({ ok: true, settings });
}

function studentTemplate(auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const csv = "\uFEFF" + [
    ["student_no", "name", "note"],
    ["1", "เด็กชายตัวอย่าง นักเรียน", ""],
    ["2", "เด็กหญิงตัวอย่าง ห้องเรียน", "แพ้อาหารทะเล"],
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
  return new Response(csv, { headers: {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="classroom-students-template.csv"',
    "cache-control": "no-store",
  } });
}

async function importStudents(request, env, ctx, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 501) : [];
  if (!classroomId || !rows.length) return json({ error: "กรุณาเลือกห้องเรียนและไฟล์ CSV" }, 400);
  if (rows.length > 500) return json({ error: "นำเข้าได้สูงสุด 500 รายชื่อต่อครั้ง" }, 400);
  const classroom = await env.DB.prepare("SELECT id,name FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const studentNo = clean(row?.student_no, 20);
    const name = clean(row?.name, 120);
    const note = clean(row?.note, 250);
    if (!name) { skipped++; continue; }
    const existing = studentNo
      ? await env.DB.prepare("SELECT id FROM students WHERE classroom_id=? AND student_no=? LIMIT 1").bind(classroomId, studentNo).first()
      : null;
    if (existing) {
      await env.DB.prepare("UPDATE students SET name=?,note=? WHERE id=?").bind(name, note, existing.id).run();
      updated++;
    } else {
      await env.DB.prepare("INSERT INTO students(classroom_id,student_no,name,note) VALUES(?,?,?,?)").bind(classroomId, studentNo, name, note).run();
      inserted++;
    }
  }
  const summary = { classroom_id: classroomId, classroom: classroom.name, inserted, updated, skipped, total: rows.length, imported_by: auth.sub };
  archiveMutation(env, ctx, "students.imported", summary);
  return json({ ok: true, ...summary });
}

function requireSchoolAdmin(auth) {
  if (!auth.schoolDomain) return json({ error: "ตารางบัญชีโรงเรียนใช้ได้เฉพาะโดเมน .ac.th" }, 400);
  if (!auth.schoolVerified || !auth.isAdmin) return json({ error: "ต้องเป็น Admin ของโรงเรียนจึงจะจัดการบัญชีได้", code: "ADMIN_REQUIRED" }, 403);
  return null;
}

async function listSchoolMembers(db, auth) {
  const denied = requireSchoolAdmin(auth);
  if (denied) return denied;
  const result = await db.prepare(`SELECT id,email,role,active,created_at,updated_at FROM school_members
    WHERE tenant_key=? ORDER BY role='admin' DESC, active DESC, email`).bind(auth.tenantKey).all();
  return json({ domain: auth.domain, members: result.results });
}

async function saveSchoolMember(request, env, ctx, auth) {
  const denied = requireSchoolAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const email = clean(body.email, 254).toLowerCase();
  const role = body.role === "admin" ? "admin" : "member";
  const active = body.active === false || body.active === 0 ? 0 : 1;
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.split("@").pop() !== auth.domain) {
    return json({ error: `อีเมลต้องลงท้ายด้วย @${auth.domain}` }, 400);
  }
  if (email === auth.email && (role !== "admin" || active !== 1)) {
    return json({ error: "ไม่สามารถลดสิทธิ์หรือปิดบัญชี Admin ที่กำลังใช้งานอยู่" }, 400);
  }
  const member = await env.DB.prepare(`INSERT INTO school_members(tenant_key,email,role,active,created_by,updated_at)
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(tenant_key,email) DO UPDATE SET
    role=excluded.role,active=excluded.active,updated_at=CURRENT_TIMESTAMP RETURNING id,email,role,active,created_at,updated_at`)
    .bind(auth.tenantKey, email, role, active, auth.sub).first();
  archiveMutation(env, ctx, "school.member.saved", { ...member, tenant_key: auth.tenantKey, updated_by: auth.sub });
  return json(member, 201);
}

async function deleteSchoolMember(env, ctx, id, auth) {
  const denied = requireSchoolAdmin(auth);
  if (denied) return denied;
  const member = await env.DB.prepare("SELECT * FROM school_members WHERE id=? AND tenant_key=?").bind(id, auth.tenantKey).first();
  if (!member) return json({ error: "ไม่พบบัญชีโรงเรียน" }, 404);
  if (member.email === auth.email) return json({ error: "ไม่สามารถลบบัญชี Admin ที่กำลังใช้งานอยู่" }, 400);
  await env.DB.prepare("DELETE FROM school_members WHERE id=? AND tenant_key=?").bind(id, auth.tenantKey).run();
  archiveMutation(env, ctx, "school.member.deleted", { ...member, deleted_by: auth.sub });
  return json({ ok: true });
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
function base64ToBytes(value) {
  const base64 = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("invalid base64");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function detectImageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "";
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function clean(value, max) { return String(value ?? "").trim().slice(0, max); }
function positiveInt(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function normalizeDays(value) { return String(value ?? "").split(",").map(Number).filter((n) => n >= 0 && n <= 6).filter((n, i, a) => a.indexOf(n) === i).join(","); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : ""; }
function bangkokDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function shiftDate(value, days) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function formatThaiDate(value) { return new Intl.DateTimeFormat("th-TH", { dateStyle: "long", timeZone: "Asia/Bangkok" }).format(new Date(`${value}T12:00:00+07:00`)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
async function readBody(request) { try { return await request.json(); } catch { return {}; } }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS }); }
