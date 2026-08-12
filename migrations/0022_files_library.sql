-- Files library: /app/files lists every upload in the event, aggregated by
-- version chain. The page's one big read is by event, newest first.

CREATE INDEX IF NOT EXISTS idx_files_event ON files(event_id, created_at);
