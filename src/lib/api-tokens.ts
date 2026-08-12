/**
 * API tokens (spec C) — mint / hash / verify / Bearer middleware.
 *
 * Secrets look like `uns_<40 base36 chars>` and are returned exactly once, at
 * creation; the DB keeps only the SHA-256 (same hashing as magic links and
 * cookie sessions — `auth.hashToken`). The middleware attaches `c.var.apiAuth`
 * ({ org, scopes, optional event restriction }) and bumps `last_used_at`
 * fire-and-forget. 401 for unknown/revoked tokens; scope and event mismatches
 * are the route layer's business (403 / 404).
 */
import type { MiddlewareHandler } from 'hono';
import { hashToken } from './auth';
import { newId } from './ids';
import { now, one, run } from './db';
import type { Bindings } from '../types';

export type ApiScope = 'read' | 'read,write';

export type ApiTokenRow = {
  id: string;
  org_id: string;
  name: string;
  token_hash: string;
  scopes: string;
  event_id: string | null;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** What every authenticated /api request carries. */
export type ApiAuth = {
  tokenId: string;
  /** Activity rows for API writes use `api:<token name>` as the actor. */
  tokenName: string;
  orgId: string;
  scopes: ApiScope;
  /** Non-null = the token only sees this event; everything else 404s. */
  eventId: string | null;
};

/** Hono env for the /api routers — Bearer auth only, no cookie session. */
export type ApiCtx = { Bindings: Bindings; Variables: { apiAuth: ApiAuth } };

export function apiActor(auth: ApiAuth): string {
  return `api:${auth.tokenName}`;
}

export function canWrite(auth: ApiAuth): boolean {
  return auth.scopes.split(',').includes('write');
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** `uns_` + 40 base36 chars (~206 bits of entropy). */
export function mintSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(40));
  let body = '';
  for (const b of bytes) body += ALPHABET[b % 36];
  return `uns_${body}`;
}

export async function createApiToken(
  env: Bindings,
  input: { orgId: string; name: string; scopes: ApiScope; eventId?: string | null; createdBy: string }
): Promise<{ id: string; secret: string }> {
  const secret = mintSecret();
  const id = newId('atk');
  await run(
    env.DB,
    `INSERT INTO api_tokens (id, org_id, name, token_hash, scopes, event_id, created_by, created_at, last_used_at, revoked_at)
     VALUES (?,?,?,?,?,?,?,?,NULL,NULL)`,
    id,
    input.orgId,
    input.name,
    await hashToken(secret),
    input.scopes,
    input.eventId ?? null,
    input.createdBy,
    now()
  );
  return { id, secret };
}

/** Hash lookup. Returns the row even when revoked — the caller decides the 401 copy. */
export async function verifyApiToken(env: Bindings, secret: string): Promise<ApiTokenRow | null> {
  if (!secret) return null;
  return one<ApiTokenRow>(env.DB, `SELECT * FROM api_tokens WHERE token_hash = ?`, await hashToken(secret));
}

/**
 * `Authorization: Bearer uns_…` → `c.var.apiAuth`. Shared by the REST router
 * and the MCP endpoint. Deliberately independent of the cookie-session
 * middleware — /api requests never touch `getSession`.
 */
export const apiTokenAuth: MiddlewareHandler<ApiCtx> = async (c, next) => {
  const header = (c.req.header('authorization') ?? '').trim();
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) {
    return c.json(
      { ok: false, error: 'Missing bearer token — send "Authorization: Bearer uns_…" (create one at /app/api)' },
      401
    );
  }
  const row = await verifyApiToken(c.env, m[1]);
  if (!row) return c.json({ ok: false, error: 'Unknown API token' }, 401);
  if (row.revoked_at) return c.json({ ok: false, error: 'This API token has been revoked' }, 401);

  c.set('apiAuth', {
    tokenId: row.id,
    tokenName: row.name,
    orgId: row.org_id,
    scopes: row.scopes === 'read,write' ? 'read,write' : 'read',
    eventId: row.event_id,
  });

  const bump = run(c.env.DB, `UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, now(), row.id).catch(() => {});
  try {
    c.executionCtx.waitUntil(bump);
  } catch {
    await bump; // no waitUntil in some local modes — settle inline
  }

  return next();
};
