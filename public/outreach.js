import { refreshProspects } from './prospects.js';
import {state,api,notify,esc,$} from './app.js';

// Manual one-to-one outreach UI. No CSV/mass-send endpoint and no Brevo calls.
const html=`
<dialog id="outreach-dialog" class="dialog outreach-dialog">
  <div class="dialog-content outreach-content">
    <div class="dialog-heading"><div><div class="eyebrow">ROYAL IT SERVICE · INDIVIDUAL OUTREACH</div><h2>Contact a prospect</h2><p id="outreach-recipient"></p></div><button class="icon-btn" type="button" id="outreach-close" aria-label="Close">✕</button></div>
    <div id="outreach-setup" class="helper-note" role="status"></div>
    <form id="outreach-send-form">
      <label for="outreach-subject">Subject</label><input id="outreach-subject" maxlength="180" required placeholder="A question about your website" />
      <label for="outreach-body">Plain-text email</label><textarea id="outreach-body" rows="12" required minlength="30" maxlength="12000" spellcheck="true"></textarea>
      <p class="helper-note">Direct message using your cPanel mailbox. No tracking pixels or mass sending. Inbox placement is not guaranteed.</p>
      <label class="consent-check"><input type="checkbox" id="outreach-confirm" required /><span>I reviewed this specific recipient and message, have a legitimate reason to contact them, and will honor any opt-out. This sends one real email.</span></label>
      <p id="outreach-error" class="form-error" role="alert"></p>
      <button class="primary-btn" type="submit" id="outreach-send-btn">Send individual email →</button>
    </form>
    <hr class="outreach-rule" />
    <h3>Conversation history</h3><div id="outreach-history" class="outreach-history" aria-live="polite">No messages yet.</div>
    <button type="button" id="outreach-check-replies" class="outline-btn small">Check cPanel inbox for replies</button>
    <hr class="outreach-rule" />
    <h3>Manual follow-up reminder</h3>
    <form id="outreach-followup-form"><label for="outreach-due">Remind me at</label><input type="datetime-local" id="outreach-due" required />
      <label for="outreach-note">Follow-up note</label><input id="outreach-note" maxlength="500" placeholder="Ask if they had time to review" />
      <button type="submit" class="outline-btn">Save reminder (does not send email)</button>
    </form><div id="outreach-followup-list" class="outreach-history"></div>
  </div>
</dialog>
<dialog id="outreach-tasks-dialog" class="dialog outreach-dialog"><div class="dialog-content outreach-content">
  <div class="dialog-heading"><div><div class="eyebrow">CRM / MANUAL FOLLOW-UPS</div><h2>Open reminders</h2><p>Nothing is sent automatically.</p></div><button type="button" id="outreach-tasks-close" class="icon-btn">✕</button></div>
  <div id="outreach-tasks" class="outreach-history"></div>
</div></dialog>`;
document.body.insertAdjacentHTML('beforeend',html);
$('prospect-add').insertAdjacentHTML('beforebegin','<button type="button" class="outline-btn" id="outreach-tasks-open">Follow-up tasks</button>');
let selectedEmail=null,configured=null;
const urlFor=(action)=>`/admin/outreach/prospects/${encodeURIComponent(selectedEmail)}/${action}`;
const safeDate=x=>x?new Date(x).toLocaleString():'—';
function defaultBody(row){
  return `Hello${row?.first_name ? ' '+row.first_name : ''},\n\nI hope you are doing well.\n\nI'm reaching out from Royal IT Service. We help businesses with website development, SEO and digital solutions.\n\nWould you be open to a short conversation about opportunities to improve your website or online presence?\n\nIf you prefer not to receive further outreach, please reply “no thanks” and we'll respect your request.\n\nBest regards,\nRoyal IT Service\nhttps://royalitservice.com`;
}
async function loadHistory(){
  if(!selectedEmail)return;
  const data=await api(urlFor('history'));
  $('outreach-history').innerHTML=data.messages?.length?data.messages.map(x=>`<div class="outreach-event">
    <div><strong>${esc(x.subject)}</strong><small>${esc(safeDate(x.created_at))} · ${esc(x.status)}</small></div>
    <details><summary>View message</summary><pre class="outreach-plain">${esc(x.body)}</pre></details>
    ${x.status==='needs_review'?'<p class="form-error">SMTP result uncertain: check cPanel Track Delivery before any retry.</p>':''}
  </div>`).join(''):'<p class="muted">No individual emails recorded yet.</p>';
  $('outreach-followup-list').innerHTML=data.followups?.length?data.followups.map(x=>`<div class="outreach-event"><strong>${esc(safeDate(x.due_at))}</strong> <span class="muted">${esc(x.status)}</span><p>${esc(x.note||'No note')}</p></div>`).join(''):'<p class="muted">No follow-ups saved.</p>';
}
async function openOutreach(email){
  const row=state.prospects.find(x=>x.email===email);
  if(!row)return;
  selectedEmail=email;
  $('outreach-recipient').textContent=`${email}${row.company?' · '+row.company:''}`;
  $('outreach-subject').value='A quick question about your website';
  $('outreach-body').value=defaultBody(row);
  $('outreach-confirm').checked=false;$('outreach-error').textContent='';
  const due=new Date(Date.now()+3*86400000);due.setMinutes(due.getMinutes()-due.getTimezoneOffset());$('outreach-due').value=due.toISOString().slice(0,16);
  $('outreach-note').value='';
  $('outreach-dialog').showModal();
  const blocked=['do_not_contact','closed'].includes(row.status);
  $('outreach-send-btn').disabled=blocked;
  $('outreach-setup').textContent='Checking cPanel mailbox connection settings…';
  try{configured=await api('/admin/outreach/config');
    $('outreach-setup').textContent=blocked?'Sending disabled: this prospect is closed / do not contact.':
      !configured.outreachEnabled?'Outreach OFF: configure your mailbox secrets, then explicitly set OUTREACH_ENABLED=true in wrangler.toml and deploy.':
      !configured.smtpConfigured?'cPanel SMTP settings are incomplete.':`Ready for individual sending from ${configured.sender}. Manual only, max 15 attempts per UTC day.`;
    $('outreach-send-btn').disabled=blocked||!configured.outreachEnabled||!configured.smtpConfigured;
    $('outreach-check-replies').disabled=!configured.imapConfigured;
  }catch(e){$('outreach-setup').textContent=String(e.message);$('outreach-send-btn').disabled=true;}
  await loadHistory().catch(e=>notify(String(e.message),true));
}
$('outreach-close').addEventListener('click',()=>$('outreach-dialog').close());
$('outreach-tasks-close').addEventListener('click',()=>$('outreach-tasks-dialog').close());
document.addEventListener('click',e=>{const btn=e.target.closest('[data-outreach-prospect]');if(btn)openOutreach(btn.dataset.outreachProspect).catch(e=>notify(e.message,true));});
$('outreach-send-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!selectedEmail)return;
  const subject=$('outreach-subject').value.trim(),text=$('outreach-body').value.trim();
  $('outreach-error').textContent='';
  if(!$('outreach-confirm').checked){$('outreach-error').textContent='Confirm the individual recipient and message first.';return;}
  if(!confirm(`Send ONE real email via cPanel to ${selectedEmail}? This action cannot be unsent.`))return;
  const btn=$('outreach-send-btn');btn.disabled=true;
  try{const result=await api(urlFor('send'),{method:'POST',body:{subject,text,confirmIndividual:true}});
    notify(result.note||'cPanel SMTP accepted one email.');$('outreach-confirm').checked=false;await loadHistory();
    await refreshProspects().catch(()=>{});
  }catch(error){$('outreach-error').textContent=error.message+' Check message history and cPanel Track Delivery before retrying.';await loadHistory().catch(()=>{});}
  finally{btn.disabled=false;}
});
$('outreach-check-replies').addEventListener('click',async()=>{
  const btn=$('outreach-check-replies');btn.disabled=true;
  try{const r=await api(urlFor('check-replies'),{method:'POST'});notify(`${r.checked} thread(s) checked; ${r.matched} matching reply/replies detected.`);await loadHistory();}
  catch(e){notify(e.message,true);}finally{btn.disabled=!configured?.imapConfigured;}
});
$('outreach-followup-form').addEventListener('submit',async e=>{
  e.preventDefault();const date=$('outreach-due').value;
  try{await api(urlFor('followups'),{method:'POST',body:{due_at:new Date(date).toISOString(),note:$('outreach-note').value.trim()}});notify('Follow-up reminder saved. No email sent.');await loadHistory();}
  catch(error){notify(error.message,true);}
});
$('outreach-tasks-open').addEventListener('click',async()=>{
  $('outreach-tasks-dialog').showModal();$('outreach-tasks').textContent='Loading…';
  try{const data=await api('/admin/outreach/followups');
    $('outreach-tasks').innerHTML=data.followups?.length?data.followups.map(x=>`<div class="outreach-event">
      <strong>${esc(x.prospect_email)}</strong><small>${esc(safeDate(x.due_at))}</small>
      <p>${esc(x.note||'Manual follow-up')}</p><button class="outline-btn small" data-done-followup="${esc(x.id)}">Mark done</button></div>`).join(''):'<p class="muted">No open follow-up reminders.</p>';
  }catch(error){$('outreach-tasks').textContent=error.message;}
});
$('outreach-tasks').addEventListener('click',async e=>{
  const btn=e.target.closest('[data-done-followup]');if(!btn)return;
  btn.disabled=true;
  try{await api(`/admin/outreach/followups/${encodeURIComponent(btn.dataset.doneFollowup)}/complete`,{method:'POST'});btn.closest('.outreach-event').remove();notify('Reminder completed.');}
  catch(error){notify(error.message,true);btn.disabled=false;}
});
