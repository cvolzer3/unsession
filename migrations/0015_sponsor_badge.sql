-- The SPONSORED badge becomes an option instead of an automatic consequence of
-- `type = 'sponsor'`. Organizers toggle it in the new-session dialog and the
-- session drawer; existing sponsor sessions keep the badge (default 1). The
-- builder-grid tint stays keyed on type — this flag only governs the public
-- agenda and embeds.
ALTER TABLE sessions ADD COLUMN sponsor_badge INTEGER NOT NULL DEFAULT 1;
