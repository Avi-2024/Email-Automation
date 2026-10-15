-- RUN ONCE on existing D1 AFTER taking a backup. Idempotent / additive.
-- No existing campaigns, subscribers, quotas or provider data are modified.

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
