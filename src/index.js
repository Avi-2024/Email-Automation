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

async function handleAdmin(request, env, path) {
  if (!auth(request, env)) return bad('Unauthorized',401);
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
      if (path.startsWith('/admin/')) return handleAdmin(request,env,path);
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
