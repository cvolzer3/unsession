-- Explicit per-submission plan assignment ("Assign to plan" in the submission
-- drawer). Plan membership stays rule-derived; a row here additively pulls one
-- submission into a plan whose rules don't cover it. Removing the row only
-- removes the override — rule-derived membership is untouched.
CREATE TABLE eval_plan_includes (
  plan_id TEXT NOT NULL REFERENCES eval_plans(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, submission_id)
);
CREATE INDEX idx_eval_plan_includes_submission ON eval_plan_includes(submission_id);
