-- RUN ONCE on an existing D1 database BEFORE deploying new Worker code.
-- A sentinel prevents an accidental second execution from dropping new columns.
CREATE TABLE mailroom_schema_migration_002 (id INTEGER PRIMARY KEY);
-- Rebuild old campaigns table to remove its day_ist UNIQUE constraint.
-- Preserve campaign IDs, bodies, remote Brevo IDs, and lifecycle statuses.
CREATE TABLE campaigns_new (
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
INSERT INTO campaigns_new (id,name,subject,html,scheduled_at,day_ist,status,
  brevo_campaign_id,last_error,created_at,updated_at)
  SELECT id,name,subject,html,scheduled_at,day_ist,status,
    brevo_campaign_id,last_error,created_at,updated_at FROM campaigns;
DROP TABLE campaigns;
ALTER TABLE campaigns_new RENAME TO campaigns;
CREATE INDEX IF NOT EXISTS campaigns_due ON campaigns(status,scheduled_at);
CREATE INDEX IF NOT EXISTS campaigns_day ON campaigns(day_ist,status);
CREATE TABLE IF NOT EXISTS daily_send_usage (
  day_ist TEXT PRIMARY KEY,
  attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted>=0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- No historical recipient counts are available for earlier external sends.
-- Conservatively lock those IST days instead of potentially overspending.
INSERT OR IGNORE INTO daily_send_usage(day_ist,attempted)
  SELECT DISTINCT day_ist,300 FROM campaigns
  WHERE status IN ('submitted','working','prepared','needs_review');

CREATE TABLE IF NOT EXISTS daily_test_usage (
  day_ist TEXT PRIMARY KEY,
  attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted>=0)
);
