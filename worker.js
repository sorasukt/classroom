const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        if (request.method === "OPTIONS") return corsPreflight(request, env);
        return withCors(await handleApi(request, env, ctx, url), request, env);
      }
      if (url.pathname.startsWith("/checkin/")) {
        return await renderCheckinPage(env, url.pathname.split("/").pop());
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
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(materializeAttendanceSessions(env.DB, bangkokDate()));
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
  if (path === "/api/checkin/claim" && method === "POST") return checkinClaim(request, env, ctx);
  if (path === "/api/checkin/reset-device" && method === "POST") return resetCheckinDevice(request, env, ctx);

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
  if (path === "/api/student-directory" && method === "GET") return listStudentDirectory(env.DB, url, auth);
  if (path === "/api/student-directory" && method === "POST") return createDirectoryStudent(request, env, ctx, auth);
  if (/^\/api\/student-directory\/\d+$/.test(path) && method === "PATCH") {
    return updateDirectoryStudent(request, env, ctx, Number(path.split("/").pop()), auth);
  }
  if (/^\/api\/student-directory\/\d+$/.test(path) && method === "DELETE") {
    return archiveDirectoryStudent(env, ctx, Number(path.split("/").pop()), auth);
  }
  if (path === "/api/enrollments" && method === "POST") return saveEnrollment(request, env, ctx, auth);
  if (path === "/api/enrollments" && method === "DELETE") return removeEnrollment(env, ctx, url, auth);
  if (path === "/api/students" && method === "GET") return listStudents(env.DB, url, auth);
  if (path === "/api/students" && method === "POST") return createStudent(request, env, ctx, auth);
  if (/^\/api\/students\/\d+$/.test(path) && method === "PATCH") {
    return updateStudent(request, env, ctx, Number(path.split("/").pop()), auth);
  }
  if (/^\/api\/students\/\d+$/.test(path) && method === "DELETE") {
    return deleteStudent(env, ctx, url, Number(path.split("/").pop()), auth);
  }
  if (/^\/api\/students\/\d+\/history$/.test(path) && method === "GET") {
    return studentHistory(env.DB, Number(path.split("/")[3]), auth);
  }
  if (path === "/api/attendance" && method === "GET") return getAttendance(env.DB, url, auth);
  if (path === "/api/attendance" && method === "POST") return saveAttendance(request, env, ctx, auth);
  if (path === "/api/attendance/scan-card" && method === "POST") return scanStudentCard(request, env, ctx, auth);
  if (path === "/api/checkin/sessions" && method === "POST") return createCheckinSession(request, env, ctx, url.origin, auth);
  if (/^\/api\/checkin\/sessions\/\d+$/.test(path) && method === "DELETE") {
    return closeCheckinSession(env, ctx, Number(path.split("/").pop()), auth);
  }
  if (path === "/api/timetable" && method === "GET") return listTimetable(env.DB, auth);
  if (path === "/api/timetable" && method === "POST") return saveTimetableEntry(request, env, ctx, auth);
  if (/^\/api\/timetable\/\d+$/.test(path) && method === "DELETE") {
    return deleteTimetableEntry(env, ctx, Number(path.split("/").pop()), auth);
  }
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
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
  await materializeAttendanceSessions(db, today, auth.tenantKey);
  const [counts, rate, todayClasses] = await Promise.all([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM classrooms WHERE tenant_key=?) classrooms,
      (SELECT COUNT(*) FROM student_profiles WHERE tenant_key=? AND active=1) students,
      (SELECT COUNT(*) FROM lesson_plans l JOIN classrooms c ON c.id=l.classroom_id WHERE c.tenant_key=?) lessons`).bind(auth.tenantKey, auth.tenantKey, auth.tenantKey).first(),
    db.prepare(`SELECT ROUND(100.0 * SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id), 0), 1) rate
      FROM attendance a JOIN attendance_sessions s ON s.id=a.session_id JOIN classrooms c ON c.id=s.classroom_id
      WHERE c.tenant_key=? AND s.session_date >= date(?, '-13 day')`).bind(auth.tenantKey, today).first(),
    db.prepare(`SELECT c.*,te.start_time,te.end_time,COALESCE(NULLIF(te.room,''),c.room) room,te.teacher_name,
      COUNT(DISTINCT ce.student_id) student_count,COUNT(DISTINCT a.student_id) attendance_count
      FROM timetable_entries te JOIN classrooms c ON c.id=te.classroom_id
      LEFT JOIN classroom_enrollments ce ON ce.classroom_id=c.id AND ce.active=1
      LEFT JOIN attendance_sessions ss ON ss.classroom_id=c.id AND ss.session_date=?
      LEFT JOIN attendance a ON a.session_id=ss.id
      WHERE te.tenant_key=? AND te.weekday=? AND te.active=1 GROUP BY te.id ORDER BY te.start_time`).bind(today, auth.tenantKey, weekday).all(),
  ]);
  return json({ ...counts, attendanceRate: rate?.rate ?? 0, todayClasses: todayClasses.results, date: today });
}

async function listClassrooms(db, auth) {
  const result = await db.prepare(`SELECT c.*, COUNT(e.student_id) student_count FROM classrooms c LEFT JOIN classroom_enrollments e ON e.classroom_id=c.id AND e.active=1
    WHERE c.tenant_key=? GROUP BY c.id ORDER BY c.created_at DESC`).bind(auth.tenantKey).all();
  return json(result.results);
}

async function createClassroom(request, env, ctx, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const name = clean(body.name, 100);
  if (!name) return json({ error: "กรุณากรอกชื่อห้องเรียน" }, 400);
  const scheduleDays = normalizeDays(body.schedule_days);
  const startTime = validTime(body.start_time);
  const result = await env.DB.prepare(`INSERT INTO classrooms(name, code, room, schedule_days, start_time, tenant_key, created_by) VALUES(?,?,?,?,?,?,?) RETURNING *`)
    .bind(name, clean(body.code, 30), clean(body.room, 60), scheduleDays, startTime, auth.tenantKey, auth.sub).first();
  const days = scheduleDays.split(",").filter(Boolean).map(Number);
  if (startTime && days.length) {
    await env.DB.batch(days.map((weekday) => env.DB.prepare(`INSERT OR IGNORE INTO timetable_entries
      (tenant_key,classroom_id,weekday,start_time,room,created_by) VALUES(?,?,?,?,?,?)`)
      .bind(auth.tenantKey, result.id, weekday, startTime, result.room, auth.sub)));
  }
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

async function listStudentDirectory(db, url, auth) {
  const query = clean(url.searchParams.get("q"), 100);
  const like = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const result = await db.prepare(`SELECT sp.*,COUNT(DISTINCT CASE WHEN ce.active=1 THEN ce.classroom_id END) classroom_count,
      GROUP_CONCAT(DISTINCT CASE WHEN ce.active=1 THEN c.name END) classrooms
    FROM student_profiles sp LEFT JOIN classroom_enrollments ce ON ce.student_id=sp.id
    LEFT JOIN classrooms c ON c.id=ce.classroom_id
    WHERE sp.tenant_key=? AND (?='' OR sp.name LIKE ? ESCAPE '\\' OR sp.student_code LIKE ? ESCAPE '\\' OR sp.homeroom LIKE ? ESCAPE '\\')
    GROUP BY sp.id ORDER BY sp.active DESC,sp.name LIMIT 1000`).bind(auth.tenantKey, query, like, like, like).all();
  return json(result.results);
}

async function createDirectoryStudent(request, env, ctx, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const name = clean(body.name, 120);
  const code = clean(body.student_code, 120);
  if (!name) return json({ error: "กรุณากรอกชื่อ-นามสกุล" }, 400);
  if (code && await env.DB.prepare("SELECT id FROM student_profiles WHERE tenant_key=? AND student_code=?").bind(auth.tenantKey, code).first()) {
    return json({ error: "รหัสนักเรียนนี้มีอยู่ในทะเบียนกลางแล้ว" }, 409);
  }
  const student = await env.DB.prepare(`INSERT INTO student_profiles(tenant_key,student_code,name,homeroom,guardian_name,guardian_phone,note)
    VALUES(?,?,?,?,?,?,?) RETURNING *`).bind(auth.tenantKey, code, name, clean(body.homeroom, 80), clean(body.guardian_name, 120), clean(body.guardian_phone, 40), clean(body.note, 250)).first();
  archiveMutation(env, ctx, "student_directory.created", { ...student, created_by: auth.sub });
  return json(student, 201);
}

async function updateDirectoryStudent(request, env, ctx, id, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const existing = await env.DB.prepare("SELECT * FROM student_profiles WHERE id=? AND tenant_key=?").bind(id, auth.tenantKey).first();
  if (!existing) return json({ error: "ไม่พบนักเรียนในทะเบียนกลาง" }, 404);
  const body = await readBody(request);
  const name = clean(body.name, 120);
  const code = clean(body.student_code, 120);
  if (!name) return json({ error: "กรุณากรอกชื่อ-นามสกุล" }, 400);
  if (code && await env.DB.prepare("SELECT id FROM student_profiles WHERE tenant_key=? AND student_code=? AND id<>?").bind(auth.tenantKey, code, id).first()) {
    return json({ error: "รหัสนักเรียนนี้มีอยู่ในทะเบียนกลางแล้ว" }, 409);
  }
  const student = await env.DB.prepare(`UPDATE student_profiles SET student_code=?,name=?,homeroom=?,guardian_name=?,guardian_phone=?,note=?,active=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND tenant_key=? RETURNING *`).bind(code, name, clean(body.homeroom, 80), clean(body.guardian_name, 120), clean(body.guardian_phone, 40), clean(body.note, 250), body.active === false || body.active === "0" ? 0 : 1, id, auth.tenantKey).first();
  archiveMutation(env, ctx, "student_directory.updated", { ...student, updated_by: auth.sub });
  return json(student);
}

async function archiveDirectoryStudent(env, ctx, id, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const student = await env.DB.prepare("SELECT * FROM student_profiles WHERE id=? AND tenant_key=?").bind(id, auth.tenantKey).first();
  if (!student) return json({ error: "ไม่พบนักเรียนในทะเบียนกลาง" }, 404);
  await env.DB.batch([
    env.DB.prepare("UPDATE student_profiles SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id),
    env.DB.prepare("UPDATE classroom_enrollments SET active=0,updated_at=CURRENT_TIMESTAMP WHERE student_id=?").bind(id),
  ]);
  archiveMutation(env, ctx, "student_directory.archived", { ...student, archived_by: auth.sub });
  return json({ ok: true });
}

async function saveEnrollment(request, env, ctx, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const studentId = positiveInt(body.student_id);
  const pair = await env.DB.prepare(`SELECT sp.id student_id,c.id classroom_id FROM student_profiles sp JOIN classrooms c
    WHERE sp.id=? AND sp.tenant_key=? AND sp.active=1 AND c.id=? AND c.tenant_key=?`).bind(studentId, auth.tenantKey, classroomId, auth.tenantKey).first();
  if (!pair) return json({ error: "ข้อมูลนักเรียนหรือห้องเรียนไม่ถูกต้อง" }, 404);
  const enrollment = await env.DB.prepare(`INSERT INTO classroom_enrollments(classroom_id,student_id,student_no,active,updated_at)
    VALUES(?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(classroom_id,student_id) DO UPDATE SET
    student_no=excluded.student_no,active=1,updated_at=CURRENT_TIMESTAMP RETURNING *`).bind(classroomId, studentId, clean(body.student_no, 20)).first();
  archiveMutation(env, ctx, "enrollment.saved", { ...enrollment, updated_by: auth.sub });
  return json(enrollment, 201);
}

async function removeEnrollment(env, ctx, url, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  const studentId = positiveInt(url.searchParams.get("student_id"));
  const enrollment = await env.DB.prepare(`SELECT ce.* FROM classroom_enrollments ce JOIN classrooms c ON c.id=ce.classroom_id
    WHERE ce.classroom_id=? AND ce.student_id=? AND c.tenant_key=?`).bind(classroomId, studentId, auth.tenantKey).first();
  if (!enrollment) return json({ error: "ไม่พบการลงทะเบียน" }, 404);
  await env.DB.prepare("UPDATE classroom_enrollments SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(enrollment.id).run();
  archiveMutation(env, ctx, "enrollment.removed", { ...enrollment, removed_by: auth.sub });
  return json({ ok: true });
}

async function listStudents(db, url, auth) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const result = await db.prepare(`SELECT sp.*,ce.student_no,ce.id enrollment_id,
      SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) present_count,
      SUM(CASE WHEN a.status='late' THEN 1 ELSE 0 END) late_count,
      SUM(CASE WHEN a.status='absent' THEN 1 ELSE 0 END) absent_count,
      SUM(CASE WHEN a.status='leave' THEN 1 ELSE 0 END) leave_count,
      ROUND(100.0 * SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id),0),1) attendance_rate
    FROM classroom_enrollments ce JOIN student_profiles sp ON sp.id=ce.student_id JOIN classrooms c ON c.id=ce.classroom_id
    LEFT JOIN attendance_sessions ss ON ss.classroom_id=ce.classroom_id
    LEFT JOIN attendance a ON a.student_id=sp.id AND a.session_id=ss.id
    WHERE ce.classroom_id=? AND ce.active=1 AND sp.active=1 AND c.tenant_key=? GROUP BY sp.id
    ORDER BY CASE WHEN ce.student_no='' THEN 1 ELSE 0 END,CAST(ce.student_no AS INTEGER),sp.name`).bind(classroomId, auth.tenantKey).all();
  return json(result.results);
}

async function createStudent(request, env, ctx, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const name = clean(body.name, 120);
  const studentCode = clean(body.student_code, 120);
  if (!classroomId || !name) return json({ error: "ข้อมูลนักเรียนไม่ครบถ้วน" }, 400);
  const classroom = await env.DB.prepare("SELECT id FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  let result = studentCode ? await env.DB.prepare("SELECT * FROM student_profiles WHERE tenant_key=? AND student_code=?").bind(auth.tenantKey, studentCode).first() : null;
  if (!result) result = await env.DB.prepare("INSERT INTO student_profiles(tenant_key,student_code,name,note) VALUES(?,?,?,?) RETURNING *")
    .bind(auth.tenantKey, studentCode, name, clean(body.note, 250)).first();
  else result = await env.DB.prepare("UPDATE student_profiles SET name=?,note=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *")
    .bind(name, clean(body.note, 250), result.id).first();
  await env.DB.prepare(`INSERT INTO classroom_enrollments(classroom_id,student_id,student_no,active,updated_at) VALUES(?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(classroom_id,student_id) DO UPDATE SET student_no=excluded.student_no,active=1,updated_at=CURRENT_TIMESTAMP`)
    .bind(classroomId, result.id, clean(body.student_no, 20)).run();
  archiveMutation(env, ctx, "student.created", result);
  return json(result, 201);
}

async function deleteStudent(env, ctx, url, id, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  const existing = await env.DB.prepare(`SELECT sp.*,ce.id enrollment_id FROM student_profiles sp JOIN classroom_enrollments ce ON ce.student_id=sp.id
    JOIN classrooms c ON c.id=ce.classroom_id WHERE sp.id=? AND ce.classroom_id=? AND c.tenant_key=?`).bind(id, classroomId, auth.tenantKey).first();
  if (!existing) return json({ error: "ไม่พบนักเรียน" }, 404);
  await env.DB.prepare("UPDATE classroom_enrollments SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(existing.enrollment_id).run();
  archiveMutation(env, ctx, "enrollment.removed", { ...existing, removed_by: auth.sub });
  return json({ ok: true });
}

async function updateStudent(request, env, ctx, id, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const existing = await env.DB.prepare(`SELECT sp.*,ce.id enrollment_id FROM student_profiles sp JOIN classroom_enrollments ce ON ce.student_id=sp.id
    JOIN classrooms c ON c.id=ce.classroom_id WHERE sp.id=? AND ce.classroom_id=? AND c.tenant_key=?`).bind(id, classroomId, auth.tenantKey).first();
  if (!existing) return json({ error: "ไม่พบนักเรียน" }, 404);
  const name = clean(body.name, 120);
  const studentCode = clean(body.student_code, 120);
  if (!name) return json({ error: "กรุณากรอกชื่อ-นามสกุล" }, 400);
  if (studentCode) {
    const duplicate = await env.DB.prepare("SELECT id FROM student_profiles WHERE tenant_key=? AND student_code=? AND id<>?").bind(auth.tenantKey, studentCode, id).first();
    if (duplicate) return json({ error: "รหัสนักเรียนนี้มีอยู่ในห้องแล้ว" }, 409);
  }
  const student = await env.DB.prepare(`UPDATE student_profiles SET student_code=?,name=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *`)
    .bind(studentCode, name, clean(body.note, 250), id).first();
  await env.DB.prepare("UPDATE classroom_enrollments SET student_no=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(clean(body.student_no, 20), existing.enrollment_id).run();
  archiveMutation(env, ctx, "student.updated", { ...student, updated_by: auth.sub });
  return json(student);
}

async function studentHistory(db, id, auth) {
  const student = await db.prepare(`SELECT sp.*,GROUP_CONCAT(DISTINCT c.name) classroom_name FROM student_profiles sp
    LEFT JOIN classroom_enrollments ce ON ce.student_id=sp.id AND ce.active=1 LEFT JOIN classrooms c ON c.id=ce.classroom_id
    WHERE sp.id=? AND sp.tenant_key=? GROUP BY sp.id`).bind(id, auth.tenantKey).first();
  if (!student) return json({ error: "ไม่พบนักเรียน" }, 404);
  const history = await db.prepare(`SELECT ss.session_date,a.status,a.note,c.name classroom_name FROM attendance a
    JOIN attendance_sessions ss ON ss.id=a.session_id JOIN classrooms c ON c.id=ss.classroom_id
    WHERE a.student_id=? AND c.tenant_key=? ORDER BY ss.session_date DESC,c.name LIMIT 180`).bind(id, auth.tenantKey).all();
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
  const students = await db.prepare(`SELECT sp.*,ce.student_no,COALESCE(a.status,'') status,COALESCE(a.note,'') attendance_note
    FROM classroom_enrollments ce JOIN student_profiles sp ON sp.id=ce.student_id
    LEFT JOIN attendance_sessions ss ON ss.classroom_id=ce.classroom_id AND ss.session_date=?
    LEFT JOIN attendance a ON a.session_id=ss.id AND a.student_id=sp.id
    WHERE ce.classroom_id=? AND ce.active=1 AND sp.active=1
    ORDER BY CASE WHEN ce.student_no='' THEN 1 ELSE 0 END,CAST(ce.student_no AS INTEGER),sp.name`).bind(date, classroomId).all();
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
  const roster = await env.DB.prepare("SELECT student_id id FROM classroom_enrollments WHERE classroom_id=? AND active=1").bind(classroomId).all();
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

async function scanStudentCard(request, env, ctx, auth) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const date = validDate(body.date) || bangkokDate();
  const studentCode = clean(body.student_code, 120);
  if (!classroomId || !studentCode) return json({ error: "ข้อมูลบัตรนักเรียนไม่ครบถ้วน" }, 400);
  const matches = await env.DB.prepare(`SELECT sp.id,sp.name,ce.student_no,sp.student_code,c.name classroom_name
    FROM classroom_enrollments ce JOIN student_profiles sp ON sp.id=ce.student_id JOIN classrooms c ON c.id=ce.classroom_id
    WHERE ce.classroom_id=? AND ce.active=1 AND sp.active=1 AND c.tenant_key=? AND sp.student_code=? LIMIT 2`).bind(classroomId, auth.tenantKey, studentCode).all();
  if (!matches.results.length) return json({ error: `ไม่พบรหัสนักเรียน ${studentCode}`, code: "STUDENT_CODE_NOT_FOUND" }, 404);
  if (matches.results.length > 1) return json({ error: "พบรหัสนักเรียนซ้ำ กรุณาแก้ไขรายชื่อก่อนใช้งาน", code: "DUPLICATE_STUDENT_CODE" }, 409);
  const student = matches.results[0];
  await markStudentPresent(env.DB, classroomId, date, student.id, "สแกนบัตรนักเรียน");
  archiveMutation(env, ctx, "attendance.card_scanned", { classroom_id: classroomId, date, student_id: student.id, student_code: studentCode, scanned_by: auth.sub });
  return json({ ok: true, student, date });
}

async function createCheckinSession(request, env, ctx, origin, auth) {
  const body = await readBody(request);
  const classroomId = positiveInt(body.classroom_id);
  const date = validDate(body.date) || bangkokDate();
  const duration = Math.min(180, Math.max(5, positiveInt(body.duration_minutes) || 20));
  const classroom = await env.DB.prepare("SELECT id,name FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + duration * 60000).toISOString();
  const session = await env.DB.prepare(`INSERT INTO checkin_sessions(token_hash,tenant_key,classroom_id,session_date,expires_at,created_by)
    VALUES(?,?,?,?,?,?) RETURNING id`).bind(tokenHash, auth.tenantKey, classroomId, date, expiresAt, auth.sub).first();
  archiveMutation(env, ctx, "checkin.session.created", { id: session.id, classroom_id: classroomId, date, expires_at: expiresAt, created_by: auth.sub });
  return json({ id: session.id, classroom, date, expires_at: expiresAt, url: `${origin}/checkin/${token}` }, 201);
}

async function closeCheckinSession(env, ctx, id, auth) {
  const session = await env.DB.prepare(`SELECT cs.id,cs.classroom_id FROM checkin_sessions cs JOIN classrooms c ON c.id=cs.classroom_id
    WHERE cs.id=? AND cs.tenant_key=? AND c.tenant_key=?`).bind(id, auth.tenantKey, auth.tenantKey).first();
  if (!session) return json({ error: "ไม่พบรอบรับเช็คชื่อ" }, 404);
  await env.DB.prepare("UPDATE checkin_sessions SET active=0 WHERE id=?").bind(id).run();
  archiveMutation(env, ctx, "checkin.session.closed", { id, classroom_id: session.classroom_id, closed_by: auth.sub });
  return json({ ok: true });
}

async function listTimetable(db, auth) {
  const result = await db.prepare(`SELECT te.*,c.name classroom_name,c.code classroom_code,
      (SELECT COUNT(*) FROM classroom_enrollments ce WHERE ce.classroom_id=te.classroom_id AND ce.active=1) student_count
    FROM timetable_entries te JOIN classrooms c ON c.id=te.classroom_id
    WHERE te.tenant_key=? ORDER BY te.weekday,te.start_time,c.name`).bind(auth.tenantKey).all();
  return json(result.results);
}

async function saveTimetableEntry(request, env, ctx, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const body = await readBody(request);
  const id = positiveInt(body.id);
  const classroomId = positiveInt(body.classroom_id);
  const weekday = Number(body.weekday);
  const startTime = validTime(body.start_time);
  const endTime = body.end_time ? validTime(body.end_time) : "";
  if (!classroomId || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !startTime) {
    return json({ error: "กรุณาระบุห้องเรียน วัน และเวลาเริ่มให้ครบถ้วน" }, 400);
  }
  if (body.end_time && !endTime) return json({ error: "เวลาสิ้นสุดไม่ถูกต้อง" }, 400);
  if (endTime && endTime <= startTime) return json({ error: "เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม" }, 400);
  const classroom = await env.DB.prepare("SELECT id,name FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  let entry;
  try {
    if (id) {
      entry = await env.DB.prepare(`UPDATE timetable_entries SET classroom_id=?,weekday=?,start_time=?,end_time=?,room=?,teacher_name=?,active=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND tenant_key=? RETURNING *`).bind(classroomId, weekday, startTime, endTime, clean(body.room, 80), clean(body.teacher_name, 120), body.active === false || body.active === "0" ? 0 : 1, id, auth.tenantKey).first();
      if (!entry) return json({ error: "ไม่พบรายการในตารางเรียน" }, 404);
    } else {
      entry = await env.DB.prepare(`INSERT INTO timetable_entries(tenant_key,classroom_id,weekday,start_time,end_time,room,teacher_name,active,created_by)
        VALUES(?,?,?,?,?,?,?,?,?) RETURNING *`).bind(auth.tenantKey, classroomId, weekday, startTime, endTime, clean(body.room, 80), clean(body.teacher_name, 120), body.active === false || body.active === "0" ? 0 : 1, auth.sub).first();
    }
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE")) return json({ error: "ห้องเรียนนี้มีคาบในวันและเวลาเดียวกันแล้ว" }, 409);
    throw error;
  }
  const today = bangkokDate();
  const todayWeekday = new Date(`${today}T12:00:00+07:00`).getDay();
  if (Number(entry.active) && weekday === todayWeekday) await materializeAttendanceSessions(env.DB, today, auth.tenantKey);
  archiveMutation(env, ctx, id ? "timetable.updated" : "timetable.created", { ...entry, updated_by: auth.sub });
  return json(entry, id ? 200 : 201);
}

async function deleteTimetableEntry(env, ctx, id, auth) {
  const denied = requireRosterAdmin(auth);
  if (denied) return denied;
  const entry = await env.DB.prepare("SELECT * FROM timetable_entries WHERE id=? AND tenant_key=?").bind(id, auth.tenantKey).first();
  if (!entry) return json({ error: "ไม่พบรายการในตารางเรียน" }, 404);
  await env.DB.prepare("DELETE FROM timetable_entries WHERE id=? AND tenant_key=?").bind(id, auth.tenantKey).run();
  archiveMutation(env, ctx, "timetable.deleted", { ...entry, deleted_by: auth.sub });
  return json({ ok: true });
}

async function materializeAttendanceSessions(db, date, tenantKey = "") {
  const weekday = new Date(`${date}T12:00:00+07:00`).getDay();
  const query = tenantKey
    ? db.prepare(`INSERT OR IGNORE INTO attendance_sessions(classroom_id,session_date,note)
        SELECT DISTINCT classroom_id,?,'' FROM timetable_entries WHERE tenant_key=? AND weekday=? AND active=1`).bind(date, tenantKey, weekday)
    : db.prepare(`INSERT OR IGNORE INTO attendance_sessions(classroom_id,session_date,note)
        SELECT DISTINCT classroom_id,?,'' FROM timetable_entries WHERE weekday=? AND active=1`).bind(date, weekday);
  await query.run();
}

async function checkinClaim(request, env, ctx) {
  const body = await readBody(request);
  const token = clean(body.token, 160);
  const studentId = positiveInt(body.student_id);
  if (!token || !studentId) return json({ error: "ข้อมูลเช็คชื่อไม่ครบถ้วน" }, 400);
  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare(`SELECT cs.*,c.name classroom_name FROM checkin_sessions cs JOIN classrooms c ON c.id=cs.classroom_id
    WHERE cs.token_hash=?`).bind(tokenHash).first();
  if (!session || !Number(session.active) || Date.parse(session.expires_at) <= Date.now()) return json({ error: "QR นี้หมดอายุหรือปิดรับเช็คชื่อแล้ว", code: "CHECKIN_CLOSED" }, 410);
  const student = await env.DB.prepare(`SELECT sp.id,sp.name,ce.student_no FROM student_profiles sp JOIN classroom_enrollments ce ON ce.student_id=sp.id
    WHERE sp.id=? AND ce.classroom_id=? AND ce.active=1 AND sp.active=1`).bind(studentId, session.classroom_id).first();
  if (!student) return json({ error: "ไม่พบนักเรียนในห้องนี้" }, 404);
  const device = await checkinDevice(request, env);
  const deviceHash = await sha256Hex(`${session.tenant_key}\0${device.id}`);
  const binding = await env.DB.prepare(`SELECT cd.*,s.name student_name FROM checkin_devices cd JOIN student_profiles s ON s.id=cd.student_id
    WHERE cd.tenant_key=? AND cd.classroom_id=? AND cd.device_hash=?`).bind(session.tenant_key, session.classroom_id, deviceHash).first();
  if (binding && Number(binding.student_id) !== studentId) {
    const message = Date.parse(binding.reset_after) > Date.now()
      ? `อุปกรณ์นี้ผูกกับ ${binding.student_name} แล้ว รีเซ็ตได้หลัง ${formatThaiDateTime(binding.reset_after)}`
      : `อุปกรณ์นี้ผูกกับ ${binding.student_name} แล้ว กรุณากดรีเซ็ตอุปกรณ์ก่อนเปลี่ยนชื่อ`;
    return json({ error: message, code: "DEVICE_BOUND", reset_after: binding.reset_after }, 409, device.cookie);
  }
  const resetAfter = new Date(Date.now() + 7 * 86400000).toISOString();
  await env.DB.prepare(`INSERT INTO checkin_devices(tenant_key,classroom_id,device_hash,student_id,reset_after,last_seen_at)
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(tenant_key,classroom_id,device_hash) DO UPDATE SET
    student_id=excluded.student_id,bound_at=CASE WHEN checkin_devices.student_id<>excluded.student_id THEN CURRENT_TIMESTAMP ELSE checkin_devices.bound_at END,
    reset_after=CASE WHEN checkin_devices.student_id<>excluded.student_id THEN excluded.reset_after ELSE checkin_devices.reset_after END,last_seen_at=CURRENT_TIMESTAMP`)
    .bind(session.tenant_key, session.classroom_id, deviceHash, studentId, resetAfter).run();
  await markStudentPresent(env.DB, session.classroom_id, session.session_date, studentId, "เช็คชื่อผ่าน QR");
  archiveMutation(env, ctx, "attendance.qr_checked_in", { checkin_session_id: session.id, classroom_id: session.classroom_id, date: session.session_date, student_id: studentId, device_hash: deviceHash });
  return json({ ok: true, student, classroom: session.classroom_name, date: session.session_date }, 200, device.cookie);
}

async function resetCheckinDevice(request, env, ctx) {
  const body = await readBody(request);
  const token = clean(body.token, 160);
  if (!token) return json({ error: "QR ไม่ถูกต้อง" }, 400);
  const session = await env.DB.prepare("SELECT * FROM checkin_sessions WHERE token_hash=?").bind(await sha256Hex(token)).first();
  if (!session || !Number(session.active) || Date.parse(session.expires_at) <= Date.now()) return json({ error: "QR นี้หมดอายุหรือปิดรับเช็คชื่อแล้ว" }, 410);
  const device = await checkinDevice(request, env);
  const deviceHash = await sha256Hex(`${session.tenant_key}\0${device.id}`);
  const binding = await env.DB.prepare("SELECT * FROM checkin_devices WHERE tenant_key=? AND classroom_id=? AND device_hash=?").bind(session.tenant_key, session.classroom_id, deviceHash).first();
  if (!binding) return json({ ok: true, reset: false }, 200, device.cookie);
  if (Date.parse(binding.reset_after) > Date.now()) return json({ error: `รีเซ็ตอุปกรณ์ได้หลัง ${formatThaiDateTime(binding.reset_after)}`, code: "RESET_NOT_READY", reset_after: binding.reset_after }, 409, device.cookie);
  await env.DB.prepare("DELETE FROM checkin_devices WHERE id=?").bind(binding.id).run();
  archiveMutation(env, ctx, "checkin.device.reset", { classroom_id: session.classroom_id, student_id: binding.student_id, device_hash: deviceHash });
  return json({ ok: true, reset: true }, 200, device.cookie);
}

async function markStudentPresent(db, classroomId, date, studentId, note) {
  const session = await db.prepare(`INSERT INTO attendance_sessions(classroom_id,session_date,note) VALUES(?,?,'')
    ON CONFLICT(classroom_id,session_date) DO UPDATE SET session_date=excluded.session_date RETURNING id`).bind(classroomId, date).first();
  await db.prepare(`INSERT INTO attendance(session_id,student_id,status,note,updated_at) VALUES(?,?,'present',?,CURRENT_TIMESTAMP)
    ON CONFLICT(session_id,student_id) DO UPDATE SET status='present',note=excluded.note,updated_at=CURRENT_TIMESTAMP`).bind(session.id, studentId, note).run();
}

async function checkinDevice(request, env) {
  const value = getCookie(request, "classroom_checkin_device");
  const [id, signature] = value.split(".");
  if (id && signature && timingSafeEqual(signature, await sign(id, await sessionSigningSecret(env)))) return { id, cookie: "" };
  const newId = crypto.randomUUID().replaceAll("-", "");
  const signed = `${newId}.${await sign(newId, await sessionSigningSecret(env))}`;
  return { id: newId, cookie: `classroom_checkin_device=${signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` };
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
  const records = await env.DB.prepare(`SELECT sp.name,ce.student_no,COALESCE(a.status,'') status
    FROM classroom_enrollments ce JOIN student_profiles sp ON sp.id=ce.student_id
    LEFT JOIN attendance_sessions ss ON ss.classroom_id=ce.classroom_id AND ss.session_date=?
    LEFT JOIN attendance a ON a.session_id=ss.id AND a.student_id=sp.id
    WHERE ce.classroom_id=? AND ce.active=1 AND sp.active=1 ORDER BY CAST(ce.student_no AS INTEGER),sp.name`).bind(date, classroomId).all();
  const counts = { present: 0, late: 0, absent: 0, leave: 0, unmarked: 0 };
  records.results.forEach((row) => counts[row.status || "unmarked"]++);
  const payload = { classroom: classroom.name, date, counts, records: records.results };
  const token = crypto.randomUUID().replaceAll("-", "");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO share_links(token,payload,expires_at) VALUES(?,?,?)").bind(token, JSON.stringify(payload), expires).run();
  archiveMutation(env, ctx, "share.created", { token, expires_at: expires, ...payload });
  const shareUrl = `${origin}/share/${token}`;
  const lineText = `สรุปการเช็คชื่อ\nห้อง ${classroom.name}\n${formatThaiDate(date)}\n\nมา ${counts.present} · สาย ${counts.late} · ขาด ${counts.absent} · ลา ${counts.leave}\n${shareUrl}`;
  return json({ url: shareUrl, lineUrl: `https://line.me/R/share?text=${encodeURIComponent(lineText)}` });
}

async function renderSharedSummary(env, token) {
  if (!/^[a-f0-9]{32}$/.test(token || "")) return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT payload FROM share_links WHERE token=? AND expires_at>CURRENT_TIMESTAMP").bind(token).first();
  if (!row) return new Response("ลิงก์หมดอายุหรือไม่พบข้อมูล", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const data = JSON.parse(row.payload);
  const labels = { present: "มา", late: "สาย", absent: "ขาด", leave: "ลา", "": "ยังไม่บันทึก" };
  const attention = data.records.filter((r) => r.status !== "present").map((r) => `<li><span class="student"><small>${escapeHtml(r.student_no || "-")}</small><b>${escapeHtml(r.name)}</b></span><span class="status ${r.status || "unmarked"}">${labels[r.status]}</span></li>`).join("");
  const description = `มา ${data.counts.present} สาย ${data.counts.late} ขาด ${data.counts.absent} ลา ${data.counts.leave}`;
  return new Response(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#fafafa"><meta name="referrer" content="no-referrer"><title>สรุปการเช็คชื่อ · ${escapeHtml(data.classroom)}</title><meta property="og:type" content="website"><meta property="og:title" content="สรุปการเช็คชื่อ · ${escapeHtml(data.classroom)}"><meta property="og:description" content="${escapeHtml(description)}"><link rel="icon" type="image/png" sizes="64x64" href="https://sorasukt.com/classroom/assets/favicon.png"><link rel="apple-touch-icon" sizes="180x180" href="https://sorasukt.com/classroom/assets/apple-touch-icon.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600&family=Kanit:wght@500;600&display=swap" rel="stylesheet"><link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.3.1/css/all.min.css" rel="stylesheet" crossorigin="anonymous" referrerpolicy="no-referrer"><style>
  :root{--ink:#161514;--paper:#fff;--surface:#fafafa;--line:#e6e6e4;--muted:#7a7873;--red:#ff3b30;--red-soft:#fff0ee}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:clamp(24px,7vh,72px) 18px;background:var(--surface);color:var(--ink);font-family:"IBM Plex Sans Thai",sans-serif;-webkit-font-smoothing:antialiased}.wrap{width:min(620px,100%);margin:auto}.card{padding:clamp(28px,6vw,48px);border:1px solid var(--line);border-radius:24px;background:var(--paper);box-shadow:0 24px 70px -55px #000}.logo{display:block;width:58px;height:58px;margin-bottom:28px;border-radius:8px;object-fit:cover}.eyebrow{margin:0 0 5px;color:var(--red);font-size:12px;font-weight:600}h1{margin:0;font:600 clamp(28px,7vw,38px)/1.2 Kanit;letter-spacing:-.02em}.date{display:flex;align-items:center;gap:9px;margin:14px 0 0;color:var(--muted);font-size:14px}.date i{color:var(--red)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:28px 0}.stat{padding:14px 8px;border:1px solid var(--line);border-radius:12px;background:var(--surface);text-align:center;color:var(--muted);font-size:12px}.stat b{display:block;color:var(--ink);font:600 25px Kanit}.stat.late b,.stat.absent b{color:var(--red)}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:4px 0 8px}.section-head h2{margin:0;font:600 17px Kanit}.section-head span{color:var(--muted);font-size:11px}ul{margin:0;padding:0;list-style:none;border-top:1px solid var(--line)}li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}.student{display:grid;grid-template-columns:28px 1fr;align-items:center;gap:8px;min-width:0}.student small{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;background:var(--surface);color:var(--muted)}.student b{overflow:hidden;text-overflow:ellipsis;font-weight:500;white-space:nowrap}.status{flex:0 0 auto;padding:5px 9px;border-radius:99px;background:#eee;color:var(--muted);font-size:11px;font-weight:600}.status.late{background:var(--red-soft);color:var(--red)}.status.absent{background:var(--red);color:#fff}.status.leave{border:1px solid var(--line);background:#fff}.all-present{display:flex;align-items:center;gap:10px;padding:16px;border-radius:12px;background:var(--surface);color:var(--muted);font-size:13px}.all-present i{color:var(--ink)}.credit{margin:22px 0 0;text-align:center;color:var(--muted);font-size:12px}.credit b{color:var(--red);font-weight:600}@media(max-width:480px){body{padding:28px 14px}.card{padding:28px 22px;border-radius:20px}.logo{width:52px;height:52px;margin-bottom:24px}.grid{grid-template-columns:repeat(2,1fr);margin:24px 0}.student{grid-template-columns:26px 1fr}.student small{width:26px;height:26px}}
  </style></head><body><main class="wrap"><section class="card"><img class="logo" src="https://sorasukt.com/classroom/assets/classroom-logo.png" alt="โลโก้ Classroom by /sorasukt"><header><p class="eyebrow">สรุปการเช็คชื่อ</p><h1>${escapeHtml(data.classroom)}</h1><p class="date"><i class="fa-regular fa-calendar" aria-hidden="true"></i>${formatThaiDate(data.date)}</p></header><div class="grid"><div class="stat"><b>${data.counts.present}</b>มา</div><div class="stat late"><b>${data.counts.late}</b>สาย</div><div class="stat absent"><b>${data.counts.absent}</b>ขาด</div><div class="stat"><b>${data.counts.leave}</b>ลา</div></div><div class="section-head"><h2>รายการที่ต้องติดตาม</h2><span>${data.counts.late + data.counts.absent + data.counts.leave + data.counts.unmarked} คน</span></div>${attention ? `<ul>${attention}</ul>` : '<div class="all-present"><i class="fa-solid fa-circle-check" aria-hidden="true"></i>นักเรียนมาครบทุกคน</div>'}</section><p class="credit">Powered by <b>/sorasukt</b> Classroom</p></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "private, no-store" } });
}

async function renderCheckinPage(env, token) {
  token = clean(token, 160);
  if (!token) return new Response("QR ไม่ถูกต้อง", { status: 404 });
  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare(`SELECT cs.*,c.name classroom_name FROM checkin_sessions cs JOIN classrooms c ON c.id=cs.classroom_id
    WHERE cs.token_hash=?`).bind(tokenHash).first();
  const open = session && Number(session.active) && Date.parse(session.expires_at) > Date.now();
  if (!open) return new Response(checkinHtml("ปิดรับเช็คชื่อแล้ว", "QR นี้หมดอายุหรือครูปิดรับเช็คชื่อแล้ว", ""), { status: 410, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" } });
  const students = await env.DB.prepare(`SELECT sp.id,ce.student_no,sp.name FROM classroom_enrollments ce JOIN student_profiles sp ON sp.id=ce.student_id
    WHERE ce.classroom_id=? AND ce.active=1 AND sp.active=1
    ORDER BY CASE WHEN ce.student_no='' THEN 1 ELSE 0 END,CAST(ce.student_no AS INTEGER),sp.name`).bind(session.classroom_id).all();
  const options = students.results.map((student) => `<option value="${student.id}">${escapeHtml(student.student_no ? `${student.student_no} · ` : "")}${escapeHtml(student.name)}</option>`).join("");
  const form = `<div class="session-meta"><i class="fa-regular fa-calendar" aria-hidden="true"></i><span>${escapeHtml(session.classroom_name)}</span><b>·</b><time datetime="${session.session_date}">${formatThaiDate(session.session_date)}</time></div><div class="form-area"><label for="student">เลือกชื่อของคุณ</label><select id="student"><option value="">— กรุณาเลือก —</option>${options}</select><button id="submit"><i class="fa-solid fa-check" aria-hidden="true"></i>ยืนยันการเข้าเรียน</button><div class="divider"><span>หรือ</span></div><button class="secondary" id="reset"><i class="fa-solid fa-qrcode" aria-hidden="true"></i>รีเซ็ตชื่อบนอุปกรณ์นี้</button><div class="security-note"><span class="security-icon"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i></span><p>อุปกรณ์นี้จะผูกกับชื่อที่เลือกเป็นเวลา 7 วัน เพื่อป้องกันการเช็คชื่อแทนกัน และต้องกดรีเซ็ตก่อนจึงจะเปลี่ยนชื่อได้</p></div><p id="message" role="alert"></p></div><script>const token=${JSON.stringify(token)},message=document.getElementById('message');document.getElementById('submit').onclick=async()=>{const button=document.getElementById('submit'),student_id=Number(document.getElementById('student').value);if(!student_id){message.textContent='กรุณาเลือกชื่อของคุณ';return}button.disabled=true;message.textContent='กำลังบันทึก...';try{const response=await fetch('/api/checkin/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,student_id})});const data=await response.json();if(!response.ok)throw new Error(data.error||'บันทึกไม่สำเร็จ');const card=document.querySelector('.card');card.textContent='';const success=document.createElement('div');success.className='success';success.innerHTML='<i class="fa-solid fa-check" aria-hidden="true"></i>';const heading=document.createElement('h1');heading.textContent='เช็คชื่อสำเร็จ';const name=document.createElement('p');name.className='success-name';name.textContent=data.student.name;const room=document.createElement('p');room.className='session-meta success-meta';room.textContent=data.classroom;card.append(success,heading,name,room)}catch(error){message.textContent=error.message;button.disabled=false}};document.getElementById('reset').onclick=async()=>{if(!confirm('ต้องการรีเซ็ตชื่อที่ผูกกับอุปกรณ์นี้หรือไม่?'))return;message.textContent='กำลังตรวจสอบสิทธิ์รีเซ็ต...';try{const response=await fetch('/api/checkin/reset-device',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});const data=await response.json();if(!response.ok)throw new Error(data.error||'รีเซ็ตไม่สำเร็จ');message.textContent=data.reset?'รีเซ็ตแล้ว กรุณาเลือกชื่อใหม่':'อุปกรณ์นี้ยังไม่ได้ผูกกับชื่อ'}catch(error){message.textContent=error.message}}</script>`;
  return new Response(checkinHtml("เช็คชื่อเข้าเรียน", "เลือกชื่อและยืนยันด้วยอุปกรณ์ของคุณ", form), { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "private, no-store" } });
}

function checkinHtml(title, subtitle, content) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · /sorasukt Classroom</title><link rel="icon" type="image/png" sizes="64x64" href="https://sorasukt.com/classroom/assets/favicon.png"><link rel="apple-touch-icon" sizes="180x180" href="https://sorasukt.com/classroom/assets/apple-touch-icon.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600&family=Kanit:wght@500;600&display=swap" rel="stylesheet"><link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.3.1/css/all.min.css" rel="stylesheet" crossorigin="anonymous" referrerpolicy="no-referrer"><style>:root{--ink:#161514;--paper:#fff;--surface:#fafafa;--muted:#7a7873;--red:#ff3b30;--red-soft:#fff0ee;--line:#e6e6e4}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:clamp(24px,7vh,72px) 18px;background:var(--surface);color:var(--ink);font-family:"IBM Plex Sans Thai",sans-serif;-webkit-font-smoothing:antialiased}main{width:min(560px,100%);margin:auto}.card{padding:clamp(28px,6vw,48px);border:1px solid var(--line);border-radius:24px;background:var(--paper);box-shadow:0 24px 70px -55px #000}.logo{display:block;width:58px;height:58px;margin-bottom:28px;border-radius:8px;object-fit:cover}h1{margin:0;font:600 clamp(28px,7vw,38px)/1.2 Kanit;letter-spacing:-.02em}header>p{margin:12px 0 0;color:var(--muted);font-size:16px}.session-meta{display:flex;align-items:center;gap:9px;margin-top:20px;color:var(--muted);font-size:14px;flex-wrap:wrap}.session-meta i{color:var(--red)}.session-meta b{font-weight:400}.form-area{margin-top:30px}label{display:block;margin-bottom:7px;font-weight:600}select,button{width:100%;min-height:52px;border-radius:10px;font:inherit}select{padding:9px 14px;border:1px solid var(--line);background:#fff;color:var(--ink);font-size:16px}select:focus{border-color:var(--red);outline:2px solid #ffd6d2}button{display:flex;align-items:center;justify-content:center;gap:9px;margin-top:12px;border:1px solid var(--ink);background:var(--ink);color:#fff;font-weight:600}button.secondary{margin:0;border-color:#ff8a83;background:#fff;color:var(--ink)}button.secondary i{color:var(--red)}button:disabled{opacity:.5}.divider{display:flex;align-items:center;gap:14px;margin:19px 0;color:var(--muted);font-size:12px}.divider:before,.divider:after{content:"";height:1px;flex:1;background:var(--line)}.security-note{display:grid;grid-template-columns:48px 1fr;align-items:center;gap:14px;margin-top:18px;padding:16px;border-radius:12px;background:var(--surface)}.security-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:#eee;font-size:20px}.security-note p{margin:0;color:#4e4c48;font-size:12.5px;line-height:1.7}#message{min-height:22px;margin:12px 0 0;color:var(--red);font-size:13px}.success{display:grid;place-items:center;width:64px;height:64px;margin-bottom:24px;border-radius:50%;background:var(--ink);color:#fff;font-size:25px}.success-name{margin:14px 0 0;font-size:18px;font-weight:600}.success-meta{margin-top:6px}.credit{margin:22px 0 0;text-align:center;color:var(--muted);font-size:12px}.credit b{color:var(--red);font-weight:600}@media(max-width:480px){body{padding:28px 14px}.card{padding:28px 22px;border-radius:20px}.logo{width:52px;height:52px;margin-bottom:24px}header>p{font-size:14px}.session-meta{font-size:12.5px}.security-note{grid-template-columns:42px 1fr;padding:14px}.security-icon{width:40px;height:40px}}</style></head><body><main><section class="card"><img class="logo" src="https://sorasukt.com/classroom/assets/classroom-logo.png" alt="โลโก้ Classroom by /sorasukt"><header><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></header>${content}</section><p class="credit">Powered by <b>/sorasukt</b> Classroom</p></main></body></html>`;
}

async function exportCsv(env, ctx, url, auth) {
  const classroomId = positiveInt(url.searchParams.get("classroom_id"));
  const from = validDate(url.searchParams.get("from")) || "1900-01-01";
  const to = validDate(url.searchParams.get("to")) || "2999-12-31";
  if (!classroomId) return json({ error: "classroom_id ไม่ถูกต้อง" }, 400);
  const classroom = await env.DB.prepare("SELECT name FROM classrooms WHERE id=? AND tenant_key=?").bind(classroomId, auth.tenantKey).first();
  if (!classroom) return json({ error: "ไม่พบห้องเรียน" }, 404);
  const rows = await env.DB.prepare(`SELECT ce.student_no,sp.student_code,sp.name,ss.session_date,a.status,a.note
    FROM classroom_enrollments ce JOIN student_profiles sp ON sp.id=ce.student_id
    LEFT JOIN attendance_sessions ss ON ss.classroom_id=ce.classroom_id AND ss.session_date BETWEEN ? AND ?
    LEFT JOIN attendance a ON a.student_id=sp.id AND a.session_id=ss.id
    WHERE ce.classroom_id=?
    ORDER BY CAST(ce.student_no AS INTEGER),sp.name,ss.session_date`).bind(from, to, classroomId).all();
  const labels = { present: "มา", late: "สาย", absent: "ขาด", leave: "ลา" };
  const header = ["เลขที่", "รหัสนักเรียน", "ชื่อ-นามสกุล", "วันที่", "สถานะ", "หมายเหตุ"];
  const lines = [header, ...rows.results.map((r) => [r.student_no, r.student_code, r.name, r.session_date || "", labels[r.status] || "ยังไม่มีประวัติ", r.note || ""])];
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
    ["student_no", "student_code", "name", "homeroom", "guardian_name", "guardian_phone", "note"],
    ["1", "66010001", "เด็กชายตัวอย่าง นักเรียน", "ม.1/1", "ผู้ปกครองตัวอย่าง", "0812345678", ""],
    ["2", "66010002", "เด็กหญิงตัวอย่าง ห้องเรียน", "ม.1/1", "", "", "แพ้อาหารทะเล"],
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
    const studentCode = clean(row?.student_code, 120);
    const name = clean(row?.name, 120);
    const homeroom = clean(row?.homeroom, 80);
    const guardianName = clean(row?.guardian_name, 120);
    const guardianPhone = clean(row?.guardian_phone, 40);
    const note = clean(row?.note, 250);
    if (!name) { skipped++; continue; }
    let existing = studentCode
      ? await env.DB.prepare("SELECT id FROM student_profiles WHERE tenant_key=? AND student_code=?").bind(auth.tenantKey, studentCode).first()
      : null;
    if (!existing && studentNo) {
      existing = await env.DB.prepare(`SELECT sp.id FROM classroom_enrollments ce JOIN student_profiles sp ON sp.id=ce.student_id
        WHERE ce.classroom_id=? AND ce.student_no=? AND ce.active=1 LIMIT 1`).bind(classroomId, studentNo).first();
    }
    let studentId;
    if (existing) {
      studentId = existing.id;
      await env.DB.prepare(`UPDATE student_profiles SET student_code=?,name=?,homeroom=?,guardian_name=?,guardian_phone=?,note=?,active=1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND tenant_key=?`).bind(studentCode, name, homeroom, guardianName, guardianPhone, note, studentId, auth.tenantKey).run();
      updated++;
    } else {
      const student = await env.DB.prepare(`INSERT INTO student_profiles(tenant_key,student_code,name,homeroom,guardian_name,guardian_phone,note)
        VALUES(?,?,?,?,?,?,?) RETURNING id`).bind(auth.tenantKey, studentCode, name, homeroom, guardianName, guardianPhone, note).first();
      studentId = student.id;
      inserted++;
    }
    await env.DB.prepare(`INSERT INTO classroom_enrollments(classroom_id,student_id,student_no,active,updated_at)
      VALUES(?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(classroom_id,student_id) DO UPDATE SET
      student_no=excluded.student_no,active=1,updated_at=CURRENT_TIMESTAMP`).bind(classroomId, studentId, studentNo).run();
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
function validTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : ""; }
function normalizeDays(value) { return String(value ?? "").split(",").map(Number).filter((n) => n >= 0 && n <= 6).filter((n, i, a) => a.indexOf(n) === i).join(","); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : ""; }
function bangkokDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function shiftDate(value, days) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function formatThaiDate(value) { return new Intl.DateTimeFormat("th-TH", { dateStyle: "long", timeZone: "Asia/Bangkok" }).format(new Date(`${value}T12:00:00+07:00`)); }
function formatThaiDateTime(value) { return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
async function readBody(request) { try { return await request.json(); } catch { return {}; } }
function json(value, status = 200, cookie = "") { const headers = new Headers(JSON_HEADERS); if (cookie) headers.set("set-cookie", cookie); return new Response(JSON.stringify(value), { status, headers }); }
