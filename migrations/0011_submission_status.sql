-- Submission status vocabulary: drop `submitted` and `confirmed`.
--
-- Session ≠ Submission. A submission is a proposal moving through triage —
-- draft → in_review → accepted | declined | waitlisted (+ withdrawn). Once
-- accepted it produces a Session, and it is the SESSION the speaker confirms.
-- `sessions.status` (pending | confirmed) has always been the real record;
-- `lib/confirm.ts` wrote the same word onto the submission as a mirror, and
-- readers drifted into asking the mirror instead of the session.
--
-- `submitted` goes because it never meant anything a reader could act on:
-- everything non-draft is submitted by definition. It was a staging flag that
-- `lib/evals.ts` flipped to `in_review` on plan sync, but plan membership is
-- rule-derived (`matchesRules`) and recomputed per read — the flip decided
-- nothing. "Nobody has reviewed this yet" is now answered by the absence of
-- `evaluations` rows, which is what the dashboard's `unreviewed` already did.

-- Sessions first: back-fill any accepted-and-confirmed submission whose session
-- somehow missed the write, so no confirmation is lost when the mirror goes.
UPDATE sessions
   SET status = 'confirmed'
 WHERE submission_id IN (SELECT id FROM submissions WHERE status = 'confirmed');

UPDATE submissions SET status = 'in_review' WHERE status = 'submitted';
UPDATE submissions SET status = 'accepted'  WHERE status = 'confirmed';
