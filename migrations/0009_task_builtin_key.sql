-- Task-assignment visibility: a stable machine key for built-in task templates.
--
-- `lib/confirm.ts` auto-completes the built-in "Confirm participation"
-- checkbox by matching the template NAME (LIKE 'Confirm participation%') —
-- renaming the template silently broke the auto-complete. `builtin_key`
-- survives renames; confirm.ts matches the key first and falls back to the
-- name for rows created before this migration ran.

ALTER TABLE task_templates ADD COLUMN builtin_key TEXT;

UPDATE task_templates
   SET builtin_key = 'confirm_participation'
 WHERE type = 'checkbox' AND name LIKE 'Confirm participation%';
