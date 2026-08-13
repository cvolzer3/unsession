/**
 * API tokens (spec C) — mint / hash / verify / Bearer middleware.
 *
 * Secrets look like `uns_<40 base36 chars>` and are returned exactly once, at
 * creation; the DB keeps only the SHA-256 (same hashing as magic links and
 * cookie sessions — `auth.hashToken`). The middleware attaches `c.var.apiAuth`
 * ({ org, scopes, optional event restriction }) and bumps `last_used_at`
 * fire-and-forget. 401 for unknown/revoked/expired tokens — carrying the
 * RFC 9728 `WWW-Authenticate: Bearer resource_metadata="…"` pointer that
 * starts the OAuth discovery dance (routes/oauth.tsx) — while scope and event
 * mismatches stay the route layer's business (403 / 404).
 *
 * OAuth-minted tokens are the same rows with `oauth_client_id` set: their
 * access secret expires (`expires_at`) and their `refresh_token_hash` rotates
 * on every refresh grant. UI-minted tokens never expire.
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
  /** Set on OAuth-minted rows (routes/oauth.tsx); NULL on UI-minted tokens. */
  oauth_client_id: string | null;
  expires_at: string | null;
  refresh_token_hash: string | null;
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

/** `<prefix>` + 40 base36 chars (~206 bits of entropy). `uns_` access, `unsr_` refresh. */
export function mintSecret(prefix = 'uns_'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(40));
  let body = '';
  for (const b of bytes) body += ALPHABET[b % 36];
  return `${prefix}${body}`;
}

export async function createApiToken(
  env: Bindings,
  input: {
    orgId: string;
    name: string;
    scopes: ApiScope;
    eventId?: string | null;
    createdBy: string;
    oauth?: { clientId: string; expiresAt: string; refreshTokenHash: string };
  }
): Promise<{ id: string; secret: string }> {
  const secret = mintSecret();
  const id = newId('atk');
  await run(
    env.DB,
    `INSERT INTO api_tokens (id, org_id, name, token_hash, scopes, event_id, created_by, created_at, last_used_at, revoked_at, oauth_client_id, expires_at, refresh_token_hash)
     VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)`,
    id,
    input.orgId,
    input.name,
    await hashToken(secret),
    input.scopes,
    input.eventId ?? null,
    input.createdBy,
    now(),
    input.oauth?.clientId ?? null,
    input.oauth?.expiresAt ?? null,
    input.oauth?.refreshTokenHash ?? null
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
  const meta = `resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource"`;
  if (!m) {
    c.header('WWW-Authenticate', `Bearer ${meta}`);
    return c.json(
      { ok: false, error: 'Missing bearer token — send "Authorization: Bearer uns_…" (create one at /app/api)' },
      401
    );
  }
  const row = await verifyApiToken(c.env, m[1]);
  if (!row) {
    c.header('WWW-Authenticate', `Bearer error="invalid_token", ${meta}`);
    return c.json({ ok: false, error: 'Unknown API token' }, 401);
  }
  if (row.revoked_at) {
    c.header('WWW-Authenticate', `Bearer error="invalid_token", ${meta}`);
    return c.json({ ok: false, error: 'This API token has been revoked' }, 401);
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    c.header('WWW-Authenticate', `Bearer error="invalid_token", ${meta}`);
    return c.json(
      { ok: false, error: 'This access token has expired — use the refresh token (grant_type=refresh_token) or reconnect' },
      401
    );
  }

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
