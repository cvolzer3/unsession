/**
 * Version history + restore for edited content — session title/abstract and
 * speaker-profile fields (migration 0020). Every content save appends a row
 * whose snapshot is the state AFTER the edit; the first edit of a subject also
 * writes an 'Original content' baseline so the pre-edit state stays
 * restorable. Restoring applies a chosen snapshot and appends a new row —
 * the list is append-only, so a restore is itself undoable.
 */
import { newId } from './ids';
import { jsonParse, now, all, one, run } from './db';

/** Session content covered by versioning — schedule/room/taxonomy stay out. */
export type SessionSnapshot = { title: string; abstract: string };

export type SpeakerSnapshot = {
  name: string;
  tagline: string | null;
  bio: string;
  pronouns: string | null;
  links_json: string | null;
  headshot_file_id: string | null;
};

export type ContentSubjectType = 'session' | 'speaker';

export type VersionRow = {
  id: string;
  event_id: string;
  editor: string;
  summary: string;
  snapshot_json: string;
  created_at: string;
};

export function sessionSnapshotOf(row: { title: string; abstract: string }): SessionSnapshot {
  return { title: row.title, abstract: row.abstract };
}

export function speakerSnapshotOf(row: {
  name: string;
  tagline?: string | null;
  bio: string;
  pronouns?: string | null;
  links_json?: string | null;
  headshot_file_id?: string | null;
}): SpeakerSnapshot {
  return {
    name: row.name,
    tagline: row.tagline ?? null,
    bio: row.bio,
    pronouns: row.pronouns ?? null,
    links_json: row.links_json ?? null,
    headshot_file_id: row.headshot_file_id ?? null,
  };
}

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  abstract: 'abstract',
  name: 'name',
  tagline: 'tagline',
  bio: 'bio',
  pronouns: 'pronouns',
  links_json: 'links',
  headshot_file_id: 'headshot',
};

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((k) => (after[k] ?? null) !== (before[k] ?? null));
}

export type RecordVersionInput = {
  eventId: string;
  subjectType: ContentSubjectType;
  subjectId: string;
  /** Display name of whoever saved the edit. */
  editor: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Stamp for the lazily written baseline row — pass the subject's created_at. */
  subjectCreatedAt?: string;
  /** Overrides the generated 'Edited …' summary (imports, restores). */
  summary?: string;
};

async function insertVersion(
  db: D1Database,
  input: RecordVersionInput,
  editor: string,
  summary: string,
  snapshot: Record<string, unknown>,
  createdAt: string
): Promise<void> {
  await run(
    db,
    `INSERT INTO content_versions (id, event_id, subject_type, subject_id, editor, summary, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('ver'),
    input.eventId,
    input.subjectType,
    input.subjectId,
    editor,
    summary,
    JSON.stringify(snapshot),
    createdAt
  );
}

/**
 * Append a version for a saved edit; no-op (returns false) when nothing in the
 * snapshot changed, so callers can invoke it unconditionally after any save.
 */
export async function recordContentVersion(db: D1Database, input: RecordVersionInput): Promise<boolean> {
  const changed = changedFields(input.before, input.after);
  if (!changed.length) return false;
  const prior = await one<{ id: string }>(
    db,
    `SELECT id FROM content_versions WHERE subject_type = ? AND subject_id = ? LIMIT 1`,
    input.subjectType,
    input.subjectId
  );
  if (!prior) {
    await insertVersion(db, input, 'Original', 'Original content', input.before, input.subjectCreatedAt ?? now());
  }
  const summary = input.summary ?? `Edited ${changed.map((k) => FIELD_LABELS[k] ?? k).join(', ')}`;
  await insertVersion(db, input, input.editor, summary, input.after, now());
  return true;
}

/** Newest first; rowid breaks same-second ties (baseline before its first edit). */
export async function listContentVersions(
  db: D1Database,
  subjectType: ContentSubjectType,
  subjectId: string
): Promise<VersionRow[]> {
  return all<VersionRow>(
    db,
    `SELECT id, event_id, editor, summary, snapshot_json, created_at
       FROM content_versions
      WHERE subject_type = ? AND subject_id = ?
      ORDER BY created_at DESC, rowid DESC`,
    subjectType,
    subjectId
  );
}

export function snapshotOf<T>(row: VersionRow, fallback: T): T {
  return jsonParse<T>(row.snapshot_json, fallback);
}

/** 'Restored the version saved 2027-05-01 14:03 UTC' — stored, so keep it locale-free. */
export function restoreSummary(version: VersionRow): string {
  return `Restored the version saved ${version.created_at.slice(0, 16).replace('T', ' ')} UTC`;
}
