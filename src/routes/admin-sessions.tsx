/**
 * `/app/sessions` — Sessions.
 *
 * OWNER: B4. This file is a placeholder; replace its contents wholesale.
 * Keep the exported Hono app and the routes it registers so `src/index.tsx`
 * does not need to change.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, UnderConstruction } from '../views/layout';
import { adminProps } from '../views/chrome';

const app = new Hono<Ctx>();

app.get('/app/sessions', async (c) => {
  const props = await adminProps(c, 'Sessions');
  if (!c.var.event) return c.redirect('/app/events/new');
  return c.html(
    <AdminLayout {...props}>
      <UnderConstruction page="Sessions" note="The session list, inline editing and sponsor/service creation land in track B4." />
    </AdminLayout>
  );
});

export default app;
