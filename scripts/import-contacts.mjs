import {readFileSync} from 'node:fs';
import {parseCSV,validateContacts} from './csv.mjs';

const usage = `Usage:\n  BREVO_API_KEY=... BREVO_LIST_ID=123 npm run import:contacts -- examples/contacts.csv\n  BREVO_API_KEY=... BREVO_LIST_ID=123 npm run import:contacts -- examples/contacts.csv --send`;
const [file, flag] = process.argv.slice(2);
if (!file || (flag && flag !== '--send')) {console.error(usage);process.exit(1);}
let contacts;
try {contacts = validateContacts(parseCSV(readFileSync(file,'utf8')));}
catch(e) {console.error('Refusing import:',e.message);process.exit(1);}
console.log(`Validated ${contacts.length} unique, affirmatively opted-in contacts. ${flag==='--send'?'Sending':'DRY RUN: no contacts sent'}.`);
if (flag !== '--send') process.exit(0);

const key = process.env.BREVO_API_KEY;
const listId = Number(process.env.BREVO_LIST_ID);
if (!key || !Number.isSafeInteger(listId) || listId <= 0) {
  console.error('BREVO_API_KEY and a positive integer BREVO_LIST_ID are required');
  process.exit(1);
}
let created = 0, existing = 0, failed = 0;
for (const contact of contacts) {
  const attributes = {};
  if (contact.first_name) attributes.FNAME = contact.first_name;
  if (contact.last_name) attributes.LNAME = contact.last_name;
  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method:'POST',
      headers:{'api-key':key,'content-type':'application/json','accept':'application/json'},
      body:JSON.stringify({email:contact.email,attributes,listIds:[listId],updateEnabled:false})
    });
    const data = await res.json().catch(()=>({}));
    if (res.ok) created++;
    else if (res.status === 400 && /exist/i.test(`${data.message || ''} ${data.code || ''}`)) existing++;
    else {failed++;console.error(`Rejected ${contact.email}: HTTP ${res.status}: ${data.message || data.code || 'unknown error'}`);}
  } catch(e) {failed++;console.error(`Network failure ${contact.email}: ${e.message}`);}
  // ~5 requests/second, below Brevo's ordinary contacts rate limit.
  await new Promise(resolve => setTimeout(resolve,210));
}
console.log({created,existing_skipped_to_preserve_optouts:existing,failed});
if (failed) process.exitCode = 2;
