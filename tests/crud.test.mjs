import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {normalizeCampaign} from '../src/helpers.js';

const origin = 'https://example.workers.dev';
const headers = {'Authorization':'Bearer test-admin-secret'};
const base = {ADMIN_TOKEN:'test-admin-secret',DRY_RUN:'true',BREVO_API_KEY:'test-key',BREVO_LIST_ID:'24'};
const call = (path,method='GET',body,env=base) => worker.fetch(new Request(`${origin}${path}`, {
  method, headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{})
}),env);
const withMockFetch=async(mock,callback)=>{
  const previous=globalThis.fetch;
  globalThis.fetch=mock;
  try{return await callback();}finally{globalThis.fetch=previous;}
};
const item = '/admin/contacts/pat%2Btag%40example.com';
const email = 'pat+tag@example.com';

test('edit contact updates ONLY names and respects list membership',async()=>{
  const calls=[];
  await withMockFetch(async(url,options)=>{
    calls.push({url:String(url),options});
    if(options.method==='GET')return Response.json({email,listIds:[24,99]});
    return new Response(null,{status:204});
  },async()=>{
    const r=await call(item,'PUT',{firstName:' Pat ',lastName:' Customer '});
    assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,email,firstName:'Pat',lastName:'Customer'});
  });
  assert.equal(calls.length,2);
  assert.equal(calls[1].options.method,'PUT');
  assert.equal(calls[1].url,`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`);
  assert.deepEqual(JSON.parse(calls[1].options.body),{attributes:{FNAME:'Pat',LNAME:'Customer'}});
});

test('delete contact only removes from configured list, not Brevo account',async()=>{
  const calls=[];
  await withMockFetch(async(url,options)=>{
    calls.push({url:String(url),options});
    if(options.method==='GET')return Response.json({email,listIds:[24,99]});
    return Response.json({success:[email],failure:[]},{status:201});
  },async()=>{
    const r=await call(item,'DELETE');assert.equal(r.status,200);
    assert.equal((await r.json()).removedFromList,24);
  });
  assert.equal(calls.length,2);
  assert.equal(calls[1].options.method,'POST');
  assert.match(calls[1].url,/\/contacts\/lists\/24\/contacts\/remove$/);
  assert.deepEqual(JSON.parse(calls[1].options.body),{emails:[email]});
});

test('contact in another Brevo list cannot be edited or removed',async()=>{
  let calls=0;
  await withMockFetch(async()=>{calls++;return Response.json({email,listIds:[11,99]});},async()=>{
    for(const method of ['PUT','DELETE']) {
      const r=await call(item,method,method==='PUT'?{firstName:'Pat',lastName:''}:undefined);
      assert.equal(r.status,404);assert.equal((await r.json()).code,'CONTACT_NOT_IN_LIST');
    }
  });
  assert.equal(calls,2);
});

test('contact mutations validate input and reject unauthenticated users',async()=>{
  for(const [path,method,body] of [[item,'PUT',{firstName:'X'.repeat(101),lastName:''}],
     [item,'PUT',{firstName:'Pat'}],['/admin/contacts/not-an-email','DELETE']]){
    const r=await call(path,method,body);assert.equal(r.status,400);
  }
  const noAuth=await worker.fetch(new Request(origin+item,{method:'DELETE'}),base);
  assert.equal(noAuth.status,401);
});

test('Brevo remove failure cannot be reported as successful',async()=>{
 await withMockFetch(async(_url,options)=>options.method==='GET'?Response.json({email,listIds:[24]}):Response.json({failure:[email],success:[]},{status:201}),async()=>{
   const r=await call(item,'DELETE');assert.equal(r.status,502);assert.equal((await r.json()).code,'BREVO_REMOVE_FAILED');
 });
});

function fakeDB(initial) {
 const rows=new Map(initial.map(r=>[r.id,{...r}]));
 return {rows, prepare(sql){
   return {bind(...params){return {
    async first(){
     if(sql.includes('SELECT attempted FROM daily_send_usage'))return {attempted:0};
     if(sql.includes('COALESCE(SUM(recipient_estimate)'))return {total:0};
     return rows.get(params[0])??null;
    },
    async run(){
     if(sql.includes('DELETE FROM campaigns')){
       const row=rows.get(params[0]);if(!row || row.status!=='queued' || Date.parse(row.scheduled_at)<=Date.parse(params[1]))return {meta:{changes:0}};
       rows.delete(params[0]);return {meta:{changes:1}};
     }
     if(sql.includes('UPDATE campaigns SET name=')){
       const id=params[8],row=rows.get(id);
       if(!row || row.status!=='queued' || row.brevo_campaign_id || new Date(row.scheduled_at).getTime()<=Date.parse(params.at(-1)))return {meta:{changes:0}};
       Object.assign(row,{name:params[0],subject:params[1],html:params[2],preview_text:params[3],scheduled_at:params[4],day_ist:params[5],recipient_estimate:params[6],updated_at:params[7]});
       return {meta:{changes:1}};
     }
     return {meta:{changes:1}};
    }
   };
  }};
 }};
}
const id='12345678-1234-4234-9234-123456789abc';
const future=()=>new Date(Date.now()+10*60_000).toISOString();
const payload=()=>({name:'Updated test',subject:'New subject',html:'<html><body>Hello everyone!</body></html>',scheduledAt:future()});

test('queued campaign CRUD uses guarded SQL update and delete',async()=>{
 const db=fakeDB([{id,status:'queued',scheduled_at:future(),day_ist:'2026-10-15',name:'Old',subject:'Old',html:'<html><body>Old</body></html>',brevo_campaign_id:null}]);
 const env={...base,DB:db,SENDER_EMAIL:'sender@example.com',SENDER_NAME:'Team'};
 const read=await call('/admin/campaigns/'+id,'GET',null,env);assert.equal(read.status,200);
 assert.equal((await read.json()).campaign.name,'Old');
 const edit=await withMockFetch(async()=>Response.json({count:1,contacts:[]}),()=>call('/admin/campaigns/'+id,'PUT',payload(),env));assert.equal(edit.status,200);
 assert.equal(db.rows.get(id).name,'Updated test');
 assert.equal((db.rows.get(id).html.match(/{{ unsubscribe }}/g)||[]).length,1);
 const del=await call('/admin/campaigns/'+id,'DELETE',undefined,env);assert.equal(del.status,200);
 assert.equal(db.rows.has(id),false);
});

test('campaigns after processing or due date are locked against modification',async()=>{
 for (const [status,scheduled] of [['submitted',future()],['working',future()],['needs_review',future()],['queued',new Date(Date.now()-60000).toISOString()]]) {
   const db=fakeDB([{id,status,scheduled_at:scheduled,brevo_campaign_id:status==='submitted'?99:null}]);
   const env={...base,DB:db};
   const edit=await call('/admin/campaigns/'+id,'PUT',payload(),env);
   const del=await call('/admin/campaigns/'+id,'DELETE',undefined,env);
   assert.equal(edit.status,409,status);assert.equal(del.status,409,status);
   assert.equal(db.rows.has(id),true);
 }
});

test('campaign editing with an existing unsubscribe link does not duplicate footer',()=>{
 const input=payload();
 const once=normalizeCampaign(input);
 const again=normalizeCampaign({...input,html:once.html});
 assert.equal(again.html,once.html);
});
