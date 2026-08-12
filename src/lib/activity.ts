import { newId } from './ids';
import { now, run } from './db';

export type ActivityInput = {
  eventId: string;
  subjectType: string;
  subjectId: string;
  actor: string;
  action: string;
  detail?: string | null;
};

export async function logActivity(db: D1Database, a: ActivityInput): Promise<void> {
  await run(
    db,
    `INSERT INTO activity (id, event_id, subject_type, subject_id, actor, action, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('act'),
    a.eventId,
    a.subjectType,
    a.subjectId,
    a.actor,
    a.action,
    a.detail ?? null,
    now()
  );
}
