import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {validateIndividualEmail,handleOutreach} from '../src/outreach.js';
import {mailConfig} from '../src/outreach-mail.js';
import {execFileSync} from 'node:child_process';
const host='https://mailroom.example';
const mail='lead@example.com';
const route=(action)=>`/admin/outreach/prospects/${encodeURIComponent(mail)}/${action}`;
const base={ADMIN_TOKEN:'test-secret',OUTREACH_ENABLED:'true',CPANEL_SMTP_HOST:'mail.royalitservice.com',CPANEL_IMAP_HOST:'mail.royalitservice.com',CPANEL_MAIL_USER:'hello@royalitservice.com',CPANEL_MAIL_PASSWORD:'not-a-real-password'};
const payload={subject:'A question about your website',text:'Hello,\nI am reaching out from Royal IT Service, royalitservice.com. Are you open to talk?\nIf not, please reply no thanks and I will not contact you.\nRegards, Royal IT Service.',confirmIndividual:true};
function db(status='new'){
 const prospect={email:mail,status,first_name:'',company:''},messages=[],followups=[],usage={attempts:0};
 return {prospect,messages,followups,usage,prepare(sql){return {bind(...a){return {
  async first(){
   if(sql.startsWith('SELECT email,status'))return prospect;
   if(sql.startsWith('SELECT email FROM outreach_suppressions'))return null;
   if(sql.startsWith('SELECT created_at,status FROM outreach_messages'))return messages.slice().sort((x,y)=>y.created_at.localeCompare(x.created_at))[0]||null;
   throw Error('Unhandled first: '+sql);
  },
  async all(){
   if(sql.startsWith('SELECT id,subject,body,message_id'))return {results:messages.filter(x=>x.prospect_email===a[0]).slice().reverse()};
   if(sql.startsWith('SELECT id,note,due_at,status'))return {results:followups.filter(x=>x.prospect_email===a[0])};
   if(sql.startsWith('SELECT id,message_id FROM outreach_messages'))return {results:messages.filter(x=>x.prospect_email===a[0]&&['sent','needs_review'].includes(x.status)).map(({id,message_id})=>({id,message_id}))};
   if(sql.startsWith('SELECT id,prospect_email,note,due_at'))return {results:followups.filter(x=>x.status==='open')};
   throw Error('Unhandled all: '+sql);
  },
  async run(){
   if(sql.startsWith('INSERT OR IGNORE INTO outreach_daily_usage'))return {meta:{changes:1}};
   if(sql.startsWith('UPDATE outreach_daily_usage')){if(usage.attempts>=15)return {meta:{changes:0}};usage.attempts++;return {meta:{changes:1}};}
   if(sql.startsWith('INSERT INTO outreach_messages')){const [id,prospect_email,subject,body,message_id,status,created_at]=a;messages.push({id,prospect_email,subject,body,message_id,status,created_at});return {meta:{changes:1}};}
   if(sql.startsWith("UPDATE outreach_messages SET status='sent'")){messages.find(x=>x.id===a[1]).status='sent';return {meta:{changes:1}};}
   if(sql.startsWith('UPDATE outreach_messages SET status=?,last_error=')){const r=messages.find(x=>x.id===a[2]);r.status=a[0];r.last_error=a[1];return {meta:{changes:1}};}
   if(sql.startsWith("UPDATE outreach_messages SET status='replied'")){const m=messages.find(x=>x.id===a[1]);m.status='replied';return {meta:{changes:1}};}
   if(sql.startsWith('UPDATE prospects SET status=')){if(prospect.status==='new'||prospect.status==='contacted'){prospect.status=sql.includes("'replied'")?'replied':'contacted';}return {meta:{changes:1}};}
   if(sql.startsWith('INSERT INTO outreach_followups')){const[id,prospect_email,note,due_at,status,created_at]=a;followups.push({id,prospect_email,note,due_at,status,created_at});return {meta:{changes:1}};}
   if(sql.startsWith("UPDATE outreach_followups SET status='done'")){const r=followups.find(x=>x.id===a[1]);if(!r)return{meta:{changes:0}};r.status='done';return{meta:{changes:1}};}
   throw Error('Unhandled run: '+sql);
  }
 };}};},};
}
async function direct(database,path,method='GET',body,env=base,deps){
 const request=new Request(host+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 return handleOutreach(request,{...env,DB:database},path,deps);
}
test('mail configuration has off switch and no passwords in dashboard response',async()=>{
 const a=await direct(db(),'/admin/outreach/config');assert.equal(a.status,200);const v=await a.json();assert.equal(v.outreachEnabled,true);assert.equal(v.smtpConfigured,true);assert.equal(v.imapConfigured,true);assert.equal(JSON.stringify(v).includes('not-a-real-password'),false);
 assert.equal(mailConfig({...base,OUTREACH_ENABLED:'false'}).enabled,false);
});
test('one-to-one validation requires identity, opt-out, reviewed recipient and reasonable text',()=>{
 assert.deepEqual(validateIndividualEmail(payload),{subject:payload.subject,text:payload.text});
 for(const bad of [{...payload,confirmIndividual:false},{...payload,text:'Hi, hire me'},{...payload,text:'Hello this is royalitservice.com. Contact us soon about our work.'},{...payload,subject:'oops\r\nBcc: abc'}])assert.throws(()=>validateIndividualEmail(bad));
});
test('suppression blocks actual sends and follows ups',async()=>{
 const d=db('do_not_contact');let sent=0;
 const r=await direct(d,route('send'),'POST',payload,base,{send:async()=>{sent++}});
 assert.equal(r.status,409);assert.equal(sent,0);assert.equal(d.usage.attempts,0);
 const follow=await direct(d,route('followups'),'POST',{due_at:new Date(Date.now()+86400000).toISOString()},base,{});assert.equal(follow.status,409);
});
test('individual explicit send is not Brevo, records SMTP acceptance and blocks rapid retry',async()=>{
 const d=db(),calls=[];
 const r=await direct(d,route('send'),'POST',payload,base,{send:async(env,data)=>{calls.push(data);return{accepted:true};}});
 assert.equal(r.status,200);assert.equal((await r.json()).status,'smtp_accepted');assert.equal(calls.length,1);assert.equal(calls[0].to,mail);
 assert.equal(d.messages[0].status,'sent');assert.equal(d.prospect.status,'contacted');assert.equal(d.usage.attempts,1);
 const second=await direct(d,route('send'),'POST',payload,base,{send:async()=>{calls.push(1)}});
 assert.equal(second.status,429);assert.equal(calls.length,1);
 const history=await direct(d,route('history'));
 assert.equal((await history.json()).messages.length,1);
});
test('outreach must be deliberately enabled and is independent of marketing DRY_RUN',async()=>{
 const d=db(),r=await direct(d,route('send'),'POST',payload,{...base,OUTREACH_ENABLED:'false',DRY_RUN:'true'},{});
 assert.equal(r.status,503);assert.equal(d.usage.attempts,0);
 const unauthorized=await worker.fetch(new Request(host+'/admin/outreach/config'),{...base,DB:d});assert.equal(unauthorized.status,401);
});
test('SMTP failures are recorded for manual review without retries',async()=>{
 const d=db();const error=new Error('provider timeout');error.uncertain=true;
 const r=await direct(d,route('send'),'POST',payload,base,{send:async()=>{throw error;}});
 assert.equal(r.status,502);assert.equal(d.messages[0].status,'needs_review');assert.equal(d.usage.attempts,1);
});
test('IMAP matches only explicit thread IDs and follow-ups never send',async()=>{
 const d=db();const send=async()=>({accepted:true});
 await direct(d,route('send'),'POST',payload,base,{send});
 const r=await direct(d,route('check-replies'),'POST',{},base,{checkReplies:async(env,{email,messageIds})=>({matched:[{messageId:messageIds[0],replyUID:'120'}]})});
 assert.equal((await r.json()).matched,1);assert.equal(d.messages[0].status,'replied');assert.equal(d.prospect.status,'replied');
 const follow=await direct(d,route('followups'),'POST',{note:'Call them',due_at:new Date(Date.now()+86400000).toISOString()});assert.equal(follow.status,201);
 assert.equal(d.followups.length,1);
});
