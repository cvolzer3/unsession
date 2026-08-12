/**
 * Confirmation loop (spec §3.1): the speaker explicitly confirms
 * participation — from the portal (B5) or the tokenized link in the accept
 * email (routes/confirm.tsx). Confirmed gates public agenda display and
 * triggers task generation.
 */
import { all, one, now, run } from './db';
import { logActivity } from './activity';
import { generateTasksOnTrigger } from './tasks';
import type { Bindings } from '../types';

export type ConfirmResult =
  | { ok: true; already: boolean; submissionId: string; eventId: string; title: string }
  | { ok: false; reason: 'not_found' | 'not_accepted' };

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
  if (sub.status === 'confirmed') return { ok: true, already: true, submissionId, eventId: sub.event_id, title: sub.title };
  if (sub.status !== 'accepted') return { ok: false, reason: 'not_accepted' };

  await run(env.DB, `UPDATE submissions SET status = 'confirmed', updated_at = ? WHERE id = ?`, now(), sub.id);
  const sessions = await all<{ id: string }>(env.DB, `SELECT id FROM sessions WHERE submission_id = ?`, sub.id);
  for (const s of sessions) {
    await run(env.DB, `UPDATE sessions SET status = 'confirmed', updated_at = ? WHERE id = ?`, now(), s.id);
  }

  const tasks = await generateTasksOnTrigger(env, { submissionId: sub.id, trigger: 'confirmation' });

  await logActivity(env.DB, {
    eventId: sub.event_id,
    subjectType: 'submission',
    subjectId: sub.id,
    actor,
    action: 'Speaker confirmed participation',
    detail: tasks.created ? `${tasks.created} onboarding tasks generated` : null,
  });

  return { ok: true, already: false, submissionId: sub.id, eventId: sub.event_id, title: sub.title };
}
