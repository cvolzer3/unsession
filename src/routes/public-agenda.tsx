/**
 * Public agenda — `/{event}` and `/{event}/agenda`.
 *
 * OWNER: B4. Placeholder — replace the contents, keep the exported app
 * and its registered routes so `src/index.tsx` does not need to change.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { PublicLayout } from '../views/layout';
import { loadPublicEvent } from '../lib/public';

const app = new Hono<Ctx>();

app.get('/:event', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  return c.html(
    <PublicLayout title="Agenda" event={found.event} theme={found.theme} maxWidth={1240} toast={c.req.query('ok') ?? null}>
      <div style={`max-width:1240px;margin:0 auto;padding:48px 20px 80px;`}>
        <div style="background:var(--card);border:1px solid var(--border);padding:40px 24px;text-align:center;">
          <div style={`font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.14em;color:var(--muted);margin-bottom:8px;`}>
            UNDER CONSTRUCTION
          </div>
          <div style="font-size:19px;font-weight:700;letter-spacing:-0.01em;margin-bottom:4px;">Agenda</div>
          <div style="font-size:13.5px;color:var(--text-secondary);">The public agenda (list, day, track, room and week views) lands in track B4.</div>
        </div>
      </div>
    </PublicLayout>
  );
});

app.get('/:event/agenda', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  return c.html(
    <PublicLayout title="Agenda" event={found.event} theme={found.theme} maxWidth={1240} toast={c.req.query('ok') ?? null}>
      <div style={`max-width:1240px;margin:0 auto;padding:48px 20px 80px;`}>
        <div style="background:var(--card);border:1px solid var(--border);padding:40px 24px;text-align:center;">
          <div style={`font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.14em;color:var(--muted);margin-bottom:8px;`}>
            UNDER CONSTRUCTION
          </div>
          <div style="font-size:19px;font-weight:700;letter-spacing:-0.01em;margin-bottom:4px;">Agenda</div>
          <div style="font-size:13.5px;color:var(--text-secondary);">The public agenda (list, day, track, room and week views) lands in track B4.</div>
        </div>
      </div>
    </PublicLayout>
  );
});

export default app;
