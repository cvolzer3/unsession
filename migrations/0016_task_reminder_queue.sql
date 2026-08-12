-- Task reminder queue (outbox): the drawer "Remind" button queues a manual
-- task reminder here instead of emailing on the spot — the same decide-vs-
-- notify outbox pattern as decision_queue. Sending from Emails → Outbox
-- resolves the reminder subject/body fresh (template wording at send time)
-- through lib/tasks.remindTask and deletes the row, so a queued reminder is
-- invisible to speakers and freely removable.
--
-- One pending reminder per (task, speaker): re-queueing replaces the row.
CREATE TABLE task_reminder_queue (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  speaker_profile_id TEXT NOT NULL REFERENCES speaker_profiles(id),
  queued_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, speaker_profile_id)
);
CREATE INDEX idx_task_reminder_queue_event ON task_reminder_queue (event_id);
