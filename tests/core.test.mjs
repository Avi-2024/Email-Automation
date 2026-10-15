import test from 'node:test';
import assert from 'node:assert/strict';
import {istDay, normalizeCampaign} from '../src/helpers.js';
import {parseCSV,validateContacts} from '../scripts/csv.mjs';

const future = '2026-10-16T09:00:00+05:30';
test('IST day computed correctly across UTC boundary',()=>{
  assert.equal(istDay('2026-10-15T21:00:00Z'), '2026-10-16');
});
test('campaigns normalize time zone, append unsubscribe and preserve personalization',()=>{
  const result=normalizeCampaign({name:'Demo',subject:'Hello',html:'<p>Hello {{ contact.FNAME }}</p>',scheduledAt:future}, new Date('2026-10-15T00:00:00Z'));
  assert.equal(result.scheduledAt,'2026-10-16T03:30:00.000Z');
  assert.match(result.html,/href="{{ unsubscribe }}"/);
  assert.match(result.html,/{{ contact.FNAME }}/);
});
test('schedule requires explicit offset',()=>{
  assert.throws(()=>normalizeCampaign({name:'Demo',subject:'Hello',html:'<p>Welcome to our store</p>',scheduledAt:'2026-10-16T09:00:00'},new Date('2026-10-15T00:00:00Z')), /ISO 8601/);
});
test('CSV parser handles quoted commas and multiline values',()=>{
  const rows=parseCSV('email,first_name,last_name,consent,consent_source\r\na@example.com,"Alice, Jr.",Test,yes,"Website\nconfirmed"\r\n');
  assert.equal(rows[0].first_name,'Alice, Jr.');
  assert.equal(rows[0].consent_source,'Website\nconfirmed');
});
test('no sending to recipients without explicit opt in',()=>{
  assert.throws(()=>validateContacts(parseCSV('email,consent,consent_source\na@example.com,no,import\n')),/consent/);
});
test('requires evidence source for opt in',()=>{
  assert.throws(()=>validateContacts(parseCSV('email,consent,consent_source\na@example.com,yes,\n')),/consent_source/);
});
test('deduplicates recipients',()=>{
  assert.equal(validateContacts(parseCSV('email,consent,consent_source\na@example.com,yes,signup\nA@example.com,yes,signup\n')).length,1);
});
