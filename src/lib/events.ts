/** Event creation + the defaults every new event is stamped with. */
import { batch, now, one, run } from './db';
import { newId } from './ids';
import { uniqueSlug } from './slugify';
import { DEFAULT_EMAIL_TEMPLATES, DEFAULT_ROOMS, DEFAULT_TAXONOMIES } from './defaults';
import { DEFAULT_THEME } from './theme';
import type { Event, Role, Theme } from '../types';

export async function slugTaken(db: D1Database, slug: string, exceptId?: string): Promise<boolean> {
  const row = await one<{ id: string }>(db, `SELECT id FROM events WHERE slug = ?`, slug);
  return !!row && row.id !== exceptId;
}

export type CreateEventInput = {
  orgId: string;
  name: string;
  slug?: string;
  startDate: string;
  endDate: string;
  timezone: string;
  venue?: string | null;
  mode?: string;
  description?: string | null;
  theme?: Partial<Theme>;
  withDefaults?: boolean;
};

export async function createEvent(db: D1Database, input: CreateEventInput): Promise<Event> {
  const slug = await uniqueSlug(input.slug || input.name, (s) => slugTaken(db, s));
  const theme: Theme = { ...DEFAULT_THEME, ...(input.theme ?? {}) };
  const event: Event = {
    id: newId('evt'),
    org_id: input.orgId,
    name: input.name,
    slug,
    start_date: input.startDate,
    end_date: input.endDate,
    timezone: input.timezone,
    venue: input.venue ?? null,
    mode: input.mode ?? 'in_person',
    description: input.description ?? null,
    theme_json: JSON.stringify(theme),
    day_start_min: 30,
    day_end_min: 600,
    published: 0,
    hide_unconfirmed: 1,
    created_at: now(),
  };

  await run(
    db,
    `INSERT INTO events (id, org_id, name, slug, start_date, end_date, timezone, venue, mode, description,
       theme_json, day_start_min, day_end_min, published, hide_unconfirmed, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    event.id,
    event.org_id,
    event.name,
    event.slug,
    event.start_date,
    event.end_date,
    event.timezone,
    event.venue,
    event.mode,
    event.description,
    event.theme_json,
    event.day_start_min,
    event.day_end_min,
    event.published,
    event.hide_unconfirmed,
    event.created_at
  );

  if (input.withDefaults !== false) await stampDefaults(db, event.id);
  return event;
}

export async function stampDefaults(db: D1Database, eventId: string): Promise<void> {
  const stamp = now();
  const stmts: Array<[string, unknown[]]> = [];

  for (const room of DEFAULT_ROOMS) {
    stmts.push([
      `INSERT INTO rooms (id, event_id, name, capacity, priority) VALUES (?,?,?,?,?)`,
      [newId('rom'), eventId, room.name, room.capacity, room.priority],
    ]);
  }

  DEFAULT_TAXONOMIES.forEach((tax, ti) => {
    const taxId = newId('tax');
    stmts.push([
      `INSERT INTO taxonomies (id, event_id, name, has_color, has_duration, position) VALUES (?,?,?,?,?,?)`,
      [taxId, eventId, tax.name, tax.hasColor ? 1 : 0, tax.hasDuration ? 1 : 0, ti],
    ]);
    tax.options.forEach((opt, oi) => {
      stmts.push([
        `INSERT INTO taxonomy_options (id, taxonomy_id, name, color, duration_min, position) VALUES (?,?,?,?,?,?)`,
        [newId('tpo'), taxId, opt.name, opt.color ?? null, opt.duration ?? null, oi],
      ]);
    });
  });

  for (const t of DEFAULT_EMAIL_TEMPLATES) {
    stmts.push([
      `INSERT INTO email_templates (id, event_id, key, name, subject, body, updated_at) VALUES (?,?,?,?,?,?,?)`,
      [newId('etp'), eventId, t.key, t.name, t.subject, t.body, stamp],
    ]);
  }

  await batch(db, stmts);
}

export async function ensureOrgForUser(
  db: D1Database,
  userId: string,
  displayName: string,
  role: Role = 'owner'
): Promise<string> {
  const existing = await one<{ org_id: string }>(
    db,
    `SELECT org_id FROM org_members WHERE user_id = ? ORDER BY created_at LIMIT 1`,
    userId
  );
  if (existing) return existing.org_id;

  const orgId = newId('org');
  const stamp = now();
  await run(db, `INSERT INTO orgs (id, name, is_sandbox, created_at) VALUES (?,?,0,?)`, orgId, `${displayName}'s events`, stamp);
  await run(
    db,
    `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?,?,?,?)`,
    orgId,
    userId,
    role,
    stamp
  );
  return orgId;
}

export async function firstFormSlug(db: D1Database, eventId: string): Promise<string | null> {
  const row = await one<{ slug: string }>(
    db,
    `SELECT slug FROM forms WHERE event_id = ? ORDER BY (status = 'open') DESC, created_at LIMIT 1`,
    eventId
  );
  return row?.slug ?? null;
}
