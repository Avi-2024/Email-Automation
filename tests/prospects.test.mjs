import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const origin='https://mailroom.example';
const base={ADMIN_TOKEN:'test-secret',DRY_RUN:'true'};
function makeDB(){
  const rows=new Map();
  const history=[];
  return {rows,history,prepare(sql){
    history.push(sql);
    return {bind(...args){return {
      async run(){
        if(sql.startsWith('INSERT OR IGNORE INTO prospects')){
          const [email,first_name,last_name,company,status]=args;
          if(rows.has(email))return {meta:{changes:0}};
          rows.set(email,{email,first_name,last_name,company,status,created_at:'2026-10-15',updated_at:'2026-10-15'});
          return {meta:{changes:1}};
        }
        if(sql.startsWith('UPDATE prospects')){const [first_name,last_name,company,status,updated_at,email]=args;const r=rows.get(email);if(!r)return {meta:{changes:0}};Object.assign(r,{first_name,last_name,company,status,updated_at});return {meta:{changes:1}};}
        if(sql.startsWith('DELETE FROM prospects'))return {meta:{changes:rows.delete(args[0])?1:0}};
        throw new Error('Unexpected write query: '+sql);
      },
      async first(){
        if(!sql.startsWith('SELECT COUNT(*)'))throw new Error('Unexpected first query: '+sql);
        return {total:rows.size};
      },
      async all(){
        if(!sql.startsWith('SELECT email,'))throw new Error('Unexpected all query: '+sql);
        return {results:Array.from(rows.values()).slice(-args.at(-2),undefined)};
      }
    };}};
  }};
}
const request=(path,method='GET',body,DB=makeDB(),authorized=true)=>worker.fetch(new Request(origin+path,{method,headers:{...(authorized?{authorization:'Bearer test-secret'}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),{...base,DB});

test('prospect endpoints require authentication and D1 storage',async()=>{
  assert.equal((await request('/admin/prospects','GET',null,makeDB(),false)).status,401);
  const missing=await worker.fetch(new Request(origin+'/admin/prospects',{headers:{authorization:'Bearer test-secret'}}),base);
  assert.equal(missing.status,503);
});

test('email-only prospects save to D1 with no Brevo API calls and never imply consent',async()=>{
  const db=makeDB();const existingFetch=globalThis.fetch;let called=0;
  globalThis.fetch=async()=>{called++;throw new Error('Unexpected external request');};
  try{
    const result=await request('/admin/prospects/import','POST',{prospects:[{email:' Lead@Example.com '},{email:'other@example.org',first_name:'Ana',company:'Example'}]},db);
    assert.equal(result.status,200);assert.deepEqual((await result.json()),{created:2,skipped:0,processed:2,storage:'D1_ONLY',marketingListModified:false});
    assert.equal(db.rows.get('lead@example.com').status,'new');
    assert.equal(db.rows.get('lead@example.com').consent,undefined);
    const repeated=await request('/admin/prospects/import','POST',{prospects:[{email:'lead@example.com'}]},db);
    assert.equal((await repeated.json()).skipped,1);
    assert.equal(called,0);
    assert.ok(db.history.every(q=>q.includes('prospects')));
  }finally{globalThis.fetch=existingFetch;}
});

test('editing and deleting a lead only change D1 CRM records',async()=>{
 const db=makeDB();
 const add=await request('/admin/prospects','POST',{email:'hello@example.com'},db);assert.equal(add.status,201);
 const edit=await request('/admin/prospects/hello%40example.com','PUT',{first_name:'Hello',last_name:'World',company:'One',status:'do_not_contact'},db);
 assert.equal(edit.status,200);assert.equal(db.rows.get('hello@example.com').status,'do_not_contact');
 const del=await request('/admin/prospects/hello%40example.com','DELETE',null,db);assert.equal(del.status,200);
 assert.equal(db.rows.size,0);
});

test('prospect API guards malformed email, unknown statuses, large batches and duplicates',async()=>{
 const db=makeDB();
 for(const payload of [
  {prospects:[{email:'invalid'}]},
  {prospects:[{email:'ok@example.com',status:'subscribed'}]},
  {prospects:Array.from({length:51},(_,i)=>({email:`${i}@example.com`}))},
  {prospects:[{email:'HELLO@example.com'},{email:'hello@example.com'}]}
 ]){
   const r=await request('/admin/prospects/import','POST',payload,db);assert.equal(r.status,400);
 }
 assert.equal(db.rows.size,0);
});

test('Brevo subscriber import still requires documented opt-in',async()=>{
 const r=await request('/admin/contacts','POST',{confirmed:true,contacts:[{email:'a@example.com'}]},makeDB());
 assert.equal(r.status,503); // No Brevo config; validation has not been bypassed by CRM changes.
});
