-- Additive, idempotent. Run after 003_prospects_crm.sql. No changes to Brevo contacts/campaigns.
CREATE TABLE IF NOT EXISTS outreach_messages (
  id TEXT PRIMARY KEY,
  prospect_email TEXT NOT NULL COLLATE NOCASE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'sending' CHECK(status IN ('sending','sent','failed','needs_review','replied')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  replied_at TEXT
);
CREATE INDEX IF NOT EXISTS outreach_messages_prospect ON outreach_messages(prospect_email,created_at DESC);
CREATE TABLE IF NOT EXISTS outreach_followups (
  id TEXT PRIMARY KEY,
  prospect_email TEXT NOT NULL COLLATE NOCASE,
  note TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outreach_followups_due ON outreach_followups(status,due_at);
CREATE INDEX IF NOT EXISTS outreach_followups_prospect ON outreach_followups(prospect_email,due_at DESC);
CREATE TABLE IF NOT EXISTS outreach_daily_usage (
  day_utc TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0)
);

-- Preserve explicit Do Not Contact suppression even if an address is removed and re-imported.
CREATE TABLE IF NOT EXISTS outreach_suppressions (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL DEFAULT 'do_not_contact',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO outreach_suppressions(email,reason)
 SELECT email,'do_not_contact' FROM prospects WHERE status='do_not_contact';

-- Atomic lock protects against simultaneous manual send actions from separate browser tabs.
CREATE TABLE IF NOT EXISTS outreach_recipient_cooldown (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  last_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
);
