import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const base={ADMIN_TOKEN:'test-token',DRY_RUN:'true',BREVO_API_KEY:'test-api',BREVO_LIST_ID:'24'};
const origin='https://example.workers.dev';
const call=(path,method='GET',body,env=base)=>worker.fetch(new Request(origin+path,{
  method,headers:{Authorization:'Bearer test-token'},
  ...(body?{body:JSON.stringify(body)}:{})
}),env);
const url='/admin/contacts/pat%2Btag%40example.com';
test('Contact edit changes names only, not list or suppression',async()=>{
  const old=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async (u,o)=>{
    calls.push({url:String(u),method:o.method,body:o.body});
    return o.method==='GET'?Response.json({email:'pat+tag@example.com',listIds:[24,90]}):new Response(null,{status:204});
  };
  try {
    const r=await call(url,'PUT',{firstName:'Pat',lastName:'Customer'});
    assert.equal(r.status,200);
    assert.deepEqual(JSON.parse(calls[1].body),{attributes:{FNAME:'Pat',LNAME:'Customer'}});
    assert.equal(calls.length,2);
  }finally{globalThis.fetch=old;}
});
test('Contact delete removes list membership only',async()=>{
  const old=globalThis.fetch;const calls=[];
  globalThis.fetch=async (u,o)=>{
    calls.push({url:String(u),method:o.method,body:o.body});
    return o.method==='GET'?Response.json({listIds:[24]}):Response.json({success:['pat+tag@example.com'],failure:[]});
  };
  try {
    const r=await call(url,'DELETE');
    assert.equal(r.status,200);assert.equal((await r.json()).removedFromList,24);
    assert.match(calls[1].url,/\/contacts\/lists\/24\/contacts\/remove$/);
    assert.deepEqual(JSON.parse(calls[1].body),{emails:['pat+tag@example.com']});
  }finally{globalThis.fetch=old;}
});
test('Cross-list mutations are forbidden and require admin authentication',async()=>{
  const old=globalThis.fetch;let count=0;
  globalThis.fetch=async()=>{count++;return Response.json({listIds:[99]});};
  try{
    for(const method of ['PUT','DELETE']){
      const r=await call(url,method,method==='PUT'?{firstName:'Pat',lastName:''}:undefined);
      assert.equal(r.status,404);assert.equal((await r.json()).code,'CONTACT_NOT_IN_LIST');
    }
    const r=await worker.fetch(new Request(origin+url,{method:'DELETE'}),base);
    assert.equal(r.status,401);assert.equal(count,2);
  }finally{globalThis.fetch=old;}
});
test('Campaign editing and deletion are guarded by queued status and future schedule',async()=>{
  const id='12345678-1234-4234-9234-123456789abc';
  const sql=[];
  const env={...base,DB:{prepare(s){sql.push(s);return{bind(...p){return{
    async first(){return {id,status:'queued',scheduled_at:new Date(Date.now()+600000).toISOString(),html:'<body>Hello</body>'};},
    async run(){return{meta:{changes:1}};}
  };}};}}};
  const future=new Date(Date.now()+600000).toISOString();
  const body={name:'Edited',subject:'Subject',html:'<html><body>Personal update</body></html>',scheduledAt:future};
  assert.equal((await call('/admin/campaigns/'+id,'GET',undefined,env)).status,200);
  assert.equal((await call('/admin/campaigns/'+id,'PUT',body,env)).status,200);
  assert.equal((await call('/admin/campaigns/'+id,'DELETE',undefined,env)).status,200);
  assert.ok(sql.some(s=>s.includes("status='queued'")&&s.startsWith('UPDATE campaigns')));
  assert.ok(sql.some(s=>s.includes("status='queued'")&&s.startsWith('DELETE FROM campaigns')));
});
test('Campaign mutation fails closed when queue claim has won',async()=>{
  const id='12345678-1234-4234-9234-123456789abc';
  const env={...base,DB:{prepare(){return{bind(){return{run:async()=>({meta:{changes:0}})}}}}}};
  const future=new Date(Date.now()+600000).toISOString();
  const result=await call('/admin/campaigns/'+id,'PUT',{name:'Edited',subject:'Subject',html:'<html><body>Personal update</body></html>',scheduledAt:future},env);
  assert.equal(result.status,409);assert.equal((await result.json()).code,'CAMPAIGN_NOT_EDITABLE');
  const deleted=await call('/admin/campaigns/'+id,'DELETE',undefined,env);
  assert.equal(deleted.status,409);
});
