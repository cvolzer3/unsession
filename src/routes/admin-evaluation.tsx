/**
 * `/app/evaluation` — Evaluation.
 *
 * OWNER: B3. This file is a placeholder; replace its contents wholesale.
 * Keep the exported Hono app and the routes it registers so `src/index.tsx`
 * does not need to change.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, UnderConstruction } from '../views/layout';
import { adminProps } from '../views/chrome';

const app = new Hono<Ctx>();

app.get('/app/evaluation', async (c) => {
  const props = await adminProps(c, 'Evaluation');
  if (!c.var.event) return c.redirect('/app/events/new');
  return c.html(
    <AdminLayout {...props}>
      <UnderConstruction page="Evaluation" note="Evaluation plans, rubrics and reviewer progress land in track B3." />
    </AdminLayout>
  );
});

export default app;
