-- File comments: speakers and organizers exchange notes on an uploaded
-- deliverable. A thread keys on the file's version chain (kind + subject),
-- not a single files row — a re-upload inserts a new files row for the next
-- version, and the conversation must survive it. `file_id` only records which
-- version the comment was written against. Deliberately no email on new
-- comments (spec: SessionBoard sends none either).

CREATE TABLE file_comments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  kind TEXT NOT NULL,                       -- mirrors files.kind (task_file|headshot|…)
  subject_type TEXT NOT NULL,               -- mirrors files.subject_type
  subject_id TEXT NOT NULL,                 -- mirrors files.subject_id
  file_id TEXT REFERENCES files(id),        -- version current when the comment was written
  author_user_id TEXT REFERENCES users(id),
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL,                -- organizer | speaker
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_file_comments_subject ON file_comments(subject_type, subject_id, created_at);
