// CRUD for the Mailroom dashboard. Uses the authenticated same-origin API.
let hooks;
let editingCampaignId = null;
let editingContactEmail = null;
const byId = id => document.getElementById(id);
const errorText = e => e instanceof Error ? e.message : String(e);
function btn(text, action, value, danger=false) {
  const b = document.createElement('button');
  b.type='button'; b.className='tiny-btn'+(danger?' crud-danger':'');
  b.textContent=text; b.dataset.crudAction=action; b.dataset.crudValue=value;
  return b;
}
function canEdit(job) {
  return job.status==='queued' && !job.brevo_campaign_id &&
    Date.parse(job.scheduled_at)>Date.now()+60000;
}
export function drawCrud(type) {
  if (!hooks) return;
  const s=hooks.state;
  if (type==='contacts') {
    const term=byId('contact-search').value.toLowerCase();
    const rows=s.contacts.filter(c=>(String(c.email||'')+' '+String(c.firstName||'')+' '+String(c.lastName||'')).toLowerCase().includes(term));
    Array.from(document.querySelectorAll('#contacts-table tr')).forEach((tr,i)=>{
      if (!rows[i] || !tr.cells[3]) return;
      const wrap=document.createElement('div'); wrap.className='crud-row-actions';
      wrap.append(btn('Edit','edit-contact',rows[i].email),btn('Remove','remove-contact',rows[i].email,true));
      tr.cells[3].append(wrap);
    });
  }
  if (type==='campaigns') {
    const query=byId('campaign-search').value.toLowerCase(), status=byId('campaign-status').value;
    const list=s.campaigns.filter(x=>(status==='all'||x.status===status) &&
      (String(x.name)+' '+String(x.subject)).toLowerCase().includes(query));
    Array.from(document.querySelectorAll('#all-campaigns tr')).forEach((tr,i)=>{
      if (!list[i] || !tr.cells[4] || !canEdit(list[i])) return;
      const wrap=document.createElement('div');wrap.className='crud-row-actions';
      wrap.append(btn('Edit','edit-campaign',list[i].id),btn('Delete','delete-campaign',list[i].id,true));
      tr.cells[4].append(wrap);
    });
  }
}
function clearCampaignEditing() {
  editingCampaignId=null;
  byId('submit-campaign').textContent='Schedule campaign ↗';
  byId('compose-title').textContent='Create a campaign';
  const notice=byId('crud-edit-indicator');if(notice)notice.hidden=true;
}
function openContactForm(contact) {
  editingContactEmail=contact?.email||null;
  byId('crud-contact-title').textContent=contact?'Edit contact':'Add contact';
  byId('crud-contact-email').value=contact?.email||'';
  byId('crud-contact-email').readOnly=Boolean(contact);
  byId('crud-contact-first').value=contact?.firstName||'';
  byId('crud-contact-last').value=contact?.lastName||'';
  byId('crud-consent-wrap').hidden=Boolean(contact);
  byId('crud-contact-consent').checked=false;
  byId('crud-contact-source').value='';
  byId('crud-contact-error').textContent='';
  byId('crud-contact-dialog').showModal();
}
async function saveContact(event) {
  event.preventDefault();
  const {api,notify,refreshContacts}=hooks;
  const submit=byId('crud-contact-save');submit.disabled=true;
  const email=byId('crud-contact-email').value.trim().toLowerCase();
  const firstName=byId('crud-contact-first').value.trim();
  const lastName=byId('crud-contact-last').value.trim();
  try {
    if (editingContactEmail) {
      await api('/admin/contacts/'+encodeURIComponent(editingContactEmail),
        {method:'PUT',body:{firstName,lastName}});
      notify('Contact updated.');
    } else {
      const consent=byId('crud-contact-consent').checked;
      const source=byId('crud-contact-source').value.trim();
      if (!consent) throw Error('Confirm the contact opted in.');
      if (source.length<3) throw Error('Enter a consent source.');
      const result=await api('/admin/contacts',{method:'POST',body:{confirmed:true,
        contacts:[{email,first_name:firstName,last_name:lastName,consent:'yes',consent_source:source}]}});
      if (result.created!==1) throw Error(result.results?.[0]?.error||
        (result.skipped?'Existing contact was skipped; it was not re-subscribed.':'Could not add contact.'));
      notify('Contact added.');
    }
    byId('crud-contact-dialog').close();
    await refreshContacts();
  } catch(e) {byId('crud-contact-error').textContent=errorText(e);}
  finally {submit.disabled=false;}
}
async function handleAction(b) {
  const {state,api,notify,refreshContacts,refreshCampaigns,view,preview}=hooks;
  const action=b.dataset.crudAction, value=b.dataset.crudValue;
  b.disabled=true;
  try {
    if (action==='edit-contact') {
      const contact=state.contacts.find(x=>x.email===value);
      if(contact)openContactForm(contact);
    } else if (action==='remove-contact') {
      if (!confirm('Remove '+value+' from this Brevo mailing list?\nThis does NOT delete the contact account-wide or override unsubscribe history.'))return;
      await api('/admin/contacts/'+encodeURIComponent(value),{method:'DELETE'});
      if(state.offset>0 && state.contacts.length===1) state.offset=Math.max(0,state.offset-state.limit);
      await refreshContacts();notify('Contact removed from this list.');
    } else if (action==='delete-campaign') {
      if (!confirm('Delete this queued campaign? This cannot be undone.'))return;
      await api('/admin/campaigns/'+encodeURIComponent(value),{method:'DELETE'});
      await refreshCampaigns();notify('Queued campaign deleted.');
    } else if (action==='edit-campaign') {
      const item=await api('/admin/campaigns/'+encodeURIComponent(value));
      const c=item.campaign;
      if(!canEdit(c)) throw Error('Campaign is no longer editable. Refresh first.');
      editingCampaignId=value;
      byId('campaign-name').value=c.name;
      byId('campaign-subject').value=c.subject;
      byId('email-html').value=c.html;
      const date=new Date(c.scheduled_at);
      const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
      byId('schedule-at').value=local.toISOString().slice(0,16);
      byId('submit-campaign').textContent='Save campaign changes ↗';
      byId('compose-title').textContent='Edit queued campaign';
      byId('crud-edit-indicator').hidden=false;
      view('compose');preview();
    }
  }catch(e){notify(errorText(e),true);}
  finally{b.disabled=false;}
}
export function installCrud(context) {
  hooks=context;
  const add=document.createElement('button');
  add.id='crud-add-contact';add.className='outline-btn';add.type='button';
  add.textContent='+ Add contact';add.addEventListener('click',()=>openContactForm(null));
  byId('open-import').before(add);
  const indicator=document.createElement('p');indicator.id='crud-edit-indicator';
  indicator.className='crud-edit-indicator';indicator.hidden=true;
  indicator.textContent='Editing a queued campaign. Only future queued campaigns can be changed.';
  byId('campaign-form').before(indicator);
  const dialog=document.createElement('dialog');dialog.id='crud-contact-dialog';dialog.className='dialog';
  dialog.innerHTML =
    '<form id="crud-contact-form" class="dialog-content">' +
    '<div class="dialog-heading"><div><p class="eyebrow">CONTACT MANAGEMENT</p><h2 id="crud-contact-title">Add contact</h2>'+
    '<p>Updates do not change unsubscribe status or list membership.</p></div>'+
    '<button type="button" class="icon-btn" id="crud-contact-close" aria-label="Close">✕</button></div>'+
    '<label for="crud-contact-email">Email</label><input id="crud-contact-email" type="email" required maxlength="254">'+
    '<label for="crud-contact-first">First name</label><input id="crud-contact-first" maxlength="100">'+
    '<label for="crud-contact-last">Last name</label><input id="crud-contact-last" maxlength="100">'+
    '<div id="crud-consent-wrap"><label for="crud-contact-source">Consent source</label>'+
    '<input id="crud-contact-source" maxlength="250" placeholder="e.g. Confirmed signup on website">'+
    '<label class="crud-consent"><input id="crud-contact-consent" type="checkbox"> I confirm this contact opted in to marketing emails.</label></div>'+
    '<p id="crud-contact-error" class="form-error" role="alert"></p>'+
    '<div class="dialog-actions"><button type="button" class="outline-btn" id="crud-contact-cancel">Cancel</button>'+
    '<button class="primary-btn" id="crud-contact-save" type="submit">Save contact →</button></div></form>';
  document.body.append(dialog);
  byId('crud-contact-form').addEventListener('submit',saveContact);
  for (const id of ['crud-contact-cancel','crud-contact-close'])
    byId(id).addEventListener('click',()=>dialog.close());
  document.addEventListener('click',(event)=>{
    const n=event.target.closest('[data-view],[data-go]');
    if (n && (n.dataset.view==='compose'||n.dataset.go==='compose')) clearCampaignEditing();
    if(event.target.closest('#reset-compose')) clearCampaignEditing();
    const b=event.target.closest('[data-crud-action]');
    if(b){event.preventDefault();event.stopPropagation();void handleAction(b);}
  },true);
  // Capture submits for edits; leave the original create handler intact.
  byId('campaign-form').addEventListener('submit',async(event)=>{
    if(!editingCampaignId)return;
    event.preventDefault();event.stopImmediatePropagation();
    const id=editingCampaignId, submit=byId('submit-campaign');
    const time=new Date(byId('schedule-at').value);
    if(!Number.isFinite(+time)||+time<Date.now()+60000){
      hooks.notify('Choose a schedule at least a minute in the future.',true);return;
    }
    if(!confirm('Save changes to the queued campaign?'))return;
    submit.disabled=true;
    try{
      await hooks.api('/admin/campaigns/'+encodeURIComponent(id),{method:'PUT',body:{
        name:byId('campaign-name').value.trim(),
        subject:byId('campaign-subject').value.trim(),
        html:byId('email-html').value.trim(),
        scheduledAt:time.toISOString()
      }});
      clearCampaignEditing();
      await hooks.refreshCampaigns();
      hooks.view('campaigns');
      hooks.notify('Campaign changes saved.');
    }catch(e){hooks.notify(errorText(e),true);}
    finally{submit.disabled=false;}
  },true);
}
