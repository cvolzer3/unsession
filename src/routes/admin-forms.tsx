/**
 * `/app/forms` — Forms.
 *
 * OWNER: B1. This file is a placeholder; replace its contents wholesale.
 * Keep the exported Hono app and the routes it registers so `src/index.tsx`
 * does not need to change.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, UnderConstruction } from '../views/layout';
import { adminProps } from '../views/chrome';

const app = new Hono<Ctx>();

app.get('/app/forms', async (c) => {
  const props = await adminProps(c, 'Forms');
  if (!c.var.event) return c.redirect('/app/events/new');
  return c.html(
    <AdminLayout {...props}>
      <UnderConstruction page="Forms" note="The form list, builder and preview land in track B1." />
    </AdminLayout>
  );
});

export default app;
