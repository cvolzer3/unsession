/**
 * Comments on uploaded files (migration 0021). Threads key on the version
 * chain — the same (kind, subject_type, subject_id) triple `saveUpload`
 * versions on — so replacing a file keeps its conversation. Speakers write
 * from the portal task list, organizers from the files library drawer.
 * No email is sent on a new comment (deliberate; see the migration).
 */
import { newId } from './ids';
import { all, one, now, run } from './db';
import { fmtDate } from '../views/layout';

/** "Aug 12, 2026 · 14:03 UTC" — comment threads and version lists need the time of day. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = iso.length >= 16 ? ` · ${iso.slice(11, 16)} UTC` : '';
  return `${fmtDate(iso, true)}${time}`;
}

export type FileCommentRow = {
  id: string;
  event_id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  file_id: string | null;
  author_user_id: string | null;
  author_name: string;
  author_role: 'organizer' | 'speaker';
  body: string;
  created_at: string;
};

export async function listFileComments(
  db: D1Database,
  subjectType: string,
  subjectId: string
): Promise<FileCommentRow[]> {
  return await all<FileCommentRow>(
    db,
    `SELECT * FROM file_comments WHERE subject_type = ? AND subject_id = ? ORDER BY created_at`,
    subjectType,
    subjectId
  );
}

export type AddFileCommentInput = {
  eventId: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  /** The version the comment was written against — the chain's latest file row. */
  fileId: string | null;
  authorUserId: string | null;
  authorName: string;
  authorRole: 'organizer' | 'speaker';
  body: string;
};

export async function addFileComment(db: D1Database, input: AddFileCommentInput): Promise<FileCommentRow> {
  const id = newId('fcm');
  await run(
    db,
    `INSERT INTO file_comments (id, event_id, kind, subject_type, subject_id, file_id, author_user_id, author_name, author_role, body, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.eventId,
    input.kind,
    input.subjectType,
    input.subjectId,
    input.fileId,
    input.authorUserId,
    input.authorName,
    input.authorRole,
    input.body,
    now()
  );
  return (await one<FileCommentRow>(db, `SELECT * FROM file_comments WHERE id = ?`, id))!;
}
