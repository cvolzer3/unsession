-- Decision queue (outbox): deciding and informing speakers are separate steps,
-- matching how program teams actually work (decide iteratively, notify once).
--
-- The decision modal writes a row here and NOTHING else happens — no status
-- flip, no session copy, no tasks, no email, so nothing leaks to the speaker
-- portal and a queued decision can still be changed or removed. Sending from
-- Emails → Outbox runs the decision engine (`lib/decisions.applyDecision`)
-- with all its side effects in the usual order and deletes the row.
--
-- One pending decision per submission: re-queueing replaces the previous row.
CREATE TABLE decision_queue (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  decision TEXT NOT NULL,                        -- accept | decline | waitlist
  subject TEXT NOT NULL,                         -- as edited in the modal; '' falls back to the event template at send time
  body TEXT NOT NULL,
  feedback TEXT,                                 -- individual feedback for this recipient (declines)
  request_confirmation INTEGER NOT NULL DEFAULT 1,
  queued_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_decision_queue_event ON decision_queue (event_id);
