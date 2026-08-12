/**
 * `/app/speakers` — Speakers & Tasks.
 *
 * OWNER: B5. This file is a placeholder; replace its contents wholesale.
 * Keep the exported Hono app and the routes it registers so `src/index.tsx`
 * does not need to change.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, UnderConstruction } from '../views/layout';
import { adminProps } from '../views/chrome';

const app = new Hono<Ctx>();

app.get('/app/speakers', async (c) => {
  const props = await adminProps(c, 'Speakers & Tasks');
  if (!c.var.event) return c.redirect('/app/events/new');
  return c.html(
    <AdminLayout {...props}>
      <UnderConstruction page="Speakers & Tasks" note="The speaker directory and the speakers x tasks grid land in track B5." />
    </AdminLayout>
  );
});

export default app;
