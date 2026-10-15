import { handleProspects } from './prospects.js';
import { normalizeCampaign, EMAIL_CAP_FREE } from './helpers.js';

const API = 'https://api.brevo.com/v3';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const response = (data, code = 200) => new Response(JSON.stringify(data), {status: code, headers: JSON_HEADERS});
const bad = (message, status = 400) => response({error: message}, status);
const nowISO = () => new Date().toISOString();
const DRY = env => env.DRY_RUN !== 'false';

function auth(request, env) {
  const header = request.headers.get('authorization') || '';
  // Use a random >=32-byte token. Never expose this endpoint through client-side code.
  return Boolean(env.ADMIN_TOKEN && header === `Bearer ${env.ADMIN_TOKEN}`);
}

function validateEnv(env) {
  const listId = Number(env.BREVO_LIST_ID);
  if (!env.DB || !env.BREVO_API_KEY || !Number.isSafeInteger(listId) || listId <= 0 || !env.SENDER_EMAIL || !env.SENDER_NAME) {
    throw new Error('Configure DB, BREVO_API_KEY, BREVO_LIST_ID, SENDER_EMAIL and SENDER_NAME');
  }
  const max = Number(env.MAX_DAILY_RECIPIENTS ?? EMAIL_CAP_FREE);
  if (!Number.isSafeInteger(max) || max < 1 || max > 300) {
    throw new Error('MAX_DAILY_RECIPIENTS must be 1..300 on the verified free-plan configuration');
  }
  return { listId, max };
}

async function brevo(env, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {'api-key': env.BREVO_API_KEY, accept: 'application/json', ...(body === undefined ? {} : {'content-type':'application/json'})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  const raw = await r.text();
  let data;
  try {data = raw ? JSON.parse(raw) : {};} catch {data = {message: raw.slice(0,300)};}
  if (!r.ok) {
    const error = new Error(`Brevo ${method} ${path}: HTTP ${r.status} ${data.message || data.code || 'unknown error'}`);
    error.httpStatus = r.status;
    throw error;
  }
  return data;
}

// Do not conflate the daily app reservation with Brevo's own account-wide quota.
// External Brevo sends and provider reset times are not visible to this worker.
async function listAudienceSize(env, listId) {
  const info = await brevo(env,'GET',`/contacts/lists/${listId}/contacts?limit=1`);
  const size=Number(info.count);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Brevo did not return a valid list size');
  return size;
}

async function dailyUsage(env, dayIst) {
  const r=await env.DB.prepare('SELECT attempted FROM daily_send_usage WHERE day_ist=?').bind(dayIst).first();
  return Number(r?.attempted ?? 0);
}

// Atomic conditional update: two cron runs cannot spend the same daily allowance.
// Never refund after a Brevo create was attempted: a timeout may mean mail was sent.
async function reserveSendQuota(env, dayIst, recipients, cap) {
  await env.DB.prepare('INSERT OR IGNORE INTO daily_send_usage(day_ist,attempted) VALUES(?,0)').bind(dayIst).run();
  const change=await env.DB.prepare(`UPDATE daily_send_usage SET attempted=attempted+?,updated_at=?
    WHERE day_ist=? AND attempted+?<=?`).bind(recipients,nowISO(),dayIst,recipients,cap).run();
  return change.meta?.changes === 1;
}

async function previewBudget(env, dayIst, count, cap, excludedId = null) {
  const reserved=await dailyUsage(env,dayIst);
  const pending=await env.DB.prepare(`SELECT COALESCE(SUM(recipient_estimate),0) AS total
    FROM campaigns WHERE day_ist=? AND status='queued' AND id<>?`)
    .bind(dayIst,excludedId||'').first();
  const pendingCount=Number(pending?.total??0);
  return {used:reserved,pending:pendingCount,requested:count,cap,allowed:count>0 && count<=cap && reserved+pendingCount+count<=cap};
}

// Contact/campaign reporting never exposes Brevo HTML or the API key.
function metrics(stats={}) {
  const number=(key)=>Number.isFinite(Number(stats[key])) ? Math.max(0,Number(stats[key])) : 0;
  return {sent:number('sent'),delivered:number('delivered'),opened:number('uniqueViews'),
    clicks:number('uniqueClicks'),bounces:number('hardBounces')+number('softBounces'),
    hardBounces:number('hardBounces'),softBounces:number('softBounces'),
    unsubscribed:number('unsubscriptions'),complaints:number('complaints'),
    appleMppOpens:number('appleMppOpens')};
}
function reportedLinks(input) {
  return Object.entries(input && typeof input==='object' && !Array.isArray(input) ? input : {})
    .slice(0,40).map(([url,v])=>({url:String(url).slice(0,500),clicks:Number(v?.nbClick ?? v ?? 0)||0}))
    .filter(row=>row.clicks>=0).sort((a,b)=>b.clicks-a.clicks);
}
async function campaignReport(env,row,includeLinks=true) {
  if (!row.brevo_campaign_id) return {id:row.id,name:row.name,status:row.status,available:false,
    reason:'This campaign has not yet been submitted to Brevo.'};
  const id=row.brevo_campaign_id;
  const report=await brevo(env,'GET',`/emailCampaigns/${id}?statistics=globalStats&excludeHtmlContent=true`);
  const output={id:row.id,name:row.name,status:row.status,brevoStatus:report.status || 'unknown',
    brevoCampaignId:id,available:true,metrics:metrics(report.statistics?.globalStats||{}),
    lastChecked:nowISO(),approximate:true};
  if(includeLinks){
    const links=await brevo(env,'GET',`/emailCampaigns/${id}?statistics=linksStats&excludeHtmlContent=true`);
    output.links=reportedLinks(links.statistics?.linksStats);
  }
  return output;
}

async function saveStatus(env, id, status, error = null, campaignId = undefined) {
  if (campaignId === undefined) {
    return env.DB.prepare('UPDATE campaigns SET status=?,last_error=?,updated_at=? WHERE id=?')
      .bind(status,error,nowISO(),id).run();
  }
  return env.DB.prepare('UPDATE campaigns SET status=?,last_error=?,brevo_campaign_id=?,updated_at=? WHERE id=?')
    .bind(status,error,campaignId,nowISO(),id).run();
}

async function runDue(env) {
  const config = validateEnv(env);
  if (!DRY(env)) {
    // A process may die after an external POST. Put abandoned claims into
    // manual review, NEVER re-send them automatically.
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    await env.DB.prepare(`UPDATE campaigns SET status='needs_review',
      last_error='Worker execution was interrupted. Inspect Brevo before rescheduling.',updated_at=?
      WHERE status IN ('working','prepared') AND updated_at<?`)
      .bind(nowISO(),stale).run();
  }
  const list = await env.DB.prepare(`SELECT id, name, subject, html, preview_text, scheduled_at, day_ist, status, brevo_campaign_id
    FROM campaigns WHERE status='queued' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 5`)
    .bind(nowISO()).all();
  if (DRY(env)) return {dryRun:true, due: list.results.map(x => ({id:x.id,name:x.name,dayIst:x.day_ist})), sent:0};

  const outcomes = [];
  for (const job of list.results) {
    // The claim prevents concurrent cron/manual processing from duplicate submission.
    const claim = await env.DB.prepare(`UPDATE campaigns SET status='working',updated_at=?
      WHERE id=? AND status='queued'`).bind(nowISO(),job.id).run();
    if (claim.meta?.changes !== 1) continue;
    try {
      // GET is safe to retry on the next cron if it fails before remote mutation.
      // Brevo list-contact count includes potentially blacklisted contacts; this is conservative.
      const audienceSize = await listAudienceSize(env,config.listId);
      if (audienceSize < 1 || audienceSize > config.max) {
        await saveStatus(env,job.id,'blocked',`Audience contains ${audienceSize} contacts; requires 1–${config.max}.`);
        outcomes.push({id:job.id,status:'blocked',count:audienceSize});
        continue;
      }
      const allowed=await reserveSendQuota(env,job.day_ist,audienceSize,config.max);
      if(!allowed) {
        await saveStatus(env,job.id,'blocked',`Daily ${config.max}-recipient app reservation exhausted for ${job.day_ist}. Edit this blocked campaign to another date.`);
        outcomes.push({id:job.id,status:'blocked',reason:'DAILY_QUOTA_REACHED'});
        continue;
      }
      // Persist the reservation on this job. Retain it even if the external
      // create/send outcome becomes uncertain; it prevents duplicate/over-budget sends.
      await env.DB.prepare('UPDATE campaigns SET recipient_estimate=?,quota_reserved=? WHERE id=?')
        .bind(audienceSize,audienceSize,job.id).run();
    } catch (error) {
      // No remote campaign was created yet. Safe to retry read-only failure.
      await saveStatus(env,job.id,'queued',String(error.message).slice(0,600));
      outcomes.push({id:job.id,status:'will_retry',error:error.message});
      continue;
    }

    // Important: once we attempt to create/send an external campaign, NO automatic
    // retries are possible without verification (timeouts can mean it was sent).
    try {
      const created = await brevo(env, 'POST', '/emailCampaigns', {
        name: `${job.name} [${job.id}]`,
        subject: job.subject,
        sender: {name: env.SENDER_NAME, email: env.SENDER_EMAIL},
        replyTo: env.REPLY_TO_EMAIL || env.SENDER_EMAIL,
        recipients: {listIds: [config.listId]},
        htmlContent: job.html,
        previewText: job.preview_text || undefined
      });
      if (!Number.isSafeInteger(created.id)) throw new Error('Brevo did not return a campaign ID');
      await saveStatus(env,job.id,'prepared',null,created.id);
      try {
        await brevo(env, 'POST', `/emailCampaigns/${created.id}/sendNow`);
        await saveStatus(env,job.id,'submitted',null,created.id);
        outcomes.push({id:job.id,status:'submitted',brevoCampaignId:created.id});
      } catch (error) {
        await saveStatus(env,job.id,'needs_review',error.message.slice(0,600),created.id);
        outcomes.push({id:job.id,status:'needs_review',error:error.message,brevoCampaignId:created.id});
      }
    } catch (error) {
      // Unknown create outcome: do not blindly create another campaign.
      await saveStatus(env,job.id,'needs_review',error.message.slice(0,600));
      outcomes.push({id:job.id,status:'needs_review',error:error.message});
    }
  }
  return {dryRun:false,outcomes};
}

// Validates only the explicit-consent contact shape used by the dashboard.
// Existing contacts are never updated or re-subscribed by this importer.
function validateContact(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Contact must be an object');
  const email = String(input.email ?? '').trim().toLowerCase();
  const firstName = String(input.first_name ?? '').trim();
  const lastName = String(input.last_name ?? '').trim();
  const consentSource = String(input.consent_source ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Invalid email');
  if (String(input.consent ?? '').toLowerCase() !== 'yes') throw new Error('Explicit consent required');
  if (consentSource.length < 3 || consentSource.length > 250) throw new Error('Consent source required (3–250 chars)');
  if (firstName.length > 100 || lastName.length > 100) throw new Error('Name too long');
  return {email, firstName, lastName};
}

// Contacts need only an API key and a list; sender and D1 are campaign-only settings.
// Return safe diagnostics to the authenticated administrator instead of a generic 500.
function contactConfig(env) {
  const missing = [];
  if (!env.BREVO_API_KEY) missing.push('BREVO_API_KEY');
  const listId = Number(env.BREVO_LIST_ID);
  if (!Number.isSafeInteger(listId) || listId <= 0) missing.push('BREVO_LIST_ID');
  if (missing.length) return { error: response({
    error: `Contact integration is not configured: ${missing.join(', ')}. Set these as Wrangler secrets, then retry.`,
    code: 'CONTACT_CONFIG_MISSING', missing
  }, 503) };
  return { listId };
}

function contactProviderError(error) {
  // Never forward provider response bodies, API keys or internal stack traces.
  if (error.httpStatus === 401 || error.httpStatus === 403) {
    return response({error:'Brevo refused contact access. Check BREVO_API_KEY and its API permissions.',code:'BREVO_AUTH_FAILED'},502);
  }
  if (error.httpStatus === 404) {
    return response({error:'The configured Brevo contact list could not be found. Check BREVO_LIST_ID.',code:'BREVO_LIST_NOT_FOUND'},502);
  }
  if (error.httpStatus === 429) {
    return response({error:'Brevo rate limit reached. Wait and try again.',code:'BREVO_RATE_LIMIT'},503);
  }
  console.error('Brevo contact request failed:',error.httpStatus ?? 'network/unexpected');
  return response({error:'Could not connect to Brevo contacts. Check the Brevo dashboard and Cloudflare Worker logs.',code:'BREVO_CONTACTS_UNAVAILABLE'},502);
}

// Contact mutations are scoped to the selected Brevo list. Deleting removes
// list membership instead of permanently erasing the contact from all lists.
function parseContactEmail(path) {
  const encoded = path.slice('/admin/contacts/'.length);
  if (!encoded || encoded.includes('/')) return null;
  let email;
  try {email = decodeURIComponent(encoded).trim().toLowerCase();} catch {return null;}
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

async function handleContactItem(request, env, path) {
  if (!['PUT','DELETE'].includes(request.method)) return bad('Method not allowed',405);
  const config = contactConfig(env);
  if (config.error) return config.error;
  const email = parseContactEmail(path);
  if (!email) return bad('Invalid contact email');
  let attributes = null;
  if (request.method === 'PUT') {
    let input;
    try { input = await request.json(); } catch { return bad('Invalid JSON body'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.firstName !== 'string' || typeof input.lastName !== 'string') {
      return bad('firstName and lastName must be strings');
    }
    const firstName = input.firstName.trim(), lastName = input.lastName.trim();
    if (firstName.length > 100 || lastName.length > 100) return bad('Names must be at most 100 characters');
    attributes = {FNAME:firstName, LNAME:lastName};
  }
  try {
    // Prevent this admin list UI from changing contacts outside its own list.
    const current = await brevo(env,'GET',`/contacts/${encodeURIComponent(email)}`);
    if (!Array.isArray(current.listIds) || !current.listIds.some(id => Number(id) === config.listId)) {
      return response({error:'This contact is not in the configured Brevo list.',code:'CONTACT_NOT_IN_LIST'},404);
    }
    if (request.method === 'PUT') {
      // Do not change emailBlacklisted, listIds, consent, or other attributes.
      await brevo(env,'PUT',`/contacts/${encodeURIComponent(email)}`,{attributes});
      return response({ok:true,email,firstName:attributes.FNAME,lastName:attributes.LNAME});
    }
    const removed = await brevo(env,'POST',`/contacts/lists/${config.listId}/contacts/remove`,{emails:[email]});
    if (Array.isArray(removed.failure) && removed.failure.some(f=>String(f).toLowerCase()===email)) {
      return response({error:'Brevo could not remove this contact from the list.',code:'BREVO_REMOVE_FAILED'},502);
    }
    return response({ok:true,email,removedFromList:config.listId,
      note:'Removed from this list only. Other Brevo lists and contact history are unchanged.'});
  } catch (error) { return contactProviderError(error); }
}

async function handleContacts(request, env, path, url) {
  const config = contactConfig(env);
  if (config.error) return config.error;
  const { listId } = config;
  if (path === '/admin/contacts' && request.method === 'GET') {
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 25);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return bad('Invalid pagination');
    let data;
    try {
      data = await brevo(env, 'GET', `/contacts/lists/${listId}/contacts?limit=${limit}&offset=${offset}&sort=desc`);
    } catch (error) { return contactProviderError(error); }
    const contacts = (data.contacts || []).map(x => ({
      id:x.id, email:x.email, firstName:x.attributes?.FNAME || x.attributes?.FIRSTNAME || '',
      lastName:x.attributes?.LNAME || x.attributes?.LASTNAME || '',
      emailBlacklisted:Boolean(x.emailBlacklisted),
      unsubscribed:Boolean(x.listUnsubscribed?.includes(listId)),
      createdAt:x.createdAt || null
    }));
    return response({contacts, count:Number(data.count) || 0, offset, limit, listId});
  }
  if (path === '/admin/contacts' && request.method === 'POST') {
    let data;
    try { data = await request.json(); } catch { return bad('Invalid JSON body'); }
    if (data?.confirmed !== true || !Array.isArray(data.contacts) || data.contacts.length < 1 || data.contacts.length > 10) {
      return bad('Confirm consent and import 1–10 contacts per request');
    }
    // Reject an entire batch with invalid consent before contacting Brevo.
    let contacts;
    try {
      contacts = data.contacts.map(validateContact);
      if (new Set(contacts.map(c => c.email)).size !== contacts.length) throw new Error('Duplicate emails in batch');
    } catch (error) { return bad(error.message); }
    const results = [];
    for (const contact of contacts) {
      const attributes = {};
      if (contact.firstName) attributes.FNAME = contact.firstName;
      if (contact.lastName) attributes.LNAME = contact.lastName;
      try {
        await brevo(env, 'POST', '/contacts', {
          email: contact.email, attributes, listIds:[listId], updateEnabled:false
        });
        results.push({email:contact.email,status:'created'});
      } catch (error) {
        if (error.httpStatus === 400 && /exist|duplicate/i.test(error.message)) {
          // Do not update, add to list, or change suppression of an existing contact.
          results.push({email:contact.email,status:'existing_skipped'});
        } else {
          results.push({email:contact.email,status:'failed',error:error.message.slice(0,180)});
          // Account-wide rate limiting or auth problems should not cause more calls.
          if ([401,403,429].includes(error.httpStatus)) break;
        }
      }
    }
    return response({results, created:results.filter(x=>x.status==='created').length,
      skipped:results.filter(x=>x.status==='existing_skipped').length,
      failed:results.filter(x=>x.status==='failed').length});
  }
  return bad('Unknown endpoint',404);
}

async function handleAdmin(request, env, path, url) {
  if (!auth(request, env)) return bad('Unauthorized',401);
  if (path === '/admin/prospects' || path.startsWith('/admin/prospects/')) return handleProspects(request,env,path,url);
  if (path === '/admin/contacts') return handleContacts(request,env,path,url);
  if (path.startsWith('/admin/contacts/') && path.endsWith('/activity') && request.method==='GET') {
    const email=parseContactEmail(path.slice(0,-'/activity'.length));
    if(!email)return bad('Invalid contact email');
    const cfg=contactConfig(env);if(cfg.error)return cfg.error;
    try {
      const r=await brevo(env,'GET',`/contacts/${encodeURIComponent(email)}/campaignStats`);
      const own=await env.DB.prepare('SELECT brevo_campaign_id FROM campaigns WHERE brevo_campaign_id IS NOT NULL').all();
      const ids=new Set(own.results.map(x=>Number(x.brevo_campaign_id)));
      const events=[];
      for(const key of ['messagesSent','delivered','opened','clicked','hardBounces','softBounces','complaints']){
        for(const v of (Array.isArray(r[key])?r[key]:[]))if(ids.has(Number(v.campaignId))){
          events.push({event:key,campaignId:Number(v.campaignId),at:v.eventTime||v.date||null,
            ...(key==='clicked'?{links:(v.links||[]).slice(0,5).map(k=>({url:String(k.url||'').slice(0,400),count:Number(k.count)||0}))}:{})});
        }
      }
      return response({email,events:events.slice(0,100),window:'Brevo contact engagement reporting is generally limited to 90-day ranges; provider data can be delayed.'});
    }catch(error){return contactProviderError(error);}
  }
  if (path.startsWith('/admin/contacts/')) return handleContactItem(request,env,path);
  if (path === '/admin/config' && request.method === 'GET') {
    const contactsConfig = contactConfig(env);
    return response({dryRun:DRY(env), maxDailyRecipients:Number(env.MAX_DAILY_RECIPIENTS || EMAIL_CAP_FREE),
      listId:Number(env.BREVO_LIST_ID)||null, senderName:env.SENDER_NAME||null,senderEmail:env.SENDER_EMAIL||null,
      contactsReady:!contactsConfig.error, contactConfigMissing:contactsConfig.error ?
        [!env.BREVO_API_KEY && 'BREVO_API_KEY', !(Number.isSafeInteger(Number(env.BREVO_LIST_ID)) && Number(env.BREVO_LIST_ID) > 0) && 'BREVO_LIST_ID'].filter(Boolean) : []});
  }
  if (path === '/admin/quota' && request.method === 'GET') {
    const day=url.searchParams.get('day') || new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) return bad('Invalid IST date');
    const cap=Number(env.MAX_DAILY_RECIPIENTS||EMAIL_CAP_FREE);
    const used=await dailyUsage(env,day);
    const pending=await env.DB.prepare(`SELECT COALESCE(SUM(recipient_estimate),0) AS total,COUNT(*) AS campaigns
      FROM campaigns WHERE day_ist=? AND status='queued'`).bind(day).first();
    return response({dayIst:day,used,pending:Number(pending?.total||0),queuedCampaigns:Number(pending?.campaigns||0),
      cap,remaining:Math.max(0,cap-used),externalBrevoUsageIncluded:false});
  }
  if (path === '/admin/reports/summary' && request.method === 'GET') {
    const rows=await env.DB.prepare(`SELECT id,name,status,brevo_campaign_id FROM campaigns
      WHERE brevo_campaign_id IS NOT NULL ORDER BY scheduled_at DESC LIMIT 5`).all();
    const results=await Promise.allSettled(rows.results.map(row=>campaignReport(env,row,false)));
    const reports=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
    const sum=reports.reduce((o,r)=>{for(const [k,v] of Object.entries(r.metrics||{}))o[k]=(o[k]||0)+v;return o;},{});
    return response({reports,totals:metrics(sum),partial:results.some(r=>r.status==='rejected') || rows.results.length===5,
      sampled:rows.results.length,limitedTo:5,updatedAt:nowISO(),
      note:'Totals reflect up to five recent campaigns with available statistics; not entire account activity. Opens are estimates.'});
  }
  const reportMatch=path.match(/^\/admin\/campaigns\/([a-f0-9-]{36})\/report$/);
  if(reportMatch && request.method==='GET') {
    const row=await env.DB.prepare('SELECT id,name,status,brevo_campaign_id FROM campaigns WHERE id=?')
      .bind(reportMatch[1]).first();
    if(!row) return bad('Campaign not found',404);
    try{return response(await campaignReport(env,row));}catch(error){return contactProviderError(error);}
  }
  if (path === '/admin/campaigns' && request.method === 'GET') {
    const all = await env.DB.prepare(`SELECT id,name,subject,scheduled_at,day_ist,status,
      brevo_campaign_id,last_error,preview_text,recipient_estimate,quota_reserved,created_at,updated_at FROM campaigns ORDER BY scheduled_at DESC LIMIT 100`).all();
    return response({campaigns:all.results});
  }
  if (path === '/admin/campaigns' && request.method === 'POST') {
    let payload;
    try {payload = normalizeCampaign(await request.json());}
    catch (e) {return bad(e.message);}
    const config=validateEnv(env);
    let estimated;
    try {estimated=await listAudienceSize(env,config.listId);}
    catch(error){return contactProviderError(error);}
    const budget=await previewBudget(env,payload.dayIst,estimated,config.max);
    if(!budget.allowed) return response({error:`Scheduling would exceed the estimated ${config.max}-recipient daily budget, or the list is empty. Change date or list size.`,code:'DAILY_BUDGET_EXCEEDED',budget},409);
    const id=crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO campaigns(id,name,subject,html,preview_text,scheduled_at,day_ist,recipient_estimate)
      VALUES(?,?,?,?,?,?,?,?)`).bind(id,payload.name,payload.subject,payload.html,payload.previewText,
        payload.scheduledAt,payload.dayIst,estimated).run();
    return response({id,status:'queued',dryRun:DRY(env),scheduledAt:payload.scheduledAt,
      recipientEstimate:estimated,budget},201);
  }
  // Explicit one-recipient test; creates a temporary Brevo marketing draft,
  // sends via /sendTest, then attempts cleanup. Never calls /sendNow.
  if (path === '/admin/test-send' && request.method==='POST') {
    let input;
    try{input=await request.json();}catch{return bad('Invalid JSON body');}
    const email=String(input?.testEmail||'').trim().toLowerCase();
    if(!input?.confirmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254)
      return bad('Confirm and provide one valid test email address you control.');
    let item;
    try{item=normalizeCampaign({...input,scheduledAt:new Date(Date.now()+5*60000).toISOString()});}
    catch(error){return bad(error.message);}
    const config=validateEnv(env);
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    await env.DB.prepare('INSERT OR IGNORE INTO daily_test_usage(day_ist,attempted) VALUES(?,0)').bind(day).run();
    const allowed=await env.DB.prepare(`UPDATE daily_test_usage SET attempted=attempted+1
      WHERE day_ist=? AND attempted<3`).bind(day).run();
    if(allowed.meta?.changes!==1) return response({error:'Maximum 3 Mailroom test emails per IST day. Retry tomorrow.',code:'TEST_LIMIT_REACHED'},429);
    let externalId=null;
    try{
      const created=await brevo(env,'POST','/emailCampaigns',{
        name:`[Mailroom TEST] ${item.name}`,subject:item.subject,
        sender:{name:env.SENDER_NAME,email:env.SENDER_EMAIL},
        replyTo:env.REPLY_TO_EMAIL||env.SENDER_EMAIL,
        recipients:{listIds:[config.listId]},htmlContent:item.html,
        previewText:item.previewText||undefined
      });
      if(!Number.isSafeInteger(created.id)) throw new Error('Brevo campaign ID missing');
      externalId=created.id;
      await brevo(env,'POST',`/emailCampaigns/${externalId}/sendTest`,{emailTo:[email]});
      return response({ok:true,submitted:true,recipient:email,
        note:'Test email requested from Brevo. Inbox delivery is not guaranteed and can take time.'});
    }catch(error){
      console.error('Test email request failed',error.httpStatus||'unknown');
      return contactProviderError(error);
    }finally{
      if(externalId){try{await brevo(env,'DELETE',`/emailCampaigns/${externalId}`);}catch(error){
        console.error('Temporary test draft cleanup failed',externalId,error.httpStatus||'unknown');
      }}
    }
  }
  if (path === '/admin/run' && request.method === 'POST') return response(await runDue(env));
  // Race-safe CRUD for queued future campaigns. A Cron claim can only update
  // queued jobs, so mutations must also use an atomic queued + future guard.
  const campaignItem = path.match(/^\/admin\/campaigns\/([a-f0-9-]{36})$/);
  if (campaignItem) {
    const id = campaignItem[1];
    if (request.method === 'GET') {
      const row = await env.DB.prepare(`SELECT id,name,subject,html,preview_text,scheduled_at,day_ist,status,brevo_campaign_id
        FROM campaigns WHERE id=?`).bind(id).first();
      if (!row) return bad('Campaign not found',404);
      return response({campaign:row});
    }
    if (request.method === 'PUT') {
      let payload;
      try {payload=normalizeCampaign(await request.json());} catch (error) {return bad(error.message);}
      const existing=await env.DB.prepare('SELECT id,status,brevo_campaign_id,scheduled_at FROM campaigns WHERE id=?').bind(id).first();
      if(!existing || !['queued','blocked'].includes(existing.status) || existing.brevo_campaign_id ||
          (existing.status==='queued' && Date.parse(existing.scheduled_at)<=Date.now()+60_000))
        return response({error:'Only future queued or blocked unsent campaigns can be edited.',code:'CAMPAIGN_NOT_EDITABLE'},409);
      const config=validateEnv(env);
      let count;
      try{count=await listAudienceSize(env,config.listId);}catch(error){return contactProviderError(error);}
      const budget=await previewBudget(env,payload.dayIst,count,config.max,id);
      if(!budget.allowed) return response({error:'Estimated daily recipient budget exceeded. Choose another day or reduce recipients.',code:'DAILY_BUDGET_EXCEEDED',budget},409);
      const change=await env.DB.prepare(`UPDATE campaigns SET name=?,subject=?,html=?,preview_text=?,scheduled_at=?,day_ist=?,
        recipient_estimate=?,status='queued',last_error=NULL,updated_at=?
        WHERE id=? AND status=? AND brevo_campaign_id IS NULL AND (status='blocked' OR scheduled_at>?)`)
        .bind(payload.name,payload.subject,payload.html,payload.previewText,payload.scheduledAt,payload.dayIst,
          count,nowISO(),id,existing.status,new Date(Date.now()+60_000).toISOString()).run();
      if(change.meta?.changes!==1) return response({error:'Campaign changed while saving. Refresh and retry.',code:'CAMPAIGN_NOT_EDITABLE'},409);
      return response({ok:true,id,status:'queued',scheduledAt:payload.scheduledAt,recipientEstimate:count});
    }
    if (request.method === 'DELETE') {
      const change=await env.DB.prepare(`DELETE FROM campaigns WHERE id=? AND ((status='queued' AND scheduled_at>?) OR status='blocked')
        AND brevo_campaign_id IS NULL`)
        .bind(id,new Date(Date.now()+60_000).toISOString()).run();
      if (change.meta?.changes !== 1) return response({error:'Only future queued or blocked unsent campaigns can be deleted. Refresh the list.',code:'CAMPAIGN_NOT_EDITABLE'},409);
      return response({ok:true,id,deleted:true});
    }
    return bad('Method not allowed',405);
  }
  const match = path.match(/^\/admin\/campaigns\/([a-f0-9-]{36})\/brevo$/);
  if (match && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT brevo_campaign_id FROM campaigns WHERE id=?').bind(match[1]).first();
    if (!row?.brevo_campaign_id) return bad('No known Brevo campaign ID; review Brevo dashboard manually.',404);
    const result = await brevo(env,'GET',`/emailCampaigns/${row.brevo_campaign_id}`);
    return response({brevoCampaignId:row.brevo_campaign_id,status:result.status,statistics:result.statistics || null});
  }
  return bad('Unknown endpoint',404);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/health' && request.method === 'GET') return response({ok:true,dryRun:DRY(env)});
      if (path.startsWith('/admin/')) return await handleAdmin(request,env,path,new URL(request.url));
      if (request.method === 'GET' && env.ASSETS && ['/', '/index.html', '/app.css', '/app.js', '/prospects.js', '/favicon.svg'].includes(path)) {
        const asset = await env.ASSETS.fetch(request);
        const headers = new Headers(asset.headers);
        headers.set('X-Content-Type-Options','nosniff');
        headers.set('Referrer-Policy','no-referrer');
        if (path === '/' || path === '/index.html') {
          headers.set('Cache-Control','no-store');
          headers.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; style-src-elem 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        }
        return new Response(asset.body,{status:asset.status,headers});
      }
      return bad('Not found',404);
    } catch (e) {
      console.error('Worker error:',e);
      return bad('Operation failed; check Worker logs. Failed send attempts require manual review.',500);
    }
  },
  async scheduled(_event,env,ctx) {
    ctx.waitUntil(runDue(env).then(result => console.log(JSON.stringify(result))));
  }
};
