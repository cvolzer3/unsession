-- B4 — agenda builder, publishing and ICS.
-- `ics_sequence` bumps on every schedule change so calendar clients accept the
-- update (RFC 5545 SEQUENCE). `published_rev` keys the public agenda cache and
-- `published_at` powers the "Unpublished changes" dot on the builder.

ALTER TABLE sessions ADD COLUMN ics_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN published_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN published_at TEXT;
