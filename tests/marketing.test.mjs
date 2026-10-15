import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { normalizeCampaign } from '../src/helpers.js';

const origin='https://mailroom.example.test';
const token='the-test-token';
const cfg={ADMIN_TOKEN:token,DRY_RUN:'false',BREVO_API_KEY:'fake-key',BREVO_LIST_ID:'9',SENDER_EMAIL:'team@example.test',SENDER_NAME:'Team',MAX_DAILY_RECIPIENTS:'300'};
const id='12345678-1234-4234-9234-123456789abc';
function makeDb() {
 const rows=new Map(),used=new Map(),testCount=new Map();
 const db={rows,used,testCount,prepare(sql) {
  return {bind(...p) { return {
   async first(){
    if(sql.startsWith('SELECT attempted FROM daily_send_usage'))return used.has(p[0])?{attempted:used.get(p[0])}:null;
    if(sql.includes('COALESCE(SUM(recipient_estimate)')){
      const pending=[...rows.values()].filter(r=>r.day_ist===p[0]&&r.status==='queued'&&(p[1]===undefined || r.id!==p[1]));
      return {total:pending.reduce((acc,r)=>acc+Number(r.recipient_estimate||0),0),campaigns:pending.length};
    }
    if(sql.includes('FROM campaigns WHERE id=?'))return rows.get(p[0])||null;
    return null;
   },
   async all(){
    if(sql.includes('status=\'queued\' AND scheduled_at<='))return {results:[...rows.values()].filter(r=>r.status==='queued'&&r.scheduled_at<=p[0]).sort((a,b)=>a.scheduled_at.localeCompare(b.scheduled_at)).slice(0,5)};
    if(sql.includes('WHERE brevo_campaign_id IS NOT NULL'))return {results:[...rows.values()].filter(r=>r.brevo_campaign_id!=null).slice(0,5)};
    if(sql.includes('FROM campaigns ORDER BY scheduled_at'))return {results:[...rows.values()]};
    return {results:[]};
   },
   async run(){
    if(sql.startsWith('INSERT INTO campaigns')){
      const [id,name,subject,html,preview_text,scheduled_at,day_ist,recipient_estimate]=p;
      rows.set(id,{id,name,subject,html,preview_text,scheduled_at,day_ist,recipient_estimate,status:'queued',quota_reserved:0,brevo_campaign_id:null});
      return {meta:{changes:1}};
    }
    if(sql.startsWith('INSERT OR IGNORE INTO daily_send_usage')){if(!used.has(p[0]))used.set(p[0],0);return {meta:{changes:1}};}
    if(sql.includes('UPDATE daily_send_usage SET attempted=attempted+')){
      const [amount,_when,day,cost,cap]=p;
      if((used.get(day)||0)+cost>cap)return {meta:{changes:0}};
      used.set(day,used.get(day)+amount);return {meta:{changes:1}};
    }
    if(sql.includes('INSERT OR IGNORE INTO daily_test_usage')){if(!testCount.has(p[0]))testCount.set(p[0],0);return {meta:{changes:1}};}
    if(sql.includes('UPDATE daily_test_usage SET attempted=attempted+1')){
      if(testCount.get(p[0])>=3)return {meta:{changes:0}};
      testCount.set(p[0],testCount.get(p[0])+1);return {meta:{changes:1}};
    }
    if(sql.includes("UPDATE campaigns SET status='working'")){
      const row=rows.get(p[1]);if(!row || row.status!=='queued')return {meta:{changes:0}};
      row.status='working';return {meta:{changes:1}};
    }
    if(sql.includes('UPDATE campaigns SET recipient_estimate=')){
      const row=rows.get(p[2]);row.recipient_estimate=p[0];row.quota_reserved=p[1];return {meta:{changes:1}};
    }
    if(sql.startsWith('UPDATE campaigns SET status=?')){
      const row=rows.get(p.at(-1));if(!row)return {meta:{changes:0}};
      row.status=p[0];if(p.length===5)row.brevo_campaign_id=p[3];return {meta:{changes:1}};
    }
    if(sql.includes('UPDATE campaigns SET status=\'needs_review\''))return {meta:{changes:0}};
    return {meta:{changes:1}};
   }
  };}};
 }};
 return db;
}
async function request(db,path,method='GET',body,overrides={}){
 const req=new Request(origin+path,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 return worker.fetch(req,{...cfg,DB:db,...overrides});
}
function schedule(name='Message',min=10) { return {name,subject:'New message',html:'<html><body>Hello friend</body></html>',previewText:'Short inbox preheader',scheduledAt:new Date(Date.now()+min*60_000).toISOString()}; }
async function mocked(fetchMock,fn){const prior=globalThis.fetch;globalThis.fetch=fetchMock;try{return await fn();}finally{globalThis.fetch=prior;}}

// Web APIs in the mock are the documented Brevo v3 endpoints; no network calls occur.
test('two campaigns may share IST day within budget; third is denied',async()=>{
 const db=makeDb();
 await mocked(async()=>Response.json({count:125}),async()=>{
  const a=await request(db,'/admin/campaigns','POST',schedule('A'));
  const b=await request(db,'/admin/campaigns','POST',schedule('B',12));
  const c=await request(db,'/admin/campaigns','POST',schedule('C',14));
  assert.equal(a.status,201);assert.equal(b.status,201);assert.equal(c.status,409);
  assert.equal((await c.json()).code,'DAILY_BUDGET_EXCEEDED');
  assert.equal(db.rows.size,2);
  const q=await request(db,`/admin/quota?day=${[...db.rows.values()][0].day_ist}`);
  assert.equal((await q.json()).pending,250);
 });
});

test('dry run finds due campaigns without making provider calls or reserving quota',async()=>{
 const db=makeDb();const yesterday=new Date(Date.now()-200000).toISOString();
 db.rows.set(id,{id,name:'Demo',subject:'Test',html:'<p>Hi</p>',scheduled_at:yesterday,day_ist:'2026-10-15',status:'queued',brevo_campaign_id:null});
 await mocked(async()=>{throw new Error('No network in dry run');},async()=>{
  const r=await request(db,'/admin/run','POST',undefined,{DRY_RUN:'true'});
  assert.equal(r.status,200);const data=await r.json();assert.equal(data.dryRun,true);assert.equal(data.due.length,1);
  assert.equal(db.rows.get(id).status,'queued');assert.equal(db.used.size,0);
 });
});

test('runtime atomic budget reserve blocks third due send after 2 x 120 recipients',async()=>{
 const db=makeDb();const yesterday=new Date(Date.now()-200000).toISOString();
 const day='2026-10-15';
 for(let i=1;i<=3;i++){const iid=`12345678-1234-4234-9234-123456789ab${i}`;db.rows.set(iid,{id:iid,name:`Message ${i}`,subject:'Test',html:'<p>Hi</p>',day_ist:day,scheduled_at:yesterday,status:'queued',brevo_campaign_id:null,preview_text:''});}
 let create=0;
 await mocked(async(url,opts)=>{
  if(String(url).includes('/contacts/lists/'))return Response.json({count:120});
  if(opts.method==='POST'&&String(url).endsWith('/emailCampaigns'))return Response.json({id:++create},{status:201});
  if(opts.method==='POST'&&String(url).includes('/sendNow'))return new Response(null,{status:204});
  throw new Error(`Unexpected request: ${url}`);
 },async()=>{
  const r=await request(db,'/admin/run','POST');assert.equal(r.status,200);
  const x=await r.json();assert.equal(x.outcomes.filter(o=>o.status==='submitted').length,2);
  assert.equal(x.outcomes.filter(o=>o.status==='blocked').length,1);
  assert.equal(db.used.get(day),240);assert.equal(create,2);
 });
});

test('campaign performance endpoint returns only safe mapped statistics and tracked link counts',async()=>{
 const db=makeDb();db.rows.set(id,{id,name:'Promo',status:'submitted',brevo_campaign_id:88});
 const paths=[];
 await mocked(async(url)=>{paths.push(String(url));return Response.json({id:88,status:'sent',htmlContent:'SECRET-HTML',statistics:String(url).includes('linksStats')?
  {linksStats:{'https://shop.example.test/products':{nbClick:13}}}:{globalStats:{sent:40,delivered:39,uniqueViews:20,uniqueClicks:9,hardBounces:1,softBounces:0,unsubscriptions:2,complaints:0}}});},async()=>{
  const r=await request(db,`/admin/campaigns/${id}/report`);assert.equal(r.status,200);
  const data=await r.json();assert.equal(data.metrics.delivered,39);assert.equal(data.metrics.clicks,9);
  assert.deepEqual(data.links,[{url:'https://shop.example.test/products',clicks:13}]);
  assert.ok(!JSON.stringify(data).includes('SECRET-HTML'));assert.equal(paths.length,2);
 });
});

test('one-recipient test send never invokes sendNow and cleans temporary draft',async()=>{
 const db=makeDb();const paths=[];
 await mocked(async(url,opts)=>{
  paths.push([String(url),opts.method]);
  if(String(url).endsWith('/emailCampaigns'))return Response.json({id:44},{status:201});
  if(String(url).endsWith('/44/sendTest')){assert.deepEqual(JSON.parse(opts.body),{emailTo:['me@example.test']});return new Response(null,{status:204});}
  if(String(url).endsWith('/44')&&opts.method==='DELETE')return new Response(null,{status:204});
  throw new Error('Unexpected provider request');
 },async()=>{
  const data={...schedule('Test'),testEmail:'me@example.test',confirmed:true};
  const r=await request(db,'/admin/test-send','POST',data,{DRY_RUN:'true'});
  assert.equal(r.status,200);assert.equal((await r.json()).submitted,true);
  assert.deepEqual(paths.map(x=>x[1]),['POST','POST','DELETE']);
  assert.equal(db.rows.size,0);
 });
});

test('preview text validated; unsubscribe footer always preserved',()=>{
 assert.throws(()=>normalizeCampaign({...schedule('Long'),previewText:'x'.repeat(161)}),/Preview text/);
 const normalized=normalizeCampaign(schedule('Ordinary'));
 assert.equal(normalized.previewText,'Short inbox preheader');
 assert.match(normalized.html,/{{ unsubscribe }}/);
});
