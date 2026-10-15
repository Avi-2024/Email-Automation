// Internal D1-only CRM, intentionally independent of Brevo APIs and campaign automation.
const JSON_HEADERS = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
const response = (data,code=200) => new Response(JSON.stringify(data),{status:code,headers:JSON_HEADERS});
const bad = (message,code=400) => response({error:message},code);
const nowISO=()=>new Date().toISOString();
// D1 CRM prospects are independent of Brevo subscribers and can never be campaign recipients.
const PROSPECT_STATUSES = new Set(['new','contacted','replied','qualified','closed','do_not_contact']);
function validateProspect(value, requireEmail = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prospect must be an object');
  const email = String(value.email ?? '').trim().toLowerCase();
  if (requireEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw new Error('Invalid prospect email');
  const firstName = String(value.first_name ?? '').trim();
  const lastName = String(value.last_name ?? '').trim();
  const company = String(value.company ?? '').trim();
  const status = String(value.status ?? 'new').trim();
  if (firstName.length > 100 || lastName.length > 100 || company.length > 160) throw new Error('Prospect names/company too long');
  if (!PROSPECT_STATUSES.has(status)) throw new Error('Invalid prospect status');
  return {email,firstName,lastName,company,status};
}
function prospectEmail(path) {
  const encoded=path.slice('/admin/prospects/'.length);
  if (!encoded || encoded.includes('/')) return null;
  try {return validateProspect({email:decodeURIComponent(encoded)}).email;} catch {return null;}
}
export async function handleProspects(request,env,path,url) {
  if (!env.DB) return response({error:'D1 binding DB is unavailable',code:'PROSPECTS_CONFIG_MISSING'},503);
  if (path==='/admin/prospects' && request.method==='GET') {
    const offset=Number(url.searchParams.get('offset')||0), limit=Number(url.searchParams.get('limit')||25);
    const q=(url.searchParams.get('q')||'').trim();
    if (!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||q.length>160) return bad('Invalid search or pagination');
    // Escape LIKE wildcards so user input is treated as a literal substring.
    const pattern='%'+q.replace(/[\%_]/g, char=>'\\'+char)+'%';
    const where="WHERE (email LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\')";
    const count=await env.DB.prepare(`SELECT COUNT(*) AS total FROM prospects ${where}`).bind(pattern,pattern,pattern,pattern).first();
    const rows=await env.DB.prepare(`SELECT email,first_name,last_name,company,status,created_at,updated_at FROM prospects ${where} ORDER BY created_at DESC,email LIMIT ? OFFSET ?`).bind(pattern,pattern,pattern,pattern,limit,offset).all();
    return response({prospects:rows.results||[],count:Number(count?.total||0),limit,offset});
  }
  if ((path==='/admin/prospects'||path==='/admin/prospects/import') && request.method==='POST') {
    let input;
    try {input=await request.json();} catch {return bad('Invalid JSON body');}
    const bulk=path.endsWith('/import');
    if (!bulk && (!input || typeof input!=='object' || Array.isArray(input))) return bad('Expected one prospect');
    if (bulk && (!Array.isArray(input?.prospects)||input.prospects.length<1||input.prospects.length>50)) return bad('Import 1–50 prospects per batch');
    let rows;
    try {
      rows=(bulk?input.prospects:[input]).map(value=>validateProspect(value));
      if (new Set(rows.map(x=>x.email)).size!==rows.length) throw new Error('Duplicate prospect emails in batch');
    }catch(error){return bad(error.message);}
    let created=0,skipped=0;
    for (const x of rows) {
      const result=await env.DB.prepare('INSERT OR IGNORE INTO prospects (email,first_name,last_name,company,status) VALUES (?,?,?,?,?)').bind(x.email,x.firstName,x.lastName,x.company,x.status).run();
      if (result.meta?.changes===1) created++; else skipped++;
    }
    return response({created,skipped,processed:rows.length,storage:'D1_ONLY',marketingListModified:false},bulk?200:201);
  }
  if (path.startsWith('/admin/prospects/') && !path.endsWith('/import')) {
    const email=prospectEmail(path);
    if (!email) return bad('Invalid prospect email');
    if (request.method==='DELETE') {
      const result=await env.DB.prepare('DELETE FROM prospects WHERE email=?').bind(email).run();
      return result.meta?.changes===1 ? response({ok:true,deleted:true,email}):bad('Prospect not found',404);
    }
    if (request.method==='PUT') {
      let input;
      try {input=await request.json();}catch{return bad('Invalid JSON body');}
      let x;
      try{x=validateProspect({...input,email});}catch(error){return bad(error.message);}
      const result=await env.DB.prepare('UPDATE prospects SET first_name=?,last_name=?,company=?,status=?,updated_at=? WHERE email=?').bind(x.firstName,x.lastName,x.company,x.status,nowISO(),email).run();
      return result.meta?.changes===1 ? response({ok:true,email}):bad('Prospect not found',404);
    }
  }
  return bad('Method not allowed',405);
}

