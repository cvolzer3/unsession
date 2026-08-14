/**
 * API domain: event administration + agenda operations (spec C parity round 2).
 *
 * Event creation and settings, rooms, taxonomies (with the option-rename
 * cascade that keeps form conditions and stored answers pointing at the new
 * label), agenda publish, the auto-scheduler, schedule conflicts, service/
 * sponsor session deletion, and the activity feed.
 */
import type { Hono } from 'hono';
import type { Bindings, Event } from '../types';
import { apiActor, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import {
  bad,
  clampLimit,
  decodeCursor,
  encodeCursor,
  eventOf,
  EVENT_PROP,
  handle,
  jsonBody,
  notFound,
  p,
  requireWrite,
  resolveEvent,
  str,
  type Tool,
} from '../lib/api-core';
import { all, batch, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { slugify } from '../lib/slugify';
import { createEvent, slugTaken } from '../lib/events';
import { FONT_PAIRINGS, normalizeHex, parseTheme } from '../lib/theme';
import { EVENT_MODES, TIMEZONES } from '../lib/defaults';
import { cascadeTaxonomyOptionRename, optionLabel } from '../lib/forms';
import {
  conflictIds,
  conflictItem,
  conflictMessages,
  eventDays,
  fmtTime,
  loadAgenda,
  roomNamer,
  speakerNamer,
  type AgendaBundle,
} from '../lib/agenda';
import { autoSchedule } from '../lib/auto-schedule';

/* ------------------------------------------------------------------ events */

export type CreateEventInput = {
  name?: string;
  slug?: string;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  venue?: string;
  mode?: string;
  description?: string;
};

/** CREATE an event with the standard defaults (Main Stage, Track/Format/Level, 7 email templates). */
export async function createEventApi(env: Bindings, auth: ApiAuth, input: CreateEventInput) {
  requireWrite(auth);
  if (auth.eventId) throw bad('This token is restricted to one event — event creation needs an org-wide token');
  const name = (input.name ?? '').trim();
  if (!name) throw bad('name is required');
  const startDate = (input.startDate ?? '').slice(0, 10);
  const endDate = (input.endDate ?? '').slice(0, 10) || startDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw bad('startDate must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw bad('endDate must be YYYY-MM-DD');
  const timezone = (input.timezone ?? '').trim() || 'UTC';
  if (!TIMEZONES.includes(timezone)) throw bad(`Unknown timezone — one of ${TIMEZONES.slice(0, 8).join(', ')}, …`);
  const mode = EVENT_MODES.some((m) => m.value === input.mode) ? String(input.mode) : 'in_person';

  const event = await createEvent(env.DB, {
    orgId: auth.orgId,
    name,
    slug: input.slug,
    startDate,
    endDate: endDate < startDate ? startDate : endDate,
    timezone,
    venue: (input.venue ?? '').trim() || null,
    mode,
    description: (input.description ?? '').trim() || null,
  });
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: apiActor(auth),
    action: 'Event created',
    detail: `${event.name} · via API`,
  });
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    startDate: event.start_date,
    endDate: event.end_date,
    timezone: event.timezone,
    venue: event.venue,
    mode: event.mode,
    published: false,
  };
}

export type UpdateEventInput = {
  name?: string;
  slug?: string;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  venue?: string | null;
  mode?: string;
  description?: string | null;
  theme?: { primary?: string; font?: string; hover?: string | null; border?: string | null; tint?: string | null };
};

/** UPDATE event settings and theme — the Event Setup form's semantics. */
export async function updateEvent(env: Bindings, auth: ApiAuth, ref: string, input: UpdateEventInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);

  const name = typeof input.name === 'string' ? input.name.trim() || event.name : event.name;
  let slug = event.slug;
  if (input.slug !== undefined || name !== event.name) {
    slug = slugify(String(input.slug ?? '') || name);
    if (slug !== event.slug && (await slugTaken(env.DB, slug, event.id))) {
      throw bad(`The slug “${slug}” is taken by another event`);
    }
  }

  const startDate = (input.startDate ?? event.start_date).slice(0, 10);
  let endDate = (input.endDate ?? event.end_date).slice(0, 10);
  if (endDate < startDate) endDate = startDate;
  const timezone = input.timezone !== undefined ? String(input.timezone) : event.timezone;
  if (input.timezone !== undefined && !TIMEZONES.includes(timezone)) throw bad('Unknown timezone');
  const mode = input.mode !== undefined && EVENT_MODES.some((m) => m.value === input.mode) ? String(input.mode) : event.mode;

  const theme = parseTheme(event.theme_json);
  if (input.theme) {
    if (input.theme.primary) theme.primary = normalizeHex(String(input.theme.primary));
    if (input.theme.font && FONT_PAIRINGS.some((fp) => fp.ui === input.theme!.font)) theme.font = String(input.theme.font);
    // Palette slots are stored only when explicitly overridden; null reverts to deriving from primary.
    for (const key of ['hover', 'border', 'tint'] as const) {
      const v = input.theme[key];
      if (v === null) delete theme[key];
      else if (typeof v === 'string' && v) theme[key] = normalizeHex(v);
    }
  }

  await run(
    env.DB,
    `UPDATE events SET name=?, slug=?, start_date=?, end_date=?, timezone=?, venue=?, mode=?, description=?, theme_json=? WHERE id=?`,
    name,
    slug,
    startDate,
    endDate,
    timezone,
    input.venue !== undefined ? String(input.venue ?? '').trim() || null : event.venue,
    mode,
    input.description !== undefined ? String(input.description ?? '').trim() || null : event.description,
    JSON.stringify(theme),
    event.id
  );
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: apiActor(auth),
    action: 'Event settings updated',
  });
  const fresh = (await one<Event>(env.DB, `SELECT * FROM events WHERE id = ?`, event.id))!;
  return {
    id: fresh.id,
    name: fresh.name,
    slug: fresh.slug,
    startDate: fresh.start_date,
    endDate: fresh.end_date,
    timezone: fresh.timezone,
    venue: fresh.venue,
    mode: fresh.mode,
    description: fresh.description,
    theme: parseTheme(fresh.theme_json),
    published: !!fresh.published,
  };
}

/* ------------------------------------------------------------------- rooms */

export type SaveRoomInput = { id?: string; name?: string; capacity?: number | null; priority?: number };

/** CREATE (no id) or UPDATE (id) a room. */
export async function saveRoom(env: Bindings, auth: ApiAuth, ref: string, input: SaveRoomInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const capacity = Number.parseInt(String(input.capacity ?? ''), 10);
  const priority = Number.parseInt(String(input.priority ?? ''), 10);

  if (input.id) {
    const room = await one<{ id: string; name: string; capacity: number | null; priority: number }>(
      env.DB,
      `SELECT * FROM rooms WHERE id = ? AND event_id = ?`,
      input.id,
      event.id
    );
    if (!room) throw notFound('Room not found');
    const name = (input.name ?? '').trim() || room.name;
    await run(
      env.DB,
      `UPDATE rooms SET name=?, capacity=?, priority=? WHERE id=? AND event_id=?`,
      name,
      input.capacity === undefined ? room.capacity : Number.isFinite(capacity) ? capacity : null,
      Number.isFinite(priority) ? priority : room.priority,
      room.id,
      event.id
    );
    await logActivity(env.DB, {
      eventId: event.id,
      subjectType: 'event',
      subjectId: event.id,
      actor: apiActor(auth),
      action: 'Room updated',
      detail: name,
    });
    return { id: room.id, name, updated: true };
  }

  const name = (input.name ?? '').trim();
  if (!name) throw bad('name is required');
  const id = newId('rom');
  await run(
    env.DB,
    `INSERT INTO rooms (id, event_id, name, capacity, priority) VALUES (?,?,?,?,?)`,
    id,
    event.id,
    name,
    Number.isFinite(capacity) ? capacity : null,
    Number.isFinite(priority) ? priority : 1
  );
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: apiActor(auth),
    action: 'Room added',
    detail: name,
  });
  return { id, name, created: true };
}

/** DELETE a room — sessions in it become room-less (never deleted). */
export async function deleteRoom(env: Bindings, auth: ApiAuth, ref: string, roomId: string) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const room = await one<{ name: string }>(env.DB, `SELECT name FROM rooms WHERE id = ? AND event_id = ?`, roomId, event.id);
  if (!room) throw notFound('Room not found');
  await run(env.DB, `UPDATE sessions SET room_id = NULL WHERE room_id = ?`, roomId);
  await run(env.DB, `DELETE FROM rooms WHERE id = ? AND event_id = ?`, roomId, event.id);
  return { id: roomId, name: room.name, deleted: true };
}

/* -------------------------------------------------------------- taxonomies */

export type CreateTaxonomyInput = { name?: string; hasColor?: boolean; hasDuration?: boolean };

export async function createTaxonomy(env: Bindings, auth: ApiAuth, ref: string, input: CreateTaxonomyInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const name = (input.name ?? '').trim();
  if (!name) throw bad('name is required');
  const count = await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM taxonomies WHERE event_id = ?`, event.id);
  const id = newId('tax');
  await run(
    env.DB,
    `INSERT INTO taxonomies (id, event_id, name, has_color, has_duration, position) VALUES (?,?,?,?,?,?)`,
    id,
    event.id,
    name,
    input.hasColor ? 1 : 0,
    input.hasDuration ? 1 : 0,
    count?.n ?? 0
  );
  return { id, name, hasColor: !!input.hasColor, hasDuration: !!input.hasDuration, created: true };
}

export type SaveTaxonomyOptionInput = {
  id?: string;
  taxonomyId?: string;
  name?: string;
  color?: string;
  duration?: number | null;
};

/**
 * CREATE (taxonomyId, no id) or UPDATE (id) a taxonomy option. Renames cascade
 * into form conditions and stored answers — options are referenced by label.
 */
export async function saveTaxonomyOption(env: Bindings, auth: ApiAuth, ref: string, input: SaveTaxonomyOptionInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const duration = Number.parseInt(String(input.duration ?? ''), 10);

  if (input.id) {
    const row = await one<{
      id: string;
      taxonomy_id: string;
      name: string;
      color: string | null;
      duration_min: number | null;
      has_color: number;
      has_duration: number;
      taxonomy: string;
    }>(
      env.DB,
      `SELECT o.*, t.has_color, t.has_duration, t.name AS taxonomy
         FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
        WHERE o.id = ? AND t.event_id = ?`,
      input.id,
      event.id
    );
    if (!row) throw notFound('Option not found');
    const name = (input.name ?? '').trim() || row.name;
    const nextDuration =
      row.has_duration && input.duration !== undefined
        ? Number.isFinite(duration)
          ? duration
          : null
        : row.duration_min;
    await run(
      env.DB,
      `UPDATE taxonomy_options SET name=?, color=?, duration_min=? WHERE id=?`,
      name,
      row.has_color && input.color ? normalizeHex(String(input.color)) : row.color,
      nextDuration,
      row.id
    );
    // Conditions and answers store the option's *label* — follow the rename so
    // "show if format is Workshop (90 min)" fields don't silently orphan.
    const oldLabel = optionLabel(row.name, row.duration_min);
    const newLabel = optionLabel(name, nextDuration);
    if (oldLabel !== newLabel) {
      await cascadeTaxonomyOptionRename(env.DB, event.id, { id: row.taxonomy_id, name: row.taxonomy }, oldLabel, newLabel);
    }
    return { id: row.id, taxonomyId: row.taxonomy_id, name, durationMin: nextDuration, updated: true, renamed: oldLabel !== newLabel };
  }

  const tax = await one<{ id: string; name: string; has_color: number; has_duration: number }>(
    env.DB,
    `SELECT * FROM taxonomies WHERE id = ? AND event_id = ?`,
    input.taxonomyId ?? '',
    event.id
  );
  if (!tax) throw bad('Pass taxonomyId (see get_event) to create, or id to update');
  const name = (input.name ?? '').trim();
  if (!name) throw bad('name is required');
  const count = await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM taxonomy_options WHERE taxonomy_id = ?`, tax.id);
  const id = newId('tpo');
  await run(
    env.DB,
    `INSERT INTO taxonomy_options (id, taxonomy_id, name, color, duration_min, position) VALUES (?,?,?,?,?,?)`,
    id,
    tax.id,
    name,
    tax.has_color ? normalizeHex(String(input.color ?? '#7048e8')) : null,
    tax.has_duration && Number.isFinite(duration) ? duration : null,
    count?.n ?? 0
  );
  return { id, taxonomyId: tax.id, name, created: true };
}

/** DELETE a taxonomy option — tagged sessions are untagged first, never deleted. */
export async function deleteTaxonomyOption(env: Bindings, auth: ApiAuth, ref: string, optionId: string) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const row = await one<{ id: string; name: string; taxonomy: string }>(
    env.DB,
    `SELECT o.id, o.name, t.name AS taxonomy
       FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
      WHERE o.id = ? AND t.event_id = ?`,
    optionId,
    event.id
  );
  if (!row) throw notFound('Option not found');
  await run(env.DB, `UPDATE sessions SET track_option_id = NULL WHERE track_option_id = ?`, optionId);
  await run(env.DB, `UPDATE sessions SET format_option_id = NULL WHERE format_option_id = ?`, optionId);
  await run(env.DB, `DELETE FROM taxonomy_options WHERE id = ?`, optionId);
  return { id: row.id, name: row.name, taxonomy: row.taxonomy, deleted: true };
}

/* ----------------------------------------------------------------- agenda */

/** PUBLISH the agenda (bumps the public revision; also how edits go live). */
export async function publishAgenda(env: Bindings, auth: ApiAuth, ref: string) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const stamp = now();
  await run(
    env.DB,
    `UPDATE events SET published = 1, published_rev = published_rev + 1, published_at = ? WHERE id = ?`,
    stamp,
    event.id
  );
  const fresh = await one<{ published_rev: number }>(env.DB, `SELECT published_rev FROM events WHERE id = ?`, event.id);
  const rev = fresh?.published_rev ?? 0;
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: apiActor(auth),
    action: 'Published agenda',
    detail: `Revision ${rev}`,
  });
  // Best-effort purge of the previous revision's cached responses.
  try {
    const cache = (caches as unknown as { default?: Cache }).default;
    if (cache) {
      const base = `${env.APP_ORIGIN}/${event.slug}/agenda`;
      await Promise.all([cache.delete(`${base}?__rev=${rev - 1}`), cache.delete(`${base}.json?__rev=${rev - 1}`)]);
    }
  } catch {
    /* Cache API unavailable (some local modes) — the rev key already isolates us. */
  }
  return { published: true, publishedRev: rev, publishedAt: stamp, url: `${env.APP_ORIGIN}/${event.slug}/agenda` };
}

/**
 * AUTO-SCHEDULE the unscheduled bin — deterministic greedy fill. Only adds
 * (placed sessions keep their slots); deliberately sends NO schedule emails,
 * unlike a manual move: the result is a reviewable draft.
 */
export async function autoScheduleApi(env: Bindings, auth: ApiAuth, ref: string) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const bundle = await loadAgenda(env.DB, event.id);
  const days = eventDays(event);
  const { placements, skipped } = autoSchedule(bundle, {
    days: days.length,
    dayStart: event.day_start_min,
    dayEnd: event.day_end_min,
  });

  if (placements.length) {
    const stamp = now();
    await batch(
      env.DB,
      placements.map((pl) => [
        `UPDATE sessions SET day = ?, start_min = ?, end_min = ?, duration_min = ?, room_id = ?, all_rooms = 0,
           ics_sequence = ics_sequence + 1, updated_at = ? WHERE id = ? AND event_id = ?`,
        [pl.day, pl.start, pl.end, pl.end - pl.start, pl.roomId, stamp, pl.id, event.id],
      ])
    );
    await logActivity(env.DB, {
      eventId: event.id,
      subjectType: 'event',
      subjectId: event.id,
      actor: apiActor(auth),
      action: 'Auto-scheduled the bin',
      detail: placements
        .map((pl) => `${pl.title} → ${days[pl.day]?.label ?? `Day ${pl.day + 1}`} ${fmtTime(pl.start)} · ${pl.roomName}`)
        .join('; '),
    });
  }

  return {
    placed: placements.map((pl) => ({
      id: pl.id,
      title: pl.title,
      day: pl.day,
      start: fmtTime(pl.start),
      end: fmtTime(pl.end),
      startMin: pl.start,
      endMin: pl.end,
      roomId: pl.roomId,
      room: pl.roomName,
      overBand: pl.over,
    })),
    skipped,
  };
}

function sessionConflicts(bundle: AgendaBundle, event: Event, sessionId: string): string[] {
  const target = bundle.sessions.find((s) => s.id === sessionId);
  if (!target) return [];
  const placed = bundle.sessions.filter((s) => s.day !== null && s.start_min !== null).map((s) => conflictItem(s, bundle));
  return conflictMessages(conflictItem(target, bundle), placed, {
    dayEnd: event.day_end_min,
    roomName: roomNamer(bundle),
    speakerName: speakerNamer(bundle),
  });
}

/** Schedule conflicts — one session's messages, or every conflicted session on the grid. */
export async function getScheduleConflicts(env: Bindings, auth: ApiAuth, ref: string, sessionId?: string) {
  const event = await resolveEvent(env, auth, ref);
  const bundle = await loadAgenda(env.DB, event.id);
  if (sessionId) {
    const target = bundle.sessions.find((s) => s.id === sessionId);
    if (!target) throw notFound('Session not found');
    return [{ sessionId, title: target.title, conflicts: sessionConflicts(bundle, event, sessionId) }];
  }
  const ids = conflictIds(bundle, event.day_end_min);
  return [...ids].map((id) => ({
    sessionId: id,
    title: bundle.sessions.find((s) => s.id === id)?.title ?? null,
    conflicts: sessionConflicts(bundle, event, id),
  }));
}

/** DELETE a sponsor/service session — talks come from submissions and can only be unscheduled. */
export async function deleteSession(env: Bindings, auth: ApiAuth, id: string) {
  requireWrite(auth);
  const cur = await one<{ id: string; event_id: string; type: string; title: string }>(
    env.DB,
    `SELECT id, event_id, type, title FROM sessions WHERE id = ?`,
    (id ?? '').trim()
  );
  if (!cur) throw notFound('Session not found');
  const event = await eventOf(env, auth, cur.event_id);
  if (cur.type === 'talk') throw bad('Talks come from submissions — unschedule it instead of deleting');
  await run(env.DB, `DELETE FROM session_speakers WHERE session_id = ?`, cur.id);
  await run(env.DB, `DELETE FROM sessions WHERE id = ?`, cur.id);
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: cur.id,
    actor: apiActor(auth),
    action: 'Deleted',
    detail: cur.title,
  });
  return { id: cur.id, title: cur.title, deleted: true };
}

/* --------------------------------------------------------------- activity */

export type ActivityQuery = {
  subjectType?: string;
  subjectId?: string;
  limit?: string | number;
  cursor?: string;
};

/** The event activity feed — every logged action, newest first. */
export async function listActivity(env: Bindings, auth: ApiAuth, ref: string, query: ActivityQuery = {}) {
  const event = await resolveEvent(env, auth, ref);
  const limit = clampLimit(query.limit);
  const conds = ['event_id = ?'];
  const params: unknown[] = [event.id];
  if (query.subjectType) {
    conds.push('subject_type = ?');
    params.push(query.subjectType);
  }
  if (query.subjectId) {
    conds.push('subject_id = ?');
    params.push(query.subjectId);
  }
  if (query.cursor) {
    const [key, id] = decodeCursor(query.cursor);
    conds.push('(created_at < ? OR (created_at = ? AND id > ?))');
    params.push(key, key, id);
  }
  const rows = await all<{
    id: string;
    subject_type: string;
    subject_id: string;
    actor: string;
    action: string;
    detail: string | null;
    created_at: string;
  }>(
    env.DB,
    `SELECT id, subject_type, subject_id, actor, action, detail, created_at
       FROM activity WHERE ${conds.join(' AND ')}
      ORDER BY created_at DESC, id ASC LIMIT ?`,
    ...params,
    limit + 1
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      actor: r.actor,
      action: r.action,
      detail: r.detail,
      createdAt: r.created_at,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/* -------------------------------------------------------------- REST routes */

export function registerEventAdminRoutes(app: Hono<ApiCtx>): void {
  app.post('/api/v1/events', handle(async (c) => createEventApi(c.env, c.var.apiAuth, await jsonBody(c))));
  app.patch('/api/v1/events/:event', handle(async (c) => updateEvent(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c))));
  app.post('/api/v1/events/:event/rooms', handle(async (c) => saveRoom(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c))));
  app.delete('/api/v1/events/:event/rooms/:id', handle((c) => deleteRoom(c.env, c.var.apiAuth, p(c, 'event'), p(c, 'id'))));
  app.post(
    '/api/v1/events/:event/taxonomies',
    handle(async (c) => createTaxonomy(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.post(
    '/api/v1/events/:event/taxonomy-options',
    handle(async (c) => saveTaxonomyOption(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.delete(
    '/api/v1/events/:event/taxonomy-options/:id',
    handle((c) => deleteTaxonomyOption(c.env, c.var.apiAuth, p(c, 'event'), p(c, 'id')))
  );
  app.post('/api/v1/events/:event/agenda/publish', handle((c) => publishAgenda(c.env, c.var.apiAuth, p(c, 'event'))));
  app.post('/api/v1/events/:event/agenda/autoschedule', handle((c) => autoScheduleApi(c.env, c.var.apiAuth, p(c, 'event'))));
  app.get(
    '/api/v1/events/:event/agenda/conflicts',
    handle((c) => getScheduleConflicts(c.env, c.var.apiAuth, p(c, 'event'), c.req.query('session')))
  );
  app.delete('/api/v1/sessions/:id', handle((c) => deleteSession(c.env, c.var.apiAuth, p(c, 'id'))));
  app.get(
    '/api/v1/events/:event/activity',
    handle((c) =>
      listActivity(c.env, c.var.apiAuth, p(c, 'event'), {
        subjectType: c.req.query('subjectType'),
        subjectId: c.req.query('subjectId'),
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
      })
    )
  );
}

/* --------------------------------------------------------------- MCP tools */

export const EVENT_ADMIN_TOOLS: Tool[] = [
  {
    name: 'create_event',
    description:
      'CREATE an event with the standard defaults stamped in: a Main Stage room, Track/Format/Level taxonomies, and the 7 seed email templates. Starts unpublished. Org-wide tokens only. Activity-logged, sends no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        slug: { type: 'string', description: 'URL slug; derived from the name when omitted.' },
        startDate: { type: 'string', description: 'YYYY-MM-DD.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD; defaults to startDate.' },
        timezone: { type: 'string', description: 'IANA timezone, e.g. Europe/Berlin. Default UTC.' },
        venue: { type: 'string' },
        mode: { type: 'string', enum: ['in_person', 'online', 'hybrid'] },
        description: { type: 'string' },
      },
      required: ['name', 'startDate'],
      additionalProperties: false,
    },
    run: (env, auth, a) => createEventApi(env, auth, a as CreateEventInput),
  },
  {
    name: 'update_event',
    description:
      'UPDATE event settings: name, slug, dates, timezone, venue, mode, description, and/or theme ({primary: "#rrggbb", font, hover/border/tint — null reverts a slot to deriving from primary}). Renaming can change the slug and thus every public URL. Activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        name: { type: 'string' },
        slug: { type: 'string' },
        startDate: { type: 'string', description: 'YYYY-MM-DD.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD.' },
        timezone: { type: 'string' },
        venue: { type: ['string', 'null'] },
        mode: { type: 'string', enum: ['in_person', 'online', 'hybrid'] },
        description: { type: ['string', 'null'] },
        theme: { type: 'object', description: '{primary, font, hover, border, tint} — see description.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => updateEvent(env, auth, str(a.event), a as UpdateEventInput),
  },
  {
    name: 'save_room',
    description: 'CREATE (no id) or UPDATE (id) a room: name, capacity, priority (scheduling order). Activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        id: { type: 'string', description: 'Room id (rom_…) to update; omit to create.' },
        name: { type: 'string' },
        capacity: { type: ['integer', 'null'] },
        priority: { type: 'integer', description: 'Lower = earlier on the grid and in auto-scheduling.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => saveRoom(env, auth, str(a.event), a as SaveRoomInput),
  },
  {
    name: 'delete_room',
    description: 'DELETE a room. Sessions scheduled in it keep their slot but lose the room assignment.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { event: EVENT_PROP, id: { type: 'string', description: 'Room id (rom_…).' } },
      required: ['event', 'id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => deleteRoom(env, auth, str(a.event), str(a.id)),
  },
  {
    name: 'create_taxonomy',
    description: 'CREATE a taxonomy (a labeled option set like Track/Format/Level). hasColor adds a color per option, hasDuration a session length.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        name: { type: 'string' },
        hasColor: { type: 'boolean' },
        hasDuration: { type: 'boolean' },
      },
      required: ['event', 'name'],
      additionalProperties: false,
    },
    run: (env, auth, a) => createTaxonomy(env, auth, str(a.event), a as CreateTaxonomyInput),
  },
  {
    name: 'save_taxonomy_option',
    description:
      'CREATE (taxonomyId, no id) or UPDATE (id) a taxonomy option. Renaming CASCADES: form conditions and stored answers referencing the old label (“Workshop (90 min)”) are rewritten across every form version and submission. Sessions tagged with the option follow by id automatically.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        id: { type: 'string', description: 'Option id (tpo_…) to update; omit to create.' },
        taxonomyId: { type: 'string', description: 'Parent taxonomy (tax_…) — create only.' },
        name: { type: 'string' },
        color: { type: 'string', description: '#rrggbb — only on taxonomies with colors.' },
        duration: { type: ['integer', 'null'], description: 'Minutes — only on taxonomies with durations.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => saveTaxonomyOption(env, auth, str(a.event), a as SaveTaxonomyOptionInput),
  },
  {
    name: 'delete_taxonomy_option',
    description: 'DELETE a taxonomy option — sessions tagged with it are untagged first, never deleted.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { event: EVENT_PROP, id: { type: 'string', description: 'Option id (tpo_…).' } },
      required: ['event', 'id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => deleteTaxonomyOption(env, auth, str(a.event), str(a.id)),
  },
  {
    name: 'publish_agenda',
    description:
      'PUBLISH the agenda — makes the public agenda pages, feeds and embeds live (or pushes pending edits live) and bumps the published revision. There is no unpublish. Activity-logged; sends no email.',
    write: true,
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => publishAgenda(env, auth, str(a.event)),
  },
  {
    name: 'auto_schedule',
    description:
      'AUTO-SCHEDULE the unscheduled bin — deterministic greedy fill honoring rooms, durations and speaker conflicts. Only adds; already-placed sessions never move. Sessions placed across a soft band (lunch) are flagged via overBand; service/all-room blocks are skipped as manual-only. Deliberately sends NO schedule emails — review, adjust, then publish. Undo = unschedule the returned ids.',
    write: true,
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => autoScheduleApi(env, auth, str(a.event)),
  },
  {
    name: 'get_schedule_conflicts',
    description:
      'Schedule conflicts on the agenda grid: double-booked rooms, speakers in two places, sessions past the day end. Pass session for one session’s messages, omit for every conflicted session. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { event: EVENT_PROP, session: { type: 'string', description: 'Session id (ses_…), optional.' } },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => getScheduleConflicts(env, auth, str(a.event), a.session === undefined ? undefined : str(a.session)),
  },
  {
    name: 'delete_session',
    description:
      'DELETE a sponsor or service session. Talk sessions cannot be deleted (they come from submissions) — unschedule or unpublish them instead. Activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Session id (ses_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => deleteSession(env, auth, str(a.id)),
  },
  {
    name: 'list_activity',
    description:
      'The event activity feed — every logged action (decisions, emails, schedule moves, edits) with actor, action, detail. Filters: subjectType (submission|session|speaker|task|event|form|plan), subjectId. Cursor-paginated, newest first. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        subjectType: { type: 'string' },
        subjectId: { type: 'string' },
        limit: { type: 'integer', description: 'Page size, default 100, max 500.' },
        cursor: { type: 'string' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) =>
      listActivity(env, auth, str(a.event), {
        subjectType: a.subjectType === undefined ? undefined : str(a.subjectType),
        subjectId: a.subjectId === undefined ? undefined : str(a.subjectId),
        limit: a.limit as number | undefined,
        cursor: a.cursor === undefined ? undefined : str(a.cursor),
      }),
  },
];
