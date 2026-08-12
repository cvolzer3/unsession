-- Explicit per-submission reviewer assignment ("Assign reviewer" in the
-- submission drawer). Assignment stays round-robin-derived (`assignedFor` in
-- lib/evals): a row here pins one plan member into that submission's review
-- slots — pinned reviewers fill slots first, round-robin fills the rest, and
-- pinning more members than reviews_per grows the slot count. Removing the
-- row only removes the pin; recorded evaluations are untouched.
CREATE TABLE eval_reviewer_pins (
  plan_id TEXT NOT NULL REFERENCES eval_plans(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, submission_id, user_id)
);
CREATE INDEX idx_eval_reviewer_pins_submission ON eval_reviewer_pins(submission_id);
