/**
 * `/app/api` — API token management (spec C). Owner/admin only.
 *
 * List (name, scope, event, created, last used), create dialog (name, scope,
 * optional event restriction), revoke. The secret is shown exactly once, in a
 * copy panel rendered straight from the create POST — it never travels through
 * a redirect URL. Sandbox orgs cannot create tokens (403): personas are shared
 * and throwaway. The page footer documents the base URL and the MCP endpoint.
 *
 * Progressive enhancement: everything here is plain form POSTs — no island.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, MONO, fmtDate } from '../views/layout';
import { adminProps, redirectWithToast } from '../views/chrome';
import { all, now, one, run } from '../lib/db';
import { requireOrgRole } from '../lib/auth';
import { createApiToken, type ApiScope, type ApiTokenRow } from '../lib/api-tokens';

const app = new Hono<Ctx>();

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;outline-color:#4c5fd5;';
const BTN = 'padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const PRIMARY = 'padding:9px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;';
const DIALOG = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;padding:20px;';
const GRID = 'grid-template-columns:minmax(180px,1fr) 120px 170px 110px 110px 80px;';

const SCOPE_LABEL: Record<string, string> = { read: 'READ', 'read,write': 'READ · WRITE' };

type PageOpts = { secret?: { name: string; secret: string }; error?: string };

async function renderPage(c: Context<Ctx>, opts: PageOpts = {}) {
  const props = await adminProps(c, 'API', { headerTitle: 'API access' });
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');

  const org = await one<{ is_sandbox: number }>(c.env.DB, `SELECT is_sandbox FROM orgs WHERE id = ?`, event.org_id);
  const isSandbox = !!org?.is_sandbox;
  const tokens = await all<ApiTokenRow>(
    c.env.DB,
    `SELECT * FROM api_tokens WHERE org_id = ? ORDER BY (revoked_at IS NOT NULL), created_at DESC`,
    event.org_id
  );
  const orgEvents = (c.var.events ?? []).filter((e) => e.org_id === event.org_id);
  const eventName = new Map(orgEvents.map((e) => [e.id, e.name]));
  const origin = (props.origin ?? 'https://unsession.dev').replace(/\/$/, '');
  const live = tokens.filter((t) => !t.revoked_at).length;

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:22px 28px;max-width:1060px;">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:16px;">
          <h1 style="margin:0;font-size:21px;letter-spacing:-0.02em;">API</h1>
          <div style={`font-family:${MONO};font-size:12px;color:#686b74;`}>
            {live ? `${live} active token${live === 1 ? '' : 's'}` : ''}
          </div>
          <div style="margin-left:auto;">
            {isSandbox ? null : (
              <button type="button" data-dialog-open="#new-token" style={PRIMARY}>
                ＋ New token
              </button>
            )}
          </div>
        </div>

        {opts.error ? (
          <div style="background:#fbe9e9;border:1px solid #e8a3a3;color:#c92a2a;padding:11px 14px;font-size:13px;margin-bottom:16px;">
            {opts.error}
          </div>
        ) : null}

        {opts.secret ? (
          <div style="background:#eef0fb;border:1px solid #4c5fd5;padding:16px 20px;margin-bottom:16px;">
            <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#4c5fd5;margin-bottom:10px;`}>
              {`TOKEN “${opts.secret.name.toUpperCase()}” CREATED — COPY IT NOW`}
            </div>
            <div style="display:flex;align-items:center;gap:0;border:1px solid #d8d9de;background:#fff;">
              <span style={`flex:1;min-width:0;font-family:${MONO};font-size:12.5px;padding:10px 14px;overflow-x:auto;white-space:nowrap;`}>
                {opts.secret.secret}
              </span>
              <button
                type="button"
                data-copy={opts.secret.secret}
                data-copy-msg="API token copied — store it somewhere safe"
                style="padding:10px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;flex:none;"
              >
                Copy token
              </button>
            </div>
            <div style="font-size:12.5px;color:#686b74;margin-top:10px;">
              This is the only time the secret is shown. Lose it and you revoke this token and mint a new one — there
              is no recovery.
            </div>
          </div>
        ) : null}

        {isSandbox ? (
          <div style="background:#fff4e6;border:1px solid #f0c078;padding:12px 16px;font-size:13px;color:#686b74;margin-bottom:16px;">
            Sandbox workspaces can’t create API tokens — the personas here are shared and throwaway. Create your own
            event to use the API.
          </div>
        ) : null}

        <div style="background:#fff;border:1px solid #e2e3e8;overflow-x:auto;margin-bottom:16px;">
          <div
            style={`display:grid;${GRID}gap:0;padding:9px 14px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;color:#9a9da6;align-items:center;min-width:840px;`}
          >
            <div>NAME</div>
            <div>SCOPE</div>
            <div>EVENT</div>
            <div>CREATED</div>
            <div>LAST USED</div>
            <div></div>
          </div>
          {tokens.map((t) => {
            const revoked = !!t.revoked_at;
            const fg = revoked ? '#c9cbd2' : '#16171d';
            return (
              <div
                style={`display:grid;${GRID}gap:0;padding:11px 14px;border-bottom:1px solid #f2f3f5;align-items:center;min-width:840px;`}
              >
                <div style="min-width:0;padding-right:12px;">
                  <div style={`font-size:13.5px;font-weight:600;color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                    {t.name}
                  </div>
                  <div style="font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    {`by ${t.created_by}`}
                  </div>
                </div>
                <div>
                  <span
                    style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.08em;padding:2px 6px;font-weight:600;color:${
                      revoked ? '#868e96' : t.scopes === 'read,write' ? '#9c36b5' : '#1c7ed6'
                    };background:${revoked ? '#f1f3f5' : t.scopes === 'read,write' ? '#f6e8f9' : '#e7f1fb'};`}
                  >
                    {revoked ? 'REVOKED' : (SCOPE_LABEL[t.scopes] ?? t.scopes.toUpperCase())}
                  </span>
                </div>
                <div style={`font-size:12.5px;color:${revoked ? '#c9cbd2' : '#686b74'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px;`}>
                  {t.event_id ? (eventName.get(t.event_id) ?? 'One event') : 'Whole org'}
                </div>
                <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{fmtDate(t.created_at, true)}</div>
                <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
                  {t.last_used_at ? fmtDate(t.last_used_at, true) : 'Never'}
                </div>
                <div style="text-align:right;">
                  {revoked ? null : (
                    <form method="post" action="/app/api/tokens/revoke" style="display:inline;">
                      <input type="hidden" name="id" value={t.id} />
                      <button
                        type="submit"
                        style="background:none;border:none;color:#c92a2a;font-size:12.5px;cursor:pointer;text-decoration:underline;padding:0;"
                      >
                        Revoke
                      </button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
          {tokens.length === 0 ? (
            <div style="padding:36px;text-align:center;font-size:13.5px;color:#686b74;">
              No API tokens yet{isSandbox ? '.' : ' — create one to script the API or connect an agent over MCP.'}
            </div>
          ) : null}
        </div>

        <div style="background:#fff;border:1px solid #e2e3e8;padding:18px 20px;">
          <div style={`${MICRO}margin-bottom:12px;`}>USING THE API</div>
          <div style="display:grid;gap:10px;font-size:13px;color:#33343c;line-height:1.55;">
            <div>
              <span style={MICRO}>BASE URL&ensp;</span>
              <span style={`font-family:${MONO};font-size:12.5px;`}>{`${origin}/api/v1`}</span>
              &ensp;·&ensp;authenticate every request with{' '}
              <span style={`font-family:${MONO};font-size:12px;background:#f4f4f6;padding:1px 5px;`}>
                Authorization: Bearer uns_…
              </span>
            </div>
            <div style={`font-family:${MONO};font-size:12px;background:#f8f8fa;border:1px solid #eceded;padding:10px 12px;overflow-x:auto;white-space:nowrap;`}>
              {`curl -H "Authorization: Bearer <token>" ${origin}/api/v1/events`}
            </div>
            <div>
              Read scope covers events, forms, submissions, sessions, speakers, tasks and the published agenda
              (<span style={`font-family:${MONO};font-size:12px;`}>{`GET ${origin}/api/v1/events/{event}/agenda`}</span>).
              Write scope adds submission create/update, decisions, session create/edit/schedule, speaker profile
              edits and task assignment — every write lands in the activity log as{' '}
              <span style={`font-family:${MONO};font-size:12px;`}>api:&lt;token name&gt;</span>.
            </div>
            <div>
              <span style={MICRO}>MCP ENDPOINT&ensp;</span>
              <span style={`font-family:${MONO};font-size:12.5px;`}>{`${origin}/api/mcp`}</span>
              &ensp;— the same tokens drive agents (Claude Code, claude.ai custom connectors) over stateless
              Streamable HTTP; read-only tokens see only the read tools.
            </div>
            <div style="font-size:12.5px;color:#9a9da6;">
              Deliberately out of scope in v1: form/schema editing, event creation, team management, email template
              CRUD.
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ new token */}
      {isSandbox ? null : (
        <div id="new-token" data-dialog hidden style={DIALOG}>
          <div style="background:#fff;width:460px;max-width:100%;box-shadow:0 16px 48px rgba(22,23,29,0.25);">
            <div style="padding:16px 20px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;">
              <div style="font-size:15px;font-weight:700;">New API token</div>
              <button
                type="button"
                data-dialog-close="#new-token"
                style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
              >
                ×
              </button>
            </div>
            <form method="post" action="/app/api/tokens/create">
              <div style="padding:18px 20px;display:grid;gap:14px;">
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>NAME</div>
                  <input name="name" placeholder="Deploy script · Claude connector · Zapier…" required style={INPUT} />
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>SCOPE</div>
                  <select name="scopes" style={INPUT}>
                    <option value="read">Read only</option>
                    <option value="read,write">Read &amp; write</option>
                  </select>
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>EVENT RESTRICTION</div>
                  <select name="event_id" style={INPUT}>
                    <option value="">Whole org — every event</option>
                    {orgEvents.map((e) => (
                      <option value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div style="padding:14px 20px;border-top:1px solid #f2f3f5;display:flex;gap:8px;align-items:center;">
                <div style="font-size:11.5px;color:#9a9da6;line-height:1.4;flex:1;">
                  The secret is shown once, on the next screen.
                </div>
                <button type="button" data-dialog-close="#new-token" style={BTN}>
                  Cancel
                </button>
                <button type="submit" style={PRIMARY}>
                  Create token
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

app.get('/app/api', requireOrgRole('admin'), (c) => renderPage(c));

app.post('/app/api/tokens/create', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  const org = await one<{ is_sandbox: number }>(c.env.DB, `SELECT is_sandbox FROM orgs WHERE id = ?`, event.org_id);
  if (org?.is_sandbox) return c.text('Sandbox orgs cannot create API tokens', 403);

  const form = await c.req.formData();
  const name = String(form.get('name') ?? '')
    .trim()
    .slice(0, 80);
  if (!name) return renderPage(c, { error: 'Name the token first — “Deploy script”, “Claude connector”…' });
  const scopes: ApiScope = String(form.get('scopes') ?? '') === 'read,write' ? 'read,write' : 'read';
  const eventIdRaw = String(form.get('event_id') ?? '').trim();
  let eventId: string | null = null;
  if (eventIdRaw) {
    const owned = (c.var.events ?? []).some((e) => e.id === eventIdRaw && e.org_id === event.org_id);
    if (!owned) return renderPage(c, { error: 'Pick an event in this workspace.' });
    eventId = eventIdRaw;
  }

  const { secret } = await createApiToken(c.env, {
    orgId: event.org_id,
    name,
    scopes,
    eventId,
    createdBy: c.var.user?.name || c.var.user?.email || 'Organizer',
  });
  return renderPage(c, { secret: { name, secret } });
});

app.post('/app/api/tokens/revoke', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  const form = await c.req.formData();
  const id = String(form.get('id') ?? '');
  await run(
    c.env.DB,
    `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL`,
    now(),
    id,
    event.org_id
  );
  return redirectWithToast(c, '/app/api', 'Token revoked — requests with it now get 401');
});

export default app;
