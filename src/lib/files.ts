/**
 * R2-backed file storage. Bucket binding `FILES` (bucket `unsession-files`).
 * All uploads flow through saveUpload so validation and the `files` table
 * stay consistent; downloads flow through routes/files.tsx.
 */
import { newId } from './ids';
import { now, one, run } from './db';
import type { Bindings } from '../types';

export type FileRow = {
  id: string;
  event_id: string | null;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  r2_key: string;
  filename: string;
  size: number;
  content_type: string;
  version: number;
  uploaded_by: string | null;
  created_at: string;
};

export function filesEnabled(env: Bindings): boolean {
  return !!env.FILES;
}

function safeName(name: string): string {
  return (name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
}

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export type SaveUploadInput = {
  eventId: string;
  kind: string; // headshot | upload | task_file | logo | sample
  subjectType?: string | null;
  subjectId?: string | null;
  file: File;
  uploadedBy?: string | null;
  maxMb?: number;
  /** comma/space separated whitelist, e.g. "pdf, key" — empty = any */
  allowedExts?: string;
};

export type SaveUploadResult = { ok: true; file: FileRow } | { ok: false; error: string };

export async function saveUpload(env: Bindings, input: SaveUploadInput): Promise<SaveUploadResult> {
  if (!env.FILES) return { ok: false, error: 'File storage is not enabled yet.' };
  const name = safeName(input.file.name);
  const ext = extOf(name);
  const allowed = (input.allowedExts || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  const capMb = input.maxMb && input.maxMb > 0 ? input.maxMb : 100;
  const limits = `${allowed.length ? allowed.join('/').toUpperCase() : 'ANY FILE'} · ≤${capMb} MB`;
  if (allowed.length && !allowed.includes(ext)) {
    return { ok: false, error: `File type .${ext || '?'} not allowed — ${limits}.` };
  }
  if (input.file.size > capMb * 1024 * 1024) {
    return { ok: false, error: `File is too large — ${limits}.` };
  }

  // Version chains per (kind, subject): re-upload replaces with history.
  let version = 1;
  if (input.subjectType && input.subjectId) {
    const prev = await one<{ v: number }>(
      env.DB,
      `SELECT MAX(version) AS v FROM files WHERE kind = ? AND subject_type = ? AND subject_id = ?`,
      input.kind,
      input.subjectType,
      input.subjectId
    );
    version = (prev?.v ?? 0) + 1;
  }

  const id = newId('fil');
  const key = `ev/${input.eventId}/${input.kind}/${id}/${name}`;
  await env.FILES.put(key, input.file.stream(), {
    httpMetadata: { contentType: input.file.type || 'application/octet-stream' },
  });
  await run(
    env.DB,
    `INSERT INTO files (id, event_id, kind, subject_type, subject_id, r2_key, filename, size, content_type, version, uploaded_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.eventId,
    input.kind,
    input.subjectType ?? null,
    input.subjectId ?? null,
    key,
    name,
    input.file.size,
    input.file.type || 'application/octet-stream',
    version,
    input.uploadedBy ?? null,
    now()
  );
  const row = await one<FileRow>(env.DB, `SELECT * FROM files WHERE id = ?`, id);
  return { ok: true, file: row! };
}

export async function getFileRow(env: Bindings, id: string): Promise<FileRow | null> {
  return await one<FileRow>(env.DB, `SELECT * FROM files WHERE id = ?`, id);
}
