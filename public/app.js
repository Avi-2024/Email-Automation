// Mailroom dashboard — statically served by the same Cloudflare Worker as the API.
// ADMIN_TOKEN stays in memory only. Never hardcode or persist it.
const $ = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
const state = { token: '', campaigns: [], contacts: [], contactCount: null, offset: 0, limit: 25, config: null, view: 'overview', reports: null, activeReport: null, quota: null, busy: false, editingCampaignId: null, editingContactEmail: null };
const starter = `<html>\n  <body style="margin:0;padding:32px;background:#f7f8fb;font-family:Arial,sans-serif;color:#203044">\n    <table role="presentation" style="max-width:580px;width:100%;margin:auto;background:#fff;border-radius:12px" cellspacing="0" cellpadding="0"><tr><td style="padding:44px">\n      <p style="font-size:12px;font-weight:700;letter-spacing:2px;color:#0e8976">NEXILO LABS</p>\n      <h1 style="font-size:30px;letter-spacing:-1px">Hello {{ contact.FNAME }}!</h1>\n      <p style="font-size:16px;line-height:1.8">Thanks for joining us. We're glad you're here.</p>\n      <p style="font-size:16px;line-height:1.8">Stay tuned for helpful resources and updates from our team.</p>\n      <p style="margin-top:30px">Best regards,<br><strong>The Nexilo Labs team</strong></p>\n    </td></tr></table>\n  </body>\n</html>`;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const message = (err) => err instanceof Error ? err.message : String(err);
function notify(s, bad = false) { const t = $('toast'); t.textContent = s; t.classList.toggle('error', bad); t.classList.add('show'); clearTimeout(notify.timer); notify.timer = setTimeout(() => t.classList.remove('show'), 4800); }
async function api(path, opts = {}) {
  if (!state.token) throw new Error('Please sign in again.');
  const res = await fetch(path, {method:opts.method || 'GET', headers:{Authorization:`Bearer ${state.token}`, ...(opts.body ? {'Content-Type':'application/json'} : {})}, body:opts.body ? JSON.stringify(opts.body):undefined, cache:'no-store'});
  let data;
  try { data = await res.json(); } catch { throw new Error('API returned an unexpected response.'); }
  if (!res.ok) { if (res.status === 401) signOut('Token invalid or expired. Please check your ADMIN_TOKEN.'); throw new Error(data.error || `Request failed (${res.status})`); }
  return data;
}
function shortDate(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(+d) ? '—' : new Intl.DateTimeFormat('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'}).format(d); }
function badge(status) { const label = String(status || 'unknown').replaceAll('_',' '); return `<span class="status status-${esc(status)}"><span class="status-dot"></span>${esc(label)}</span>`; }
function campaignRows(items, brief = false) {
  if (!items.length) return `<tr><td colspan="${brief ? 4 : 5}" class="empty-td">No campaigns ${state.campaigns.length ? 'match your filters' : 'yet. Create your first campaign in the editor'}.</td></tr>`;
  return items.map(c=>{
    const editable = !c.brevo_campaign_id && (c.status === 'blocked' || (c.status === 'queued' && Date.parse(c.scheduled_at) > Date.now() + 60000));
    const controls = editable ? `<button class="tiny-btn" data-edit-campaign="${esc(c.id)}">Edit</button><button class="tiny-btn danger-link" data-delete-campaign="${esc(c.id)}">Delete</button>` :
      c.brevo_campaign_id ? `<button class="tiny-btn" data-report-campaign="${esc(c.id)}">View report ↗</button>` : `<span class="cell-sub" title="${esc(c.last_error||'')}">${esc(c.last_error ? c.last_error.slice(0,90) : 'Locked')}</span>`;
    return `<tr><td><div class="cell-main">${esc(c.name)}</div><div class="cell-sub">${esc(c.subject)}</div></td><td>${esc(shortDate(c.scheduled_at))}</td><td>${badge(c.status)}</td>${brief ? '<td></td>' : `<td class="mono">${c.brevo_campaign_id ? esc(c.brevo_campaign_id) : '—'}</td><td><div class="row-actions">${controls}</div></td>`}</tr>`;
  }).join('');
}
function renderCampaigns() {
 const s = $('campaign-search').value.toLowerCase(); const f = $('campaign-status').value;
 const matching = state.campaigns.filter(x => (f==='all' || x.status===f) && (`${x.name} ${x.subject}`.toLowerCase().includes(s)));
 $('all-campaigns').innerHTML = campaignRows(matching);
 $('recent-table').innerHTML = campaignRows(state.campaigns.slice(0,5),true);
 const counts = state.campaigns.reduce((o,c)=>(o[c.status]=(o[c.status]||0)+1,o),{});
 $('metric-total').textContent=state.campaigns.length;
 $('metric-queued').textContent=counts.queued||0;
 $('metric-submitted').textContent=counts.submitted||0;
 $('side-campaign-count').textContent=state.campaigns.length;
}
async function refreshCampaigns() { const d = await api('/admin/campaigns'); state.campaigns = Array.isArray(d.campaigns) ? d.campaigns:[]; renderCampaigns(); }
async function refreshContacts() {
 const d = await api(`/admin/contacts?limit=${state.limit}&offset=${state.offset}`);
 state.contacts = Array.isArray(d.contacts)?d.contacts:[]; state.contactCount=d.count||0;
 renderContacts();
}
function renderContacts() {
 const search = $('contact-search').value.toLowerCase();
 const contacts = state.contacts.filter(c=>`${c.email} ${c.firstName} ${c.lastName}`.toLowerCase().includes(search));
 $('contacts-table').innerHTML = contacts.length ? contacts.map(c=>`<tr><td><div class="cell-main">${esc(c.email)}</div></td><td>${esc(`${c.firstName||''} ${c.lastName||''}`.trim() || '—')}</td><td>${badge(c.emailBlacklisted?'blocked':c.unsubscribed?'unsubscribed':'active')}</td><td>${esc(shortDate(c.createdAt))}</td><td><div class="row-actions"><button class="tiny-btn" data-contact-activity="${esc(c.email)}">Activity</button><button class="tiny-btn" data-edit-contact="${esc(c.email)}">Edit</button><button class="tiny-btn danger-link" data-remove-contact="${esc(c.email)}" title="Delete from this list only, not from other Brevo lists">Delete</button></div></td></tr>`).join('') : '<tr><td colspan="5" class="empty-td">No contacts found on this page.</td></tr>';
 const total=state.contactCount??0; $('contacts-total').textContent = total.toLocaleString('en-IN'); $('metric-contacts').textContent = total.toLocaleString('en-IN');
 $('contacts-pagination').textContent = total ? `Showing ${Math.min(state.offset+1,total)}–${Math.min(state.offset+state.limit,total)} of ${total} contacts` : 'No contacts in this list';
 $('contact-prev').disabled=state.offset===0; $('contact-next').disabled=state.offset+state.limit>=total;
 $('plan-used').textContent = `${total} / 300 contacts`;
 $('quota-progress').value = Math.min(total,300);
}
async function refreshConfig() {
 const c = await api('/admin/config'); state.config=c;
 $('config-dry').textContent = c.dryRun?'Enabled · no sending':'Disabled · live sending';
 $('config-list').textContent = c.listId??'Not configured';
 $('config-sender').textContent = c.senderEmail || 'Not configured';
 $('config-cap').textContent = `${c.maxDailyRecipients || 300} total recipient attempts per IST day`;
    await refreshQuota();
  if (!c.contactsReady) notify(`Contact integration needs: ${(c.contactConfigMissing || []).join(', ')}`,true);
 $('mode-badge').textContent = c.dryRun?'SAFE MODE':'LIVE SENDING';
 $('mode-badge').classList.toggle('live',!c.dryRun);
 $('drynotice').innerHTML = c.dryRun?'◈ <strong>Safe mode is on.</strong> Campaigns are queued but never sent while DRY_RUN=true. You’re free to explore and test. <button data-view="settings">View settings →</button>':'◈ <strong>Live sending is on.</strong> Due campaigns can be submitted automatically by Cloudflare Cron. <button data-view="settings">View settings →</button>';
 $('drynotice').classList.toggle('live-notice',!c.dryRun);
}
async function refreshAll() {
 const r = await Promise.allSettled([refreshConfig(),refreshCampaigns(),refreshContacts()]);
 const failed = r.filter(x=>x.status==='rejected'); if (failed.length) notify(message(failed[0].reason),true);
 return failed.length===0;
}
function view(name) {
 state.view=name;
 all('.view').forEach(x=>x.classList.toggle('active',x.id===name));
 all('.nav-link').forEach(x=>x.classList.toggle('active',x.dataset.view===name));
 $('crumb').innerHTML = `Workspace <span class="crumb-separator">/</span> ${esc(({overview:'Overview',campaigns:'Campaigns',analytics:'Analytics',contacts:'Contacts',compose:'Email editor',settings:'Settings'})[name])}`;
 $('sidebar').classList.remove('open');
 window.scrollTo({top:0,behavior:'smooth'});
}
function signOut(reason = '') { state.token=''; state.contacts=[]; state.campaigns=[]; state.config=null; $('admin-key').value=''; $('auth-overlay').classList.remove('hidden'); if(reason) $('login-error').textContent=reason; }
function defaultTime() { const d = new Date(Date.now()+20*60*1000); const p = n=>String(n).padStart(2,'0'); const l = new Date(d.getTime()-d.getTimezoneOffset()*60000); $('schedule-at').value=l.toISOString().slice(0,16); }
function preview() {
 const html = $('email-html').value || starter; const sample = html.replaceAll(/{{\s*contact\.FNAME\s*}}/gi,'Rahul').replaceAll(/{{\s*unsubscribe\s*}}/gi,'Unsubscribe');
 // A sandboxed iframe does not execute scripts, access cookies, or navigate the parent.
 $('preview-frame').srcdoc=sample;
 $('preview-subject').textContent=$('campaign-subject').value || 'Your subject will appear here';
}
function parseCSV(str) { const rows=[]; let row=[], val='', quote=false; for(let i=0;i<str.length;i++){const c=str[i];if(quote){if(c==='"'&&str[i+1]==='"'){val+='"';i++;}else if(c==='"'){quote=false;}else val+=c;}else if(c==='"'){quote=true;}else if(c===','){row.push(val);val='';}else if(c==='\n'){row.push(val.replace(/\r$/,'')); if(row.some(x=>x.trim()))rows.push(row);row=[];val='';}else{val+=c;}} if(quote)throw new Error('CSV has an unclosed quoted field');if(val||row.length){row.push(val.replace(/\r$/,''));rows.push(row);}const cols=(rows.shift()||[]).map(x=>x.trim().toLowerCase().replace(/^\uFEFF/,'')); const needed=['email','first_name','last_name','consent','consent_source']; if(needed.some(n=>!cols.includes(n)))throw new Error(`CSV must have: ${needed.join(', ')}`); return rows.map(r=>Object.fromEntries(needed.map(n=>[n,r[cols.indexOf(n)]||'']))); }
function validateImport(contacts){ if(contacts.length<1||contacts.length>300)throw new Error('CSV must contain 1–300 contacts.'); const seen=new Set(); for(const c of contacts){if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim()))throw new Error(`Invalid email: ${c.email.slice(0,45)}`); if(c.consent.trim().toLowerCase()!=='yes'||c.consent_source.trim().length<3)throw new Error('Every contact needs consent=yes and a recorded consent_source.'); const email=c.email.trim().toLowerCase();if(seen.has(email))throw new Error(`Duplicate email: ${email}`);seen.add(email);} }
async function importContacts() {
 const err=$('import-error');err.textContent=''; if(!$('confirm-consent').checked) {err.textContent='You must confirm explicit consent before importing.'; return;}
 const file=$('csv-file').files?.[0]; if(!file){err.textContent='Choose a CSV file.';return;}if(file.size>200000){err.textContent='CSV exceeds the 200 KB upload limit.';return;}
 let contacts;try{contacts=parseCSV(await file.text());validateImport(contacts);}catch(e){err.textContent=message(e);return;}
 const button=$('import-submit');button.disabled=true;const output=$('import-result');output.textContent='Importing consented contacts...'; let created=0,skipped=0,failed=0;
 try{for(let i=0;i<contacts.length;i+=10){const r=await api('/admin/contacts',{method:'POST',body:{confirmed:true,contacts:contacts.slice(i,i+10)}});created+=r.created||0;skipped+=r.skipped||0;failed+=r.failed||0;output.textContent=`Processed ${Math.min(i+10,contacts.length)}/${contacts.length} — ${created} added · ${skipped} existing · ${failed} failed`;}await refreshContacts();notify(`${created} contacts imported. ${skipped} already existed.`); if(failed)err.textContent=`${failed} failed. Check provider settings and import logs.`;}catch(e){err.textContent=message(e);}finally{button.disabled=false;}
}
function clearCampaignEdit() {
 state.editingCampaignId=null;
 $('edit-campaign-banner').hidden=true;
 $('submit-campaign').textContent='Schedule campaign ↗';
 $('campaign-form').reset(); defaultTime(); $('email-html').value=starter; preview(); refreshScheduleBudget().catch(()=>{});
}
async function editCampaign(id) {
 const data=await api(`/admin/campaigns/${encodeURIComponent(id)}`);
 const c=data.campaign;
 if((c.status!=='queued' && c.status!=='blocked') || c.brevo_campaign_id || (c.status==='queued' && Date.parse(c.scheduled_at) <= Date.now()+60000)) throw new Error('Only future queued or blocked campaigns can be edited.');
 state.editingCampaignId=c.id;
 $('campaign-name').value=c.name;
 $('campaign-subject').value=c.subject;
 $('campaign-preview-text').value=c.preview_text||'';
 $('email-html').value=c.html;
 const date=new Date(c.scheduled_at);
 const shifted=new Date(date.getTime()-date.getTimezoneOffset()*60000);
 $('schedule-at').value=shifted.toISOString().slice(0,16);
 $('edit-campaign-banner').hidden=false;
 $('submit-campaign').textContent='Save changes ↗';
 preview();view('compose');
 notify('Editing queued campaign. Save or cancel your changes.');
}
async function deleteCampaign(id) {
 const c=state.campaigns.find(x=>x.id===id);
 if(!c || !['queued','blocked'].includes(c.status)) throw new Error('Only future queued or blocked unsent campaigns can be deleted.');
 if(!confirm(`Delete queued campaign "${c.name}"? This cancels the scheduled send and cannot be undone.`))return;
 await api(`/admin/campaigns/${encodeURIComponent(id)}`,{method:'DELETE'});
 if(state.editingCampaignId===id)clearCampaignEdit();
 await refreshCampaigns();notify('Queued campaign deleted.');
}
function contactDialog(edit=null) {
 state.editingContactEmail=edit?.email||null;
 $('contact-form').reset();$('contact-form-error').textContent='';
 $('contact-dialog-title').textContent=edit?'Edit contact':'Add contact';
 $('contact-dialog-help').textContent=edit?'Update names only. Email and subscription status stay unchanged.':'Add a contact with confirmed marketing consent.';
 $('contact-email-input').value=edit?.email||'';
 $('contact-email-input').readOnly=Boolean(edit);
 $('contact-first-input').value=edit?.firstName||'';
 $('contact-last-input').value=edit?.lastName||'';
 $('contact-consent-fields').hidden=Boolean(edit);
 $('contact-form-submit').textContent=edit?'Save contact':'Add contact';
 $('contact-dialog').showModal();
}
async function submitContact(e) {
 e.preventDefault();
 const error=$('contact-form-error');error.textContent='';
 const btn=$('contact-form-submit');btn.disabled=true;
 try {
  const email=$('contact-email-input').value.trim().toLowerCase();
  const firstName=$('contact-first-input').value.trim(),lastName=$('contact-last-input').value.trim();
  if(state.editingContactEmail) {
   await api(`/admin/contacts/${encodeURIComponent(state.editingContactEmail)}`,{method:'PUT',body:{firstName,lastName}});
   notify('Contact updated.');
  } else {
   if(!$('contact-consent-confirm').checked) throw new Error('Explicit contact consent is required.');
   const consentSource=$('contact-consent-source').value.trim();
   const result=await api('/admin/contacts',{method:'POST',body:{confirmed:true,contacts:[{email,first_name:firstName,last_name:lastName,consent:'yes',consent_source:consentSource}]}});
   if(result.failed) throw new Error(result.results?.find(r=>r.status==='failed')?.error||'Brevo could not add contact');
   if(result.skipped) throw new Error('This contact already exists in Brevo; it was not re-subscribed.');
   notify('Contact added to the mailing list.');
  }
  $('contact-dialog').close();
  await refreshContacts();
 } catch(x) {error.textContent=message(x);} finally{btn.disabled=false;}
}
async function removeContact(email) {
 if(!confirm(`Remove ${email} from this mailing list? They will stop receiving campaigns sent to this list. The contact is NOT deleted from other Brevo lists.`))return;
 await api(`/admin/contacts/${encodeURIComponent(email)}`,{method:'DELETE'});
 if(state.contacts.length===1 && state.offset>0)state.offset=Math.max(0,state.offset-state.limit);
 await refreshContacts();notify('Contact removed from this mailing list.');
}
const fmtCount=(value)=>Number(value||0).toLocaleString('en-IN');
const rate=(n,d)=>d ? `${(100*n/d).toFixed(1)}%` : '—';
function istDate(value) {return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
async function refreshQuota(day=null) {
 const today=day||istDate(new Date());
 const q=await api(`/admin/quota?day=${encodeURIComponent(today)}`);
 state.quota=q;
 $('config-today-budget').textContent=`${fmtCount(q.used)} / ${fmtCount(q.cap)} used · ${fmtCount(q.pending)} queued estimate`;
 return q;
}
async function refreshScheduleBudget() {
 if(!state.token)return;
 const d=new Date($('schedule-at').value);
 if(Number.isNaN(+d))return;
 const q=await refreshQuota(istDate(d));
 $('schedule-budget').textContent=`${q.dayIst}: ${fmtCount(q.used)} attempted · ${fmtCount(q.pending)} estimated queued · ${fmtCount(q.remaining)} of ${q.cap} remaining (excluding external Brevo sends).`;
}
async function refreshReports() {
 const row=$('analytics-summary-note');row.textContent='Fetching reports from Brevo…';
 const [data]=await Promise.all([api('/admin/reports/summary'),refreshCampaigns()]);
 state.reports=data;
 const m=data.totals||{};
 for(const [id,key] of Object.entries({'report-sent':'sent','report-delivered':'delivered','report-opens':'opened','report-clicks':'clicks','report-hard-bounces':'hardBounces','report-soft-bounces':'softBounces','report-unsubs':'unsubscribed','report-complaints':'complaints'}))$(id).textContent=fmtCount(m[key]);
 $('report-delivery-rate').textContent=`${rate(m.delivered,m.sent)} of attempted sends`;
 $('report-open-rate').textContent=`${rate(m.opened,m.delivered)} of delivered (estimate)`;
 $('report-click-rate').textContent=`${rate(m.clicks,m.delivered)} of delivered`;
 row.textContent=`${data.note}${data.partial?' Some results were unavailable or omitted.':''} Last checked ${shortDate(data.updatedAt)}.`;
 $('analytics-report-count').textContent=data.sampled||'0';
 const select=$('report-campaign-select'),chosen=select.value;
 select.innerHTML='<option value="">Select a campaign...</option>'+state.campaigns.map(c=>`<option value="${esc(c.id)}">${esc(c.name)} — ${esc(c.status)}</option>`).join('');
 select.value=state.campaigns.some(c=>c.id===chosen)?chosen:'';
 return data;
}
async function loadReport(id) {
 if(!id) {notify('Choose a campaign first.',true);return;}
 $('report-campaign-select').value=id;
 $('report-status').textContent='Loading detailed report…';
 $('campaign-report-content').replaceChildren();
 try {
  const r=await api(`/admin/campaigns/${encodeURIComponent(id)}/report`);
  state.activeReport=r;
  if(!r.available){$('report-status').textContent=r.reason;return;}
  const m=r.metrics||{};
  $('report-status').textContent=`${r.name} · Brevo: ${r.brevoStatus} · Updated ${shortDate(r.lastChecked)}`;
  const rows=[['Sent',m.sent],['Delivered',m.delivered],['Unique opens (estimate)',m.opened],['Unique clicks',m.clicks],['Hard bounces',m.hardBounces],['Soft bounces',m.softBounces],['Unsubscribes',m.unsubscribed],['Spam complaints',m.complaints]];
  $('campaign-report-content').innerHTML=`<div class="report-detail-grid">${rows.map(([name,val])=>`<div class="report-detail"><span>${esc(name)}</span><strong>${fmtCount(val)}</strong></div>`).join('')}</div>
    <h3>Tracked link clicks</h3>${r.links?.length?`<div class="link-report">${r.links.map(x=>`<div class="link-report-row"><span title="${esc(x.url)}">${esc(x.url)}</span><strong>${fmtCount(x.clicks)}</strong></div>`).join('')}</div>`:'<p class="muted">No link-click breakdown reported yet.</p>'}
    <p class="helper-note">Stats come from Brevo and may update after delivery. Opens can be inflated by privacy systems and cannot prove a person read a message.</p>`;
 }catch(e){ $('report-status').textContent=message(e);throw e; }
}
async function showContactActivity(email) {
 $('activity-dialog').showModal();$('activity-email').textContent=email;
 $('activity-events').textContent='Loading activity…';
 try {
  const data=await api(`/admin/contacts/${encodeURIComponent(email)}/activity`);
  if(!data.events?.length) {$('activity-events').textContent='No tracked engagement available yet for this contact and this workspace.';return;}
  $('activity-events').innerHTML=data.events.map(event=>`<div class="activity-event"><strong>${esc(event.event)}</strong><span>Campaign ${esc(event.campaignId)} · ${esc(shortDate(event.at))}</span></div>`).join('');
 }catch(e){$('activity-events').textContent=message(e);}
}
function wire() {
 document.addEventListener('click',async (e)=>{
  const v=e.target.closest('[data-view], [data-go]');if(v){const dest=v.dataset.view||v.dataset.go;if(dest==='compose')clearCampaignEdit();view(dest);}
  const b=e.target.closest('[data-report-campaign]');if(b){$('report-campaign-select').value=b.dataset.reportCampaign;view('analytics');loadReport(b.dataset.reportCampaign).catch(err=>notify(message(err),true));}
  const act=e.target.closest('[data-contact-activity]');if(act){showContactActivity(act.dataset.contactActivity).catch(err=>notify(message(err),true));}
  const cEdit=e.target.closest('[data-edit-contact]');if(cEdit){const c=state.contacts.find(x=>x.email===cEdit.dataset.editContact);if(c) contactDialog(c);}
  const cRemove=e.target.closest('[data-remove-contact]');if(cRemove){cRemove.disabled=true;try{await removeContact(cRemove.dataset.removeContact);}catch(x){notify(message(x),true);}finally{cRemove.disabled=false;}}
  const campEdit=e.target.closest('[data-edit-campaign]');if(campEdit){campEdit.disabled=true;try{await editCampaign(campEdit.dataset.editCampaign);}catch(x){notify(message(x),true);}finally{campEdit.disabled=false;}}
  const campDelete=e.target.closest('[data-delete-campaign]');if(campDelete){campDelete.disabled=true;try{await deleteCampaign(campDelete.dataset.deleteCampaign);}catch(x){notify(message(x),true);}finally{campDelete.disabled=false;}}
 });
 $('mobile-menu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
 $('signout').addEventListener('click',()=>signOut());
 $('login-form').addEventListener('submit',async(e)=>{e.preventDefault();const btn=e.currentTarget.querySelector('button[type=submit]');btn.disabled=true;$('login-error').textContent='';state.token=$('admin-key').value.trim();try{await api('/admin/campaigns');$('auth-overlay').classList.add('hidden');$('admin-key').value='';await refreshAll();notify('Welcome to Mailroom.');}catch(x){if(state.token){state.token='';$('login-error').textContent=message(x);}}finally{btn.disabled=false;}});
 $('campaign-search').addEventListener('input',renderCampaigns);$('campaign-status').addEventListener('change',renderCampaigns);$('contact-search').addEventListener('input',renderContacts);
 for (const id of ['refresh-campaigns','refresh-contacts','refresh-settings']) $(id).addEventListener('click',async()=>{try{await ({'refresh-campaigns':refreshCampaigns,'refresh-contacts':refreshContacts,'refresh-settings':refreshConfig})[id]();notify('Updated.');}catch(e){notify(message(e),true);}});
 $('contact-prev').addEventListener('click',async()=>{state.offset=Math.max(0,state.offset-state.limit);try{await refreshContacts();}catch(e){notify(message(e),true);}});
 $('contact-next').addEventListener('click',async()=>{state.offset+=state.limit;try{await refreshContacts();}catch(e){state.offset-=state.limit;notify(message(e),true);}});
 $('top-new').addEventListener('click',()=>{clearCampaignEdit();view('compose');});
 $('open-import').addEventListener('click',()=>$('import-dialog').showModal());
 $('open-add-contact').addEventListener('click',()=>contactDialog());
 $('contact-form').addEventListener('submit',submitContact);
 $('contact-dialog-close').addEventListener('click',()=>$('contact-dialog').close());
 $('contact-form-cancel').addEventListener('click',()=>$('contact-dialog').close());
 $('cancel-edit-campaign').addEventListener('click',clearCampaignEdit);
 $('csv-file').addEventListener('change',()=>$('selected-file').textContent=$('csv-file').files?.[0]?.name||'No file selected');
 $('import-submit').addEventListener('click',importContacts);
 $('import-dialog').addEventListener('close',()=>{$('import-error').textContent='';});
 $('insert-name').addEventListener('click',()=>{const t=$('email-html');const val='{{ contact.FNAME }}';t.setRangeText(val,t.selectionStart,t.selectionEnd,'end');t.focus();preview();});
 $('load-template').addEventListener('click',()=>{$('email-html').value=starter;preview();notify('Starter email template loaded.');});
 $('preview-toggle').addEventListener('click',()=>document.querySelector('.preview-card').scrollIntoView({behavior:'smooth',block:'center'}));
 $('email-html').addEventListener('input',preview);$('campaign-subject').addEventListener('input',preview);
 $('reset-compose').addEventListener('click',clearCampaignEdit);
 $('campaign-form').addEventListener('submit',async(e)=>{
  e.preventDefault();const btn=$('submit-campaign'),isEdit=Boolean(state.editingCampaignId);
  const time=$('schedule-at').value;const d=new Date(time);
  if(!time||Number.isNaN(+d)||d.getTime()<Date.now()+60000){notify('Choose a schedule at least one minute in the future.',true);return;}
  const html=$('email-html').value.trim();if(!html){notify('Enter your email HTML.',true);return;}
  if(!confirm(`${isEdit?'Save changes to':'Schedule'} this campaign for ${shortDate(d.toISOString())}? ${state.config?.dryRun?'Dry-run is currently enabled.':'LIVE SENDING IS ENABLED.'}`))return;
  btn.disabled=true;
  try {
    const payload={name:$('campaign-name').value.trim(),subject:$('campaign-subject').value.trim(),previewText:$('campaign-preview-text').value.trim(),html,scheduledAt:d.toISOString()};
    const endpoint=isEdit?`/admin/campaigns/${encodeURIComponent(state.editingCampaignId)}`:'/admin/campaigns';
    const res=await api(endpoint,{method:isEdit?'PUT':'POST',body:payload});
    clearCampaignEdit();await refreshCampaigns();await refreshQuota();notify(isEdit?'Campaign updated.':`Campaign queued (${res.dryRun?'safe mode':'live mode'}).`);view('campaigns');
  }catch(x){notify(message(x),true);}finally{btn.disabled=false;}
 });
 $('schedule-at').addEventListener('change',()=>refreshScheduleBudget().catch(()=>{}));
 $('export-analytics').addEventListener('click',()=>{
  if(!state.reports?.reports?.length){notify('Load available reports before exporting.',true);return;}
  const headings=['Campaign','Brevo status','Sent','Delivered','Unique opens (estimate)','Unique clicks','Hard bounces','Soft bounces','Unsubscribes','Complaints'];
  const rows=state.reports.reports.map(r=>[r.name,r.brevoStatus,r.metrics?.sent,r.metrics?.delivered,r.metrics?.opened,r.metrics?.clicks,r.metrics?.hardBounces,r.metrics?.softBounces,r.metrics?.unsubscribed,r.metrics?.complaints]);
  // Prefix formula-like CSV values to avoid spreadsheet formula injection.
  const csvValue=x=>{let v=String(x??'');if(/^[=+@\-\t\r]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';};
  const csv=[headings,...rows].map(row=>row.map(csvValue).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='mailroom-campaign-report.csv';a.click();URL.revokeObjectURL(url);
  notify('Exported the currently available campaign report sample.');
 });
 $('copy-utm').addEventListener('click',async()=>{
  try{
   const u=new URL($('utm-landing').value.trim());if(!['https:','http:'].includes(u.protocol))throw new Error('Use a http(s) landing URL.');
   u.searchParams.set('utm_source','mailroom');u.searchParams.set('utm_medium','email');
   u.searchParams.set('utm_campaign',$('campaign-name').value.trim()||'mailroom-campaign');
   await navigator.clipboard.writeText(u.toString());notify('Tagged campaign URL copied. Paste it into your email HTML link.');
  }catch(e){notify('Enter a valid HTTPS website URL and allow clipboard permission.',true);}
 });
 $('refresh-analytics').addEventListener('click',()=>refreshReports().catch(e=>notify(message(e),true)));
 $('load-campaign-report').addEventListener('click',()=>loadReport($('report-campaign-select').value).catch(e=>notify(message(e),true)));
 $('activity-close').addEventListener('click',()=>$('activity-dialog').close());
 $('test-send').addEventListener('click',async()=>{
   const email=prompt('Send ONE test email to an address you control. Enter your email:','');
   if(!email)return;
   if(!confirm(`Send an actual test email to ${email}? This works even in SAFE MODE and may count against your Brevo test quota.`))return;
   const btn=$('test-send');btn.disabled=true;
   try{const result=await api('/admin/test-send',{method:'POST',body:{name:$('campaign-name').value.trim()||'Mailroom preview',
     subject:$('campaign-subject').value.trim(),html:$('email-html').value.trim(),
     previewText:$('campaign-preview-text').value.trim(),testEmail:email,confirmed:true}});
     notify(result.note||'Test email submitted to Brevo. Check your inbox.');
   }catch(err){notify(message(err),true);}finally{btn.disabled=false;}
 });
 $('run-now').addEventListener('click' ,async()=>{const dry=state.config?.dryRun;if(!dry && !confirm('LIVE MODE: This can send due campaigns to customers. Continue?'))return;const btn=$('run-now');btn.disabled=true;try{const d=await api('/admin/run',{method:'POST'});$('run-output').textContent=JSON.stringify(d,null,2);await refreshCampaigns();notify(d.dryRun?'Dry-run checked: no emails were sent.':'Run complete. Review campaign statuses.');}catch(e){notify(message(e),true);}finally{btn.disabled=false;}});
}
defaultTime();$('timezone-note').textContent=`Uses your device timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Campaign dates display in IST.`;$('email-html').value=starter;preview();wire();
