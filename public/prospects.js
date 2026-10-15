import {state,api,notify,esc,badge,$} from './app.js';
const SECTION_HTML = '        <section id="prospects" class="view" aria-labelledby="prospects-title">\n          <div class="page-heading"><div><div class="eyebrow">CRM WORKSPACE / NOT FOR BULK SENDING</div><h1 id="prospects-title">Prospects</h1><p>Organize leads separately from opted-in Brevo subscribers.</p></div><div class="header-actions"><button class="outline-btn" id="prospect-add">+ Add lead</button><button class="primary-btn" id="prospect-import-open">⇧ Import CSV</button></div></div>\n          <div class="notice prospect-notice"><span class="notice-symbol">◈</span><span><strong>CRM only.</strong> These leads are stored in Cloudflare D1, never added to Brevo, and never included in automatic marketing campaigns. Saving a prospect does not establish marketing consent.</span></div>\n          <div class="panel listing-panel"><div class="list-toolbar"><div class="searchbox"><span>⌕</span><input id="prospect-search" placeholder="Search email, name or company" aria-label="Search prospects" /></div><button class="outline-btn small" id="prospect-refresh">↻ Refresh</button></div><div class="table-wrap"><table><thead><tr><th>EMAIL</th><th>NAME</th><th>COMPANY</th><th>CRM STATUS</th><th>ACTIONS</th></tr></thead><tbody id="prospect-rows"><tr><td colspan="5" class="empty-td">No prospects imported yet.</td></tr></tbody></table></div><div class="panel-footer"><span id="prospect-page-status">0 prospects</span><div><button class="outline-btn small" id="prospect-prev" disabled>← Previous</button><button class="outline-btn small" id="prospect-next" disabled>Next →</button></div></div></div>\n        </section>\n\n';
const DIALOG_HTML = '  <dialog id="prospect-import-dialog" class="dialog"><div class="dialog-content"><div class="dialog-heading"><div><div class="eyebrow">CRM ONLY · NO EMAIL SENDING</div><h2>Import prospects</h2><p>CSV requires only <strong>email</strong>. Optional: first_name, last_name, company. Extra columns ignored.</p></div><button type="button" class="icon-btn" id="prospect-import-close" aria-label="Close">✕</button></div><label class="upload-box" for="prospect-file"><span class="upload-icon">⇧</span><strong>Select a CSV file</strong><small>Up to 1,000 rows · 200 KB · stored only in D1</small><input type="file" id="prospect-file" accept=".csv,text/csv" /></label><div id="prospect-import-file" class="selected-file">No file selected</div><p class="helper-note">Does not grant marketing consent or add leads to the Brevo list. Do not import suppression/bounced addresses for renewed outreach.</p><p class="form-error" id="prospect-import-error" role="alert"></p><div class="dialog-actions"><button type="button" class="outline-btn" id="prospect-import-cancel">Cancel</button><button type="button" class="primary-btn" id="prospect-import-submit">Import prospects →</button></div><div class="import-result" id="prospect-import-result" aria-live="polite"></div></div></dialog>\n  <dialog id="prospect-edit-dialog" class="dialog"><form class="dialog-content" id="prospect-edit-form"><div class="dialog-heading"><div><div class="eyebrow">CRM / PRIVATE LEADS</div><h2 id="prospect-dialog-title">Add prospect</h2><p>Contact details are stored internally. No Brevo subscription.</p></div><button type="button" class="icon-btn" id="prospect-edit-close" aria-label="Close">✕</button></div><label for="prospect-email">Email *</label><input type="email" id="prospect-email" required maxlength="254" /><div class="contact-fields"><div><label for="prospect-first">First name</label><input id="prospect-first" maxlength="100" /></div><div><label for="prospect-last">Last name</label><input id="prospect-last" maxlength="100" /></div></div><label for="prospect-company">Company</label><input id="prospect-company" maxlength="160" /><label for="prospect-status">CRM status</label><select id="prospect-status"><option value="new">New</option><option value="contacted">Contacted</option><option value="replied">Replied</option><option value="qualified">Qualified</option><option value="closed">Closed</option><option value="do_not_contact">Do not contact</option></select><p class="form-error" id="prospect-form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="outline-btn" id="prospect-edit-cancel">Cancel</button><button type="submit" class="primary-btn">Save prospect →</button></div></form></dialog>\n\n';
// UI shell is inserted after app.js initializes the authenticated workspace.
const nav = document.querySelector('.nav');
nav.querySelector('[data-view="contacts"]').insertAdjacentHTML('afterend', `<button data-view="prospects" class="nav-link"><span class="nav-icon">◎</span> Prospects <span class="nav-count" id="side-prospect-count">0</span></button>`);
document.querySelector('#contacts').insertAdjacentHTML('beforebegin', SECTION_HTML);
document.body.insertAdjacentHTML('beforeend', DIALOG_HTML);

// Prospects are a separate D1-only CRM, never the Brevo campaign recipient list.
function parseProspectCSV(raw) {
  const lines=[];let row=[],value='',quoted=false;
  for(let i=0;i<raw.length;i++){
    const c=raw[i];
    if(quoted){if(c==='"'&&raw[i+1]==='"'){value+='"';i++;}else if(c==='"'){quoted=false;}else value+=c;}
    else if(c==='"'){if(value)throw new Error('Invalid CSV quote');quoted=true;}
    else if(c===','){row.push(value);value='';}
    else if(c==='\n'){row.push(value.replace(/\r$/,''));if(row.some(v=>v.trim()))lines.push(row);row=[];value='';}
    else value+=c;
  }
  if(quoted)throw new Error('CSV has an unclosed quote');
  if(value||row.length){row.push(value.replace(/\r$/,''));lines.push(row);}
  const header=(lines.shift()||[]).map(v=>v.trim().replace(/^\uFEFF/,'').toLowerCase());
  if(!header.includes('email'))throw new Error('CSV must include an email column.');
  const idx=name=>header.indexOf(name);
  const results=lines.map(columns=>({email:(columns[idx('email')]||'').trim(),first_name:idx('first_name')<0?'':columns[idx('first_name')]||'',last_name:idx('last_name')<0?'':columns[idx('last_name')]||'',company:idx('company')<0?'':columns[idx('company')]||''}));
  if(results.length<1||results.length>1000)throw new Error('CSV must have 1–1,000 prospects.');
  const seen=new Set();
  for(const r of results){const email=r.email.toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new Error('Invalid email in CSV');if(seen.has(email))throw new Error(`Duplicate email: ${email}`);seen.add(email);}
  return results;
}
async function refreshProspects() {
  const q=$('prospect-search').value.trim();
  const data=await api(`/admin/prospects?limit=25&offset=${state.prospectOffset}&q=${encodeURIComponent(q)}`);
  state.prospects=data.prospects||[];state.prospectCount=data.count||0;
  $('side-prospect-count').textContent=state.prospectCount;
  $('prospect-page-status').textContent=state.prospectCount?`Showing ${state.prospectOffset+1}–${Math.min(state.prospectOffset+25,state.prospectCount)} of ${state.prospectCount}`:'0 matching prospects';
  $('prospect-prev').disabled=state.prospectOffset<=0;
  $('prospect-next').disabled=state.prospectOffset+25>=state.prospectCount;
  $('prospect-rows').innerHTML=state.prospects.length?state.prospects.map(x=>`<tr><td><div class="cell-main">${esc(x.email)}</div></td><td>${esc(`${x.first_name||''} ${x.last_name||''}`.trim()||'—')}</td><td>${esc(x.company||'—')}</td><td>${badge(x.status)}</td><td><div class="row-actions"><button class="tiny-btn" data-outreach-prospect="${esc(x.email)}">Email / History</button><button class="tiny-btn" data-edit-prospect="${esc(x.email)}">Edit</button><button class="tiny-btn danger-link" data-delete-prospect="${esc(x.email)}">Delete</button></div></td></tr>`).join(''):'<tr><td class="empty-td" colspan="5">No matching prospects. Import a CSV or add one.</td></tr>';
}
function editProspect(data=null){
  state.editingProspect=data?.email||null;
  $('prospect-edit-form').reset();$('prospect-form-error').textContent='';
  $('prospect-dialog-title').textContent=data?'Edit prospect':'Add prospect';
  $('prospect-email').value=data?.email||'';$('prospect-email').readOnly=Boolean(data);
  $('prospect-first').value=data?.first_name||'';$('prospect-last').value=data?.last_name||'';
  $('prospect-company').value=data?.company||'';$('prospect-status').value=data?.status||'new';
  $('prospect-edit-dialog').showModal();
}
async function importProspects(){
  const err=$('prospect-import-error'),output=$('prospect-import-result'),btn=$('prospect-import-submit');err.textContent='';output.textContent='';
  const file=$('prospect-file').files?.[0];if(!file){err.textContent='Select a CSV file.';return;}
  if(file.size>200000){err.textContent='CSV exceeds 200 KB.';return;}
  let rows;try{rows=parseProspectCSV(await file.text());}catch(error){err.textContent=message(error);return;}
  btn.disabled=true;let created=0,skipped=0;
  try{
    for(let i=0;i<rows.length;i+=50){const result=await api('/admin/prospects/import',{method:'POST',body:{prospects:rows.slice(i,i+50)}});created+=result.created;skipped+=result.skipped;output.textContent=`Processed ${Math.min(i+50,rows.length)}/${rows.length}: ${created} new · ${skipped} already saved.`;}
    state.prospectOffset=0;await refreshProspects();notify(`${created} prospects saved in CRM only. No marketing emails sent.`);
  }catch(error){err.textContent=`Import stopped: ${message(error)}. ${created} added so far. Retrying skips existing contacts.`;}
  finally{btn.disabled=false;}
}
function wireProspects(){
  $('prospect-import-open').addEventListener('click',()=>$('prospect-import-dialog').showModal());
  for(const [id,dialog] of [['prospect-import-close','prospect-import-dialog'],['prospect-import-cancel','prospect-import-dialog'],['prospect-edit-close','prospect-edit-dialog'],['prospect-edit-cancel','prospect-edit-dialog']]) $(id).addEventListener('click',()=>$(dialog).close());
  $('prospect-add').addEventListener('click',()=>editProspect());
  $('prospect-import-submit').addEventListener('click',importProspects);
  $('prospect-file').addEventListener('change',()=>$('prospect-import-file').textContent=$('prospect-file').files?.[0]?.name||'No file selected');
  $('prospect-refresh').addEventListener('click',()=>refreshProspects().catch(e=>notify(message(e),true)));
  let searchRun=0;
  $('prospect-search').addEventListener('input',()=>{state.prospectOffset=0;const request=++searchRun;Promise.resolve().then(()=>{if(request===searchRun)refreshProspects().catch(e=>notify(message(e),true));});});
  $('prospect-prev').addEventListener('click',()=>{state.prospectOffset=Math.max(0,state.prospectOffset-25);refreshProspects().catch(e=>notify(message(e),true));});
  $('prospect-next').addEventListener('click',()=>{state.prospectOffset+=25;refreshProspects().catch(e=>notify(message(e),true));});
  $('prospect-edit-form').addEventListener('submit',async(e)=>{e.preventDefault();const err=$('prospect-form-error');err.textContent='';const submit=e.currentTarget.querySelector('button[type=submit]');submit.disabled=true;try{
    const row={email:$('prospect-email').value.trim(),first_name:$('prospect-first').value.trim(),last_name:$('prospect-last').value.trim(),company:$('prospect-company').value.trim(),status:$('prospect-status').value};
    await api(state.editingProspect?`/admin/prospects/${encodeURIComponent(state.editingProspect)}`:'/admin/prospects',{method:state.editingProspect?'PUT':'POST',body:row});
    $('prospect-edit-dialog').close();await refreshProspects();notify('Prospect saved (CRM only).');
  }catch(error){err.textContent=message(error);}finally{submit.disabled=false;}});
  document.addEventListener('click',async e=>{
    const edit=e.target.closest('[data-edit-prospect]');if(edit){const row=state.prospects.find(x=>x.email===edit.dataset.editProspect);if(row)editProspect(row);return;}
    const del=e.target.closest('[data-delete-prospect]');if(del){const email=del.dataset.deleteProspect;if(!confirm(`Delete ${email} from this CRM?`))return;del.disabled=true;try{await api(`/admin/prospects/${encodeURIComponent(email)}`,{method:'DELETE'});if(state.prospects.length===1)state.prospectOffset=Math.max(0,state.prospectOffset-25);await refreshProspects();notify('Prospect deleted from CRM.');}catch(error){notify(message(error),true);}finally{del.disabled=false;}}
  });
}


wireProspects();

export { refreshProspects };
