/**
 * `/app/submissions` — Submissions.
 *
 * OWNER: B2. This file is a placeholder; replace its contents wholesale.
 * Keep the exported Hono app and the routes it registers so `src/index.tsx`
 * does not need to change.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, UnderConstruction } from '../views/layout';
import { adminProps } from '../views/chrome';

const app = new Hono<Ctx>();

app.get('/app/submissions', async (c) => {
  const props = await adminProps(c, 'Submissions');
  if (!c.var.event) return c.redirect('/app/events/new');
  return c.html(
    <AdminLayout {...props}>
      <UnderConstruction page="Submissions" note="The submissions table, detail drawer and decision flows land in track B2." />
    </AdminLayout>
  );
});

export default app;
