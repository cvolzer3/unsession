/**
 * `/app/org/contact/:id` — one contact's record (Speaker CRM).
 *
 * Singular path on purpose: the record is its own page, not a child of the
 * `/app/org/contacts` directory listing.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, UnderConstruction } from '../views/layout';
import { adminProps } from '../views/chrome';

const app = new Hono<Ctx>();

app.get('/app/org/contact/:id', async (c) => {
  const props = await adminProps(c, 'Contact', { headerTitle: 'Contact' });
  if (!c.var.event) return c.redirect('/app/events/new');
  return c.html(
    <AdminLayout {...props}>
      <UnderConstruction page="Contact" note="Profile, notes, tags and event history for one speaker." />
    </AdminLayout>
  );
});

export default app;
