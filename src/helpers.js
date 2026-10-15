export const EMAIL_CAP_FREE = 300;

export function istDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid schedule date');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

export function normalizeCampaign(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('JSON object required');
  const name = String(input.name ?? '').trim();
  const subject = String(input.subject ?? '').trim();
  const html = String(input.html ?? '').trim();
  const at = input.scheduledAt;
  if (!name || name.length > 160) throw new Error('Name required (max 160 characters)');
  if (!subject || subject.length > 190) throw new Error('Subject required (max 190 characters)');
  if (html.length < 11 || new TextEncoder().encode(html).length > 500_000) {
    throw new Error('HTML must be 11 to 500,000 UTF-8 bytes');
  }
  // Full ISO datetime with timezone is mandatory. A local datetime is ambiguous.
  if (typeof at !== 'string' || !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at)) {
    throw new Error('scheduledAt must be ISO 8601 with timezone, e.g. 2026-10-16T09:00:00+05:30');
  }
  const ms = Date.parse(at);
  if (!Number.isFinite(ms) || ms < now.getTime() + 60_000) {
    throw new Error('Schedule at least 1 minute in the future');
  }
  // Marketing messages must always have an unsubscribe link.
  const previewText = String(input.previewText ?? '').trim();
  if (previewText.length > 160) throw new Error('Preview text must be at most 160 characters');
  const footer = `<hr><p style="font-size:12px;color:#555">You are receiving this because you subscribed to our updates. <a href="{{ unsubscribe }}">Unsubscribe</a></p>`;
  const bodyClose = html.search(/<\/body\s*>/i);
  const hasUnsubscribe = /{{\s*unsubscribe\s*}}/i.test(html);
  const withFooter = hasUnsubscribe ? html : bodyClose >= 0
    ? html.slice(0, bodyClose) + footer + html.slice(bodyClose)
    : html + footer;
  return { name, subject, html: withFooter, scheduledAt: new Date(ms).toISOString(), dayIst: istDay(ms), previewText };
}

export function safeStatus(status) {
  return ['queued','working','prepared','submitted','needs_review','blocked'].includes(status);
}
