-- Evaluation plans (review rounds) get an open date to pair with the existing
-- deadline (close date), so each round carries its own open/close date range.
ALTER TABLE eval_plans ADD COLUMN opens_at TEXT;
