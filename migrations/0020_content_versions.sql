-- Version history for edited content (sessions, speaker profiles): one row per
-- saved state of a record's content fields. snapshot_json holds the state
-- AFTER the edit, so restoring a row rewrites the subject to exactly that
-- state. The first edit of a subject also writes an 'Original content'
-- baseline row, keeping the pre-edit state restorable. History is append-only:
-- a restore adds a new row rather than rewinding the list.
CREATE TABLE content_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  subject_type TEXT NOT NULL,              -- 'session' | 'speaker'
  subject_id TEXT NOT NULL,
  editor TEXT NOT NULL,                    -- display name; 'Original' on the baseline row
  summary TEXT NOT NULL,                   -- 'Edited title, abstract' / 'Original content' / 'Restored …'
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_content_versions_subject ON content_versions(subject_type, subject_id, created_at);
