/**
 * Public submission form — `/{event}/{form}`. Registered last: it is the catch-all.
 *
 * OWNER: B1. Placeholder — replace the contents, keep the exported app
 * and its registered routes so `src/index.tsx` does not need to change.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { PublicLayout } from '../views/layout';
import { loadPublicEvent } from '../lib/public';

const app = new Hono<Ctx>();

app.get('/:event/:form', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  return c.html(
    <PublicLayout title="Submission form" event={found.event} theme={found.theme} maxWidth={620} toast={c.req.query('ok') ?? null}>
      <div style={`max-width:620px;margin:0 auto;padding:48px 20px 80px;`}>
        <div style="background:var(--card);border:1px solid var(--border);padding:40px 24px;text-align:center;">
          <div style={`font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.14em;color:var(--muted);margin-bottom:8px;`}>
            UNDER CONSTRUCTION
          </div>
          <div style="font-size:19px;font-weight:700;letter-spacing:-0.01em;margin-bottom:4px;">Submission form</div>
          <div style="font-size:13.5px;color:var(--text-secondary);">The public submission form (conditional fields, autosave, co-speakers) lands in track B1.</div>
        </div>
      </div>
    </PublicLayout>
  );
});

export default app;
