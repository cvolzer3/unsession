import type { Context } from 'hono';
import type { Ctx } from '../types';
import { cfpStatus, firstFormSlug } from '../lib/events';
import { all } from '../lib/db';
import type { AdminLayoutProps } from './layout';

/** Everything AdminLayout needs, assembled once per admin page. */
export async function adminProps(
  c: Context<Ctx>,
  title: string,
  extra: Partial<AdminLayoutProps> = {}
): Promise<Omit<AdminLayoutProps, 'children'>> {
  const event = c.var.event;
  const [cfp, formSlug, publicForms] = event
    ? await Promise.all([
        cfpStatus(c.env.DB, event.id),
        firstFormSlug(c.env.DB, event.id),
        all<{ slug: string; name: string }>(
          c.env.DB,
          `SELECT slug, name FROM forms WHERE event_id = ? AND status != 'draft' ORDER BY (status = 'open') DESC, created_at`,
          event.id
        ),
      ])
    : [null, null, [] as { slug: string; name: string }[]];
  return {
    title,
    user: c.var.user,
    event,
    events: c.var.events,
    path: new URL(c.req.url).pathname,
    cfp,
    publicFormSlug: formSlug,
    publicForms,
    toast: c.req.query('ok') ?? null,
    origin: c.env.APP_ORIGIN,
    ...extra,
  };
}

export function redirectWithToast(c: Context<Ctx>, path: string, message: string) {
  const sep = path.includes('?') ? '&' : '?';
  return c.redirect(`${path}${sep}ok=${encodeURIComponent(message)}`);
}
