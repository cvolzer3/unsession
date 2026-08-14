/**
 * API domain: embeds (spec C parity round 2).
 *
 * The website-integration widgets: list an event's saved embeds with their
 * copy-paste snippets and feed URLs, create/toggle/delete them — same
 * validation and snippet builder as the admin Embeds page.
 */
import type { Hono } from 'hono';
import type { Bindings, Event } from '../types';
import { apiActor, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import {
  bad,
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
import { all, jsonCol, jsonParse, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { embedUrl, FIELD_KEYS, formatLabel, FORMATS, snippetFor, WIDGET_TYPES, widgetLabel } from './admin-embeds';
import type { EmbedConfig, EmbedRow } from './public-embed';

const WIDGET_KEYS = new Set(WIDGET_TYPES.map((w) => w.key as string));
const FORMAT_KEYS = new Set(FORMATS.map((f) => f.key as string));

function shapeEmbed(env: Bindings, event: Event, row: EmbedRow) {
  return {
    id: row.id,
    name: row.name,
    widget: row.widget,
    format: row.format,
    enabled: !!row.enabled,
    config: jsonParse<EmbedConfig>(row.config_json ?? '{}', {}),
    url: embedUrl(env.APP_ORIGIN, event, row.widget, row.format, row.id),
    snippet: snippetFor(env.APP_ORIGIN, event, row),
    updatedAt: row.updated_at,
  };
}

async function embedByRef(env: Bindings, auth: ApiAuth, id: string): Promise<{ row: EmbedRow; event: Event }> {
  const row = await one<EmbedRow>(env.DB, `SELECT * FROM embeds WHERE id = ?`, (id ?? '').trim());
  if (!row) throw notFound('Embed not found');
  const event = await eventOf(env, auth, row.event_id);
  return { row, event };
}

/* -------------------------------------------------------------------- read */

/** Saved embeds with their snippets, plus the widget/format catalog for creating new ones. */
export async function listEmbeds(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  const rows = await all<EmbedRow>(env.DB, `SELECT * FROM embeds WHERE event_id = ? ORDER BY created_at DESC`, event.id);
  return {
    embeds: rows.map((row) => shapeEmbed(env, event, row)),
    widgets: WIDGET_TYPES.map((w) => ({
      key: w.key,
      label: w.label,
      blurb: w.blurb,
      hideableFields: (FIELD_KEYS[w.key] ?? []).map((f) => f.key),
    })),
    formats: FORMATS.map((f) => ({ key: f.key, label: f.label, blurb: f.blurb })),
  };
}

/* ------------------------------------------------------------------- write */

export type CreateEmbedInput = {
  name?: string;
  widget?: string;
  format?: string;
  config?: EmbedConfig;
};

export async function createEmbed(env: Bindings, auth: ApiAuth, ref: string, input: CreateEmbedInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const widget = String(input.widget ?? '');
  const format = String(input.format ?? '');
  if (!WIDGET_KEYS.has(widget)) throw bad(`widget must be one of ${[...WIDGET_KEYS].join(', ')}`);
  if (!FORMAT_KEYS.has(format)) throw bad(`format must be one of ${[...FORMAT_KEYS].join(', ')}`);

  const cfg = input.config ?? {};
  const allowedFields = new Set((FIELD_KEYS[widget] ?? []).map((f) => f.key));
  const config: EmbedConfig = {
    transparent: !!cfg.transparent,
    accent: typeof cfg.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(cfg.accent) ? cfg.accent : null,
    tracks: Array.isArray(cfg.tracks) ? cfg.tracks.filter((t) => typeof t === 'string').slice(0, 50) : [],
    hide: Array.isArray(cfg.hide) ? cfg.hide.filter((h) => allowedFields.has(String(h))) : [],
  };

  const name = String(input.name ?? '').trim() || `${widgetLabel(widget)} — ${formatLabel(format)}`;
  const id = newId('emb');
  const stamp = now();
  await run(
    env.DB,
    `INSERT INTO embeds (id, event_id, name, widget, format, config_json, enabled, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,1,?,?,?)`,
    id,
    event.id,
    name,
    widget,
    format,
    jsonCol(config),
    apiActor(auth),
    stamp,
    stamp
  );
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: apiActor(auth),
    action: 'Embed created',
    detail: `${name} · ${widgetLabel(widget)} · ${formatLabel(format)}`,
  });
  const row = (await one<EmbedRow>(env.DB, `SELECT * FROM embeds WHERE id = ?`, id))!;
  return shapeEmbed(env, event, row);
}

export async function toggleEmbed(env: Bindings, auth: ApiAuth, id: string, enabled: boolean) {
  requireWrite(auth);
  const { row, event } = await embedByRef(env, auth, id);
  await run(env.DB, `UPDATE embeds SET enabled = ?, updated_at = ? WHERE id = ?`, enabled ? 1 : 0, now(), row.id);
  const fresh = (await one<EmbedRow>(env.DB, `SELECT * FROM embeds WHERE id = ?`, row.id))!;
  return shapeEmbed(env, event, fresh);
}

export async function deleteEmbed(env: Bindings, auth: ApiAuth, id: string) {
  requireWrite(auth);
  const { row, event } = await embedByRef(env, auth, id);
  await run(env.DB, `DELETE FROM embeds WHERE id = ?`, row.id);
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: apiActor(auth),
    action: 'Embed deleted',
    detail: row.name,
  });
  return { id: row.id, name: row.name, deleted: true };
}

/* -------------------------------------------------------------- REST routes */

export function registerEmbedRoutes(app: Hono<ApiCtx>): void {
  app.get('/api/v1/events/:event/embeds', handle((c) => listEmbeds(c.env, c.var.apiAuth, p(c, 'event'))));
  app.post(
    '/api/v1/events/:event/embeds',
    handle(async (c) => createEmbed(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.patch(
    '/api/v1/embeds/:id',
    handle(async (c) => {
      const body = await jsonBody<{ enabled?: boolean }>(c);
      if (typeof body.enabled !== 'boolean') throw bad('Pass enabled: true|false');
      return toggleEmbed(c.env, c.var.apiAuth, p(c, 'id'), body.enabled);
    })
  );
  app.delete('/api/v1/embeds/:id', handle((c) => deleteEmbed(c.env, c.var.apiAuth, p(c, 'id'))));
}

/* --------------------------------------------------------------- MCP tools */

export const EMBED_TOOLS: Tool[] = [
  {
    name: 'list_embeds',
    description:
      'List an event’s website embeds/widgets with their copy-paste snippet and live URL, plus the catalog of widget types (sessions, speakers, agenda, itinerary, gallery) and output formats (styled, basic, json, xml, ical). Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => listEmbeds(env, auth, str(a.event)),
  },
  {
    name: 'create_embed',
    description:
      'CREATE an embed and get its snippet/URL back. Widgets serve only the published agenda. Config: transparent background, #rrggbb accent override, track option ids to keep, card fields to hide (see list_embeds → widgets.hideableFields). Activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        name: { type: 'string', description: 'Defaults to “Widget — Format”.' },
        widget: { type: 'string', enum: ['sessions', 'speakers', 'agenda', 'itinerary', 'gallery'] },
        format: { type: 'string', enum: ['styled', 'basic', 'json', 'xml', 'ical'] },
        config: {
          type: 'object',
          properties: {
            transparent: { type: 'boolean' },
            accent: { type: ['string', 'null'], description: '#rrggbb accent override.' },
            tracks: { type: 'array', items: { type: 'string' }, description: 'Track option ids to keep; empty = all.' },
            hide: { type: 'array', items: { type: 'string' }, description: 'Card field keys to hide.' },
          },
          additionalProperties: false,
        },
      },
      required: ['event', 'widget', 'format'],
      additionalProperties: false,
    },
    run: (env, auth, a) => createEmbed(env, auth, str(a.event), a as CreateEmbedInput),
  },
  {
    name: 'toggle_embed',
    description: 'ENABLE or DISABLE an embed. Disabled embeds 404 on their public URL but keep their configuration.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Embed id (emb_…).' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'enabled'],
      additionalProperties: false,
    },
    run: (env, auth, a) => toggleEmbed(env, auth, str(a.id), a.enabled === true),
  },
  {
    name: 'delete_embed',
    description: 'DELETE an embed — its public URL stops working immediately. Activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Embed id (emb_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => deleteEmbed(env, auth, str(a.id)),
  },
];
