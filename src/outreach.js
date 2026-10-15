import { sendCpanelMail, checkCpanelReplies, mailConfig } from './outreach-mail.js';

const hdr={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:hdr});
const bad=(error,status=400)=>json({error},status);
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function recipient(path){
  const match=path.match(/^\/admin\/outreach\/prospects\/([^/]+)\/(send|history|check-replies|followups)$/);
  if(!match)return null;
  try{const email=decodeURIComponent(match[1]).trim().toLowerCase();
    return EMAIL.test(email)&&email.length<=254?{email,action:match[2]}:null;
  }catch{return null;}
}
export function validateIndividualEmail(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid email request');
  const subject=String(input.subject||'').trim(),text=String(input.text||'').trim();
  if(subject.length<4||subject.length>180||/[\r\n\0]/.test(subject))throw new Error('Subject must be 4–180 characters, on one line');
  if(text.length<30||text.length>12000)throw new Error('Message must be 30–12,000 characters');
  if(!input.confirmIndividual||input.confirmIndividual!==true)throw new Error('Confirm this single personally reviewed recipient');
  if(!/royalitservice\.com/i.test(text))throw new Error('Include your business identity and website');
  if(!/opt.out|no thanks|not to be contacted|do not contact|unsubscribe/i.test(text))throw new Error('Include a clear opt-out line');
  return {subject,text};
}
const utcDay=()=>new Date().toISOString().slice(0,10);
export async function handleOutreach(request,env,path,{send=sendCpanelMail,checkReplies=checkCpanelReplies}={}) {
  if(!env.DB)return bad('D1 binding unavailable',503);
  if(path==='/admin/outreach/config'&&request.method==='GET'){
    const cfg=mailConfig(env);
    return json({provider:'cPanel SMTP 465 / optional IMAP 993',outreachEnabled:cfg.enabled,smtpConfigured:cfg.smtpConfigured,
      imapConfigured:cfg.imapConfigured,sender:cfg.sender||null,manualOnly:true,dailyLimit:15,
      note:'Marketing SAFE MODE is separate. One-to-one sending requires an explicit click and OUTREACH_ENABLED=true.'});
  }
  if(path==='/admin/outreach/followups'&&request.method==='GET'){
    const rows=await env.DB.prepare('SELECT id,prospect_email,note,due_at,status,created_at FROM outreach_followups WHERE status=? ORDER BY due_at ASC LIMIT 100').bind('open').all();
    return json({followups:rows.results||[]});
  }
  const finish=path.match(/^\/admin\/outreach\/followups\/([a-z0-9-]{8,80})\/complete$/i);
  if(finish && request.method==='POST'){
    const result=await env.DB.prepare("UPDATE outreach_followups SET status='done',updated_at=? WHERE id=? AND status='open'").bind(new Date().toISOString(),finish[1]).run();
    return result.meta?.changes===1?json({ok:true}):bad('Follow-up not found or already done',404);
  }
  const parsed=recipient(path);if(!parsed)return bad('Unknown outreach endpoint',404);
  const {email,action}=parsed;
  const prospect=await env.DB.prepare('SELECT email,status,first_name,company FROM prospects WHERE email=?').bind(email).first();
  if(!prospect)return bad('Prospect not found in D1 CRM',404);
  if(action==='history' && request.method==='GET'){
    const [messages,followups]=await Promise.all([
      env.DB.prepare('SELECT id,subject,body,message_id,status,last_error,created_at,sent_at,replied_at FROM outreach_messages WHERE prospect_email=? ORDER BY created_at DESC LIMIT 30').bind(email).all(),
      env.DB.prepare('SELECT id,note,due_at,status,created_at FROM outreach_followups WHERE prospect_email=? ORDER BY due_at DESC LIMIT 30').bind(email).all()
    ]);
    return json({email,messages:messages.results||[],followups:followups.results||[]});
  }
  if(action==='followups' && request.method==='POST'){
    if(prospect.status==='do_not_contact'||prospect.status==='closed')return bad('This lead is closed or suppressed',409);
    let input;try{input=await request.json();}catch{return bad('Invalid JSON');}
    const date=new Date(input?.due_at),note=String(input?.note||'').trim();
    if(!Number.isFinite(date.getTime())||date.getTime()<Date.now()-60000||date.getTime()>Date.now()+365*86400000)return bad('Select a future follow-up within 365 days');
    if(note.length>500)return bad('Note too long');
    const id=crypto.randomUUID(),now=new Date().toISOString();
    await env.DB.prepare('INSERT INTO outreach_followups (id,prospect_email,note,due_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(id,email,note,date.toISOString(),'open',now,now).run();
    return json({ok:true,id},201);
  }
  if(action==='send' && request.method==='POST'){
    const suppressed=await env.DB.prepare('SELECT email FROM outreach_suppressions WHERE email=?').bind(email).first();
    if(suppressed)return bad('This address is permanently suppressed from prospect outreach',409);
    if(prospect.status==='do_not_contact'||prospect.status==='closed')return bad('This lead is closed or marked Do Not Contact',409);
    if(!mailConfig(env).enabled)return bad('One-to-one sending is disabled. Set OUTREACH_ENABLED=true only after mailbox setup and review.',503);
    if(!mailConfig(env).smtpConfigured)return bad('cPanel SMTP host/user/password secrets are not configured',503);
    let input;try{input=await request.json();}catch{return bad('Invalid JSON');}
    let validated;try{validated=validateIndividualEmail(input);}catch(e){return bad(e.message);}
    const previous=await env.DB.prepare("SELECT created_at,status FROM outreach_messages WHERE prospect_email=? ORDER BY created_at DESC LIMIT 1").bind(email).first();
    if(previous && Date.now()-Date.parse(previous.created_at)<24*3600*1000)return bad('One manual outreach attempt per prospect every 24 hours. Check previous send status first.',429);
    const date=utcDay();await env.DB.prepare('INSERT OR IGNORE INTO outreach_daily_usage(day_utc,attempts) VALUES (?,0)').bind(date).run();
    const reserved=await env.DB.prepare('UPDATE outreach_daily_usage SET attempts=attempts+1 WHERE day_utc=? AND attempts<15').bind(date).run();
    if(reserved.meta?.changes!==1)return bad('Daily one-to-one safety cap reached (15 attempts UTC). Try another day.',429);
    // D1 atomic recipient lock: prevents concurrent requests from two tabs double-sending one lead.
    await env.DB.prepare('INSERT OR IGNORE INTO outreach_recipient_cooldown(email,last_attempt_at) VALUES (?,?)')
      .bind(email,'1970-01-01T00:00:00.000Z').run();
    const locked=await env.DB.prepare('UPDATE outreach_recipient_cooldown SET last_attempt_at=? WHERE email=? AND last_attempt_at<=?')
      .bind(new Date().toISOString(),email,new Date(Date.now()-86400000).toISOString()).run();
    if(locked.meta?.changes!==1)return bad('A message was already attempted for this recipient within 24 hours',429);
    const id=crypto.randomUUID();
    const host=String(mailConfig(env).sender.split('@')[1]||'royalitservice.com').replace(/[^a-z0-9.-]/g,'');
    const messageId=`<${id}@${host}>`;
    const now=new Date().toISOString();
    // Reserve an immutable attempt before making a network request. Failure never automatically re-sends.
    await env.DB.prepare('INSERT INTO outreach_messages (id,prospect_email,subject,body,message_id,status,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id,email,validated.subject,validated.text,messageId,'sending',now).run();
    try{
      await send(env,{to:email,subject:validated.subject,text:validated.text,messageId});
      await env.DB.prepare("UPDATE outreach_messages SET status='sent',sent_at=? WHERE id=?").bind(new Date().toISOString(),id).run();
      await env.DB.prepare("UPDATE prospects SET status='contacted',updated_at=? WHERE email=? AND status='new'").bind(new Date().toISOString(),email).run();
      return json({ok:true,status:'smtp_accepted',id,messageId,note:'SMTP accepted submission; delivery to inbox is not guaranteed.'});
    }catch(error){
      // Even pre-DATA failures consume the attempt cap and cooldown, preventing rapid repeated sends.
      const status=error?.uncertain?'needs_review':'failed';
      await env.DB.prepare('UPDATE outreach_messages SET status=?,last_error=? WHERE id=?').bind(status,String(error?.message||'Submission failed').slice(0,160),id).run();
      return json({ok:false,status,error:'SMTP did not confirm acceptance. Check cPanel Track Delivery / server logs before reattempting.',id},502);
    }
  }
  if(action==='check-replies'&&request.method==='POST'){
    if(!mailConfig(env).imapConfigured)return bad('Optional IMAP checking is not configured (CPANEL_IMAP_HOST)',503);
    const rows=await env.DB.prepare("SELECT id,message_id FROM outreach_messages WHERE prospect_email=? AND status IN ('sent','needs_review') ORDER BY created_at DESC LIMIT 8").bind(email).all();
    if(!rows.results?.length)return json({checked:0,matched:0,message:'No sent threads available to match.'});
    let result;try{result=await checkReplies(env,{email,messageIds:rows.results.map(x=>x.message_id)});}catch{return bad('IMAP connection or login failed. Check cPanel settings and Worker logs.',502);}
    const detected=new Set((result.matched||[]).map(x=>x.messageId));
    for(const row of rows.results){if(detected.has(row.message_id))await env.DB.prepare("UPDATE outreach_messages SET status='replied',replied_at=? WHERE id=? AND status IN ('sent','needs_review')").bind(new Date().toISOString(),row.id).run();}
    if(detected.size && prospect.status!=='do_not_contact')await env.DB.prepare("UPDATE prospects SET status='replied',updated_at=? WHERE email=? AND status IN ('new','contacted')").bind(new Date().toISOString(),email).run();
    return json({checked:rows.results.length,matched:detected.size,note:'Checked INBOX for matching In-Reply-To / References headers only. Other replies may require manual review.'});
  }
  return bad('Method not allowed',405);
}
