import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {setup,apply} from './helpers.mjs';
const html=readFileSync('student.html','utf8');
async function waitFor(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not settle');}
function screen(f,{cookie='',staff=false,hash=''}={}){
 const errors=[];const console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM(html,{url:'https://classroom.test/student'+(staff?'#staff_session=teacher':hash),runScripts:'dangerously',virtualConsole:console,beforeParse(w){
  w.eval(readFileSync('vendor/qrcode.js.txt','utf8'));w.confirm=()=>true;w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.fetch=async(path,options={})=>{const r=await f.call(path,options.body?JSON.parse(options.body):undefined,{cookie,teacher:options.headers?.authorization==='Bearer teacher'});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return r;};
 }});return {dom,w:dom.window,errors};
}
test('teacher UI saves settings, creates an invite and approves a real application without losing button state',async()=>{const f=setup();await f.settings();const c=await f.auth();await apply(f,c);const {dom,w,errors}=screen(f,{staff:true});try{await waitFor(()=>w.document.querySelector('[data-review]'));assert.equal(w.document.querySelector('#staffView').classList.contains('hidden'),false);w.document.querySelector('#accessMode').value='auth';w.document.querySelector('#settingsForm').requestSubmit();await waitFor(()=>w.document.querySelector('#message').textContent==='บันทึกแล้ว');w.document.querySelector('#inviteForm').requestSubmit();await waitFor(()=>w.document.querySelector('#inviteOutput input'));assert.match(w.document.querySelector('#inviteOutput input').value,/student#invite=\d{16}$/);assert(w.document.querySelector('#inviteQr svg'));w.document.querySelector('[data-status="approved"]').click();await waitFor(()=>f.DB.db.prepare('SELECT status FROM student_applications').get().status==='approved');await waitFor(()=>w.document.querySelector('[data-member="revoke"]'));assert.equal(w.document.querySelector('[data-member="revoke"]').textContent,'ระงับสิทธิ์ห้องนี้');assert.deepEqual(errors,[]);}finally{dom.window.close();}});
test('student UI retains invite through login and direct entry shows only the enrolled room',async()=>{const f=setup();await f.settings('code');const invite=await f.invite();const {dom,w,errors}=screen(f,{hash:'#invite='+invite.code});try{await waitFor(()=>w.document.querySelector('#joinForm'));assert.equal(w.location.hash,'');assert.equal(w.document.querySelector('#roomCode').value,invite.code);w.document.querySelector('#studentCode').value='S001';w.document.querySelector('#joinForm').requestSubmit();await waitFor(()=>w.document.querySelector('#myRooms').textContent.includes('English'));assert(!w.document.querySelector('#myRooms').textContent.includes('Other school'));assert.deepEqual(errors,[]);}finally{dom.window.close();}});
test('student controlled names and status markup are escaped in the portal',async()=>{const f=setup();await f.settings();const c=await f.auth('<img src=x onerror=alert(1)>');await apply(f,c);const {dom,w,errors}=screen(f,{cookie:c});try{await waitFor(()=>w.document.querySelector('#myApplications article'));assert(!w.document.querySelector('#welcome img'));assert.deepEqual(errors,[]);}finally{dom.window.close();}});

test('multi-school home isolates school rooms, student codes and requests, including pending-only schools',async()=>{
 const f=setup(),cookie=await f.auth();
 f.DB.db.exec(`
 INSERT INTO tenant_settings(tenant_key,organization_name) VALUES('user:teacher','School A'),('school:other.ac.th','<img src=x onerror=alert(1)>School B'),('school:hidden.ac.th','Hidden school');
 UPDATE student_profiles SET student_code='B009' WHERE id=3;
 INSERT INTO student_account_bindings(tenant_key,student_id,sub,created_at) VALUES('user:teacher',1,'student',0),('school:other.ac.th',3,'student',0);
 INSERT INTO student_room_members(classroom_id,student_id,sub) VALUES(1,1,'student'),(2,3,'student');
 INSERT INTO classrooms(id,name,tenant_key) VALUES(3,'Pending room','school:pending.ac.th'),(4,'Hidden room','school:hidden.ac.th');
 INSERT INTO student_profiles(id,tenant_key,student_code,name) VALUES(4,'school:pending.ac.th','P001','Student');
 INSERT INTO student_applications(id,tenant_key,classroom_id,student_id,sub,status,created_at) VALUES('pending-app','school:pending.ac.th',3,4,'student','pending',0);
 `);
 const me=await (await f.call('/api/student/me',undefined,{cookie})).json();
 assert.equal(me.schools.length,3);assert.equal(me.rooms.length,2);
 assert(!JSON.stringify(me).includes('user:teacher'));assert(!JSON.stringify(me).includes('Hidden school'));
 assert.deepEqual(me.rooms.map(r=>r.student_code).sort(),['B009','S001']);
 const {dom,w,errors}=screen(f,{cookie});
 try{
  await waitFor(()=>w.document.querySelectorAll('[data-school]').length===3);
  assert.equal(w.document.querySelector('#schoolOverview img'),null);
  const schoolA=me.schools.find(s=>s.name==='School A'),schoolB=me.schools.find(s=>s.name.includes('School B')),pending=me.schools.find(s=>s.name==='pending.ac.th');
  w.document.querySelector('[data-school="'+schoolA.id+'"]').click();
  assert(w.document.querySelector('#myRooms').textContent.includes('S001'));
  assert(!w.document.querySelector('#myRooms').textContent.includes('B009'));
  assert.equal(w.document.querySelector('#myApplications').textContent,'');
  w.document.querySelector('[data-school="'+schoolB.id+'"]').click();
  assert(w.document.querySelector('#myRooms').textContent.includes('B009'));
  assert(!w.document.querySelector('#myRooms').textContent.includes('English'));
  w.document.querySelector('[data-school="'+pending.id+'"]').click();
  assert(w.document.querySelector('#myApplications').textContent.includes('Pending room'));
  assert(w.document.querySelector('#myRooms').textContent.includes('ยังไม่มีห้องเรียน'));
  w.document.querySelector('#allSchools').click();
  assert(w.document.querySelector('#myRooms').textContent.includes('English'));
  w.document.querySelector('#addSchool').click();assert(w.document.querySelector('#joinPanel').open);assert.equal(w.document.activeElement.id,'roomCode');
  assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
 f.DB.db.exec('UPDATE student_room_members SET active=0 WHERE classroom_id=2');
 const revoked=await (await f.call('/api/student/me',undefined,{cookie})).json();
 assert(!revoked.rooms.some(r=>r.student_code==='B009'));assert(!revoked.schools.some(s=>s.name.includes('School B')));
 const otherCookie=await f.auth('someone-else');
 const other=await (await f.call('/api/student/me',undefined,{cookie:otherCookie})).json();
 assert.deepEqual(other.schools,[]);assert.deepEqual(other.rooms,[]);assert.deepEqual(other.applications,[]);
});
