-- Reset sandbox state: delete every sandbox org (`orgs.is_sandbox = 1`) and
-- everything under it, so the next "Try the sandbox" click provisions fresh
-- from the current seed. Safe to run any time; real orgs are untouched.
--
--   npx wrangler d1 execute unsession-db --remote --file scripts/reset-sandboxes.sql -y
--
-- R2 note: `files` rows are deleted here, but their R2 objects are not.
-- List the keys BEFORE running this and delete them from the bucket, or
-- accept the orphans (a few small PDFs per sandbox):
--   SELECT r2_key FROM files WHERE event_id IN
--     (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));
--
-- Seeded sandbox users are plus-suffixed per sandbox and only ever belong to
-- sandbox orgs; the user sweep keeps anyone who is a member of a real org.

-- Remote D1 runs each statement in its own transaction (deferred FK checks
-- do not span statements), so every DELETE below strictly follows its
-- children. Users go LAST: dropping the sandbox membership rows first turns
-- every seeded user into a passwordless, plus-suffixed, member-of-nothing
-- account, which is exactly what the final sweep matches.

-- Event-scoped children first ------------------------------------------------

DELETE FROM file_comments WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM files WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM content_versions WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM embeds WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM activity WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM counters WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM task_reminder_queue WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM tasks WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM task_templates WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM evaluations WHERE plan_id IN
  (SELECT id FROM eval_plans WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1)));

DELETE FROM eval_reviewer_pins WHERE plan_id IN
  (SELECT id FROM eval_plans WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1)));

DELETE FROM eval_plan_includes WHERE plan_id IN
  (SELECT id FROM eval_plans WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1)));

DELETE FROM eval_plan_reviewers WHERE plan_id IN
  (SELECT id FROM eval_plans WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1)));

DELETE FROM eval_plans WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM decision_queue WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM comments WHERE submission_id IN
  (SELECT id FROM submissions WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1)));

DELETE FROM session_speakers WHERE session_id IN
  (SELECT id FROM sessions WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1)));

DELETE FROM sessions WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM submission_speakers WHERE submission_id IN
  (SELECT id FROM submissions WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1)));

DELETE FROM submissions WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM speaker_profiles WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM form_versions WHERE form_id IN
  (SELECT id FROM forms WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1)));

DELETE FROM forms WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM taxonomy_options WHERE taxonomy_id IN
  (SELECT id FROM taxonomies WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1)));

DELETE FROM taxonomies WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM rooms WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM email_templates WHERE event_id IN
  (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM emails WHERE event_id IN
    (SELECT id FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1))
  OR org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1);

-- Org-scoped children --------------------------------------------------------

DELETE FROM pipeline_notes WHERE card_id IN
  (SELECT id FROM pipeline_cards WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM pipeline_history WHERE card_id IN
  (SELECT id FROM pipeline_cards WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM pipeline_cards WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1);

DELETE FROM contact_notes WHERE contact_id IN
  (SELECT id FROM org_contacts WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1));

DELETE FROM org_contacts WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1);

DELETE FROM org_fields WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1);

DELETE FROM org_segments WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1);

DELETE FROM api_tokens WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1);

DELETE FROM invites WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1);

-- Membership rows, then the events and orgs themselves ------------------------

DELETE FROM org_members WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1);

DELETE FROM events WHERE org_id IN (SELECT id FROM orgs WHERE is_sandbox = 1);

DELETE FROM orgs WHERE is_sandbox = 1;

-- Sandbox users, last — every row referencing them is gone by now. With the
-- sandbox membership rows dropped, seeded users (the roster in PEOPLE plus
-- the member-less speaker persona) are exactly the accounts that are
-- passwordless (the picker signs them in directly), plus-suffixed AND member
-- of no org. Real accounts always carry a password hash, so none can match;
-- this also sweeps remnants of sandboxes torn down by older flows.

DELETE FROM magic_tokens WHERE email IN (
  SELECT email FROM users
   WHERE password_hash IS NULL AND email LIKE '%+%@%'
     AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = users.id));

DELETE FROM auth_sessions WHERE user_id IN (
  SELECT id FROM users
   WHERE password_hash IS NULL AND email LIKE '%+%@%'
     AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = users.id));

DELETE FROM users
 WHERE password_hash IS NULL AND email LIKE '%+%@%'
   AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = users.id);
