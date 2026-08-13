/**
 * Task reminder queue (the Emails → Outbox tab) — the drawer "Remind" button
 * queues a manual reminder instead of emailing on the spot, the same
 * decide-vs-notify pattern as lib/decision-queue.
 *
 * Queueing records intent and nothing else: no email, no activity visible to
 * the speaker. Sending from the outbox resolves the reminder wording fresh
 * (template subject/body at send time) and deletes the row — one email per
 * speaker: a lone reminder goes through `remindTask`, several batch into a
 * single combined email via `remindTasksBatch`. One pending reminder per
 * (task, speaker): re-queueing replaces it.
 */
import { all, jsonParse, now, one, run } from './db';
import { logActivity } from './activity';
import { newId } from './ids';
import {
  parseReminders,
  remindTask,
  remindTasksBatch,
  snapshotOf,
  type OneOffSpec,
  type TaskRow,
  type TaskTemplateRow,
} from './tasks';
import type { Bindings } from '../types';

function taskName(task: TaskRow, template: TaskTemplateRow | null): string {
  return (
    snapshotOf(task)?.name ??
    template?.name ??
    jsonParse<OneOffSpec>(task.one_off_json, { name: 'Task', type: 'checkbox' }).name
  );
}

export async function queueTaskReminder(
  env: Bindings,
  input: { eventId: string; taskId: string; speakerProfileId: string; taskName: string; actorName: string }
): Promise<{ replaced: boolean }> {
  const prior = await one<{ id: string }>(
    env.DB,
    `SELECT id FROM task_reminder_queue WHERE task_id = ? AND speaker_profile_id = ?`,
    input.taskId,
    input.speakerProfileId
  );
  await run(
    env.DB,
    `INSERT INTO task_reminder_queue (id, event_id, task_id, speaker_profile_id, queued_by, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (task_id, speaker_profile_id) DO UPDATE SET
       queued_by = excluded.queued_by, created_at = excluded.created_at`,
    newId('trq'),
    input.eventId,
    input.taskId,
    input.speakerProfileId,
    input.actorName,
    now()
  );
  await logActivity(env.DB, {
    eventId: input.eventId,
    subjectType: 'task',
    subjectId: input.taskId,
    actor: input.actorName,
    action: 'Reminder queued',
    detail: `“${input.taskName}” queued in Emails → Outbox`,
  });
  return { replaced: !!prior };
}

export type QueuedReminderRow = {
  id: string;
  task_id: string;
  speaker_profile_id: string;
  queued_by: string;
  created_at: string;
  task_name: string;
  due_date: string | null;
  speaker_name: string | null;
  speaker_email: string | null;
};

/** Queue rows joined with fresh task + speaker data, for the outbox UI. */
export async function listReminderQueue(env: Bindings, eventId: string): Promise<QueuedReminderRow[]> {
  const rows = await all<
    QueuedReminderRow & { snapshot_json: string | null; one_off_json: string | null; tpl_name: string | null }
  >(
    env.DB,
    `SELECT q.id, q.task_id, q.speaker_profile_id, q.queued_by, q.created_at,
            t.due_date, t.snapshot_json, t.one_off_json, tt.name AS tpl_name,
            sp.name AS speaker_name, sp.email AS speaker_email
     FROM task_reminder_queue q
     JOIN tasks t ON t.id = q.task_id
     LEFT JOIN task_templates tt ON tt.id = t.template_id
     LEFT JOIN speaker_profiles sp ON sp.id = q.speaker_profile_id
     WHERE q.event_id = ? ORDER BY q.created_at DESC, q.id`,
    eventId
  );
  return rows.map((r) => ({
    ...r,
    task_name:
      snapshotOf(r)?.name ??
      r.tpl_name ??
      jsonParse<OneOffSpec>(r.one_off_json, { name: 'Task', type: 'checkbox' }).name,
  }));
}

export async function queuedReminderCount(env: Bindings, eventId: string): Promise<number> {
  const row = await one<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM task_reminder_queue WHERE event_id = ?`,
    eventId
  );
  return row?.n ?? 0;
}

export async function removeQueuedReminders(
  env: Bindings,
  eventId: string,
  ids: string[],
  actorName: string
): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    const row = await one<{ id: string; task_id: string }>(
      env.DB,
      `SELECT id, task_id FROM task_reminder_queue WHERE id = ? AND event_id = ?`,
      id,
      eventId
    );
    if (!row) continue;
    await run(env.DB, `DELETE FROM task_reminder_queue WHERE id = ?`, row.id);
    removed++;
    await logActivity(env.DB, {
      eventId,
      subjectType: 'task',
      subjectId: row.task_id,
      actor: actorName,
      action: 'Reminder undone',
      detail: 'Queued reminder removed from the outbox — no email was sent',
    });
  }
  return removed;
}

export type SendQueuedRemindersResult = {
  processed: number;
  emailed: number;
  /** Distinct emails sent — every queued reminder for the same speaker batches into one. */
  emails: number;
  simulated: number;
  skipped: { id: string; reason: string }[];
  /** Rows still queued after this batch (a send processes at most `limit`). */
  remaining: number;
};

/**
 * Act on the queue: send up to `limit` queued reminders and delete their rows.
 * All of a speaker's queued reminders go out as ONE email — a single reminder
 * keeps its template's custom wording (`remindTask`), two or more become a
 * combined list (`remindTasksBatch`). A speaker's batch is never split, so
 * `limit` is checked between speakers, not between rows.
 * Rows whose task or speaker can no longer take a reminder (task completed or
 * cancelled since queueing, speaker gone) are deleted too — a row that can
 * never send must not stick in the outbox — and reported.
 */
export async function sendQueuedReminders(
  env: Bindings,
  eventId: string,
  actorName: string,
  limit: number
): Promise<SendQueuedRemindersResult> {
  const result: SendQueuedRemindersResult = {
    processed: 0,
    emailed: 0,
    emails: 0,
    simulated: 0,
    skipped: [],
    remaining: 0,
  };
  if (limit <= 0) {
    result.remaining = await queuedReminderCount(env, eventId);
    return result;
  }

  const event = await one<{ id: string; name: string; slug: string }>(
    env.DB,
    `SELECT id, name, slug FROM events WHERE id = ?`,
    eventId
  );
  if (!event) return result;

  const rows = await all<{ id: string; task_id: string; speaker_profile_id: string }>(
    env.DB,
    `SELECT id, task_id, speaker_profile_id FROM task_reminder_queue
     WHERE event_id = ? ORDER BY created_at, id`,
    eventId
  );

  // Group by speaker, ordered by each speaker's earliest queued row.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const g = groups.get(row.speaker_profile_id);
    if (g) g.push(row);
    else groups.set(row.speaker_profile_id, [row]);
  }

  for (const [speakerProfileId, group] of groups) {
    if (result.processed >= limit) break;

    const profile = await one<{ id: string; name: string; email: string }>(
      env.DB,
      `SELECT id, name, email FROM speaker_profiles WHERE id = ?`,
      speakerProfileId
    );

    const sendable: { rowId: string; task: TaskRow; template: TaskTemplateRow | null }[] = [];
    for (const row of group) {
      result.processed++;
      const task = await one<TaskRow>(
        env.DB,
        `SELECT * FROM tasks WHERE id = ? AND event_id = ?`,
        row.task_id,
        eventId
      );
      const template =
        task?.template_id != null
          ? await one<TaskTemplateRow>(env.DB, `SELECT * FROM task_templates WHERE id = ?`, task.template_id)
          : null;

      const reason = !task
        ? 'task no longer exists'
        : task.status === 'done'
          ? 'task already completed'
          : task.status === 'cancelled'
            ? 'task was removed'
            : !profile?.email
              ? 'speaker no longer on file'
              : null;
      if (reason || !task || !profile) {
        result.skipped.push({ id: row.id, reason: reason ?? 'not sendable' });
        await run(env.DB, `DELETE FROM task_reminder_queue WHERE id = ?`, row.id);
        continue;
      }
      sendable.push({ rowId: row.id, task, template });
    }
    if (!sendable.length || !profile) continue;

    let status: string;
    if (sendable.length === 1) {
      const { task, template } = sendable[0];
      const session = task.session_id
        ? await one<{ title: string }>(env.DB, `SELECT title FROM sessions WHERE id = ?`, task.session_id)
        : null;
      const rem = template ? parseReminders(template) : null;
      status = (
        await remindTask(env, {
          task,
          taskName: taskName(task, template),
          event,
          profile,
          sessionTitle: session?.title ?? null,
          subject: rem?.subject,
          body: rem?.body,
          actor: actorName,
        })
      ).status;
    } else {
      status = (
        await remindTasksBatch(env, {
          event,
          profile,
          items: sendable.map(({ task, template }) => ({ task, taskName: taskName(task, template) })),
          actor: actorName,
        })
      ).status;
    }
    result.emailed += sendable.length;
    result.emails++;
    if (status === 'simulated') result.simulated += sendable.length;
    for (const { rowId } of sendable) await run(env.DB, `DELETE FROM task_reminder_queue WHERE id = ?`, rowId);
  }

  result.remaining = await queuedReminderCount(env, eventId);
  return result;
}
