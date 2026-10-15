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
