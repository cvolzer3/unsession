/**
 * Confirmation loop (spec §3.1): the speaker explicitly confirms
 * participation — from the portal (B5) or the tokenized link in the accept
 * email (routes/confirm.tsx). Confirmed gates public agenda display and
 * triggers task generation.
 *
 * Confirmation is a property of the SESSION, not the submission (migration
 * 0011). The submission stays `accepted` forever; `sessions.status` flips
 * pending → confirmed. Accept always creates the session first
 * (`decisions.ts` → `createSessionFromSubmission`), so there is always
 * something to confirm.
 */
import { all, one, now, run } from './db';
import { logActivity } from './activity';
import { generateTasksOnTrigger } from './tasks';
import type { Bindings } from '../types';

export type ConfirmResult =
  | { ok: true; already: boolean; submissionId: string; eventId: string; title: string }
  | { ok: false; reason: 'not_found' | 'not_accepted' | 'no_session' };

export async function confirmParticipation(
  env: Bindings,
  submissionId: string,
  actor: string
): Promise<ConfirmResult> {
  const sub = await one<{ id: string; event_id: string; status: string; title: string }>(
    env.DB,
    `SELECT id, event_id, status, title FROM submissions WHERE id = ?`,
    submissionId
  );
  if (!sub) return { ok: false, reason: 'not_found' };
  if (sub.status !== 'accepted') return { ok: false, reason: 'not_accepted' };

  const sessions = await all<{ id: string; status: string }>(
    env.DB,
    `SELECT id, status FROM sessions WHERE submission_id = ?`,
    sub.id
  );
  // Accept creates the session, so this only fires if it was deleted afterwards.
  // Better a visible failure than silently reporting a confirmation we cannot store.
  if (!sessions.length) return { ok: false, reason: 'no_session' };
  if (sessions.every((s) => s.status === 'confirmed')) {
    return { ok: true, already: true, submissionId, eventId: sub.event_id, title: sub.title };
  }

  for (const s of sessions) {
    await run(env.DB, `UPDATE sessions SET status = 'confirmed', updated_at = ? WHERE id = ?`, now(), s.id);
  }
  await run(env.DB, `UPDATE submissions SET updated_at = ? WHERE id = ?`, now(), sub.id);

  const tasks = await generateTasksOnTrigger(env, { submissionId: sub.id, trigger: 'confirmation' });

  // The built-in "Confirm participation" checkbox task (tasks-spec §8 Q7: the
  // documented on-acceptance exception) completes itself the moment the speaker
  // actually confirms — never leave it dangling in the portal. Matched by the
  // stable `builtin_key` (migration 0008) so renaming the template can't break
  // it; the name fallback covers templates created before the key existed.
  await run(
    env.DB,
    `UPDATE tasks SET status = 'done', completed_by = ?, completed_at = ?
     WHERE event_id = ? AND status = 'open'
       AND template_id IN (SELECT id FROM task_templates WHERE event_id = ?
         AND (builtin_key = 'confirm_participation' OR (type = 'checkbox' AND name LIKE 'Confirm participation%')))
       AND speaker_profile_id IN (
         SELECT sp.id FROM speaker_profiles sp
         JOIN submission_speakers ss ON ss.email = sp.email COLLATE NOCASE
         WHERE sp.event_id = ? AND ss.submission_id = ?
       )`,
    actor,
    now(),
    sub.event_id,
    sub.event_id,
    sub.event_id,
    sub.id
  );

  const skipNote = tasks.skippedNoSession
    ? `${tasks.skippedNoSession} session task template${tasks.skippedNoSession === 1 ? '' : 's'} skipped (no session)`
    : '';
  await logActivity(env.DB, {
    eventId: sub.event_id,
    subjectType: 'submission',
    subjectId: sub.id,
    actor,
    action: 'Speaker confirmed participation',
    detail: tasks.created
      ? `${tasks.created} onboarding tasks generated${skipNote ? ` · ${skipNote}` : ''}`
      : skipNote
        ? `No tasks created — ${skipNote}`
        : null,
  });

  return { ok: true, already: false, submissionId: sub.id, eventId: sub.event_id, title: sub.title };
}
