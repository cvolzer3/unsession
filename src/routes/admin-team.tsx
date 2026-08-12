/** `/app/team` — members + pending invites in one paginated, filterable table (spec §5.7). */
import { Hono } from 'hono';
import type { Ctx, Role } from '../types';
import { AdminLayout, MONO, StatusChip, fmtDate, initials } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { requestMagicLink, requireOrgRole } from '../lib/auth';

const app = new Hono<Ctx>();

const CARD = 'background:#fff;border:1px solid #e2e3e8;';
const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;outline-color:#4c5fd5;';
const FILTER_INPUT = 'padding:7px 12px;border:1px solid #e2e3e8;font-size:13px;outline-color:#4c5fd5;background:#fff;';
const FILTER_SELECT = 'padding:7px 10px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;color:#33343c;cursor:pointer;outline-color:#4c5fd5;';
const DIALOG_WRAP = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;';
const DIALOG_CARD = 'background:#fff;width:420px;max-width:calc(100vw - 48px);box-shadow:0 16px 48px rgba(22,23,29,0.25);';
const DIALOG_HEAD = 'padding:16px 20px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;';
const DIALOG_BODY = 'padding:18px 20px;display:grid;gap:12px;';
const DIALOG_FOOT = 'padding:14px 20px;border-top:1px solid #f2f3f5;display:flex;gap:8px;align-items:center;justify-content:flex-end;';
const FIELD_LABEL = 'font-size:12px;color:#686b74;margin-bottom:4px;';
const CANCEL_BTN = 'padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const PRIMARY_BTN = 'padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;';
const PG_ON = 'padding:6px 12px;font-size:12px;border:1px solid #e2e3e8;background:#fff;color:#33343c;cursor:pointer;text-decoration:none;';
const PG_OFF = 'padding:6px 12px;font-size:12px;border:1px solid #e2e3e8;background:#fff;color:#c9cbd2;cursor:default;';
const COLS = 'minmax(170px,1fr) minmax(210px,1fr) 130px 90px 130px 60px';
const ROLES: Role[] = ['owner', 'admin', 'collaborator'];
const PAGE_SIZE = 20;

type TeamRow = {
  kind: 'member' | 'invite';
  id: string;
  name: string | null;
  email: string;
  role: string;
  date: string;
};

app.get('/app/team', async (c) => {
  const event = c.var.event;
  const props = await adminProps(c, 'Team');
  if (!event) return c.redirect('/app/events/new');

  const members = await all<{ id: string; name: string | null; email: string; role: string; created_at: string }>(
    c.env.DB,
    `SELECT u.id, u.name, u.email, m.role, m.created_at
       FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email`,
    event.org_id
  );
  const invites = await all<{ id: string; email: string; role: string; status: string; created_at: string }>(
    c.env.DB,
    `SELECT * FROM invites WHERE org_id = ? AND status = 'pending' ORDER BY created_at DESC`,
    event.org_id
  );
  const canManage = c.var.role === 'owner' || c.var.role === 'admin';
  const inviteLink = c.req.query('link');

  /* ------------------------------------------------ filters + pagination */
  const q = (c.req.query('q') ?? '').trim();
  const roleParam = c.req.query('role') ?? 'all';
  const roleFilter = ['owner', 'admin', 'collaborator', 'pending'].includes(roleParam) ? roleParam : 'all';

  let rows: TeamRow[] = [
    ...members.map((m) => ({ kind: 'member' as const, id: m.id, name: m.name, email: m.email, role: m.role, date: m.created_at })),
    ...invites.map((i) => ({ kind: 'invite' as const, id: i.id, name: null, email: i.email, role: i.role, date: i.created_at })),
  ];
  if (roleFilter === 'pending') rows = rows.filter((r) => r.kind === 'invite');
  else if (roleFilter !== 'all') rows = rows.filter((r) => r.role === roleFilter);
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) => `${r.name ?? ''} ${r.email}`.toLowerCase().includes(needle));
  }

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cur = Math.min(Math.max(0, Number(c.req.query('page') ?? '0') || 0), pages - 1);
  const pageRows = rows.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);
  const hasFilters = !!(q || roleFilter !== 'all');
  const pageLink = (p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (roleFilter !== 'all') sp.set('role', roleFilter);
    if (p > 0) sp.set('page', String(p));
    const s = sp.toString();
    return s ? `/app/team?${s}` : '/app/team';
  };

  const headerActions = canManage ? (
    <button type="button" data-dialog-open="#invite-dialog" style={PRIMARY_BTN}>
      ＋ Invite teammate
    </button>
  ) : (
    <div style="font-size:12.5px;color:#686b74;">Owners and admins manage the team.</div>
  );

  return c.html(
    <AdminLayout {...props} headerActions={headerActions}>
      <div style="padding:24px 28px;max-width:1160px;">
        {inviteLink ? (
          <div style="border:1px solid #b08800;background:#fdf5dc;padding:12px 14px;margin-bottom:16px;">
            <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#b08800;margin-bottom:6px;`}>
              DEV MODE — EMAIL SENDING NOT YET ENABLED
            </div>
            <div style="font-size:12.5px;color:#686b74;margin-bottom:8px;">
              Send this invite link to your teammate directly:
            </div>
            <a href={inviteLink} style="font-size:12px;word-break:break-all;">
              {inviteLink}
            </a>
          </div>
        ) : null}

        <form method="get" action="/app/team" style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
          <input name="q" value={q} placeholder="Search name or email…" style={`width:250px;${FILTER_INPUT}`} />
          <select name="role" onchange="this.form.submit()" style={FILTER_SELECT}>
            <option value="all" selected={roleFilter === 'all'}>
              All roles
            </option>
            {ROLES.map((r) => (
              <option value={r} selected={roleFilter === r}>
                {r}
              </option>
            ))}
            <option value="pending" selected={roleFilter === 'pending'}>
              pending invites
            </option>
          </select>
          <button type="submit" style="padding:7px 14px;background:#fff;border:1px solid #e2e3e8;font-size:12.5px;cursor:pointer;">
            Apply
          </button>
          {hasFilters ? (
            <a href="/app/team" style="padding:7px 10px;color:#4c5fd5;font-size:12.5px;font-weight:600;text-decoration:none;">
              Clear ×
            </a>
          ) : null}
        </form>

        <div style={CARD}>
          <div style={`padding:12px 16px;border-bottom:1px solid #eceded;${MICRO}`}>
            {`TEAM · ${members.length} MEMBER${members.length === 1 ? '' : 'S'} · ${invites.length} PENDING`}
          </div>
          <div
            style={`display:grid;grid-template-columns:${COLS};gap:12px;padding:9px 16px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;color:#9a9da6;align-items:center;`}
          >
            <div>NAME</div>
            <div>EMAIL</div>
            <div>ROLE</div>
            <div>STATUS</div>
            <div>JOINED / INVITED</div>
            <div></div>
          </div>
          {pageRows.map((r) => (
            <div style={`display:grid;grid-template-columns:${COLS};gap:12px;padding:10px 16px;border-bottom:1px solid #f2f3f5;align-items:center;`}>
              <div style="display:flex;align-items:center;gap:9px;min-width:0;">
                <div
                  style={`width:26px;height:26px;border-radius:50%;${
                    r.kind === 'member' ? 'background:#4c5fd5;color:#fff;' : 'background:#e2e3e8;color:#686b74;'
                  }display:grid;place-items:center;font-family:${MONO};font-size:10px;font-weight:600;flex:none;`}
                >
                  {initials(r.name || r.email)}
                </div>
                <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {r.name || '—'}
                </div>
              </div>
              <div style={`font-family:${MONO};font-size:11.5px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                {r.email}
              </div>
              <div>
                {r.kind === 'member' && canManage && r.id !== c.var.user?.id ? (
                  <form method="post" action="/app/team/role">
                    <input type="hidden" name="user_id" value={r.id} />
                    <select
                      name="role"
                      onchange="this.form.submit()"
                      style="padding:5px 6px;border:1px solid #e2e3e8;font-size:12px;background:#fff;"
                    >
                      {ROLES.map((x) => (
                        <option value={x} selected={x === r.role}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </form>
                ) : (
                  <StatusChip status="pending" label={r.role} />
                )}
              </div>
              <div>{r.kind === 'member' ? <StatusChip status="open" label="active" /> : <StatusChip status="pending" />}</div>
              <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{fmtDate(r.date, true)}</div>
              <div style="text-align:right;">
                {r.kind === 'invite' && canManage ? (
                  <form method="post" action="/app/team/revoke">
                    <input type="hidden" name="invite_id" value={r.id} />
                    <button
                      type="submit"
                      style="background:none;border:none;padding:0;font-size:12px;color:#c92a2a;cursor:pointer;"
                    >
                      Revoke
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          ))}
          {rows.length === 0 ? (
            <div style="padding:28px 16px;text-align:center;font-size:13px;color:#9a9da6;">
              No teammates match —{' '}
              <a href="/app/team" style="color:#4c5fd5;font-weight:600;">
                clear filters
              </a>
            </div>
          ) : null}
          <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid #eceded;">
            <div style={`font-family:${MONO};font-size:11px;color:#686b74;`}>
              {rows.length === 0
                ? 'Showing 0 of 0'
                : `Showing ${cur * PAGE_SIZE + 1}–${Math.min(rows.length, (cur + 1) * PAGE_SIZE)} of ${rows.length}`}
            </div>
            {pages > 1 ? (
              <div style="margin-left:auto;display:flex;gap:6px;">
                {cur > 0 ? (
                  <a href={pageLink(cur - 1)} style={PG_ON}>
                    ← Prev
                  </a>
                ) : (
                  <span style={PG_OFF}>← Prev</span>
                )}
                {cur < pages - 1 ? (
                  <a href={pageLink(cur + 1)} style={PG_ON}>
                    Next →
                  </a>
                ) : (
                  <span style={PG_OFF}>Next →</span>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {canManage ? (
        <div id="invite-dialog" data-dialog hidden style={DIALOG_WRAP}>
          <div style={DIALOG_CARD}>
            <div style={DIALOG_HEAD}>
              <div style="font-size:15px;font-weight:700;">Invite a teammate</div>
              <button
                type="button"
                data-dialog-close="#invite-dialog"
                style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
              >
                ×
              </button>
            </div>
            <form method="post" action="/app/team/invite">
              <div style={DIALOG_BODY}>
                <div>
                  <div style={FIELD_LABEL}>Email *</div>
                  <input name="email" type="email" required placeholder="teammate@example.com" style={INPUT} />
                </div>
                <div>
                  <div style={FIELD_LABEL}>Role</div>
                  <select name="role" style="width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;background:#fff;">
                    {ROLES.filter((r) => r !== 'owner' || c.var.role === 'owner').map((r) => (
                      <option value={r} selected={r === 'collaborator'}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <div style="font-size:11.5px;color:#9a9da6;line-height:1.5;">
                  Invites are magic links — no password to set.
                </div>
              </div>
              <div style={DIALOG_FOOT}>
                <button type="button" data-dialog-close="#invite-dialog" style={CANCEL_BTN}>
                  Cancel
                </button>
                <button type="submit" style={PRIMARY_BTN}>
                  Send invite
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AdminLayout>
  );
});

const guard = requireOrgRole('admin');

app.post('/app/team/invite', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const email = String(body.email ?? '').trim();
  let role = String(body.role ?? 'collaborator');
  if (!ROLES.includes(role as Role)) role = 'collaborator';
  if (role === 'owner' && c.var.role !== 'owner') role = 'admin';
  if (!email.includes('@')) return c.redirect('/app/team');

  const existing = await one<{ user_id: string }>(
    c.env.DB,
    `SELECT m.user_id FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?`,
    event.org_id,
    email
  );
  if (existing) {
    return c.redirect('/app/team?ok=' + encodeURIComponent(`${email} is already on the team`));
  }

  const inviteId = newId('inv');
  await run(
    c.env.DB,
    `INSERT INTO invites (id, org_id, email, role, invited_by, status, created_at) VALUES (?,?,?,?,?,'pending',?)`,
    inviteId,
    event.org_id,
    email,
    role,
    c.var.user?.id ?? null,
    now()
  );

  const inviter = c.var.user?.name || c.var.user?.email || 'A teammate';
  const res = await requestMagicLink(
    c.env,
    email,
    'invite',
    { orgId: event.org_id, role, inviteId, next: '/app' },
    {
      eventId: event.id,
      subject: `${inviter} invited you to ${event.name} on Unsession`,
      text:
        `${inviter} added you as ${role} on ${event.name}.\n\n` +
        `Open the workspace — the link signs you in, no password needed:`,
    }
  );

  const suffix = res.simulatedLink ? `&link=${encodeURIComponent(res.simulatedLink)}` : '';
  return c.redirect(
    '/app/team?ok=' + encodeURIComponent(`Invite sent to ${email}`) + suffix
  );
});

app.post('/app/team/revoke', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  await run(
    c.env.DB,
    `UPDATE invites SET status = 'revoked' WHERE id = ? AND org_id = ?`,
    String(body.invite_id ?? ''),
    event.org_id
  );
  return c.redirect('/app/team?ok=' + encodeURIComponent('Invite revoked'));
});

app.post('/app/team/role', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const userId = String(body.user_id ?? '');
  let role = String(body.role ?? 'collaborator');
  if (!ROLES.includes(role as Role)) role = 'collaborator';
  if (role === 'owner' && c.var.role !== 'owner') return c.redirect('/app/team');
  if (userId === c.var.user?.id) return c.redirect('/app/team');
  await run(
    c.env.DB,
    `UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?`,
    role,
    event.org_id,
    userId
  );
  return c.redirect('/app/team?ok=' + encodeURIComponent('Role updated'));
});

export default app;
