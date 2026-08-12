-- Emails overhaul: allow multiple templates per key (decision-dialog template
-- picker + "Duplicate" on /app/emails). SQLite can't drop an inline UNIQUE, so
-- rebuild email_templates without UNIQUE (event_id, key).
CREATE TABLE email_templates_new (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), key TEXT NOT NULL,
  name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO email_templates_new (id, event_id, key, name, subject, body, updated_at)
  SELECT id, event_id, key, name, subject, body, updated_at FROM email_templates;
DROP TABLE email_templates;
ALTER TABLE email_templates_new RENAME TO email_templates;
CREATE INDEX idx_email_templates_event_key ON email_templates (event_id, key);
