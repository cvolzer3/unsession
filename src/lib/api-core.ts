/**
 * Shared plumbing for the public API surface (spec C) — used by
 * `routes/api.tsx`, the `routes/api-*.ts` domain modules and `routes/mcp.ts`.
 *
 * Extracted so the domain modules can share errors, event scoping, paging and
 * the MCP Tool shape without importing the REST router (which imports them —
 * a cycle the Workers bundle must never see at module-init time).
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Bindings, Event } from '../types';
import { canWrite, type ApiAuth, type ApiCtx } from './api-tokens';
import { one } from './db';

/* ------------------------------------------------------------------ errors */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export const bad = (msg: string) => new ApiError(400, msg);
export const notFound = (msg = 'Not found') => new ApiError(404, msg);

export function requireWrite(auth: ApiAuth): void {
  if (!canWrite(auth)) {
    throw new ApiError(
      403,
      "This token is read-only (scope 'read') — create a token with the read,write scope at /app/api"
    );
  }
}

/* ----------------------------------------------------------- event scoping */

/** Resolve `:event` (slug or id) inside the token's org + event restriction. */
export async function resolveEvent(env: Bindings, auth: ApiAuth, ref: string): Promise<Event> {
  const r = (ref ?? '').trim();
  if (!r) throw bad('Missing event — pass an event slug or id');
  const event = await one<Event>(
    env.DB,
    `SELECT * FROM events WHERE org_id = ? AND (id = ? OR slug = ?)`,
    auth.orgId,
    r,
    r
  );
  if (!event || (auth.eventId && event.id !== auth.eventId)) throw notFound('Event not found');
  return event;
}

/** Scope check for rows reached by id (submission/session/speaker/task/…). */
export async function eventOf(env: Bindings, auth: ApiAuth, eventId: string): Promise<Event> {
  const event = await one<Event>(env.DB, `SELECT * FROM events WHERE id = ? AND org_id = ?`, eventId, auth.orgId);
  if (!event || (auth.eventId && event.id !== auth.eventId)) throw notFound('Not found');
  return event;
}

/* ------------------------------------------------------------------ paging */

/** Opaque keyset cursor: base64 of [sortKey, id]. */
export function encodeCursor(sortKey: string, id: string): string {
  return btoa(JSON.stringify([sortKey, id]));
}

export function decodeCursor(raw: string): [string, string] {
  try {
    const v = JSON.parse(atob(raw)) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    /* fall through */
  }
  throw bad('Bad cursor — pass the nextCursor value from the previous page');
}

export function clampLimit(raw: string | number | undefined, fallback = 100, max = 500): number {
  const n = Math.round(Number(raw ?? fallback));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/* ------------------------------------------------------------ route shells */

/** try/catch shell: ApiError → its status, anything else → 500. */
export function handle(fn: (c: Context<ApiCtx>) => Promise<unknown>) {
  return async (c: Context<ApiCtx>) => {
    try {
      return c.json({ ok: true, data: await fn(c) });
    } catch (err) {
      if (err instanceof ApiError) return c.json({ ok: false, error: err.message }, err.status as ContentfulStatusCode);
      console.error('[api]', err);
      return c.json({ ok: false, error: 'Something went wrong' }, 500);
    }
  };
}

export async function jsonBody<TBody>(c: Context<ApiCtx>): Promise<TBody> {
  try {
    return await c.req.json<TBody>();
  } catch {
    throw bad('Body must be JSON');
  }
}

/** Route param — the `handle` wrapper erases Hono's path typing, so read it loosely. */
export function p(c: Context<ApiCtx>, name: string): string {
  return c.req.param(name) ?? '';
}

/* ------------------------------------------------------------------- tools */

export type ToolArgs = Record<string, unknown>;

/** One MCP tool — the domain modules export arrays of these; mcp.ts concatenates. */
export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True = omitted from tools/list for read-only tokens. */
  write?: boolean;
  run: (env: Bindings, auth: ApiAuth, args: ToolArgs) => Promise<unknown>;
};

export const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export const optStr = (v: unknown): string | undefined => (v === undefined ? undefined : str(v));

export const EVENT_PROP = { type: 'string', description: 'Event slug or id (see list_events).' };
