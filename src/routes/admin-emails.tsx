/**
 * `/app/emails` — Templates + Log tabs (spec §5.8). The template editor reuses
 * the prototype's decision-modal editor styling (`Submissions.dc.html`).
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, MONO, StatusChip } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, now, one, run } from '../lib/db';
import { renderTemplate, sendEmail } from '../lib/email';
import { requireOrgRole } from '../lib/auth';
import { parseTheme } from '../lib/theme';

const app = new Hono<Ctx>();

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const DIALOG_WRAP = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;';

const VARIABLE_HINT: Record<string, string> = {
  accept: '{{speaker_name}}, {{session_title}}, {{event_name}}, {{event_dates}}, {{event_venue}}, {{confirmation_link}}',
  decline: '{{speaker_name}}, {{session_title}}, {{event_name}}, {{individual_feedback}}',
  waitlist: '{{speaker_name}}, {{session_title}}, {{event_name}}',
  reminder: '{{first_name}}, {{remaining}}, {{deadline}}, {{event_name}}, {{evaluate_link}}, {{organizer_name}}',
  task_nag: '{{speaker_name}}, {{task_name}}, {{due_date}}, {{days_left}}, {{event_name}}, {{portal_link}}',
  schedule_notice: '{{speaker_name}}, {{session_title}}, {{session_time}}, {{session_room}}, {{event_name}}, {{portal_link}}',
  confirm_submission: '{{speaker_name}}, {{session_title}}, {{event_name}}, {{portal_link}}',
};

function tabStyle(active: boolean): string {
  return `padding:7px 14px;font-size:12.5px;cursor:pointer;border:none;font-weight:600;text-decoration:none;display:inline-block;${
    active ? 'background:#16171d;color:#fff;' : 'background:#fff;color:#686b74;'
  }`;
}

app.get('/app/emails', async (c) => {
  const event = c.var.event;
  const props = await adminProps(c, 'Emails');
  if (!event) return c.redirect('/app/events/new');

  const tab = c.req.query('tab') === 'log' ? 'log' : 'templates';
  const statusFilter = c.req.query('status') ?? 'all';
  const detailId = c.req.query('id');

  const templates = await all<{ id: string; key: string; name: string; subject: string; body: string; updated_at: string }>(
    c.env.DB,
    `SELECT * FROM email_templates WHERE event_id = ? ORDER BY key`,
    event.id
  );

  const logRows =
    tab === 'log'
      ? await all<{
          id: string;
          created_at: string;
          to_email: string;
          to_name: string | null;
          template_key: string | null;
          subject: string;
          status: string;
        }>(
          c.env.DB,
          statusFilter === 'all'
            ? `SELECT id, created_at, to_email, to_name, template_key, subject, status FROM emails
                WHERE event_id = ? ORDER BY created_at DESC LIMIT 200`
            : `SELECT id, created_at, to_email, to_name, template_key, subject, status FROM emails
                WHERE event_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200`,
          ...(statusFilter === 'all' ? [event.id] : [event.id, statusFilter])
        )
      : [];

  const detail = detailId
    ? await one<{ subject: string; body: string; to_email: string; status: string; created_at: string; error: string | null }>(
        c.env.DB,
        `SELECT subject, body, to_email, status, created_at, error FROM emails WHERE id = ? AND event_id = ?`,
        detailId,
        event.id
      )
    : null;

  const tabs = (
    <div style="display:flex;border:1px solid #e2e3e8;width:fit-content;">
      <a href="/app/emails" style={tabStyle(tab === 'templates')}>
        Templates
      </a>
      <a href="/app/emails?tab=log" style={tabStyle(tab === 'log')}>
        Log
      </a>
    </div>
  );

  return c.html(
    <AdminLayout {...props} headerActions={tabs}>
      <div style="padding:24px 28px;max-width:1160px;">
        {tab === 'templates' ? (
          <div style="display:grid;gap:12px;max-width:760px;">
            {templates.map((t) => (
              <div style="background:#fff;border:1px solid #e2e3e8;padding:14px 16px;">
                <div style="display:flex;align-items:baseline;gap:10px;">
                  <div style="font-size:14.5px;font-weight:700;letter-spacing:-0.01em;">{t.name}</div>
                  <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`}>
                    {t.key.toUpperCase()}
                  </div>
                  <button
                    type="button"
                    data-dialog-open={`#tpl-${t.id}`}
                    style="margin-left:auto;background:none;border:none;padding:0;font-size:12.5px;color:#4c5fd5;cursor:pointer;"
                  >
                    Edit
                  </button>
                </div>
                <div style="font-size:13px;font-weight:600;margin-top:8px;">{t.subject}</div>
                <div style="font-size:12.5px;color:#686b74;line-height:1.5;margin-top:4px;white-space:pre-wrap;">
                  {t.body.length > 220 ? t.body.slice(0, 220) + '…' : t.body}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style="display:grid;gap:12px;">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <div style={MICRO}>FILTER</div>
              {['all', 'sent', 'queued', 'simulated', 'failed'].map((s) => (
                <a
                  href={`/app/emails?tab=log${s === 'all' ? '' : `&status=${s}`}`}
                  style={`padding:4px 10px;border:1px solid ${
                    statusFilter === s ? '#4c5fd5' : '#e2e3e8'
                  };background:${statusFilter === s ? '#eef0fb' : '#fff'};color:${
                    statusFilter === s ? '#4c5fd5' : '#686b74'
                  };font-size:12px;text-decoration:none;`}
                >
                  {s}
                </a>
              ))}
            </div>

            <div style="background:#fff;border:1px solid #e2e3e8;overflow-x:auto;">
              <div style={`display:grid;grid-template-columns:150px minmax(180px,1fr) 140px minmax(220px,2fr) 110px;padding:9px 14px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;color:#9a9da6;min-width:860px;`}>
                <div>TIME</div>
                <div>TO</div>
                <div>TEMPLATE</div>
                <div>SUBJECT</div>
                <div>STATUS</div>
              </div>
              {logRows.length ? (
                logRows.map((r) => (
                  <a
                    href={`/app/emails?tab=log${statusFilter === 'all' ? '' : `&status=${statusFilter}`}&id=${r.id}`}
                    style="display:grid;grid-template-columns:150px minmax(180px,1fr) 140px minmax(220px,2fr) 110px;padding:9px 14px;border-bottom:1px solid #f2f3f5;align-items:center;min-width:860px;color:#16171d;text-decoration:none;"
                  >
                    <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
                      {r.created_at.replace('T', ' ').replace('Z', '')}
                    </div>
                    <div style={`font-family:${MONO};font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                      {r.to_email}
                    </div>
                    <div style={`font-family:${MONO};font-size:11px;color:#686b74;`}>{r.template_key ?? '—'}</div>
                    <div style="font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px;">
                      {r.subject}
                    </div>
                    <div>
                      <StatusChip status={r.status} />
                    </div>
                  </a>
                ))
              ) : (
                <div style="padding:16px;font-size:12.5px;color:#9a9da6;">Nothing sent yet.</div>
              )}
            </div>

            {detail ? (
              <div style="background:#fff;border:1px solid #e2e3e8;padding:16px;">
                <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;">
                  <div style={MICRO}>MESSAGE</div>
                  <StatusChip status={detail.status} />
                  <a
                    href={`/app/emails?tab=log${statusFilter === 'all' ? '' : `&status=${statusFilter}`}`}
                    style="margin-left:auto;font-size:12px;"
                  >
                    Close
                  </a>
                </div>
                <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;margin-bottom:4px;`}>
                  {`${detail.created_at} · ${detail.to_email}`}
                </div>
                <div style="font-size:14px;font-weight:700;margin-bottom:10px;">{detail.subject}</div>
                <div style="font-size:13px;line-height:1.6;white-space:pre-wrap;color:#33343c;">{detail.body}</div>
                {detail.error ? (
                  <div style="margin-top:10px;border:1px solid #e03131;background:#fbe9e9;color:#c92a2a;padding:8px 10px;font-size:12.5px;">
                    {detail.error}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {templates.map((t) => (
        <div id={`tpl-${t.id}`} data-dialog hidden style={DIALOG_WRAP}>
          <div style="background:#fff;width:640px;max-width:calc(100vw - 48px);box-shadow:0 16px 48px rgba(22,23,29,0.25);">
            <form method="post" action="/app/emails/template">
              <input type="hidden" name="id" value={t.id} />
              <div style="padding:16px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
                <div style="font-weight:700;font-size:15px;">{`Edit template · ${t.name}`}</div>
                <button
                  type="button"
                  data-dialog-close={`#tpl-${t.id}`}
                  style="margin-left:auto;background:none;border:none;color:#9a9da6;cursor:pointer;font-size:15px;padding:0;"
                >
                  ✕
                </button>
              </div>
              <div style="padding:18px 24px;display:grid;gap:14px;">
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>{`EMAIL · TEMPLATE “${t.name}” · EDITABLE PER SEND`}</div>
                  <input
                    name="subject"
                    value={t.subject}
                    style="width:100%;padding:8px 12px;border:1px solid #e2e3e8;font-size:13px;font-weight:600;margin-bottom:6px;outline-color:#4c5fd5;"
                  />
                  <textarea
                    name="body"
                    rows={Math.min(20, t.body.split('\n').length + 1)}
                    style="width:100%;padding:10px 12px;border:1px solid #e2e3e8;font-size:13px;line-height:1.5;resize:vertical;outline-color:#4c5fd5;font-family:inherit;"
                  >
                    {t.body}
                  </textarea>
                  <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:4px;`}>
                    {`Variables resolve per recipient: ${VARIABLE_HINT[t.key] ?? '{{event_name}}'}`}
                  </div>
                </div>
              </div>
              <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
                <button
                  type="submit"
                  name="action"
                  value="test"
                  style="padding:9px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;margin-right:auto;"
                >
                  Send test to me
                </button>
                <button type="button" data-dialog-close={`#tpl-${t.id}`} style="padding:9px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;">
                  Cancel
                </button>
                <button
                  type="submit"
                  name="action"
                  value="save"
                  style="padding:9px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
                >
                  Save template
                </button>
              </div>
            </form>
          </div>
        </div>
      ))}
    </AdminLayout>
  );
});

app.post('/app/emails/template', requireOrgRole('admin'), async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const id = String(body.id ?? '');
  const subject = String(body.subject ?? '').trim();
  const text = String(body.body ?? '');
  const action = String(body.action ?? 'save');

  const tpl = await one<{ id: string; key: string; name: string }>(
    c.env.DB,
    `SELECT id, key, name FROM email_templates WHERE id = ? AND event_id = ?`,
    id,
    event.id
  );
  if (!tpl) return c.redirect('/app/emails');

  await run(
    c.env.DB,
    `UPDATE email_templates SET subject = ?, body = ?, updated_at = ? WHERE id = ?`,
    subject,
    text,
    now(),
    id
  );

  if (action === 'test') {
    const user = c.var.user!;
    const theme = parseTheme(event.theme_json);
    const vars: Record<string, string> = {
      speaker_name: user.name || 'there',
      first_name: (user.name || 'there').split(' ')[0],
      session_title: 'Your session title',
      event_name: event.name,
      event_dates: `${event.start_date} – ${event.end_date}`,
      event_venue: event.venue ?? 'the venue',
      confirmation_link: `${c.env.APP_ORIGIN}/${event.slug}/portal`,
      portal_link: `${c.env.APP_ORIGIN}/${event.slug}/portal`,
      evaluate_link: `${c.env.APP_ORIGIN}/${event.slug}/evaluate`,
      individual_feedback: '(individual feedback goes here)',
      organizer_name: user.name || 'The program team',
      remaining: '3',
      deadline: 'Aug 24',
      task_name: 'Upload slides',
      due_date: 'Sep 14',
      days_left: '5 days',
      session_time: 'Day 1, 14:00',
      session_room: 'Main Stage',
    };
    void theme;
    const res = await sendEmail(c.env, {
      eventId: event.id,
      to: user.email,
      toName: user.name,
      templateKey: tpl.key,
      subject: `[test] ${renderTemplate(subject, vars)}`,
      text: renderTemplate(text, vars),
      subjectType: 'email_template',
      subjectId: tpl.id,
    });
    const label =
      res.status === 'simulated'
        ? `Test logged as simulated — open the Log tab (email sending not yet enabled)`
        : `Test sent to ${user.email}`;
    return c.redirect('/app/emails?tab=log&ok=' + encodeURIComponent(label));
  }

  return c.redirect('/app/emails?ok=' + encodeURIComponent(`“${tpl.name}” saved`));
});

export default app;
