import type { Context } from 'hono';
import type { Ctx } from '../types';
import { firstFormSlug } from '../lib/events';
import { all, one } from '../lib/db';
import { SANDBOX_PERSONAS, personaKeyForEmail } from '../lib/seed-data';
import type { AdminLayoutProps, SandboxWidget } from './layout';

/** Everything AdminLayout needs, assembled once per admin page. */
export async function adminProps(
  c: Context<Ctx>,
  title: string,
  extra: Partial<AdminLayoutProps> = {}
): Promise<Omit<AdminLayoutProps, 'children'>> {
  const event = c.var.event;
  const [formSlug, publicForms, orgRow] = event
    ? await Promise.all([
        firstFormSlug(c.env.DB, event.id),
        all<{ slug: string; name: string }>(
          c.env.DB,
          `SELECT slug, name FROM forms WHERE event_id = ? AND status != 'draft' ORDER BY (status = 'open') DESC, created_at`,
          event.id
        ),
        one<{ is_sandbox: number }>(c.env.DB, `SELECT is_sandbox FROM orgs WHERE id = ?`, event.org_id),
      ])
    : [null, [] as { slug: string; name: string }[], null];

  // Sandbox orgs get the bottom-right role-switcher chip on every admin page.
  let sandbox: SandboxWidget | null = null;
  if (event && orgRow?.is_sandbox) {
    const user = c.var.user;
    const key = personaKeyForEmail(user?.email);
    const personaLabel = key
      ? `${SANDBOX_PERSONAS[key].first} (${SANDBOX_PERSONAS[key].title})`
      : // A real user who claimed / was invited into the sandbox org.
        `${(user?.name || user?.email || 'you').split(/[\s@]/)[0]} (${
          c.var.role ? c.var.role[0].toUpperCase() + c.var.role.slice(1) : 'Member'
        })`;
    sandbox = { orgId: event.org_id, personaKey: key, personaLabel };
  }

  return {
    title,
    user: c.var.user,
    event,
    events: c.var.events,
    path: new URL(c.req.url).pathname,
    publicFormSlug: formSlug,
    publicForms,
    toast: c.req.query('ok') ?? null,
    origin: c.env.APP_ORIGIN,
    sandbox,
    ...extra,
  };
}

export function redirectWithToast(c: Context<Ctx>, path: string, message: string) {
  const sep = path.includes('?') ? '&' : '?';
  return c.redirect(`${path}${sep}ok=${encodeURIComponent(message)}`);
}
