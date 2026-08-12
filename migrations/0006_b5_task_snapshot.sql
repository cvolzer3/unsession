-- B5 — "apply to open instances" (tasks-spec §4.8.3) needs teeth.
--
-- Instances read their name/description from the template, so editing a
-- template would silently rewrite what speakers already saw. Editing now pins
-- the pre-edit wording onto every live instance (`snapshot_json`); choosing
-- "also update N open instances" clears it on the open ones so they follow the
-- template again. Completed instances keep their snapshot forever.

ALTER TABLE tasks ADD COLUMN snapshot_json TEXT;
