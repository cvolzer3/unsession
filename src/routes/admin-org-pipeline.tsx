/**
 * `/app/org/pipeline` — the speaker pipeline board (Speaker CRM).
 *
 * One card per contact, moving through the fixed stages: researching,
 * identified, contacted, interested, confirmed, declined.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, UnderConstruction } from '../views/layout';
import { adminProps } from '../views/chrome';

const app = new Hono<Ctx>();

app.get('/app/org/pipeline', async (c) => {
  const props = await adminProps(c, 'Pipeline', { headerTitle: 'Pipeline' });
  if (!c.var.event) return c.redirect('/app/events/new');
  return c.html(
    <AdminLayout {...props}>
      <UnderConstruction page="Pipeline" note="Track speakers from first idea to a confirmed slot." />
    </AdminLayout>
  );
});

export default app;
