/**
 * `/app/org/contacts` — the org's Speaker Directory (Speaker CRM).
 *
 * Lists every contact the org has worked with, across all its events.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, UnderConstruction } from '../views/layout';
import { adminProps } from '../views/chrome';

const app = new Hono<Ctx>();

app.get('/app/org/contacts', async (c) => {
  const props = await adminProps(c, 'Speaker Directory', { headerTitle: 'Speaker Directory' });
  if (!c.var.event) return c.redirect('/app/events/new');
  return c.html(
    <AdminLayout {...props}>
      <UnderConstruction page="Speaker Directory" note="Every speaker your organization has worked with, in one place." />
    </AdminLayout>
  );
});

export default app;
