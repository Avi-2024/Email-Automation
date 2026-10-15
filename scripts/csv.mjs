// RFC-4180-style CSV parser with escaped quotes and multiline cells.
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {field += '"'; i++;}
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {row.push(field); field = '';}
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(s => s !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error('Unterminated quoted CSV field');
  if (field !== '' || row.length) {row.push(field); rows.push(row);}
  if (!rows.length) throw new Error('Empty CSV');
  const headers = rows.shift().map(x=>x.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV columns');
  return rows.map((cells, i) => {
    if (cells.length !== headers.length) throw new Error(`Malformed row ${i + 2}: wrong column count`);
    return Object.fromEntries(headers.map((h,j)=>[h,cells[j].trim()]));
  });
}

export function validateContacts(rows) {
  const result = []; const seen = new Set();
  for (const [i,r] of rows.entries()) {
    const email = (r.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error(`Invalid email at data row ${i+1}`);
    }
    if (!['yes','true','1'].includes((r.consent || '').toLowerCase())) {
      throw new Error(`Missing affirmative opt-in consent at data row ${i+1}`);
    }
    if (!(r.consent_source || '').trim()) {
      throw new Error(`Missing consent_source at data row ${i+1}`);
    }
    if ((r.first_name || '').length > 100 || (r.last_name || '').length > 100) {
      throw new Error(`Name too long at data row ${i+1}`);
    }
    if (!seen.has(email)) {
      result.push({...r,email}); seen.add(email);
    }
  }
  return result;
}
