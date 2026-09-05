import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import {setup,apply,jpg} from './helpers.mjs';
import {handleStudentApi,cleanupStudentEvidence,studentDeviceCookie} from '../phase2a.js';
let source=readFileSync('worker.js','utf8').replace(/import (\w+) from "(.*\.(?:html|txt))";/g,(_,name,path)=>'const '+name+'='+JSON.stringify(readFileSync(path,'utf8'))+';');
source=source.replace('"./phase2a.js"',JSON.stringify(new URL('../phase2a.js',import.meta.url).href));
const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
function token(env,sub){const secret=createHash('sha256').update('sorasukt-classroom-session-v1\0'+env.AUTH0_CLIENT_SECRET).digest('hex');const body=Buffer.from(JSON.stringify({sub,name:sub,email:sub+'@gmail.com',emailVerified:true,exp:Date.now()/1000+3600})).toString('base64url');return body+'.'+createHmac('sha256',secret).update(body).digest('hex');}
test('actual Worker enforces student/teacher boundary and keeps unknown routes as 404',async()=>{const f=setup();await f.settings();await apply(f,await f.auth());const request=(path,headers={})=>new Request('https://classroom.test'+path,{headers});const ctx={waitUntil(){}};
 assert.equal((await worker.fetch(request('/api/classrooms',{authorization:'Bearer '+token(f.env,'student')}),f.env,ctx)).status,403);
 assert.equal((await worker.fetch(request('/api/session',{authorization:'Bearer '+token(f.env,'teacher')}),f.env,ctx)).status,200);
 assert.equal((await worker.fetch(request('/api/student/unknown'),f.env,ctx)).status,404);
 const page=await worker.fetch(request('/student'),f.env,ctx);assert.equal(page.status,200);assert.match(page.headers.get('set-cookie'),/__Host-student_device=/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('Auth0 callback validates state and sends student sessions only to /student without a teacher bearer',async()=>{const f=setup();f.env.AUTH0_DOMAIN='auth.example.org';f.env.AUTH0_CLIENT_ID='client';const ctx={waitUntil(){}};
 const start=await worker.fetch(new Request('https://classroom.test/api/auth/login?student=1'),f.env,ctx);const state=new URL(start.headers.get('location')).searchParams.get('state');assert.match(state,/~student$/);const csrf=start.headers.get('set-cookie').split(';')[0];
 const oldFetch=globalThis.fetch;globalThis.fetch=async url=>new Response(JSON.stringify(String(url).endsWith('/oauth/token')?{access_token:'test'}:{sub:'auth0|student',email:'student@gmail.com',name:'Student',email_verified:true}),{headers:{'content-type':'application/json'}});
 try{const callback=await worker.fetch(new Request('https://classroom.test/api/auth/callback?code=abc&state='+encodeURIComponent(state),{headers:{cookie:csrf}}),f.env,ctx);assert.equal(callback.headers.get('location'),'https://classroom.test/student');assert(callback.headers.getSetCookie().some(c=>c.startsWith('__Host-classroom_student=')));assert(!callback.headers.get('location').includes('#session='));
 const bad=await worker.fetch(new Request('https://classroom.test/api/auth/callback?code=abc&state=wrong',{headers:{cookie:csrf}}),f.env,ctx);assert(!bad.headers.getSetCookie().some(c=>c.startsWith('__Host-classroom_student=')));
 }finally{globalThis.fetch=oldFetch;}
});
test('sensitive text follows same private-storage and deletion policy as images',async()=>{const f=setup();await f.settings();const cookie=await f.auth();const app=await apply(f,cookie);const secret='<script>private evidence</script>';const r=await handleStudentApi(new Request('https://classroom.test/api/student/evidence/'+app.id,{method:'POST',headers:{origin:'https://classroom.test',cookie,'content-type':'text/plain'},body:secret}),f.env,{},{});assert.equal(r.status,200);const e=f.DB.db.prepare('SELECT * FROM student_evidence').get();assert.equal(e.mime,'text/plain');assert(!JSON.stringify(e).includes(secret));await f.call('/api/student/cancel',{id:app.id},{cookie});assert.equal(f.objects.size,0);});
test('classroom deletion leaves purge tombstones rather than orphaning evidence',async()=>{const f=setup();await f.settings();const cookie=await f.auth();const app=await apply(f,cookie);await f.call('/api/student/evidence/'+app.id,jpg,{cookie});f.DB.db.exec('DELETE FROM classrooms WHERE id=1');await cleanupStudentEvidence(f.env);assert.equal(f.objects.size,0);});
test('signed device identification cannot be forged and is HttpOnly',async()=>{const f=setup();const request=new Request('https://classroom.test/student');const c=await studentDeviceCookie(request,f.env);assert.match(c,/HttpOnly; Secure; SameSite=Lax/);const same=await studentDeviceCookie(new Request(request,{headers:{cookie:c.split(';')[0]}}),f.env);assert.equal(c,same);const forged=await studentDeviceCookie(new Request(request,{headers:{cookie:c.split(';')[0]+'bad'}}),f.env);assert.notEqual(c,forged);});
