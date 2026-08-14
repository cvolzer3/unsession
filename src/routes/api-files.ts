/**
 * API domain: files (spec C parity round 2).
 *
 * The files library over the same version-chain aggregation as `/app/files`:
 * list every upload in the event (speaker deliverables, headshots, logos,
 * task samples) with association and comment counts, read one chain in full
 * (version history + cross-role comment thread), and reply as the organizer.
 * Comments deliberately send no email — the speaker reads the thread in their
 * portal, exactly like the admin drawer.
 */
import type { Hono } from 'hono';
import type { Bindings, Event } from '../types';
import { apiActor, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import {
  bad,
  eventOf,
  EVENT_PROP,
  handle,
  jsonBody,
  notFound,
  p,
  requireWrite,
  resolveEvent,
  str,
  type Tool,
} from '../lib/api-core';
import { logActivity } from '../lib/activity';
import { getFileRow, type FileRow } from '../lib/files';
import { addFileComment, listFileComments, type FileCommentRow } from '../lib/file-comments';
import { loadLibrary, type Chain } from './admin-files';

/* ----------------------------------------------------------------- helpers */

function fileUrl(env: Bindings, id: string): string {
  return `${env.APP_ORIGIN}/files/${id}`;
}

function shapeChain(env: Bindings, chain: Chain) {
  return {
    fileId: chain.fileId,
    kind: chain.kind,
    label: chain.label,
    filename: chain.filename,
    size: chain.size,
    uploadedBy: chain.uploadedBy,
    uploadedAt: chain.uploadedAt,
    speaker: chain.speaker,
    session: chain.session,
    subjectType: chain.subjectType,
    subjectId: chain.subjectId,
    url: fileUrl(env, chain.fileId),
    versions: chain.versions.map(shapeVersion.bind(null, env)),
    comments: chain.comments,
  };
}

function shapeVersion(env: Bindings, f: FileRow) {
  return {
    fileId: f.id,
    version: f.version,
    filename: f.filename,
    size: f.size,
    contentType: f.content_type,
    uploadedBy: f.uploaded_by,
    uploadedAt: f.created_at,
    url: fileUrl(env, f.id),
  };
}

function shapeComment(c: FileCommentRow) {
  return {
    id: c.id,
    author: c.author_name,
    role: c.author_role,
    body: c.body,
    fileId: c.file_id,
    createdAt: c.created_at,
  };
}

async function fileByRef(env: Bindings, auth: ApiAuth, id: string): Promise<{ file: FileRow; event: Event }> {
  const file = await getFileRow(env, (id ?? '').trim());
  if (!file || !file.event_id) throw notFound('File not found');
  const event = await eventOf(env, auth, file.event_id);
  return { file, event };
}

/* -------------------------------------------------------------------- read */

const FILE_FILTERS: Record<string, (c: Chain) => boolean> = {
  all: () => true,
  deliverables: (c) => c.kind === 'task_file',
  headshots: (c) => c.kind === 'headshot',
  other: (c) => c.kind !== 'task_file' && c.kind !== 'headshot',
};

export async function listFiles(env: Bindings, auth: ApiAuth, ref: string, filter?: string) {
  const event = await resolveEvent(env, auth, ref);
  const chains = await loadLibrary(env, event.id);
  const want = (filter ?? 'all').trim() || 'all';
  const pred = FILE_FILTERS[want] ?? ((c: Chain) => c.kind === want);
  return chains.filter(pred).map((c) => shapeChain(env, c));
}

/** One version chain in full: every version and the cross-role comment thread. */
export async function getFile(env: Bindings, auth: ApiAuth, id: string) {
  const { file, event } = await fileByRef(env, auth, id);
  const chains = await loadLibrary(env, event.id);
  const chain = chains.find((c) => c.versions.some((v) => v.id === file.id));
  if (!chain) throw notFound('File not found');
  const comments =
    chain.subjectType && chain.subjectId ? await listFileComments(env.DB, chain.subjectType, chain.subjectId) : [];
  return { ...shapeChain(env, chain), thread: comments.map(shapeComment) };
}

/* ------------------------------------------------------------------- write */

/** COMMENT on a file's thread as the organizer — same rules as the drawer reply. */
export async function commentOnFile(env: Bindings, auth: ApiAuth, id: string, body: string) {
  requireWrite(auth);
  const { file, event } = await fileByRef(env, auth, id);
  const text = (body ?? '').trim().slice(0, 2000);
  if (!text) throw bad('Write the comment first');
  if (!file.subject_type || !file.subject_id) throw bad('This file has no comment thread (it is not attached to anything)');

  const comment = await addFileComment(env.DB, {
    eventId: event.id,
    kind: file.kind,
    subjectType: file.subject_type,
    subjectId: file.subject_id,
    fileId: file.id,
    authorUserId: null,
    authorName: apiActor(auth),
    authorRole: 'organizer',
    body: text,
  });
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: file.subject_type === 'task' ? 'task' : 'speaker',
    subjectId: file.subject_id,
    actor: apiActor(auth),
    action: 'Commented on file',
    detail: file.filename,
  });
  // Deliberately no email — the speaker reads the thread in their portal.
  return shapeComment(comment);
}

/* -------------------------------------------------------------- REST routes */

export function registerFileRoutes(app: Hono<ApiCtx>): void {
  app.get(
    '/api/v1/events/:event/files',
    handle((c) => listFiles(c.env, c.var.apiAuth, p(c, 'event'), c.req.query('filter')))
  );
  app.get('/api/v1/files/:id', handle((c) => getFile(c.env, c.var.apiAuth, p(c, 'id'))));
  app.post(
    '/api/v1/files/:id/comments',
    handle(async (c) => {
      const body = await jsonBody<{ body?: string }>(c);
      return commentOnFile(c.env, c.var.apiAuth, p(c, 'id'), str(body.body));
    })
  );
}

/* --------------------------------------------------------------- MCP tools */

export const FILE_TOOLS: Tool[] = [
  {
    name: 'list_files',
    description:
      'List an event’s uploaded files grouped by version chain (task deliverables, headshots, logos, samples) with what each is attached to, speaker/session, version count, comment count and download URL. Filter: all | deliverables | headshots | other, or an exact kind. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        filter: { type: 'string', description: 'all (default) | deliverables | headshots | other | exact kind.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => listFiles(env, auth, str(a.event), a.filter === undefined ? undefined : str(a.filter)),
  },
  {
    name: 'get_file',
    description:
      'Get one file’s version chain in full: every version with download URLs, plus the cross-role comment thread (organizer and speaker replies). Fetch the binary from the returned url with the same Bearer token in a browser session (files are access-controlled). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File id (file_…) — any version in the chain.' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => getFile(env, auth, str(a.id)),
  },
  {
    name: 'comment_on_file',
    description:
      'REPLY on a file’s comment thread as the organizer (e.g. slide feedback). The thread follows the version chain, so replacing the file keeps the conversation. Activity-logged. Deliberately sends NO email — the speaker reads the thread in their portal.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'File id (file_…).' },
        body: { type: 'string', description: 'Comment text, max 2000 chars.' },
      },
      required: ['id', 'body'],
      additionalProperties: false,
    },
    run: (env, auth, a) => commentOnFile(env, auth, str(a.id), str(a.body)),
  },
];
