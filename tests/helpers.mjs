import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handleStudentApi,studentAuthCallback} from '../phase2a.js';
class D1 {
 constructor(){this.db=new DatabaseSync(':memory:');this.db.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())this.db.exec(readFileSync('migrations/'+file,'utf8'));}
 prepare(sql){const stmt=this.db.prepare(sql);let args=[];return {bind(...a){args=a;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:r.lastInsertRowid}};}};}
 async batch(statements){this.db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
export function setup(){
 const DB=new D1(),objects=new Map();let deleteFail=false;
 const env={DB,AUTH0_CLIENT_SECRET:'test-key',EXPORTS:{async put(k,v){objects.set(k,v);},async get(k){return objects.has(k)?{body:objects.get(k)}:null;},async delete(k){if(deleteFail)throw Error('storage unavailable');objects.delete(k);}}};
 DB.db.exec(`INSERT INTO classrooms(id,name,tenant_key) VALUES(1,'English','user:teacher'),(2,'Other school','school:other.ac.th');INSERT INTO student_profiles(id,tenant_key,student_code,name) VALUES(1,'user:teacher','S001','Alice'),(2,'user:teacher','S002','Bob'),(3,'school:other.ac.th','S001','Other');INSERT INTO classroom_enrollments(classroom_id,student_id) VALUES(1,1),(1,2),(2,3);`);
 const teacher={sub:'teacher',email:'teacher@example.org',emailVerified:true,tenantKey:'user:teacher',canManageRoster:true,schoolAccess:true};
 const helpers={authorize:async r=>r.headers.get('authorization')==='Bearer teacher'?teacher:null,resolveSchoolAccess:async(d,a)=>a};
 async function call(path,data,{cookie='',teacher=false,ip='127.0.0.1',origin='https://classroom.test',method}={}){const r=new Request('https://classroom.test'+path,{method:method||(data===undefined?'GET':'POST'),headers:{origin,'cf-connecting-ip':ip,...(teacher?{authorization:'Bearer teacher'}:{}),...(cookie?{cookie}:{}),'content-type':data instanceof Uint8Array?'application/octet-stream':'application/json'},body:data===undefined?undefined:data instanceof Uint8Array?data:JSON.stringify(data)});return handleStudentApi(r,env,{waitUntil(){}},helpers);}
 async function auth(sub='student',verified=true){const r=await studentAuthCallback(env,{sub,name:sub,email:sub+'@gmail.com',emailVerified:verified},'https://classroom.test');return r.headers.getSetCookie()[0].split(';')[0];}
 async function settings(mode='auth',extra={}){assert.equal((await call('/api/student-admin/settings',{mode,...extra},{teacher:true})).status,200);}
 async function invite(extra={}){const r=await call('/api/student-admin/invite',{classroom_id:1,...extra},{teacher:true});assert.equal(r.status,200,await r.clone().text());return r.json();}
 return {env,DB,call,auth,settings,invite,objects,failDeletes:v=>{deleteFail=v;}};
}
export const jpg=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
export async function apply(f,cookie,code='S001',room){room||=await f.invite();const r=await f.call('/api/student/join',{room_code:room.code,student_code:code},{cookie});assert.equal(r.status,200,await r.clone().text());const me=await (await f.call('/api/student/me',undefined,{cookie})).json();return me.applications[0];}
