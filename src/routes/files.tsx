/**
 * File downloads: /files/:id streams from R2.
 * Access: logo + headshot are public (they render on public pages); anything
 * else needs a signed-in user who is either an org member of the file's event
 * or a speaker (by email) in that event.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { one } from '../lib/db';
import { getFileRow } from '../lib/files';

const app = new Hono<Ctx>();

const PUBLIC_KINDS = new Set(['logo', 'headshot', 'sample']);

app.get('/files/:id', async (c) => {
  const row = await getFileRow(c.env, c.req.param('id'));
  if (!row || !c.env.FILES) return c.notFound();

  if (!PUBLIC_KINDS.has(row.kind)) {
    const user = c.var.user;
    if (!user) return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`);
    const member = row.event_id
      ? await one(
          c.env.DB,
          `SELECT 1 FROM org_members m JOIN events e ON e.org_id = m.org_id WHERE e.id = ? AND m.user_id = ?`,
          row.event_id,
          user.id
        )
      : null;
    const speaker = row.event_id
      ? await one(
          c.env.DB,
          `SELECT 1 FROM speaker_profiles WHERE event_id = ? AND email = ?`,
          row.event_id,
          user.email
        )
      : null;
    if (!member && !speaker) return c.text('Forbidden', 403);
  }

  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  headers.set('Content-Type', row.content_type || 'application/octet-stream');
  headers.set('Content-Length', String(row.size));
  headers.set('Content-Disposition', `inline; filename="${row.filename.replace(/"/g, '')}"`);
  headers.set('Cache-Control', PUBLIC_KINDS.has(row.kind) ? 'public, max-age=3600' : 'private, no-store');
  return new Response(obj.body, { headers });
});

export default app;
