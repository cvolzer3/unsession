-- B5 — speaker tasks: mini-form answers + the file-review loop.
-- `tasks.review_note` already exists (changes-requested message); the task
-- instance also needs somewhere to keep a submitted mini-form response, and the
-- grid queries the table by event and by template on every page load.

ALTER TABLE tasks ADD COLUMN response_json TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_event ON tasks(event_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_template ON tasks(template_id);
CREATE INDEX IF NOT EXISTS idx_tasks_speaker ON tasks(speaker_profile_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_files_subject ON files(subject_type, subject_id, version);
