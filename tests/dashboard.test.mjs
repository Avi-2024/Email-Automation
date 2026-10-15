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
