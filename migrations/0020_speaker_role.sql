-- Speaker role labels on a submission: a co-speaker card can now say what the
-- person actually is — Co-speaker, Co-author, Moderator, Panelist — instead of
-- everyone reading as an anonymous extra name next to the submitter.
-- Empty string means "never chosen": the label falls back to position (card 1
-- is the Speaker, the rest are Co-speakers), so every pre-existing row renders
-- with a sensible role without a backfill.
ALTER TABLE submission_speakers ADD COLUMN role TEXT NOT NULL DEFAULT '';
