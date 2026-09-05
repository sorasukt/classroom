// Student credentials never authenticate legacy teacher APIs. Evidence never enters archiveMutation.
const DAY = 86400000, MAX_FILE = 2 * 1024 * 1024;
const now = () => Date.now();
const id = () => crypto.randomUUID();
const cookieName = '__Host-classroom_student';
const cookie = (token, age = 604800) => `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const reply = (data, status = 200, token = null) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...(token !== null ? {'set-cookie':cookie(token, token ? 604800 : 0)} : {})}});
class AccessError extends Error { constructor(message, status=400){super(message);this.status=status;} }
const fail = (message='ไม่สามารถเข้าห้องได้ โปรดตรวจรหัส เข้าสู่ระบบหากห้องกำหนด หรือติดต่อครู', status=400) => {throw new AccessError(message,status);};
const text = (v,n=180) => String(v??'').trim().slice(0,n);
const rows = r => r.results || [];
export async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
// Rejection sampling avoids modulo bias. Leading zeros are significant.
export function roomCode(){let s='';while(s.length<16){for(const b of crypto.getRandomValues(new Uint8Array(24))){if(b<250)s+=b%10;if(s.length===16)break;}}return s;}
async function keyedHash(env,value){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.AUTH0_CLIENT_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
async function codeHash(env,code){return keyedHash(env,'student-invite\0'+code);}
async function verifiedDevice(request,env){const raw=request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-student_device=([^;]+)/)?.[1]||'';const [token,signature]=raw.split('.');if(!token||!signature||!/^[-a-f0-9]{36}$/.test(token))return '';return signature===await keyedHash(env,'student-device\0'+token)?token:'';}
export async function studentDeviceCookie(request,env){const token=await verifiedDevice(request,env)||id();return '__Host-student_device='+token+'.'+await keyedHash(env,'student-device\0'+token)+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800';}

async function limitedBody(request,max=12000){
 if(Number(request.headers.get('content-length')||0)>max)fail('ข้อมูลมีขนาดใหญ่เกินกำหนด',413);
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();let size=0;const chunks=[];
 for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();fail('ข้อมูลมีขนาดใหญ่เกินกำหนด',413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}
async function body(request){try{return JSON.parse(new TextDecoder().decode(await limitedBody(request)));}catch(e){if(e instanceof AccessError)throw e;fail('ข้อมูลไม่ถูกต้อง');}}
function originCheck(request){if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==new URL(request.url).origin)fail('คำขอไม่ถูกต้อง',403);}
async function rate(env,request,scope,limit=60){
 const ip=request.headers.get('cf-connecting-ip')||'local';
 const key=await hash(`${scope}\0${scope==='global-join'||scope.startsWith('account:')||scope.startsWith('upload:')||scope.startsWith('device:')?'global':ip}\0${env.AUTH0_CLIENT_SECRET}`), expiry=now()+600000;
 const r=await env.DB.prepare(`INSERT INTO student_access_attempts(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`).bind(key,expiry,now(),now()).first();
 if(r.count>limit)fail('ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',429);
}
export async function portalSession(request,env){
 const token=request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-classroom_student=([^;]+)/)?.[1];if(!token)return null;
 return env.DB.prepare(`SELECT s.*,i.name,i.email,i.verified FROM student_portal_sessions s LEFT JOIN student_identities i ON i.sub=s.sub WHERE token_hash=? AND expires_at>?`).bind(await hash(token),now()).first();
}
async function issueSession(env,sub=null,student=null,room=null){
 const token=id()+id();await env.DB.prepare('INSERT INTO student_portal_sessions(token_hash,sub,student_id,classroom_id,expires_at,created_at) VALUES(?,?,?,?,?,?)').bind(await hash(token),sub,student,room,now()+7*DAY,now()).run();return token;
}
export async function studentAuthCallback(env,profile,origin){
 if(!profile.sub)throw Error('Missing subject');
 await env.DB.prepare(`INSERT INTO student_identities(sub,name,email,verified) VALUES(?,?,?,?) ON CONFLICT(sub) DO UPDATE SET name=excluded.name,email=excluded.email,verified=excluded.verified`).bind(profile.sub,text(profile.name),text(profile.email,254).toLowerCase(),profile.emailVerified?1:0).run();
 const token=await issueSession(env,profile.sub);
 const headers=new Headers({location:origin+'/student','cache-control':'no-store'});headers.append('set-cookie',cookie(token));headers.append('set-cookie','classroom_auth_state=; Path=/api/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
 return new Response(null,{status:302,headers});
}
// Existing teachers/owners take precedence. Merely visiting /student does not remove teacher rights.
export async function shouldRouteStudent(db,auth){
 const owner=await db.prepare('SELECT 1 FROM classrooms WHERE tenant_key=? LIMIT 1').bind(`user:${auth.sub}`).first();
 const staff=auth.emailVerified&&await db.prepare('SELECT 1 FROM school_members WHERE email=? AND active=1 LIMIT 1').bind(auth.email).first();
 if(owner||staff||(auth.auth0Admin&&auth.schoolVerified))return false;
 const known=await db.prepare('SELECT 1 FROM student_applications WHERE sub=? LIMIT 1').bind(auth.sub).first();
 if(known)return true;
 if(auth.schoolDomain&&auth.emailVerified){const setting=await db.prepare('SELECT auto_domain FROM student_access_settings WHERE tenant_key=?').bind(auth.tenantKey).first();return Boolean(setting?.auto_domain);}
 return false;
}
async function policy(env,room){
 const settings=await env.DB.prepare('SELECT * FROM student_access_settings WHERE tenant_key=?').bind(room.tenant_key).first();
 if(!settings)return {mode:'auth',require_evidence:0,allow_private:0,enabled:false};
 const override=await env.DB.prepare('SELECT * FROM student_class_access WHERE classroom_id=?').bind(room.id).first();
 return {...settings,...(settings.allow_override&&override?.mode?override:{}),enabled:true};
}
async function findInvite(env,code){
 const normalized=String(code||'').replace(/[\s-]/g,'');if(!/^\d{16}$/.test(normalized))return null;
 return env.DB.prepare(`SELECT i.*,c.name FROM student_invites i JOIN classrooms c ON c.id=i.classroom_id WHERE i.token_hash=? AND i.revoked=0 AND i.expires_at>?`).bind(await codeHash(env,normalized),now()).first();
}
async function matchStudent(env,inv,code){return env.DB.prepare(`SELECT p.id FROM student_profiles p JOIN classroom_enrollments e ON e.student_id=p.id WHERE p.tenant_key=? AND p.student_code=? AND p.active=1 AND e.classroom_id=? AND e.active=1`).bind(inv.tenant_key,text(code,80),inv.classroom_id).first();}
async function join(request,env,session){
 const b=await body(request);await rate(env,request,'global-join',20000);await rate(env,request,'join',90);const device=await verifiedDevice(request,env);if(device)await rate(env,request,'device:'+device,60);await rate(env,request,'pair:'+await hash(text(b.room_code,40)+':'+text(b.student_code,80)),8);
 const inv=await findInvite(env,b.room_code);if(!inv)fail();
 const student=await matchStudent(env,inv,b.student_code);if(!student||(inv.student_id&&inv.student_id!==student.id))fail();
 const p=await policy(env,{id:inv.classroom_id,tenant_key:inv.tenant_key});
 if(!p.enabled)fail();
 if(p.mode==='code')return reply({ok:true,mode:'code'},200,await issueSession(env,null,student.id,inv.classroom_id));
 if(!session?.sub||!session.verified)fail();
 await rate(env,request,'account:'+session.sub,20);
 const binding=await env.DB.prepare('SELECT * FROM student_account_bindings WHERE tenant_key=? AND (student_id=? OR sub=?)').bind(inv.tenant_key,student.id,session.sub).first();
 if(binding&&(binding.student_id!==student.id||binding.sub!==session.sub||!binding.active))fail('กรุณาติดต่อครูเพื่อตรวจสอบบัญชี',409);
 const application=id();
 await env.DB.prepare(`INSERT INTO student_applications(id,tenant_key,classroom_id,student_id,sub,status,require_evidence,created_at) VALUES(?,?,?,?,?,'pending',?,?) ON CONFLICT(classroom_id,student_id,sub) DO UPDATE SET status='pending',require_evidence=excluded.require_evidence,created_at=excluded.created_at,reviewed_at=NULL,reviewed_by=NULL WHERE student_applications.status IN ('rejected','cancelled','expired') AND NOT EXISTS(SELECT 1 FROM student_evidence e WHERE e.application_id=student_applications.id AND e.state<>'deleted')`).bind(application,inv.tenant_key,inv.classroom_id,student.id,session.sub,p.require_evidence,now()).run();
 const submitted=await env.DB.prepare('SELECT status FROM student_applications WHERE classroom_id=? AND student_id=? AND sub=?').bind(inv.classroom_id,student.id,session.sub).first();
 if(!['pending','more','approved'].includes(submitted?.status))fail('กำลังลบหลักฐานคำขอเดิม กรุณารอสักครู่แล้วสมัครใหม่',409);
 return reply({ok:true,mode:'auth'});
}
async function myContext(env,session){
 if(!session)return reply({authenticated:false});
 if(!session.sub){
  const room=await env.DB.prepare(`SELECT c.*,p.name student_name FROM classrooms c JOIN classroom_enrollments e ON e.classroom_id=c.id JOIN student_profiles p ON p.id=e.student_id WHERE c.id=? AND p.id=? AND p.active=1 AND e.active=1`).bind(session.classroom_id,session.student_id).first();
  if(!room||(await policy(env,room)).mode!=='code')return reply({authenticated:false},200,'');
  return reply({authenticated:true,mode:'code',name:room.student_name,rooms:[{id:room.id,name:room.name}],applications:[],staff:false});
 }
 if(!session.verified)return reply({authenticated:true,mode:'auth',verified:false,name:session.name,rooms:[],applications:[],staff:false});
 const rooms=rows(await env.DB.prepare(`SELECT c.id,c.name FROM student_room_members m JOIN classrooms c ON c.id=m.classroom_id JOIN student_account_bindings b ON b.student_id=m.student_id AND b.tenant_key=c.tenant_key AND b.sub=m.sub JOIN student_profiles p ON p.id=m.student_id JOIN classroom_enrollments e ON e.classroom_id=c.id AND e.student_id=m.student_id WHERE m.sub=? AND m.reauth_after<=? AND m.active=1 AND b.active=1 AND p.active=1 AND e.active=1`).bind(session.sub,session.created_at).all());
 const applications=rows(await env.DB.prepare(`SELECT a.id,a.status,a.require_evidence,a.created_at,c.name classroom_name FROM student_applications a JOIN classrooms c ON c.id=a.classroom_id WHERE a.sub=? ORDER BY a.created_at DESC LIMIT 100`).bind(session.sub).all());
 for(const app of applications)app.evidence=rows(await env.DB.prepare(`SELECT id,expires_at,state FROM student_evidence WHERE application_id=? AND state<>'deleted'`).bind(app.id).all());
 const staff=await env.DB.prepare('SELECT 1 FROM student_review_teachers WHERE sub=? LIMIT 1').bind(session.sub).first();
 return reply({authenticated:true,mode:'auth',verified:Boolean(session.verified),name:session.name,rooms,applications,staff:Boolean(staff)});
}
async function ownApplication(env,session,application){
 if(!session?.sub||!session.verified)fail('กรุณาเข้าสู่ระบบและยืนยันอีเมล',401);
 const app=await env.DB.prepare('SELECT * FROM student_applications WHERE id=? AND sub=?').bind(application,session.sub).first();if(!app)fail('ไม่พบคำขอ',404);return app;
}
export function imageType(bytes){
 const sizeOK=(w,h)=>w>0&&h>0&&w<=16000&&h<=16000&&w*h<=40000000;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(bytes.length>=33&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)){
  let at=8,header=false,data=false;
  while(at+12<=bytes.length){const length=view.getUint32(at),kind=String.fromCharCode(...bytes.slice(at+4,at+8));if(at+12+length>bytes.length)return '';
   if(at===8){if(kind!=='IHDR'||length!==13||!sizeOK(view.getUint32(at+8),view.getUint32(at+12)))return '';header=true;}
   if(kind==='IDAT'&&length>0)data=true;
   if(kind==='IEND')return header&&data&&length===0&&at+12===bytes.length?'image/png':'';
   at+=12+length;
  }return '';
 }
 if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216){
  let at=2,frame=false,scan=false;
  while(at<bytes.length){if(bytes[at++]!==255)return '';while(bytes[at]===255)at++;const marker=bytes[at++];
   if(marker===217)return frame&&scan&&at===bytes.length?'image/jpeg':'';
   if(at+2>bytes.length)return '';const length=view.getUint16(at);if(length<2||at+length>bytes.length)return '';
   if([192,193,194].includes(marker)){if(length<8||!sizeOK(view.getUint16(at+5),view.getUint16(at+3)))return '';frame=true;}
   at+=length;
   if(marker===218){scan=true;let found=false;while(at<bytes.length-1){if(bytes[at]===255&&bytes[at+1]!==0&&!(bytes[at+1]>=208&&bytes[at+1]<=215)){found=true;break;}at+=bytes[at]===255?2:1;}if(!found)return '';}
  }
 }
 return '';
}

async function upload(request,env,session,application){
 const app=await ownApplication(env,session,application);if(!['pending','more'].includes(app.status))fail('คำขอนี้ไม่รับหลักฐานแล้ว',409);
 await rate(env,request,'upload:'+session.sub,12);
 const isText=(request.headers.get('content-type')||'').startsWith('text/plain');const bytes=await limitedBody(request,isText?8000:MAX_FILE),mime=isText?'text/plain':imageType(bytes);if(!mime||!bytes.length)fail('รองรับภาพ PNG/JPEG ไม่เกิน 2 MB หรือข้อความไม่เกิน 8 KB');
 const evidence=id(),key='student-evidence/'+evidence,created=now();
 const added=await env.DB.prepare(`INSERT INTO student_evidence(id,application_id,object_key,mime,bytes,created_at,expires_at) SELECT ?,id,?,?,?,?,? FROM student_applications WHERE id=? AND status IN ('pending','more') AND (SELECT COUNT(*) FROM student_evidence WHERE application_id=? AND state IN ('uploading','ready'))<3`).bind(evidence,key,mime,bytes.length,created,created+7*DAY,app.id,app.id).run();
 if(!added.meta.changes)fail('รับได้สูงสุด 3 ภาพต่อคำขอ หรือคำขอถูกปิดแล้ว',409);
 try{
  await env.EXPORTS.put(key,bytes,{httpMetadata:{contentType:mime,cacheControl:'no-store'}});
  const saved=await env.DB.prepare(`UPDATE student_evidence SET state='ready' WHERE id=? AND state='uploading' AND expires_at>? AND EXISTS(SELECT 1 FROM student_applications WHERE id=? AND status IN ('pending','more'))`).bind(evidence,now(),app.id).run();
  if(!saved.meta.changes){await env.EXPORTS.delete(key);fail('คำขอถูกปิดแล้ว กรุณาโหลดหน้าใหม่',409);}
 }catch(e){await env.DB.prepare("UPDATE student_evidence SET state='revoked' WHERE id=?").bind(evidence).run();try{await env.EXPORTS.delete(key);}catch{}throw e;}
 // If review raced with the upload, this second check prevents a late object surviving deletion.
 const valid=await env.DB.prepare(`SELECT 1 FROM student_evidence e JOIN student_applications a ON a.id=e.application_id WHERE e.id=? AND e.state='ready' AND a.status IN ('pending','more') AND e.expires_at>?`).bind(evidence,now()).first();
 if(!valid){await env.EXPORTS.delete(key);await env.DB.prepare("UPDATE student_evidence SET state='deleted' WHERE id=?").bind(evidence).run();}
 return reply({ok:true});
}
// Deletion failures are persisted as revoked and retried; never log object content or student identifiers.
export async function cleanupStudentEvidence(env){
 const t=now(),cutoff=t+60000; // Purge in the minute before the maximum retention deadline.
 await env.DB.batch([
  env.DB.prepare(`UPDATE student_applications SET status='expired' WHERE status IN ('pending','more') AND EXISTS(SELECT 1 FROM student_evidence e WHERE e.application_id=student_applications.id AND e.expires_at<=? AND e.state<>'deleted')`).bind(cutoff),
  env.DB.prepare(`UPDATE student_evidence SET state='revoked' WHERE state IN ('uploading','ready') AND (expires_at<=? OR (state='uploading' AND created_at<?) OR EXISTS(SELECT 1 FROM student_applications a WHERE a.id=application_id AND a.status NOT IN ('pending','more')) OR NOT EXISTS(SELECT 1 FROM student_applications a WHERE a.id=application_id))` ).bind(cutoff,t-600000)
 ]);
 const doomed=rows(await env.DB.prepare("SELECT id,object_key,created_at FROM student_evidence WHERE state='revoked' ORDER BY expires_at LIMIT 100").all());
 let failed=0;for(const row of doomed){try{await env.EXPORTS.delete(row.object_key);if(row.created_at<t-600000)await env.DB.prepare("UPDATE student_evidence SET state='deleted' WHERE id=? AND state='revoked'").bind(row.id).run();}catch{failed++;}}
 if(failed)console.error(JSON.stringify({event:'student_evidence_delete_retry',count:failed}));
 await env.DB.batch([env.DB.prepare('DELETE FROM student_portal_sessions WHERE expires_at<=?').bind(t),env.DB.prepare('DELETE FROM student_access_attempts WHERE expires_at<=?').bind(t)]);
}
async function purgeApplication(env,application){
 await env.DB.prepare("UPDATE student_evidence SET state='revoked' WHERE application_id=? AND state<>'deleted'").bind(application).run();
 const evidence=rows(await env.DB.prepare("SELECT id,object_key,created_at FROM student_evidence WHERE application_id=? AND state='revoked'").bind(application).all());
 for(const e of evidence){try{await env.EXPORTS.delete(e.object_key);if(e.created_at<now()-600000)await env.DB.prepare("UPDATE student_evidence SET state='deleted' WHERE id=?").bind(e.id).run();}catch{console.error('{"event":"student_evidence_delete_retry"}');}}
}
async function staffAccess(request,env,session,helpers){
 const legacy=await helpers.authorize(request,env);
 if(legacy&&!await shouldRouteStudent(env.DB,legacy)){
  const auth=await helpers.resolveSchoolAccess(env.DB,legacy);
  if(auth.canManageRoster)return {sub:auth.sub,tenant:auth.tenantKey,admin:true};
  // Existing school teachers must be explicitly assigned to review a room.
  if(auth.schoolAccess){const assigned=await env.DB.prepare('SELECT 1 FROM student_review_teachers WHERE sub=? LIMIT 1').bind(auth.sub).first();if(assigned)return {sub:auth.sub,admin:false};}
 }
 if(session?.sub&&session.verified){const assigned=await env.DB.prepare('SELECT 1 FROM student_review_teachers WHERE sub=? LIMIT 1').bind(session.sub).first();if(assigned)return {sub:session.sub,admin:false};}
 fail('ไม่มีสิทธิ์จัดการนักเรียน',403);
}
async function managedRoom(env,staff,roomId){
 const room=await env.DB.prepare('SELECT * FROM classrooms WHERE id=?').bind(Number(roomId)||0).first();
 if(!room)fail('ไม่พบห้องเรียน',404);
 if(staff.admin){if(room.tenant_key!==staff.tenant)fail('ไม่มีสิทธิ์ในห้องเรียนนี้',403);}
 else if(!await env.DB.prepare('SELECT 1 FROM student_review_teachers WHERE classroom_id=? AND sub=? AND tenant_key=?').bind(room.id,staff.sub,room.tenant_key).first())fail('ไม่มีสิทธิ์ในห้องเรียนนี้',403);
 return room;
}
async function staffContext(env,staff){
 const classes=staff.admin?rows(await env.DB.prepare('SELECT id,name FROM classrooms WHERE tenant_key=?').bind(staff.tenant).all()):rows(await env.DB.prepare('SELECT c.id,c.name FROM classrooms c JOIN student_review_teachers t ON t.classroom_id=c.id WHERE t.sub=?').bind(staff.sub).all());
 const settings=staff.admin?await env.DB.prepare('SELECT * FROM student_access_settings WHERE tenant_key=?').bind(staff.tenant).first():null;
 return reply({admin:staff.admin,classes,settings:settings||{mode:'auth',allow_override:0,require_evidence:0,allow_private:0,auto_domain:0},school:staff.admin&&staff.tenant.startsWith('school:')});
}
async function roomContext(env,staff,roomId){
 const room=await managedRoom(env,staff,roomId);
 const applications=rows(await env.DB.prepare(`SELECT a.*,p.name,p.student_code,i.email FROM student_applications a JOIN student_profiles p ON p.id=a.student_id JOIN student_identities i ON i.sub=a.sub WHERE a.classroom_id=? ORDER BY a.created_at DESC LIMIT 200`).bind(room.id).all());
 for(const a of applications)a.evidence=rows(await env.DB.prepare("SELECT id,expires_at,state FROM student_evidence WHERE application_id=? AND state<>'deleted'").bind(a.id).all());
 const invites=rows(await env.DB.prepare('SELECT id,student_id,expires_at,revoked,created_at FROM student_invites WHERE classroom_id=? ORDER BY created_at DESC LIMIT 100').bind(room.id).all());
 const members=rows(await env.DB.prepare(`SELECT m.sub,m.student_id,m.active,p.name,p.student_code,i.email FROM student_room_members m JOIN student_profiles p ON p.id=m.student_id JOIN student_identities i ON i.sub=m.sub WHERE m.classroom_id=?`).bind(room.id).all());
 const teachers=rows(await env.DB.prepare('SELECT t.sub,i.name,i.email FROM student_review_teachers t JOIN student_identities i ON i.sub=t.sub WHERE classroom_id=?').bind(room.id).all());
 const pendingDeletion=await env.DB.prepare(`SELECT COUNT(*) n FROM student_evidence e JOIN student_applications a ON a.id=e.application_id WHERE a.classroom_id=? AND e.state='revoked'`).bind(room.id).first();
 const students=rows(await env.DB.prepare('SELECT p.id,p.name,p.student_code FROM student_profiles p JOIN classroom_enrollments e ON e.student_id=p.id WHERE e.classroom_id=? AND e.active=1 AND p.active=1').bind(room.id).all());
 const override=await env.DB.prepare('SELECT * FROM student_class_access WHERE classroom_id=?').bind(room.id).first();
 return reply({room:{id:room.id,name:room.name},policy:await policy(env,room),override,students,applications,invites,members,teachers,pendingDeletion:pendingDeletion.n});
}
async function review(env,staff,b){
 const a=await env.DB.prepare('SELECT * FROM student_applications WHERE id=?').bind(text(b.id)).first();if(!a)fail('ไม่พบคำขอ',404);
 await managedRoom(env,staff,a.classroom_id);if(!staff.admin&&staff.sub===a.sub)fail('ให้ผู้ดูแลตรวจคำขอของคุณ',403);if(!['pending','more'].includes(a.status))fail('คำขอถูกดำเนินการแล้ว',409);
 if(!['approved','rejected','more'].includes(b.status))fail('สถานะไม่ถูกต้อง');
 if(b.status==='approved'){
  const proof=await env.DB.prepare(`SELECT 1 FROM student_evidence WHERE application_id=? AND state='ready' AND expires_at>? LIMIT 1`).bind(a.id,now()).first();
  if(a.require_evidence&&!proof)fail('ต้องมีหลักฐานที่ยังไม่หมดอายุ',409);
  // All predicates repeat inside the transaction: a concurrent reviewer cannot overwrite a decision.
  const eligibility=`SELECT 1 FROM student_applications a JOIN student_profiles p ON p.id=a.student_id JOIN classroom_enrollments ce ON ce.student_id=p.id AND ce.classroom_id=a.classroom_id WHERE a.id=? AND a.status IN ('pending','more') AND p.active=1 AND ce.active=1 AND (a.require_evidence=0 OR EXISTS(SELECT 1 FROM student_evidence e WHERE e.application_id=a.id AND e.state='ready' AND e.expires_at>?)) AND NOT EXISTS(SELECT 1 FROM student_evidence e WHERE e.application_id=a.id AND e.state<>'deleted' AND e.expires_at<=?)`;
  const t=now();
  await env.DB.batch([
   env.DB.prepare(`INSERT OR IGNORE INTO student_account_bindings(tenant_key,student_id,sub,created_at) SELECT ?,?,?,? WHERE EXISTS(${eligibility})`).bind(a.tenant_key,a.student_id,a.sub,t,a.id,t,t),
   env.DB.prepare(`UPDATE student_applications SET status='approved',reviewed_by=?,reviewed_at=? WHERE id=? AND EXISTS(${eligibility}) AND EXISTS(SELECT 1 FROM student_account_bindings WHERE tenant_key=? AND student_id=? AND sub=? AND active=1)`).bind(staff.sub,t,a.id,a.id,t,t,a.tenant_key,a.student_id,a.sub),
   env.DB.prepare(`INSERT INTO student_room_members(classroom_id,student_id,sub,active) SELECT classroom_id,student_id,sub,1 FROM student_applications WHERE id=? AND status='approved' ON CONFLICT(classroom_id,sub) DO UPDATE SET active=1 WHERE student_id=excluded.student_id`).bind(a.id),
   env.DB.prepare(`UPDATE student_evidence SET state='revoked' WHERE application_id=? AND state<>'deleted' AND EXISTS(SELECT 1 FROM student_applications WHERE id=? AND status='approved')`).bind(a.id,a.id)
  ]);
  const after=await env.DB.prepare('SELECT status FROM student_applications WHERE id=?').bind(a.id).first();if(after.status!=='approved')fail('อนุมัติไม่ได้: บัญชีซ้ำ หลักฐานหมดอายุ หรือทะเบียนเปลี่ยน กรุณาตรวจใหม่',409);
 }else await env.DB.prepare("UPDATE student_applications SET status=?,require_evidence=CASE WHEN ?='more' THEN 1 ELSE require_evidence END,reviewed_by=?,reviewed_at=? WHERE id=? AND status IN ('pending','more')").bind(b.status,b.status,staff.sub,now(),a.id).run();
 if(b.status!=='more')await purgeApplication(env,a.id);
 return reply({ok:true});
}
async function staffApi(request,env,session,helpers,path,url){
 const staff=await staffAccess(request,env,session,helpers);
 if(path==='/api/student-admin/context')return staffContext(env,staff);
 if(path==='/api/student-admin/room')return roomContext(env,staff,url.searchParams.get('id'));
 if(path==='/api/student-admin/evidence'){
  const e=await env.DB.prepare(`SELECT e.*,a.classroom_id,a.status FROM student_evidence e JOIN student_applications a ON a.id=e.application_id WHERE e.id=?`).bind(url.searchParams.get('id')).first();
  if(!e)fail('ไม่พบหลักฐาน',404);await managedRoom(env,staff,e.classroom_id);
  if(e.state!=='ready'||e.expires_at<=now()||!['pending','more'].includes(e.status))fail('หลักฐานถูกลบหรือหมดอายุแล้ว',410);
  const object=await env.EXPORTS.get(e.object_key);if(!object)fail('ไม่พบหลักฐาน',404);
  // Recheck after storage read to close the approval/delete race.
  const valid=await env.DB.prepare(`SELECT 1 FROM student_evidence e JOIN student_applications a ON a.id=e.application_id WHERE e.id=? AND e.state='ready' AND e.expires_at>? AND a.status IN ('pending','more')`).bind(e.id,now()).first();if(!valid)fail('หลักฐานถูกลบแล้ว',410);
  return new Response(object.body,{headers:{'content-type':e.mime,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'content-disposition':'attachment; filename="evidence.'+(e.mime==='image/png'?'png':e.mime==='text/plain'?'txt':'jpg')+'"'}});
 }
 const b=await body(request);
 if(path==='/api/student-admin/settings'){
  if(!staff.admin)fail('เฉพาะผู้ดูแลพื้นที่',403);if(!['auth','code'].includes(b.mode))fail();
  await env.DB.prepare(`INSERT INTO student_access_settings(tenant_key,mode,allow_override,require_evidence,allow_private,auto_domain) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_key) DO UPDATE SET mode=excluded.mode,allow_override=excluded.allow_override,require_evidence=excluded.require_evidence,allow_private=excluded.allow_private,auto_domain=excluded.auto_domain`).bind(staff.tenant,b.mode,b.allow_override?1:0,b.require_evidence?1:0,b.allow_private?1:0,staff.tenant.startsWith('school:')&&b.auto_domain?1:0).run();return reply({ok:true});
 }
 if(path==='/api/student-admin/review')return review(env,staff,b);
 const room=await managedRoom(env,staff,b.classroom_id);
 if(path==='/api/student-admin/room-settings'){
  const p=await policy(env,room);if(!p.allow_override)fail('พื้นที่ไม่อนุญาตให้ตั้งค่ารายห้อง',403);if(!['auth','code','inherit'].includes(b.mode))fail();
  await env.DB.prepare(`INSERT INTO student_class_access(classroom_id,mode,require_evidence,allow_private) VALUES(?,?,?,?) ON CONFLICT(classroom_id) DO UPDATE SET mode=excluded.mode,require_evidence=excluded.require_evidence,allow_private=excluded.allow_private`).bind(room.id,b.mode==='inherit'?null:b.mode,b.require_evidence?1:0,b.allow_private?1:0).run();return reply({ok:true});
 }
 if(path==='/api/student-admin/invite'){
  const p=await policy(env,room);if(!p.enabled)fail('บันทึกวิธีเข้าระดับพื้นที่ก่อน');
  const student=b.student_id?await env.DB.prepare('SELECT 1 FROM classroom_enrollments WHERE classroom_id=? AND student_id=? AND active=1').bind(room.id,Number(b.student_id)).first():true;if(!student)fail('ไม่พบผู้เรียนในห้อง');
  const days=Math.min(30,Math.max(1,Number(b.days)||7));
  // Rotating revokes all previous room invites atomically; members are untouched.
  for(let attempt=0;attempt<5;attempt++){
   const code=roomCode(),inviteId=id();try{await env.DB.batch([...(b.rotate?[env.DB.prepare('UPDATE student_invites SET revoked=1 WHERE classroom_id=?').bind(room.id)]:[]),env.DB.prepare('INSERT INTO student_invites(id,tenant_key,classroom_id,token_hash,student_id,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(inviteId,room.tenant_key,room.id,await codeHash(env,code),b.student_id?Number(b.student_id):null,now()+days*DAY,staff.sub,now())]);return reply({ok:true,code,url:url.origin+'/student#invite='+code});}catch(e){if(!String(e.message).includes('UNIQUE'))throw e;}
  }fail('สร้างรหัสไม่สำเร็จ กรุณาลองใหม่',503);
 }
 if(path==='/api/student-admin/revoke-invite'){await env.DB.prepare('UPDATE student_invites SET revoked=1 WHERE id=? AND classroom_id=?').bind(text(b.id),room.id).run();return reply({ok:true});}
 if(path==='/api/student-admin/guest-signout'){
  const member=await env.DB.prepare('SELECT 1 FROM classroom_enrollments WHERE classroom_id=? AND student_id=?').bind(room.id,Number(b.student_id)||0).first();if(!member)fail('ไม่พบผู้เรียน',404);await env.DB.prepare('DELETE FROM student_portal_sessions WHERE classroom_id=? AND student_id=?').bind(room.id,Number(b.student_id)).run();return reply({ok:true});
 }
 if(path==='/api/student-admin/member'){
  if(!staff.admin)fail('เฉพาะผู้ดูแลพื้นที่',403);
  if(['revoke','restore','reauth','reset-binding'].includes(b.action)){
   const target=await env.DB.prepare('SELECT 1 FROM student_room_members WHERE classroom_id=? AND student_id=?').bind(room.id,Number(b.student_id)||0).first();if(!target)fail('ไม่พบสมาชิกในห้อง',404);
  }
  if(b.action==='reauth'){
   await env.DB.prepare('UPDATE student_room_members SET reauth_after=? WHERE classroom_id=? AND student_id=?').bind(now(),room.id,Number(b.student_id)).run();
  }else if(b.action==='restore'){
   await env.DB.prepare('UPDATE student_room_members SET active=1 WHERE classroom_id=? AND student_id=?').bind(room.id,Number(b.student_id)).run();
  }else if(b.action==='revoke'){
   await env.DB.batch([env.DB.prepare('UPDATE student_room_members SET active=0 WHERE classroom_id=? AND student_id=?').bind(room.id,Number(b.student_id)),env.DB.prepare('DELETE FROM student_portal_sessions WHERE classroom_id=? AND student_id=?').bind(room.id,Number(b.student_id))]);
  }else if(b.action==='teacher'||b.action==='remove-teacher'){
   const account=await env.DB.prepare('SELECT 1 FROM student_identities i WHERE i.sub=? AND (EXISTS(SELECT 1 FROM student_applications a WHERE a.sub=i.sub AND a.tenant_key=?) OR EXISTS(SELECT 1 FROM student_review_teachers t WHERE t.sub=i.sub AND t.tenant_key=?))').bind(text(b.sub),room.tenant_key,room.tenant_key).first();if(!account)fail('ให้บัญชีเข้าสู่หน้านักเรียนผ่าน Auth0 ก่อน');
   if(b.action==='teacher')await env.DB.prepare('INSERT OR IGNORE INTO student_review_teachers(tenant_key,classroom_id,sub) VALUES(?,?,?)').bind(room.tenant_key,room.id,text(b.sub)).run();
   else await env.DB.prepare('DELETE FROM student_review_teachers WHERE classroom_id=? AND sub=?').bind(room.id,text(b.sub)).run();
  }else if(b.action==='reset-binding'){
   await env.DB.batch([env.DB.prepare('DELETE FROM student_room_members WHERE student_id=? AND classroom_id IN (SELECT id FROM classrooms WHERE tenant_key=?)').bind(Number(b.student_id),room.tenant_key),env.DB.prepare('DELETE FROM student_account_bindings WHERE tenant_key=? AND student_id=?').bind(room.tenant_key,Number(b.student_id)),env.DB.prepare('DELETE FROM student_portal_sessions WHERE student_id=? OR sub IN (SELECT sub FROM student_applications WHERE tenant_key=? AND student_id=?)').bind(Number(b.student_id),room.tenant_key,Number(b.student_id)),env.DB.prepare("UPDATE student_applications SET status='cancelled' WHERE tenant_key=? AND student_id=?").bind(room.tenant_key,Number(b.student_id))]);
   const apps=rows(await env.DB.prepare('SELECT id FROM student_applications WHERE tenant_key=? AND student_id=?').bind(room.tenant_key,Number(b.student_id)).all());for(const a of apps)await purgeApplication(env,a.id);
  }else fail('คำสั่งไม่ถูกต้อง');return reply({ok:true});
 }
 fail('ไม่พบเส้นทาง',404);
}
export function isStudentApi(path,method){
 const gets=['/api/student/me','/api/student-admin/context','/api/student-admin/room','/api/student-admin/evidence'];
 const posts=['/api/student/join','/api/student/logout','/api/student/cancel','/api/student-admin/settings','/api/student-admin/room-settings','/api/student-admin/invite','/api/student-admin/revoke-invite','/api/student-admin/review','/api/student-admin/member','/api/student-admin/guest-signout'];
 return method==='GET'&&gets.includes(path)||method==='POST'&&(posts.includes(path)||/^\/api\/student\/evidence\/[a-f0-9-]{36}$/.test(path));
}
export async function handleStudentApi(request,env,ctx,helpers){
 try{
  const url=new URL(request.url),path=url.pathname;originCheck(request);
  const session=await portalSession(request,env);
  if(path.startsWith('/api/student-admin/'))return await staffApi(request,env,session,helpers,path,url);
  if(path==='/api/student/me')return await myContext(env,session);
  if(path==='/api/student/join')return await join(request,env,session);
  if(path==='/api/student/logout'){if(session)await env.DB.prepare('DELETE FROM student_portal_sessions WHERE token_hash=?').bind(session.token_hash).run();return reply({ok:true},200,'');}
  if(path.startsWith('/api/student/evidence/'))return await upload(request,env,session,path.split('/').pop());
  if(path==='/api/student/cancel'){
   const b=await body(request),app=await ownApplication(env,session,text(b.id));
   await env.DB.prepare("UPDATE student_applications SET status='cancelled' WHERE id=? AND status IN ('pending','more','expired')").bind(app.id).run();await purgeApplication(env,app.id);return reply({ok:true});
  }
  return reply({error:'ไม่พบเส้นทาง'},404);
 }catch(e){if(e instanceof AccessError)return reply({error:e.message},e.status);console.error('{"event":"student_access_error"}');return reply({error:'ดำเนินการไม่สำเร็จ กรุณาลองใหม่'},500);}
}
