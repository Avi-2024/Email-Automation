import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const env = {DRY_RUN:'true', ADMIN_TOKEN:'my-long-test-token', DB:{prepare(sql){return {all:async()=>({results:[]})};}}};
test('health stays public, returns safe mode', async()=>{
 const r = await worker.fetch(new Request('https://example.workers.dev/health'), env);
 assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,dryRun:true});
});
test('unauthorized browser cannot fetch campaigns or contacts',async()=>{
 for (const path of ['/admin/campaigns','/admin/contacts','/admin/config']) {
  const r=await worker.fetch(new Request('https://example.workers.dev'+path),env);
  assert.equal(r.status,401);
 }
});
test('UI HTML is served as a Worker asset without exposing credentials',async()=>{
 const withAssets={...env, ASSETS:{fetch:async()=>new Response('<!doctype html><html><title>Mailroom</title></html>',{headers:{'content-type':'text/html'}})}};
 const r=await worker.fetch(new Request('https://example.workers.dev/'),withAssets);
 assert.equal(r.status,200);assert.match(await r.text(),/Mailroom/);
 assert.match(r.headers.get('Content-Security-Policy'),/script-src 'self'/);
 assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');
});
test('dashboard admin config shows safe mode without secrets',async()=>{
 const cfg={...env, BREVO_LIST_ID:'8',SENDER_EMAIL:'sample@example.com',SENDER_NAME:'Team',MAX_DAILY_RECIPIENTS:'300'};
 const r=await worker.fetch(new Request('https://example.workers.dev/admin/config',{headers:{authorization:'Bearer my-long-test-token'}}),cfg);
 const d=await r.json();assert.equal(r.status,200);assert.equal(d.dryRun,true);assert.equal(d.listId,8);
 assert.ok(!JSON.stringify(d).includes('ADMIN_TOKEN'));
});


test('contact GET returns a helpful 503 when Brevo credentials are missing', async () => {
 const r = await worker.fetch(new Request('https://example.workers.dev/admin/contacts?limit=25&offset=0', {headers:{authorization:'Bearer my-long-test-token'}}),env);
 assert.equal(r.status,503);
 const data=await r.json();
 assert.equal(data.code,'CONTACT_CONFIG_MISSING');
 assert.deepEqual(data.missing,['BREVO_API_KEY','BREVO_LIST_ID']);
 assert.doesNotMatch(JSON.stringify(data),/my-long-test-token/);
});

test('contacts API does not require sender settings or D1 to list and import opted-in contacts', async () => {
 const old = globalThis.fetch;
 const called = [];
 globalThis.fetch = async (url, opts) => {
   called.push({url:String(url),method:opts.method});
   if(opts.method === 'GET') return Response.json({contacts:[{id:17,email:'customer@example.com',attributes:{FNAME:'Rahul'},emailBlacklisted:false}],count:1});
   if(opts.method === 'POST') return Response.json({id:77, email:'self@example.com'}, {status:201});
   throw new Error('Unexpected method');
 };
 try {
   const config={...env, BREVO_LIST_ID:'24', BREVO_API_KEY:'private-test-key'};
   const headers={authorization:'Bearer my-long-test-token'};
   const get=await worker.fetch(new Request('https://example.workers.dev/admin/contacts?limit=25&offset=0',{headers}),config);
   assert.equal(get.status,200);
   const listed=await get.json();
   assert.equal(listed.count,1);assert.equal(listed.contacts[0].firstName,'Rahul');
   const post=await worker.fetch(new Request('https://example.workers.dev/admin/contacts',{method:'POST',headers,body:JSON.stringify({confirmed:true,contacts:[{email:'self@example.com',first_name:'Self',last_name:'',consent:'yes',consent_source:'Self test sign-up'}]})}),config);
   assert.equal(post.status,200);
   assert.equal((await post.json()).created,1);
   assert.equal(called.length,2);
   assert.match(called[0].url,/contacts\/lists\/24\/contacts/);
   assert.match(called[1].url,/\/contacts$/);
 } finally {globalThis.fetch=old;}
});

test('provider authentication errors return a safe 502 with actionable code', async () => {
 const old = globalThis.fetch;
 globalThis.fetch = async () => Response.json({message:'Internal provider text, potentially sensitive'}, {status:403});
 try {
   const config={...env,BREVO_LIST_ID:'24',BREVO_API_KEY:'private-test-key'};
   const r=await worker.fetch(new Request('https://example.workers.dev/admin/contacts',{headers:{authorization:'Bearer my-long-test-token'}}),config);
   assert.equal(r.status,502);
   const body=await r.json();
   assert.equal(body.code,'BREVO_AUTH_FAILED');
   assert.doesNotMatch(JSON.stringify(body),/Internal provider text|private-test-key/);
 } finally {globalThis.fetch=old;}
});

test('admin config reports secret presence without exposing values',async()=>{
 const cfg={...env,BREVO_LIST_ID:'25',BREVO_API_KEY:'private-test-key'};
 const r=await worker.fetch(new Request('https://example.workers.dev/admin/config',{headers:{authorization:'Bearer my-long-test-token'}}),cfg);
 assert.equal(r.status,200);
 const body=await r.json();
 assert.equal(body.contactsReady,true);
 assert.deepEqual(body.contactConfigMissing,[]);
 assert.doesNotMatch(JSON.stringify(body),/private-test-key|my-long-test-token/);
});

test('unexpected async errors in admin handlers yield JSON 500 rather than rejected response',async()=>{
 const broken={...env,DB:{prepare(){throw new Error('simulated DB error') }} };
 const r=await worker.fetch(new Request('https://example.workers.dev/admin/campaigns',{headers:{authorization:'Bearer my-long-test-token'}}),broken);
 assert.equal(r.status,500);
 assert.match(r.headers.get('content-type'),/application\/json/);
 assert.equal((await r.json()).error,'Operation failed; check Worker logs. Failed send attempts require manual review.');
});

test('CSP permits email preview styling but not inline executable scripts',async()=>{
 const assetEnv={...env,ASSETS:{fetch:async()=>new Response('<h1>UI</h1>')}};
 const r=await worker.fetch(new Request('https://example.workers.dev/'),assetEnv);
 const csp=r.headers.get('Content-Security-Policy');
 assert.match(csp,/script-src 'self'/);
 assert.doesNotMatch(csp,/script-src[^;]*unsafe-inline/);
 assert.match(csp,/style-src-attr 'unsafe-inline'/);
 assert.match(csp,/style-src-elem 'self' 'unsafe-inline'/);
});
