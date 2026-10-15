// Small TLS-only cPanel mail transport for a Cloudflare Worker. No third-party bridge.
// Requires real remote mail host, not a Cloudflare-proxied hostname.
const encoder = new TextEncoder();
function b64(value) {
  const bytes=typeof value==='string'?encoder.encode(value):value;
  let result='';for(let i=0;i<bytes.length;i+=8192)result+=String.fromCharCode(...bytes.slice(i,i+8192));
  return btoa(result);
}
function validHost(host) { return typeof host==='string' && host.length<=253 && /^(?=.{1,253}$)[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(host) && !/^localhost$/i.test(host); }
export function mailConfig(env) {
  const sender=String(env.CPANEL_MAIL_USER||'').trim().toLowerCase();
  return {sender, smtpConfigured: validHost(env.CPANEL_SMTP_HOST) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender) && Boolean(env.CPANEL_MAIL_PASSWORD),
    imapConfigured:validHost(env.CPANEL_IMAP_HOST)&&Boolean(env.CPANEL_MAIL_PASSWORD)&&Boolean(sender),
    enabled:env.OUTREACH_ENABLED==='true'};
}
function smtpHeader(s){return String(s).replace(/[\r\n\0]/g,' ').trim();}
function rfc2047(s){return /^[\x20-\x7e]*$/.test(s)?smtpHeader(s):`=?UTF-8?B?${b64(smtpHeader(s))}?=`;}
function encodedBody(text) {return b64(text).replace(/.{1,76}/g,'$&\r\n');}
function lineClient(socket) {
  const reader=socket.readable.getReader(),writer=socket.writable.getWriter(),decoder=new TextDecoder();
  let buffer='',total=0;
  return {
    async line(){for(;;){const pos=buffer.indexOf('\r\n');if(pos>=0){const row=buffer.slice(0,pos);buffer=buffer.slice(pos+2);return row;}
      const {value,done}=await reader.read();if(done)throw new Error('Mail server closed the connection');
      total+=value.byteLength;if(total>1024*1024)throw new Error('Mail server response too large');
      buffer+=decoder.decode(value,{stream:true});
    }},
    async write(content){await writer.write(encoder.encode(content));},
    release(){try{writer.releaseLock();}catch{}try{reader.releaseLock();}catch{}}
  };
}
async function smtpReply(c, expected){let value='';for(let i=0;i<30;i++){
  const line=await c.line();if(!/^\d{3}[ -]/.test(line))throw new Error('Invalid SMTP response');
  value=line.slice(0,3);if(line[3]===' '){if(!expected.includes(Number(value)))throw new Error(`SMTP rejected request (${value})`);return value;}
}throw new Error('SMTP response too long');}
async function imapCommand(c,tag,command) {
  await c.write(`${tag} ${command}\r\n`);
  const lines=[];for(let n=0;n<2000;n++){
    const line=await c.line();if(line.startsWith(tag+' ')){
      if(!new RegExp('^'+tag+' OK(?: |$)','i').test(line))throw new Error('IMAP command not accepted');
      return lines;
    }
    lines.push(line);
  }
  throw new Error('IMAP server response too long');
}
// Sending a DATA payload has ambiguous semantics on network errors; caller must never blindly retry.
export async function sendCpanelMail(env,{to,subject,text,messageId}) {
  const conf=mailConfig(env);
  if(!conf.smtpConfigured)throw new Error('cPanel SMTP secrets not configured');
  const {connect}=await import('cloudflare:sockets');
  const socket=connect({hostname:env.CPANEL_SMTP_HOST,port:465},{secureTransport:'on'});
  let client,afterData=false;
  try {
    await socket.opened;client=lineClient(socket);
    await smtpReply(client,[220]);
    await client.write('EHLO mailroom.local\r\n');await smtpReply(client,[250]);
    await client.write('AUTH LOGIN\r\n');await smtpReply(client,[334]);
    await client.write(b64(conf.sender)+'\r\n');await smtpReply(client,[334]);
    await client.write(b64(String(env.CPANEL_MAIL_PASSWORD))+'\r\n');await smtpReply(client,[235]);
    await client.write(`MAIL FROM:<${conf.sender}>\r\n`);await smtpReply(client,[250]);
    await client.write(`RCPT TO:<${to}>\r\n`);await smtpReply(client,[250,251]);
    await client.write('DATA\r\n');await smtpReply(client,[354]);
    const headers=[`From: ${rfc2047('Royal IT Service')} <${conf.sender}>`,`To: <${to}>`,
      `Subject: ${rfc2047(subject)}`,`Date: ${new Date().toUTCString()}`,`Message-ID: ${messageId}`,
      `Reply-To: <${conf.sender}>`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64', 'X-Mailer: Mailroom Individual Outreach'];
    afterData=true;
    await client.write(headers.join('\r\n')+'\r\n\r\n'+encodedBody(text)+'\r\n.\r\n');
    await smtpReply(client,[250]);
    afterData=false;
    try{await client.write('QUIT\r\n');await smtpReply(client,[221]);}catch{}
    return {accepted:true,messageId};
  } catch(error){const safe=new Error(String(error.message||'SMTP submission failed').slice(0,160));safe.uncertain=afterData;throw safe;}
  finally{client?.release();try{socket.close();}catch{}}
}
function imapQuote(value){return '"'+String(value).replace(/[\\"\r\n\0]/g,'')+'"';}
// On-demand IMAPS check. Search only this prospect's INBOX threaded replies; no mailbox-wide sync.
export async function checkCpanelReplies(env,{email,messageIds}) {
  const conf=mailConfig(env);
  if(!conf.imapConfigured)throw new Error('IMAP 993 is not configured');
  if(messageIds.length>8)throw new Error('Too many threads requested');
  const {connect}=await import('cloudflare:sockets');
  const socket=connect({hostname:env.CPANEL_IMAP_HOST,port:993},{secureTransport:'on'});
  let c;try{
    await socket.opened;c=lineClient(socket);const greeting=await c.line();
    if(!/^\* OK\b/i.test(greeting))throw new Error('IMAP greeting failed');
    await imapCommand(c,'A001',`LOGIN ${imapQuote(conf.sender)} ${imapQuote(env.CPANEL_MAIL_PASSWORD)}`);
    await imapCommand(c,'A002','SELECT INBOX');
    const matched=[];let n=3;
    for(const id of messageIds){
      const valid=/^<[a-z0-9.-]{1,180}@[a-z0-9.-]+>$/i.test(id);
      if(!valid)continue;
      for(const header of ['In-Reply-To','References']){
        const rows=await imapCommand(c,'A'+String(n++).padStart(3,'0'),`UID SEARCH FROM ${imapQuote(email)} HEADER ${header} ${imapQuote(id)}`);
        const hits=rows.filter(v=>/^\* SEARCH(?:\s|$)/.test(v)).flatMap(v=>v.replace(/^\* SEARCH\s*/,'').split(/\s+/)).filter(x=>/^\d+$/.test(x));
        if(hits.length){matched.push({messageId:id,replyUID:hits[hits.length-1]});break;}
      }
    }
    try{await imapCommand(c,'A999','LOGOUT');}catch{}
    return {matched};
  } finally {c?.release();try{socket.close();}catch{}}
}
