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
  const list = await env.DB.prepare(`SELECT id, name, subject, html, scheduled_at, day_ist, status, brevo_campaign_id
    FROM campaigns WHERE status='queued' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 3`)
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
      const listInfo = await brevo(env, 'GET', `/contacts/lists/${config.listId}/contacts?limit=1`);
      if (!Number.isSafeInteger(listInfo.count) || listInfo.count < 1 || listInfo.count > config.max) {
        await saveStatus(env, job.id, 'blocked', `List has ${listInfo.count} contacts; free limit configured at ${config.max}. Adjust the list before making a NEW campaign.`);
        outcomes.push({id:job.id,status:'blocked',count:listInfo.count});
        continue;
      }
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
        htmlContent: job.html
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

// Contacts only need the API key and list ID, not D1 or campaign sender credentials.
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
  // Keep provider error bodies, API keys and internal exception details server-side.
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


// Contact CRUD uses the configured Brevo list as its scope.
// "Delete" removes list membership, NEVER globally deletes the contact.
function contactItemEmail(path) {
  const raw = path.slice('/admin/contacts/'.length);
  if (!raw || raw.includes('/')) return null;
  let email;
  try { email = decodeURIComponent(raw).trim().toLowerCase(); }
  catch { return null; }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

async function handleContactItem(request, env, path) {
  if (!['PUT','DELETE'].includes(request.method)) return bad('Method not allowed',405);
  const config = contactConfig(env);
  if (config.error) return config.error;
  const email = contactItemEmail(path);
  if (!email) return bad('Invalid contact email');
  let attrs;
  if (request.method === 'PUT') {
    let data;
    try { data = await request.json(); }
    catch { return bad('Invalid JSON body'); }
    if (!data || typeof data.firstName !== 'string' || typeof data.lastName !== 'string') {
      return bad('firstName and lastName must be strings');
    }
    const firstName = data.firstName.trim(), lastName = data.lastName.trim();
    if (firstName.length > 100 || lastName.length > 100) return bad('Names must be at most 100 characters');
    attrs = {FNAME:firstName,LNAME:lastName};
  }
  try {
    const current = await brevo(env,'GET','/contacts/'+encodeURIComponent(email));
    if (!Array.isArray(current.listIds) || !current.listIds.some(id=>Number(id)===config.listId)) {
      return response({error:'Contact is not in this mailing list.',code:'CONTACT_NOT_IN_LIST'},404);
    }
    if (request.method === 'PUT') {
      await brevo(env,'PUT','/contacts/'+encodeURIComponent(email),{attributes:attrs});
      return response({ok:true,email,firstName:attrs.FNAME,lastName:attrs.LNAME});
    }
    const removed = await brevo(env,'POST','/contacts/lists/'+config.listId+'/contacts/remove',{emails:[email]});
    if (Array.isArray(removed.failure) && removed.failure.some(v=>String(v).toLowerCase()===email)) {
      return response({error:'Brevo could not remove the contact from this list.',code:'BREVO_REMOVE_FAILED'},502);
    }
    return response({ok:true,email,removedFromList:config.listId});
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
  if (path === '/admin/contacts') return handleContacts(request,env,path,url);
  if (path.startsWith('/admin/contacts/')) return handleContactItem(request,env,path);
  if (path === '/admin/config' && request.method === 'GET') {
    const contactsConfig = contactConfig(env);
    return response({dryRun:DRY(env), maxDailyRecipients:Number(env.MAX_DAILY_RECIPIENTS || EMAIL_CAP_FREE),
      listId:Number(env.BREVO_LIST_ID)||null, senderName:env.SENDER_NAME||null,senderEmail:env.SENDER_EMAIL||null,
      contactsReady:!contactsConfig.error, contactConfigMissing:contactsConfig.error ?
        [!env.BREVO_API_KEY && 'BREVO_API_KEY', !(Number.isSafeInteger(Number(env.BREVO_LIST_ID)) && Number(env.BREVO_LIST_ID) > 0) && 'BREVO_LIST_ID'].filter(Boolean) : []});
  }
  if (path === '/admin/campaigns' && request.method === 'GET') {
    const all = await env.DB.prepare(`SELECT id,name,subject,scheduled_at,day_ist,status,
      brevo_campaign_id,last_error,created_at,updated_at FROM campaigns ORDER BY scheduled_at DESC LIMIT 100`).all();
    return response({campaigns:all.results});
  }
  if (path === '/admin/campaigns' && request.method === 'POST') {
    let payload;
    try {payload = normalizeCampaign(await request.json());}
    catch (e) {return bad(e.message);}
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(`INSERT INTO campaigns(id,name,subject,html,scheduled_at,day_ist)
        VALUES(?,?,?,?,?,?)`)
        .bind(id,payload.name,payload.subject,payload.html,payload.scheduledAt,payload.dayIst).run();
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return bad('Only one campaign per IST day is allowed in this free-plan starter',409);
      throw e;
    }
    return response({id,status:'queued',dryRun:DRY(env),scheduledAt:payload.scheduledAt},201);
  }
  if (path === '/admin/run' && request.method === 'POST') return response(await runDue(env));

  // Only queued future campaigns can be changed; never modify submitted jobs.
  const item = path.match(/^\/admin\/campaigns\/([a-f0-9-]{36})$/);
  if (item) {
    const id = item[1];
    if (request.method === 'GET') {
      const job = await env.DB.prepare(
        'SELECT id,name,subject,html,scheduled_at,day_ist,status,brevo_campaign_id FROM campaigns WHERE id=?'
      ).bind(id).first();
      return job ? response({campaign:job}) : bad('Campaign not found',404);
    }
    if (request.method === 'PUT') {
      let payload;
      try { payload=normalizeCampaign(await request.json()); }
      catch(error) { return bad(error.message); }
      try {
        const change=await env.DB.prepare(
          "UPDATE campaigns SET name=?,subject=?,html=?,scheduled_at=?,day_ist=?,updated_at=? WHERE id=? AND status='queued' AND brevo_campaign_id IS NULL AND scheduled_at>?"
        ).bind(payload.name,payload.subject,payload.html,payload.scheduledAt,payload.dayIst,nowISO(),id,
          new Date(Date.now()+60000).toISOString()).run();
        if (change.meta?.changes!==1) return response({error:'Only queued future campaigns can be edited.',code:'CAMPAIGN_NOT_EDITABLE'},409);
        return response({ok:true,id,status:'queued',scheduledAt:payload.scheduledAt});
      } catch(error) {
        if (/UNIQUE/i.test(error.message)) return bad('Another campaign exists on that IST date',409);
        throw error;
      }
    }
    if (request.method === 'DELETE') {
      const change=await env.DB.prepare(
        "DELETE FROM campaigns WHERE id=? AND status='queued' AND brevo_campaign_id IS NULL AND scheduled_at>?"
      ).bind(id,new Date(Date.now()+60000).toISOString()).run();
      if (change.meta?.changes!==1) return response({error:'Only queued future campaigns can be deleted.',code:'CAMPAIGN_NOT_EDITABLE'},409);
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
      if (request.method === 'GET' && env.ASSETS && ['/', '/index.html', '/app.css', '/app.js', '/favicon.svg', '/crud.js'].includes(path)) {
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
