/**
 * OAuth 2.1 authorization server + Dynamic Client Registration for the MCP
 * endpoint (spec C addendum, DECISIONS D15).
 *
 * MCP clients discover us through RFC 9728 protected-resource metadata (the
 * 401s from `apiTokenAuth` carry the pointer), register with RFC 7591 DCR —
 * public clients, PKCE S256 only, no client secrets — and send a human through
 * `/oauth/authorize`. Consent rides the normal password session: the signed-in
 * user picks a workspace they admin (sandbox orgs excluded, same rule as
 * /app/api) and a scope, and approval mints an ordinary `api_tokens` row with
 * `oauth_client_id` set, a 1-hour access secret and a rotating refresh token.
 * Bearer auth, the /app/api token list and Revoke are untouched — revoking the
 * row kills both secrets.
 *
 * Reserves the `/oauth` and `/.well-known` path roots (like /docs and /mcp,
 * they can never be event slugs).
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { Ctx, Org, Role, User } from '../types';
import { MONO } from '../views/layout';
import { Shell } from './auth';
import { hashToken, randomToken, requireUser } from '../lib/auth';
import { createApiToken, mintSecret, type ApiScope, type ApiTokenRow } from '../lib/api-tokens';
import { all, jsonParse, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';

const app = new Hono<Ctx>();

const CODE_MINUTES = 10;
const ACCESS_TOKEN_SECONDS = 3600;
/** External (space-delimited) scope tokens; internally they collapse to ApiScope. */
const SUPPORTED_SCOPES = ['read', 'write'];

type OAuthClientRow = {
  id: string;
  name: string;
  redirect_uris_json: string;
  created_at: string;
  last_used_at: string | null;
};

type OAuthCodeRow = {
  id: string;
  code_hash: string;
  client_id: string;
  user_id: string;
  org_id: string;
  scopes: string;
  redirect_uri: string;
  code_challenge: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

/* ------------------------------------------------------------------ helpers */

function origin(c: Context<Ctx>): string {
  return new URL(c.req.url).origin;
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** base64url(SHA-256(verifier)) — the PKCE S256 transform. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PKCE_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * https everywhere; http only on loopback; native-app custom schemes
 * (cursor://…, vscode://…) allowed per RFC 8252 §7.1. Never a fragment.
 */
function validRedirectUri(s: unknown): s is string {
  if (typeof s !== 'string' || !s || s.length > 500) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return !['javascript:', 'data:', 'file:', 'blob:', 'about:', 'vbscript:'].includes(u.protocol);
}

/** 'read write' → 'read,write'; unknown tokens are ignored (we may narrow, RFC 6749 §3.3). */
function requestedScope(scopeParam: string): ApiScope | null {
  const known = scopeParam.split(/\s+/).filter((t) => SUPPORTED_SCOPES.includes(t));
  if (!known.length) return null;
  return known.includes('write') ? 'read,write' : 'read';
}

function externalScope(s: ApiScope): string {
  return s === 'read,write' ? 'read write' : 'read';
}

/**
 * RFC 8707 `resource` — must point at us (request origin or APP_ORIGIN).
 * Loopback origins are also accepted: wrangler dev's asset layer rewrites GET
 * request URLs to the production route host, so a local client's `resource`
 * can never match the request origin there.
 */
function validResource(c: Context<Ctx>, raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.origin === origin(c) || u.origin === new URL(c.env.APP_ORIGIN).origin) return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/** Workspaces the signed-in user may connect: owner/admin, never sandbox. */
async function eligibleOrgs(c: Context<Ctx>): Promise<Array<Org & { role: Role }>> {
  return all<Org & { role: Role }>(
    c.env.DB,
    `SELECT o.*, m.role FROM orgs o
       JOIN org_members m ON m.org_id = o.id
      WHERE m.user_id = ? AND m.role IN ('owner','admin') AND o.is_sandbox = 0
      ORDER BY o.name`,
    c.var.user!.id
  );
}

/** Permissive CORS for the machine-facing endpoints (metadata, register, token). */
const cors: MiddlewareHandler<Ctx> = async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  return next();
};

app.use('/.well-known/oauth-protected-resource', cors);
app.use('/.well-known/oauth-protected-resource/*', cors);
app.use('/.well-known/oauth-authorization-server', cors);
app.use('/.well-known/oauth-authorization-server/*', cors);
app.use('/oauth/register', cors);
app.use('/oauth/token', cors);

/* ------------------------------------------------------------------ metadata */

function protectedResource(c: Context<Ctx>, resource: string) {
  return c.json({
    resource,
    authorization_servers: [origin(c)],
    bearer_methods_supported: ['header'],
    scopes_supported: SUPPORTED_SCOPES,
    resource_name: 'Unsession',
    resource_documentation: `${origin(c)}/docs/mcp`,
  });
}

app.get('/.well-known/oauth-protected-resource', (c) => protectedResource(c, origin(c)));
app.get('/.well-known/oauth-protected-resource/api/mcp', (c) => protectedResource(c, `${origin(c)}/api/mcp`));

function authServerMetadata(c: Context<Ctx>) {
  const o = origin(c);
  return c.json({
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SUPPORTED_SCOPES,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/docs/mcp`,
  });
}

app.get('/.well-known/oauth-authorization-server', authServerMetadata);
// Pre-RFC-9728 clients append the resource path to the well-known URL.
app.get('/.well-known/oauth-authorization-server/api/mcp', authServerMetadata);

/* ------------------------------------------------------------------ DCR */

app.post('/oauth/register', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON' }, 400);
  }

  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
    return c.json(
      {
        error: 'invalid_redirect_uri',
        error_description:
          'redirect_uris must be 1–10 absolute URLs — https, http on localhost, or a native-app scheme — with no fragment',
      },
      400
    );
  }

  let name = typeof body.client_name === 'string' ? body.client_name.trim().slice(0, 80) : '';
  if (!name) name = new URL(uris[0]).hostname || 'MCP client';

  const id = newId('ocl');
  await run(
    c.env.DB,
    `INSERT INTO oauth_clients (id, name, redirect_uris_json, created_at, last_used_at) VALUES (?,?,?,?,NULL)`,
    id,
    name,
    JSON.stringify(uris),
    now()
  );

  return c.json(
    {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    201
  );
});

/* ------------------------------------------------------------------ consent */

const LABEL = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:5px;`;
const INPUT = 'width:100%;padding:9px 11px;border:1px solid #d4d5db;font-size:13.5px;background:#fff;';
const BTN = 'flex:1;padding:11px;background:#fff;border:1px solid #d4d5db;font-size:14px;cursor:pointer;';
const PRIMARY_BTN = 'flex:1;padding:11px;background:#4c5fd5;color:#fff;font-size:14px;font-weight:600;border:none;cursor:pointer;';

/** Terminal errors (bad client / bad redirect) must never redirect — RFC 6749 §4.1.2.1. */
function errorPage(c: Context<Ctx>, message: string) {
  return c.html(
    <Shell title="Can’t connect">
      <div style="background:#fff;border:1px solid #e2e3e8;padding:28px;">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:12px;">Can’t connect</div>
        <div style="border:1px solid #e03131;background:#fbe9e9;color:#c92a2a;padding:9px 11px;font-size:12.5px;margin-bottom:14px;">
          {message}
        </div>
        <div style="font-size:12.5px;">
          <a href="/app" style="color:#4c5fd5;">Back to Unsession</a>
        </div>
      </div>
    </Shell>,
    400
  );
}

/**
 * Client + redirect_uri resolution shared by GET (render) and POST (issue).
 * Only after both check out may an error travel back to the client.
 */
async function resolveClient(
  c: Context<Ctx>,
  clientId: string,
  redirectUriParam: string
): Promise<{ client: OAuthClientRow; redirectUri: string } | { error: ReturnType<typeof errorPage> }> {
  const client = clientId
    ? await one<OAuthClientRow>(c.env.DB, `SELECT * FROM oauth_clients WHERE id = ?`, clientId)
    : null;
  if (!client) {
    return { error: errorPage(c, 'Unknown client — the connector must register first (POST /oauth/register).') };
  }
  const uris = jsonParse<string[]>(client.redirect_uris_json, []);
  const redirectUri = redirectUriParam || (uris.length === 1 ? uris[0] : '');
  if (!uris.includes(redirectUri)) {
    return { error: errorPage(c, 'The redirect address is not one this client registered.') };
  }
  return { client, redirectUri };
}

function backToClient(c: Context<Ctx>, redirectUri: string, state: string, params: Record<string, string>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (state) u.searchParams.set('state', state);
  u.searchParams.set('iss', origin(c));
  return c.redirect(u.toString());
}

app.get('/oauth/authorize', requireUser, async (c) => {
  const q = (k: string) => c.req.query(k) ?? '';
  const resolved = await resolveClient(c, q('client_id'), q('redirect_uri'));
  if ('error' in resolved) return resolved.error;
  const { client, redirectUri } = resolved;
  const deny = (error: string, description: string) =>
    backToClient(c, redirectUri, q('state'), { error, error_description: description });

  if (q('response_type') !== 'code') return deny('unsupported_response_type', 'Only response_type=code is supported');
  if (q('code_challenge_method') && q('code_challenge_method') !== 'S256')
    return deny('invalid_request', 'Only PKCE method S256 is supported');
  if (!PKCE_SHAPE.test(q('code_challenge'))) return deny('invalid_request', 'A PKCE S256 code_challenge is required');
  if (q('resource') && !validResource(c, q('resource'))) {
    return deny('invalid_target', 'resource must be this server');
  }

  const orgs = await eligibleOrgs(c);
  if (!orgs.length) {
    return errorPage(
      c,
      'Your account isn’t an owner or admin of any workspace, so there’s nothing to connect. Create an event at /app first (sandbox workspaces can’t be connected).'
    );
  }

  const scope = requestedScope(q('scope')) ?? 'read,write';
  const activeOrgId = c.var.event?.org_id;
  const redirectHost = (() => {
    try {
      const u = new URL(redirectUri);
      return u.host || redirectUri;
    } catch {
      return redirectUri;
    }
  })();

  return c.html(
    <Shell title="Authorize" width={420}>
      <div style="background:#fff;border:1px solid #e2e3e8;padding:28px;">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:2px;">{`Authorize ${client.name}`}</div>
        <div style="font-size:13px;color:#686b74;margin-bottom:16px;">wants to connect to your Unsession workspace</div>
        <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;background:#f8f8fa;border:1px solid #eceded;padding:8px 10px;margin-bottom:18px;overflow-x:auto;white-space:nowrap;`}>
          {`returns to ${redirectHost}`}
        </div>
        <form method="post" action="/oauth/authorize" style="display:flex;flex-direction:column;gap:16px;">
          <input type="hidden" name="client_id" value={client.id} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="state" value={q('state')} />
          <input type="hidden" name="code_challenge" value={q('code_challenge')} />
          <label style="display:block;">
            <div style={LABEL}>WORKSPACE</div>
            <select name="org_id" style={INPUT}>
              {orgs.map((o) => (
                <option value={o.id} selected={o.id === activeOrgId}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <div>
            <div style={LABEL}>ACCESS</div>
            <label style="display:flex;align-items:baseline;gap:8px;font-size:13.5px;padding:3px 0;cursor:pointer;">
              <input type="radio" name="scopes" value="read" checked={scope === 'read'} />
              <span>Read only — events, submissions, sessions, speakers, agenda</span>
            </label>
            <label style="display:flex;align-items:baseline;gap:8px;font-size:13.5px;padding:3px 0;cursor:pointer;">
              <input type="radio" name="scopes" value="read,write" checked={scope === 'read,write'} />
              <span>Read &amp; write — also decide submissions, schedule sessions, edit speakers</span>
            </label>
          </div>
          <div style="display:flex;gap:8px;">
            <button type="submit" name="deny" value="1" style={BTN}>
              Deny
            </button>
            <button type="submit" style={PRIMARY_BTN}>
              Allow
            </button>
          </div>
        </form>
        <div style="font-size:12px;color:#9a9da6;margin-top:16px;line-height:1.5;">
          {`Approving creates an API token in that workspace — see and revoke it any time under API access. Signed in as ${c.var.user!.email}.`}
        </div>
      </div>
    </Shell>
  );
});

app.post('/oauth/authorize', requireUser, async (c) => {
  const form = await c.req.parseBody();
  const f = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
  const resolved = await resolveClient(c, f('client_id'), f('redirect_uri'));
  if ('error' in resolved) return resolved.error;
  const { client, redirectUri } = resolved;

  if (f('deny')) {
    return backToClient(c, redirectUri, f('state'), {
      error: 'access_denied',
      error_description: 'The user declined the request',
    });
  }
  if (!PKCE_SHAPE.test(f('code_challenge'))) {
    return backToClient(c, redirectUri, f('state'), {
      error: 'invalid_request',
      error_description: 'A PKCE S256 code_challenge is required',
    });
  }

  const scopes: ApiScope = f('scopes') === 'read' ? 'read' : 'read,write';
  const org = (await eligibleOrgs(c)).find((o) => o.id === f('org_id'));
  if (!org) return errorPage(c, 'Pick a workspace you own or administer.');

  const raw = randomToken();
  await run(
    c.env.DB,
    `INSERT INTO oauth_codes (id, code_hash, client_id, user_id, org_id, scopes, redirect_uri, code_challenge, created_at, expires_at, used_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
    newId('oac'),
    await hashToken(raw),
    client.id,
    c.var.user!.id,
    org.id,
    scopes,
    redirectUri,
    f('code_challenge'),
    now(),
    isoIn(CODE_MINUTES * 60_000)
  );
  await run(c.env.DB, `UPDATE oauth_clients SET last_used_at = ? WHERE id = ?`, now(), client.id);

  return backToClient(c, redirectUri, f('state'), { code: raw });
});

/* ------------------------------------------------------------------ token */

function tokenError(c: Context<Ctx>, status: 400 | 401, error: string, description: string) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error, error_description: description }, status);
}

function tokenResponse(c: Context<Ctx>, access: string, refresh: string, scopes: ApiScope) {
  c.header('Cache-Control', 'no-store');
  return c.json({
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refresh,
    scope: externalScope(scopes),
  });
}

app.post('/oauth/token', async (c) => {
  let body: Record<string, unknown>;
  try {
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    body = ct.includes('json') ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
  } catch {
    return tokenError(c, 400, 'invalid_request', 'Send application/x-www-form-urlencoded (or JSON) parameters');
  }
  const p = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');

  if (p('grant_type') === 'authorization_code') {
    if (!p('code') || !p('code_verifier') || !p('client_id')) {
      return tokenError(c, 400, 'invalid_request', 'code, code_verifier and client_id are required');
    }
    const row = await one<OAuthCodeRow>(
      c.env.DB,
      `SELECT * FROM oauth_codes WHERE code_hash = ?`,
      await hashToken(p('code'))
    );
    if (!row || row.client_id !== p('client_id')) {
      return tokenError(c, 400, 'invalid_grant', 'Unknown authorization code');
    }
    if (row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return tokenError(c, 400, 'invalid_grant', 'The authorization code expired or was already used');
    }
    if (p('redirect_uri') && p('redirect_uri') !== row.redirect_uri) {
      return tokenError(c, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    }
    if ((await s256(p('code_verifier'))) !== row.code_challenge) {
      return tokenError(c, 400, 'invalid_grant', 'PKCE verification failed');
    }
    // Conditional flip is the single-use guard — a raced second redeem changes 0 rows.
    const used = await run(c.env.DB, `UPDATE oauth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`, now(), row.id);
    if (!used.meta.changes) {
      return tokenError(c, 400, 'invalid_grant', 'The authorization code expired or was already used');
    }

    const client = await one<OAuthClientRow>(c.env.DB, `SELECT * FROM oauth_clients WHERE id = ?`, row.client_id);
    const user = await one<User>(c.env.DB, `SELECT * FROM users WHERE id = ?`, row.user_id);
    const scopes: ApiScope = row.scopes === 'read,write' ? 'read,write' : 'read';
    const refresh = mintSecret('unsr_');
    const { secret } = await createApiToken(c.env, {
      orgId: row.org_id,
      name: client?.name ?? 'MCP client',
      scopes,
      eventId: null,
      createdBy: user?.name || user?.email || 'OAuth',
      oauth: {
        clientId: row.client_id,
        expiresAt: isoIn(ACCESS_TOKEN_SECONDS * 1000),
        refreshTokenHash: await hashToken(refresh),
      },
    });
    return tokenResponse(c, secret, refresh, scopes);
  }

  if (p('grant_type') === 'refresh_token') {
    if (!p('refresh_token')) return tokenError(c, 400, 'invalid_request', 'refresh_token is required');
    const row = await one<ApiTokenRow>(
      c.env.DB,
      `SELECT * FROM api_tokens WHERE refresh_token_hash = ?`,
      await hashToken(p('refresh_token'))
    );
    if (!row || (p('client_id') && row.oauth_client_id !== p('client_id'))) {
      return tokenError(c, 400, 'invalid_grant', 'Unknown refresh token');
    }
    if (row.revoked_at) return tokenError(c, 400, 'invalid_grant', 'This connection was revoked');

    const access = mintSecret();
    const refresh = mintSecret('unsr_');
    // Rotation: both secrets are replaced in one conditional write; the
    // refresh-hash guard makes a raced double-refresh change 0 rows.
    const rotated = await run(
      c.env.DB,
      `UPDATE api_tokens SET token_hash = ?, refresh_token_hash = ?, expires_at = ?
        WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
      await hashToken(access),
      await hashToken(refresh),
      isoIn(ACCESS_TOKEN_SECONDS * 1000),
      row.id,
      row.refresh_token_hash
    );
    if (!rotated.meta.changes) return tokenError(c, 400, 'invalid_grant', 'The refresh token was already rotated — retry');

    const scopes: ApiScope = row.scopes === 'read,write' ? 'read,write' : 'read';
    return tokenResponse(c, access, refresh, scopes);
  }

  return tokenError(c, 400, 'unsupported_grant_type', 'Use grant_type=authorization_code or refresh_token');
});

export default app;
