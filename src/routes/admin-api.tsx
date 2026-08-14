/**
 * `/app/api` — API token management (spec C). Owner/admin only.
 *
 * List (name, scope, event, created, last used), create dialog (name, scope,
 * optional event restriction), revoke. The secret is shown exactly once, in a
 * copy panel rendered straight from the create POST — it never travels through
 * a redirect URL. Sandbox orgs cannot create tokens (403): personas are shared
 * and throwaway. The page footer documents the base URL and the MCP endpoint,
 * and links the public setup guide at `/docs/mcp` (`routes/docs.tsx`).
 *
 * Progressive enhancement: everything here is plain form POSTs — no island.
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
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
const CODE = `font-family:${MONO};font-size:12px;background:#f8f8fa;border:1px solid #eceded;padding:10px 12px;overflow-x:auto;white-space:pre;line-height:1.6;max-width:100%;`;
const CHIP = `flex:none;font-family:${MONO};font-size:9.5px;letter-spacing:0.08em;padding:2px 6px;font-weight:600;`;

/**
 * Responsive layout for the API page. The token table drops its six-column grid
 * and reflows to a stacked card per token — a horizontally scrolling 840px grid
 * would park the Revoke button off-screen. The "Using the API" panels stack and
 * the code samples scroll inside their own box.
 * The literal 768 is deliberate — importing MOBILE_MAX into a route module's
 * top-level template crashes the worker at startup (SPECS/M-mobile.md).
 */
const PAGE_CSS = `
  .api-wrap{padding:22px 28px;}
  /* gap lives here, not inline, so the mobile card layout can space its rows. */
  .api-head{min-width:840px;gap:0;}
  .api-row{min-width:840px;gap:0;}
  .api-revoke{padding:0;}
  .api-panels{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);}
  .api-cell{padding:16px 20px;min-width:0;}
  .api-cell-l{border-right:1px solid #f2f3f5;}
  .api-scopes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);border-top:1px solid #f2f3f5;}
  .api-scope{padding:14px 20px;display:flex;gap:10px;align-items:baseline;min-width:0;}
  .api-secret-row{display:flex;align-items:center;border:1px solid #d8d9de;background:#fff;}
  .api-copy{padding:10px 16px;}
  @media (max-width:768px){
    .api-wrap{padding:16px 14px;}
    .api-title{flex-wrap:wrap;gap:6px 10px;}
    .api-head{display:none !important;}
    /* One card per token: name on its own line, meta wrapping under it, and the
       Revoke action still on screen. */
    .api-row{display:flex !important;flex-wrap:wrap;align-items:baseline;min-width:0;gap:5px 10px;padding:13px 14px;}
    .api-name{flex:1 1 100%;padding-right:0 !important;}
    .api-event,.api-created,.api-used{white-space:normal !important;padding-right:0 !important;}
    /* The column headers are gone on a phone, so each value names itself. */
    .api-created::before{content:'created ';}
    .api-used::before{content:'· used ';}
    .api-act{margin-left:auto;text-align:right;}
    .api-revoke{padding:10px 0 10px 12px;}
    .api-panelhead{flex-wrap:wrap;gap:4px 12px;padding:12px 14px;}
    .api-panelhead a{margin-left:0 !important;}
    .api-panels,.api-scopes{grid-template-columns:minmax(0,1fr);}
    .api-cell{padding:14px;}
    .api-cell-l{border-right:none;border-bottom:1px solid #f2f3f5;}
    .api-scope{padding:12px 14px;}
    .api-secret-row{flex-direction:column;align-items:stretch;}
    .api-copy{padding:12px 16px;}
    .api-foot{padding:10px 14px !important;}
    .api-dlgfoot{flex-wrap:wrap;}
  }
`;

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
      <style>{raw(PAGE_CSS)}</style>
      <div class="api-wrap" style="max-width:1060px;">
        <div class="api-title" style="display:flex;align-items:baseline;gap:12px;margin-bottom:16px;">
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
            <div class="api-secret-row">
              <span style={`flex:1;min-width:0;font-family:${MONO};font-size:12.5px;padding:10px 14px;overflow-x:auto;white-space:nowrap;`}>
                {opts.secret.secret}
              </span>
              <button
                type="button"
                data-copy={opts.secret.secret}
                data-copy-msg="API token copied — store it somewhere safe"
                class="api-copy"
                style="background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;flex:none;"
              >
                Copy token
              </button>
            </div>
            <div style="font-size:12.5px;color:#686b74;margin-top:10px;">
              This is the only time the secret is shown. Lose it and you revoke this token and mint a new one.
            </div>
          </div>
        ) : null}

        {isSandbox ? (
          <div style="background:#fff4e6;border:1px solid #f0c078;padding:12px 16px;font-size:13px;color:#686b74;margin-bottom:16px;">
            Sandbox workspaces can’t create API tokens. Create your own event to use the API.
          </div>
        ) : null}

        <div style="background:#fff;border:1px solid #e2e3e8;overflow-x:auto;margin-bottom:16px;">
          <div
            class="api-head"
            style={`display:grid;${GRID}padding:9px 14px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;color:#9a9da6;align-items:center;`}
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
                class="api-row"
                style={`display:grid;${GRID}padding:11px 14px;border-bottom:1px solid #f2f3f5;align-items:center;`}
              >
                <div class="api-name" style="min-width:0;padding-right:12px;">
                  <div style={`font-size:13.5px;font-weight:600;color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                    {t.name}
                    {t.oauth_client_id ? (
                      <span
                        style={`font-family:${MONO};font-size:9px;letter-spacing:0.08em;padding:1px 5px;margin-left:6px;font-weight:600;color:${revoked ? '#868e96' : '#0b7285'};background:${revoked ? '#f1f3f5' : '#e3fafc'};`}
                      >
                        OAUTH
                      </span>
                    ) : null}
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
                <div
                  class="api-event"
                  style={`font-size:12.5px;color:${revoked ? '#c9cbd2' : '#686b74'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px;`}
                >
                  {t.event_id ? (eventName.get(t.event_id) ?? 'One event') : 'Whole org'}
                </div>
                <div class="api-created" style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
                  {fmtDate(t.created_at, true)}
                </div>
                <div class="api-used" style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
                  {t.last_used_at ? fmtDate(t.last_used_at, true) : 'Never'}
                </div>
                <div class="api-act" style="text-align:right;">
                  {revoked ? null : (
                    <form method="post" action="/app/api/tokens/revoke" style="display:inline;">
                      <input type="hidden" name="id" value={t.id} />
                      <button
                        type="submit"
                        class="api-revoke"
                        style="background:none;border:none;color:#c92a2a;font-size:12.5px;cursor:pointer;text-decoration:underline;"
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
              No API tokens yet{isSandbox ? '.' : ' — create one to script the API or connect an agent.'}
            </div>
          ) : null}
        </div>

        <div style="background:#fff;border:1px solid #e2e3e8;">
          <div class="api-panelhead" style="display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid #e2e3e8;">
            <div style={MICRO}>USING THE API</div>
            <a href="/docs/mcp" style="margin-left:auto;color:#4c5fd5;font-weight:600;font-size:12.5px;">
              Setup guide, tool reference and connection snippets →
            </a>
          </div>

          <div class="api-panels">
            <div class="api-cell api-cell-l" style="display:grid;gap:10px;align-content:start;">
              <div style={MICRO}>REST API</div>
              <div style={`font-family:${MONO};font-size:13px;color:#16171d;overflow-wrap:anywhere;`}>{`${origin}/api/v1`}</div>
              <div style="font-size:12.5px;color:#686b74;line-height:1.5;">
                For scripts and integrations. Authenticate every request with{' '}
                <span style={`font-family:${MONO};font-size:11.5px;background:#f4f4f6;padding:1px 5px;`}>
                  Authorization: Bearer uns_…
                </span>
              </div>
              <div style={CODE}>{`curl -H "Authorization: Bearer <token>" \\\n  ${origin}/api/v1/events`}</div>
              <div style="font-size:12.5px;">
                <a href="/docs/mcp#rest" style="color:#4c5fd5;font-weight:600;">
                  Every endpoint you can call →
                </a>
              </div>
            </div>
            <div class="api-cell" style="display:grid;gap:10px;align-content:start;">
              <div style={MICRO}>MCP ENDPOINT — FOR AGENTS</div>
              <div style={`font-family:${MONO};font-size:13px;color:#16171d;overflow-wrap:anywhere;`}>{`${origin}/api/mcp`}</div>
              <div style="font-size:12.5px;color:#686b74;line-height:1.5;">
                No token needed: MCP clients (Claude Code, claude.ai connectors, Cursor, VS Code) register
                themselves with OAuth. Add the endpoint URL, sign in on the consent page, and the connection
                appears in the list above tagged OAUTH — revoke it like any other token.
              </div>
              <div style={CODE}>
                {`claude mcp add --transport http unsession \\\n  ${origin}/api/mcp\n# then run /mcp inside Claude Code and sign in`}
              </div>
              <div style="font-size:12.5px;color:#686b74;line-height:1.5;">
                Clients without OAuth can still send the Bearer header instead.{' '}
                <a href="/docs/mcp#tools" style="color:#4c5fd5;font-weight:600;white-space:nowrap;">
                  All 84 tools →
                </a>
              </div>
            </div>
          </div>

          <div class="api-scopes">
            <div class="api-scope api-cell-l">
              <span style={`${CHIP}color:#1c7ed6;background:#e7f1fb;`}>READ</span>
              <span style="font-size:12.5px;color:#686b74;line-height:1.5;">
                Events, forms, submissions, evaluations, sessions, speakers, tasks, files, emails, embeds, the CRM
                and the published agenda. Read-only tokens see only the read MCP tools.
              </span>
            </div>
            <div class="api-scope">
              <span style={`${CHIP}color:#9c36b5;background:#f6e8f9;`}>WRITE</span>
              <span style="font-size:12.5px;color:#686b74;line-height:1.5;">
                Adds everything an organizer can do: decisions and the outbox, form building, evaluation plans and
                scores, scheduling and publish, task and email workflows, CRM and team invites. Every write lands
                in the activity log as <span style={`font-family:${MONO};font-size:11.5px;`}>api:&lt;token name&gt;</span>.
              </span>
            </div>
          </div>

          <div class="api-foot" style="border-top:1px solid #f2f3f5;padding:10px 20px;font-size:12px;color:#9a9da6;">
            Deliberately UI-only: file uploads, CRM contact deletion/merging, team role changes and removal, and
            CSV/XLSX exports. Org-level tools (CRM, pipeline, team) need an org-wide token.
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ new token */}
      {isSandbox ? null : (
        <div id="new-token" data-dialog hidden style={DIALOG}>
          {/* `max-width:100%` cannot cap this — the overlay's grid track grows
              to the item's own 460px, so the cap is viewport-relative. */}
          <div style="background:#fff;width:min(460px,calc(100vw - 40px));max-height:100%;overflow-y:auto;box-shadow:0 16px 48px rgba(22,23,29,0.25);">
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
              <div class="api-dlgfoot" style="padding:14px 20px;border-top:1px solid #f2f3f5;display:flex;gap:8px;align-items:center;">
                <div style="font-size:11.5px;color:#9a9da6;line-height:1.4;flex:1;min-width:0;">
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
