/** `/app/team` — members, email invites (magic-link accept), pending invites (spec §5.7). */
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
const ROLES: Role[] = ['owner', 'admin', 'collaborator'];

const ROLE_HINT: Record<Role, string> = {
  owner: 'Full control, including billing and deleting the workspace.',
  admin: 'Everything except workspace deletion — can manage team and events.',
  collaborator: 'Works inside events: submissions, evaluation, sessions, speakers.',
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

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:24px 28px;display:grid;grid-template-columns:minmax(0,620px) minmax(300px,380px);gap:24px;align-items:start;max-width:1160px;">
        <div style="display:grid;gap:18px;">
          <div style={CARD}>
            <div style={`padding:12px 16px;border-bottom:1px solid #eceded;${MICRO}`}>
              {`MEMBERS · ${members.length}`}
            </div>
            <div style={`display:grid;grid-template-columns:minmax(160px,1fr) minmax(180px,1fr) 130px 110px;gap:0;padding:9px 16px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;color:#9a9da6;align-items:center;`}>
              <div>NAME</div>
              <div>EMAIL</div>
              <div>ROLE</div>
              <div>JOINED</div>
            </div>
            {members.map((m) => (
              <div style="display:grid;grid-template-columns:minmax(160px,1fr) minmax(180px,1fr) 130px 110px;padding:10px 16px;border-bottom:1px solid #f2f3f5;align-items:center;">
                <div style="display:flex;align-items:center;gap:9px;min-width:0;">
                  <div style={`width:26px;height:26px;border-radius:50%;background:#4c5fd5;color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:10px;font-weight:600;flex:none;`}>
                    {initials(m.name || m.email)}
                  </div>
                  <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    {m.name || '—'}
                  </div>
                </div>
                <div style={`font-family:${MONO};font-size:11.5px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                  {m.email}
                </div>
                <div>
                  {canManage && m.id !== c.var.user?.id ? (
                    <form method="post" action="/app/team/role" style="display:flex;gap:6px;align-items:center;">
                      <input type="hidden" name="user_id" value={m.id} />
                      <select
                        name="role"
                        onchange="this.form.submit()"
                        style="padding:5px 6px;border:1px solid #e2e3e8;font-size:12px;background:#fff;"
                      >
                        {ROLES.map((r) => (
                          <option value={r} selected={r === m.role}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </form>
                  ) : (
                    <StatusChip status="pending" label={m.role} />
                  )}
                </div>
                <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{fmtDate(m.created_at, true)}</div>
              </div>
            ))}
          </div>

          <div style={CARD}>
            <div style={`padding:12px 16px;border-bottom:1px solid #eceded;${MICRO}`}>
              {`PENDING INVITES · ${invites.length}`}
            </div>
            {invites.length ? (
              invites.map((i) => (
                <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #f2f3f5;">
                  <div style={`font-family:${MONO};font-size:12px;color:#16171d;`}>{i.email}</div>
                  <StatusChip status="pending" label={i.role} />
                  <div style={`margin-left:auto;font-family:${MONO};font-size:10.5px;color:#9a9da6;`}>
                    {fmtDate(i.created_at, true)}
                  </div>
                  {canManage ? (
                    <form method="post" action="/app/team/revoke">
                      <input type="hidden" name="invite_id" value={i.id} />
                      <button
                        type="submit"
                        style="background:none;border:none;padding:0;font-size:12px;color:#c92a2a;cursor:pointer;"
                      >
                        Revoke
                      </button>
                    </form>
                  ) : null}
                </div>
              ))
            ) : (
              <div style="padding:14px 16px;font-size:12.5px;color:#9a9da6;">No invites waiting.</div>
            )}
          </div>
        </div>

        <div style="display:grid;gap:18px;position:sticky;top:20px;">
          <div style="background:#fff;border:1px solid #e2e3e8;padding:18px 20px;">
            <div style={`${MICRO}margin-bottom:12px;`}>INVITE A TEAMMATE</div>
            {canManage ? (
              <form method="post" action="/app/team/invite" style="display:grid;gap:12px;">
                <div>
                  <div style="font-size:12px;color:#686b74;margin-bottom:4px;">Email *</div>
                  <input name="email" type="email" required placeholder="teammate@example.com" style={INPUT} />
                </div>
                <div>
                  <div style="font-size:12px;color:#686b74;margin-bottom:4px;">Role</div>
                  <select name="role" style="width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;background:#fff;">
                    {ROLES.filter((r) => r !== 'owner' || c.var.role === 'owner').map((r) => (
                      <option value={r} selected={r === 'collaborator'}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <div style="font-size:11.5px;color:#9a9da6;line-height:1.5;">
                  {ROLE_HINT.collaborator} Invites are magic links — no password to set.
                </div>
                <button
                  type="submit"
                  style="padding:9px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
                >
                  Send invite
                </button>
              </form>
            ) : (
              <div style="font-size:12.5px;color:#686b74;">Owners and admins manage the team.</div>
            )}
          </div>

          {inviteLink ? (
            <div style="border:1px solid #b08800;background:#fdf5dc;padding:12px 14px;">
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
        </div>
      </div>
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
