-- Fresh installations. Existing installations must run migrations/002_multi_campaign_quota.sql once.
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  preview_text TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL,
  day_ist TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','working','prepared','submitted','needs_review','blocked')),
  brevo_campaign_id INTEGER,
  last_error TEXT,
  recipient_estimate INTEGER NOT NULL DEFAULT 0,
  quota_reserved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS campaigns_due ON campaigns(status,scheduled_at);
CREATE INDEX IF NOT EXISTS campaigns_day ON campaigns(day_ist,status);
CREATE TABLE IF NOT EXISTS daily_send_usage (
  day_ist TEXT PRIMARY KEY,
  attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted>=0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS daily_test_usage (
  day_ist TEXT PRIMARY KEY,
  attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted>=0)
);

-- Prospects are internal CRM records only. NEVER sync these rows to Brevo.
-- No opt-in is inferred by saving an email address.
CREATE TABLE IF NOT EXISTS prospects (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK(status IN ('new','contacted','replied','qualified','closed','do_not_contact')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS prospects_status ON prospects(status,created_at);

-- Manual one-to-one outreach, separate from subscriber marketing and Brevo.
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
