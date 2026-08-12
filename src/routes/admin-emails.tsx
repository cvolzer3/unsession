/**
 * `/app/emails` — Templates + Log + Outbox tabs (spec §5.8). Templates are
 * grouped by category and edited on a full-page editor (`/app/emails/t/:id`)
 * with the shared rich-lite WYSIWYG island (DECISIONS C3/R3) and a
 * server-rendered themed preview. Multiple templates per key are allowed —
 * Duplicate creates “Copy of X” for the decision dialog's template picker.
 *
 * The Outbox tab is where queued decisions (lib/decision-queue) and queued
 * task reminders (lib/reminder-queue) are reviewed and actually sent —
 * deciding a submission or hitting Remind on a task queues it here, and
 * nothing reaches a speaker until an organizer sends from this page.
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { AdminLayout, MONO, StatusChip } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, now, one, run } from '../lib/db';
import { renderTemplate, sendEmail, wrapHtml } from '../lib/email';
import { looksRich, sanitizeRich } from '../lib/rich';
import { newId } from '../lib/ids';
import { requireOrgRole } from '../lib/auth';
import { parseTheme } from '../lib/theme';
import {
  listDecisionQueue,
  OUTBOX_SEND_LIMIT,
  queuedDecisionCount,
  removeQueuedDecisions,
  sendQueuedDecisions,
} from '../lib/decision-queue';
import {
  listReminderQueue,
  queuedReminderCount,
  removeQueuedReminders,
  sendQueuedReminders,
} from '../lib/reminder-queue';
import type { DecisionKind } from '../lib/decisions';

const app = new Hono<Ctx>();

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const INPUT = 'width:100%;padding:8px 12px;border:1px solid #e2e3e8;font-size:13px;outline-color:#4c5fd5;';

const VARIABLE_HINT: Record<string, string> = {
  accept: '{{speaker_name}}, {{session_title}}, {{event_name}}, {{event_dates}}, {{event_venue}}, {{confirmation_link}}',
  decline: '{{speaker_name}}, {{session_title}}, {{event_name}}, {{individual_feedback}}',
  waitlist: '{{speaker_name}}, {{session_title}}, {{event_name}}',
  reminder: '{{first_name}}, {{remaining}}, {{deadline}}, {{event_name}}, {{evaluate_link}}, {{organizer_name}}',
  task_nag: '{{speaker_name}}, {{task_name}}, {{due_date}}, {{days_left}}, {{event_name}}, {{portal_link}}',
  schedule_notice: '{{speaker_name}}, {{session_title}}, {{session_time}}, {{session_room}}, {{event_name}}, {{portal_link}}',
  confirm_submission: '{{speaker_name}}, {{session_title}}, {{event_name}}, {{portal_link}}',
};

/** Template list groups, in display order. Unknown/custom keys land in “Other”. */
const GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Decisions', keys: ['accept', 'waitlist', 'decline'] },
  { label: 'Submissions', keys: ['confirm_submission'] },
  { label: 'Speaker onboarding', keys: ['task_nag'] },
  { label: 'Scheduling', keys: ['schedule_notice'] },
  { label: 'Evaluation', keys: ['reminder'] },
];
const KNOWN_KEYS = new Set(GROUPS.flatMap((g) => g.keys));

/** Outbox display order + colors — mirrors the queued chips on /app/submissions. */
const OUTBOX_KINDS: { kind: DecisionKind; label: string; color: string }[] = [
  { kind: 'accept', label: 'Accept', color: '#2b8a3e' },
  { kind: 'waitlist', label: 'Waitlist', color: '#9c36b5' },
  { kind: 'decline', label: 'Decline', color: '#c92a2a' },
];


type TemplateRow = { id: string; key: string; name: string; subject: string; body: string; updated_at: string };

/** The dummy variable set used by “Send test to me” and the editor preview. */
function dummyVars(
  origin: string,
  event: { name: string; slug: string; start_date: string; end_date: string; venue?: string | null },
  user: { name?: string | null; email?: string } | null
): Record<string, string> {
  const userName = user?.name || 'there';
  return {
    speaker_name: userName,
    first_name: userName.split(' ')[0],
    session_title: 'Your session title',
    event_name: event.name,
    event_dates: `${event.start_date} – ${event.end_date}`,
    event_venue: event.venue ?? 'the venue',
    confirmation_link: `${origin}/${event.slug}/portal`,
    portal_link: `${origin}/${event.slug}/portal`,
    evaluate_link: `${origin}/${event.slug}/evaluate`,
    individual_feedback: '(individual feedback goes here)',
    organizer_name: user?.name || 'The program team',
    remaining: '3',
    deadline: 'Aug 24',
    task_name: 'Upload slides',
    due_date: 'Sep 14',
    days_left: '5 days',
    session_time: 'Day 1, 14:00',
    session_room: 'Main Stage',
  };
}

function tabStyle(active: boolean): string {
  return `padding:7px 14px;font-size:12.5px;cursor:pointer;border:none;font-weight:600;text-decoration:none;display:inline-block;${
    active ? 'background:#16171d;color:#fff;' : 'background:#fff;color:#686b74;'
  }`;
}

/** Underlined page-level tab, matching `/app/evaluation`. */
const subTab = (on: boolean) =>
  `padding:0 2px 10px;border-bottom:2px solid ${on ? '#4c5fd5' : 'transparent'};margin-bottom:-1px;font-size:13.5px;font-weight:600;color:${
    on ? '#16171d' : '#686b74'
  };text-decoration:none;display:inline-block;`;

app.get('/app/emails', async (c) => {
  const event = c.var.event;
  const props = await adminProps(c, 'Emails');
  if (!event) return c.redirect('/app/events/new');

  const tabParam = c.req.query('tab');
  const tab = tabParam === 'log' ? 'log' : tabParam === 'outbox' ? 'outbox' : 'templates';
  const statusFilter = c.req.query('status') ?? 'all';
  const detailId = c.req.query('id');

  const queuedDecisions = await queuedDecisionCount(c.env, event.id);
  const queuedReminders = await queuedReminderCount(c.env, event.id);
  const queuedCount = queuedDecisions + queuedReminders;
  const outboxRows = tab === 'outbox' ? await listDecisionQueue(c.env, event.id) : [];
  const reminderRows = tab === 'outbox' ? await listReminderQueue(c.env, event.id) : [];
  // Sending batches reminders per speaker (one email each) — show them grouped the same way.
  const reminderGroups: (typeof reminderRows)[] = [];
  {
    const bySpeaker = new Map<string, typeof reminderRows>();
    for (const r of reminderRows) {
      const g = bySpeaker.get(r.speaker_profile_id);
      if (g) g.push(r);
      else {
        const fresh = [r];
        bySpeaker.set(r.speaker_profile_id, fresh);
        reminderGroups.push(fresh);
      }
    }
  }

  const templates =
    tab === 'templates'
      ? await all<TemplateRow>(c.env.DB, `SELECT * FROM email_templates WHERE event_id = ? ORDER BY key, name`, event.id)
      : [];

  const sentByKey = new Map<string, number>();
  if (tab === 'templates') {
    const counts = await all<{ template_key: string; n: number }>(
      c.env.DB,
      `SELECT template_key, COUNT(*) AS n FROM emails WHERE event_id = ? AND template_key IS NOT NULL GROUP BY template_key`,
      event.id
    );
    for (const r of counts) sentByKey.set(r.template_key, r.n);
  }

  const sections = [
    ...GROUPS.map((g) => ({ label: g.label, rows: g.keys.flatMap((k) => templates.filter((t) => t.key === k)) })),
    { label: 'Other', rows: templates.filter((t) => !KNOWN_KEYS.has(t.key)) },
  ].filter((s) => s.rows.length);

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
    <div style="display:flex;gap:18px;border-bottom:1px solid #e2e3e8;margin-bottom:20px;">
      <a href="/app/emails" style={subTab(tab === 'templates')}>
        Templates
      </a>
      <a href="/app/emails?tab=log" style={subTab(tab === 'log')}>
        Log
      </a>
      <a href="/app/emails?tab=outbox" style={subTab(tab === 'outbox')}>
        {queuedCount > 0 ? `Outbox · ${queuedCount}` : 'Outbox'}
      </a>
    </div>
  );

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:24px 28px;max-width:1160px;">
        {tabs}
        {tab === 'templates' ? (
          <div style="display:grid;gap:18px;max-width:860px;">
            {sections.map((s) => (
              <div>
                <div style={`${MICRO}margin-bottom:6px;`}>{s.label.toUpperCase()}</div>
                <div style="background:#fff;border:1px solid #e2e3e8;">
                  {s.rows.map((t) => (
                    <a
                      href={`/app/emails/t/${t.id}`}
                      style="display:grid;grid-template-columns:220px minmax(0,1fr) 80px auto;gap:14px;align-items:center;padding:11px 14px;border-bottom:1px solid #f2f3f5;color:#16171d;text-decoration:none;"
                    >
                      <div style="font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        {t.name}
                      </div>
                      <div style="font-size:12.5px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        {t.subject}
                      </div>
                      <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;text-align:right;`}>
                        {`${sentByKey.get(t.key) ?? 0} sent`}
                      </div>
                      {/* the whole row is the link — this is the affordance, not a nested control */}
                      <span style="justify-self:end;padding:6px 14px;background:#4c5fd5;color:#fff;font-size:12px;font-weight:600;">
                        Edit
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : tab === 'outbox' ? (
          <div style="display:grid;gap:14px;max-width:1000px;">
            <div style="background:#fff;border:1px solid #e2e3e8;padding:16px 18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
              <div style="min-width:0;">
                <div style="font-size:15px;font-weight:700;">
                  {queuedCount > 0
                    ? `${[
                        queuedDecisions ? `${queuedDecisions} decision${queuedDecisions === 1 ? '' : 's'}` : '',
                        queuedReminders ? `${queuedReminders} task reminder${queuedReminders === 1 ? '' : 's'}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')} queued`
                    : 'The outbox is empty'}
                </div>
                {reminderRows.length > reminderGroups.length ? (
                  <div style="font-size:12px;color:#686b74;margin-top:2px;">
                    {`Task reminders batch per speaker — the ${reminderRows.length} reminders go out as ${
                      reminderGroups.length
                    } email${reminderGroups.length === 1 ? '' : 's'}.`}
                  </div>
                ) : null}
              </div>
              {queuedCount > 0 ? (
                <form method="post" action="/app/emails/outbox/send" style="margin-left:auto;">
                  <button
                    type="submit"
                    style="padding:10px 20px;background:#2b8a3e;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;"
                  >
                    {queuedCount > OUTBOX_SEND_LIMIT
                      ? `Send ${OUTBOX_SEND_LIMIT} of ${queuedCount} now`
                      : `Send all ${queuedCount} now`}
                  </button>
                </form>
              ) : null}
            </div>

            {OUTBOX_KINDS.map((k) => {
              const rows = outboxRows.filter((r) => r.decision === k.kind);
              if (!rows.length) return null;
              return (
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>{`${k.label.toUpperCase()} · ${rows.length}`}</div>
                  <div style="background:#fff;border:1px solid #e2e3e8;">
                    {rows.map((r) => (
                      <div style="display:grid;grid-template-columns:68px minmax(0,1fr) 220px 170px 80px;gap:12px;padding:11px 14px;border-bottom:1px solid #f2f3f5;align-items:center;">
                        <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{`SUB-${r.seq}`}</div>
                        <div style="min-width:0;">
                          <a
                            href={`/app/submissions?open=${r.submission_id}`}
                            style="font-size:13.5px;font-weight:600;color:#16171d;text-decoration:none;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                          >
                            {r.title}
                          </a>
                          <div style="font-size:11.5px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            {(r.subject || 'Subject from the event template') +
                              (r.feedback ? ' · individual feedback' : '') +
                              (k.kind === 'accept' && !r.request_confirmation ? ' · no confirmation requested' : '')}
                          </div>
                        </div>
                        <div style="min-width:0;">
                          <div style="font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            {r.speaker_name || 'No speaker on file'}
                          </div>
                          <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                            {r.speaker_email || 'status will change without an email'}
                          </div>
                        </div>
                        <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;`}>
                          {`${r.queued_by} · ${r.created_at.slice(0, 16).replace('T', ' ')}`}
                        </div>
                        <form method="post" action="/app/emails/outbox/remove" style="justify-self:end;">
                          <input type="hidden" name="id" value={r.id} />
                          <button
                            type="submit"
                            style="padding:6px 12px;background:#fff;border:1px solid #e2e3e8;font-size:12px;color:#c92a2a;cursor:pointer;"
                          >
                            Undo
                          </button>
                        </form>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {reminderRows.length ? (
              <div>
                <div style={`${MICRO}margin-bottom:6px;`}>
                  {`TASK REMINDERS · ${reminderRows.length} · ${reminderGroups.length} EMAIL${
                    reminderGroups.length === 1 ? '' : 'S'
                  } (ONE PER SPEAKER)`}
                </div>
                <div style="background:#fff;border:1px solid #e2e3e8;">
                  {reminderGroups.map((g) => (
                    <div style="border-bottom:1px solid #eceded;">
                      <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:#fafafb;">
                        <div style="min-width:0;">
                          <div style="font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            {g[0].speaker_name || 'No speaker on file'}
                          </div>
                          <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                            {g[0].speaker_email || '—'}
                          </div>
                        </div>
                        <span
                          title={
                            g.length === 1
                              ? 'This speaker gets one reminder email'
                              : `These ${g.length} reminders are batched — this speaker gets ONE email listing all of them`
                          }
                          style={`margin-left:auto;padding:2px 7px;font-size:10px;font-weight:600;white-space:nowrap;color:#b08800;border:1px dashed #b08800;font-family:${MONO};letter-spacing:0.04em;flex:none;`}
                        >
                          {g.length === 1 ? '1 EMAIL' : `1 EMAIL · ${g.length} REMINDERS`}
                        </span>
                      </div>
                      {g.map((r) => (
                        <div style="display:grid;grid-template-columns:minmax(0,1fr) 170px 80px;gap:12px;padding:8px 14px 8px 28px;border-bottom:1px solid #f2f3f5;align-items:center;">
                          <div style="min-width:0;">
                            <a
                              href={`/app/speakers?open=${r.speaker_profile_id}`}
                              style="font-size:13px;font-weight:600;color:#16171d;text-decoration:none;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                            >
                              {r.task_name}
                            </a>
                            <div style="font-size:11.5px;color:#9a9da6;">
                              {r.due_date ? `Due ${r.due_date}` : 'No due date'}
                            </div>
                          </div>
                          <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;`}>
                            {`${r.queued_by} · ${r.created_at.slice(0, 16).replace('T', ' ')}`}
                          </div>
                          <form method="post" action="/app/emails/outbox/remove" style="justify-self:end;">
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="kind" value="reminder" />
                            <button
                              type="submit"
                              style="padding:6px 12px;background:#fff;border:1px solid #e2e3e8;font-size:12px;color:#c92a2a;cursor:pointer;"
                            >
                              Undo
                            </button>
                          </form>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {queuedCount === 0 ? (
              <div style="background:#fff;border:1px solid #e2e3e8;padding:36px 16px;text-align:center;font-size:13px;color:#686b74;">
                Accept, decline or waitlist submissions from{' '}
                <a href="/app/submissions" style="color:#4c5fd5;font-weight:600;">
                  Submissions
                </a>{' '}
                or the evaluation view, or hit Remind on a speaker task — they collect here for one reviewed send.
              </div>
            ) : null}
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
                {looksRich(detail.body) ? (
                  <div style="font-size:13px;line-height:1.6;color:#33343c;max-width:620px;">{raw(sanitizeRich(detail.body))}</div>
                ) : (
                  <div style="font-size:13px;line-height:1.6;white-space:pre-wrap;color:#33343c;">{detail.body}</div>
                )}
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
    </AdminLayout>
  );
});

/* ------------------------------------------------------------- outbox */

/**
 * Outbox actions are posted from two places — this page's Outbox tab and the
 * queue panel on /app/submissions. A `back` form field (in-app paths only)
 * sends the redirect home to whichever page the organizer acted from.
 */
function backTo(form: Record<string, unknown>, fallback: string): string {
  const back = String(form.back ?? '');
  return back.startsWith('/app') && !back.includes('//') ? back : fallback;
}

app.post('/app/emails/outbox/send', requireOrgRole('admin'), async (c) => {
  const event = c.var.event!;
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  // The speakers page's queue panel labels its button with the reminder count,
  // so `only=reminders` must not also fire whatever decisions sit in the queue.
  const remindersOnly = String(form.only ?? '') === 'reminders';
  const res = remindersOnly
    ? { processed: 0, updated: 0, emailed: 0, simulated: 0, sessionsCreated: 0, skipped: [], remaining: 0 }
    : await sendQueuedDecisions(c.env, event.id, actor, OUTBOX_SEND_LIMIT);
  // Decisions and reminders share one send budget; reminders take what's left.
  const rem = await sendQueuedReminders(c.env, event.id, actor, OUTBOX_SEND_LIMIT - res.processed);

  const n = (x: number, word: string) => `${x} ${word}${x === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (res.processed || !rem.processed) {
    let d = `${n(res.updated, 'decision')} applied · ${n(res.emailed, 'email')}${
      res.emailed > 0 && res.simulated === res.emailed ? ' simulated (see Log)' : ' sent'
    }`;
    if (res.simulated && res.simulated !== res.emailed) d += ` (${res.simulated} simulated)`;
    parts.push(d);
  }
  if (rem.processed) {
    let r = `${n(rem.emailed, 'task reminder')}${
      rem.emailed > 0 && rem.simulated === rem.emailed ? ' simulated (see Log)' : ' sent'
    }`;
    if (rem.emails && rem.emails < rem.emailed) r += ` in ${n(rem.emails, 'email')} — batched per speaker`;
    parts.push(r);
  }
  let msg = parts.join(' · ');
  const skippedCount = res.skipped.length + rem.skipped.length;
  if (skippedCount) msg += ` · ${skippedCount} skipped — no longer sendable`;
  const remaining = res.remaining + rem.remaining;
  if (remaining) msg += ` · ${remaining} still queued — send again for the rest`;

  const dest = backTo(form, `/app/emails?tab=${remaining ? 'outbox' : 'log'}`);
  return c.redirect(`${dest}${dest.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}`);
});

app.post('/app/emails/outbox/remove', requireOrgRole('admin'), async (c) => {
  const event = c.var.event!;
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  const form = await c.req.parseBody();
  const id = String(form.id ?? '');
  const isReminder = String(form.kind ?? '') === 'reminder';
  const removed = !id
    ? 0
    : isReminder
      ? await removeQueuedReminders(c.env, event.id, [id], actor)
      : await removeQueuedDecisions(c.env, event.id, [id], actor);
  const msg = removed ? `${isReminder ? 'Reminder' : 'Decision'} undone — nothing was sent` : 'Already gone';
  const dest = backTo(form, '/app/emails?tab=outbox');
  return c.redirect(`${dest}${dest.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}`);
});

/* ------------------------------------------------------ full-page editor */

app.get('/app/emails/t/:id', async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  const t = await one<TemplateRow>(
    c.env.DB,
    `SELECT * FROM email_templates WHERE id = ? AND event_id = ?`,
    c.req.param('id'),
    event.id
  );
  if (!t) return c.redirect('/app/emails');

  const sent = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM emails WHERE event_id = ? AND template_key = ?`,
    event.id,
    t.key
  );

  const props = await adminProps(c, `Emails · ${t.name}`, {
    headerTitle: 'Edit template',
    scripts: ['/js/rich-editor.js'],
  });

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:24px 28px;max-width:860px;">
        <a href="/app/emails" style="font-size:12.5px;">
          ← Back to templates
        </a>
        <div style="background:#fff;border:1px solid #e2e3e8;margin-top:12px;">
          <form method="post" action={`/app/emails/t/${t.id}`}>
            <div style="padding:14px 24px;border-bottom:1px solid #e2e3e8;">
              <div style={MICRO}>{`TEMPLATE · ${t.key.toUpperCase()} · ${sent?.n ?? 0} SENT · EDITABLE PER SEND`}</div>
            </div>
            <div style="padding:18px 24px;display:grid;gap:14px;">
              <div style="display:grid;grid-template-columns:220px 1fr;gap:14px;">
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>NAME</div>
                  <input name="name" value={t.name} required style={`${INPUT}font-weight:600;`} />
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>SUBJECT</div>
                  <input name="subject" value={t.subject} required style={`${INPUT}font-weight:600;`} />
                </div>
              </div>
              <div>
                <div style="display:flex;align-items:center;margin-bottom:6px;">
                  <div style={MICRO}>BODY</div>
                  <div style="margin-left:auto;display:flex;border:1px solid #e2e3e8;">
                    <button type="button" id="tpl-editor-btn" style={tabStyle(true)}>
                      Editor
                    </button>
                    <button type="button" id="tpl-preview-btn" style={tabStyle(false)}>
                      Preview
                    </button>
                  </div>
                </div>
                <div id="tpl-editor-pane">
                  <textarea
                    name="body"
                    data-rich-editor="1"
                    rows={14}
                    style="width:100%;padding:10px 12px;border:1px solid #e2e3e8;font-size:13px;line-height:1.5;resize:vertical;outline-color:#4c5fd5;font-family:inherit;"
                  >
                    {t.body}
                  </textarea>
                </div>
                <div id="tpl-preview-pane" hidden>
                  <div id="tpl-preview-subject" style="font-size:14px;font-weight:700;margin-bottom:10px;"></div>
                  <iframe
                    id="tpl-preview-frame"
                    title="Email preview"
                    style="width:100%;height:460px;border:1px solid #e2e3e8;background:#f4f4f6;"
                  ></iframe>
                </div>
                <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:6px;`}>
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
              <button
                type="submit"
                formaction={`/app/emails/t/${t.id}/duplicate`}
                style="padding:9px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;"
              >
                Duplicate
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
    </AdminLayout>
  );
});

/** Themed preview for the editor's Preview tab — dummy vars, real wrapper. */
app.post('/app/emails/preview', async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event selected' }, 400);
  const payload = await c.req.json<{ subject?: string; body?: string }>().catch(() => null);
  if (!payload) return c.json({ ok: false, error: 'Bad request' }, 400);

  const vars = dummyVars(c.env.APP_ORIGIN, event, c.var.user);
  const subject = renderTemplate(String(payload.subject ?? ''), vars);
  const html = wrapHtml(renderTemplate(String(payload.body ?? ''), vars), {
    subject,
    theme: parseTheme(event.theme_json),
    eventName: event.name,
  });
  return c.json({ ok: true, subject, html });
});

app.post('/app/emails/t/:id', requireOrgRole('admin'), async (c) => {
  const event = c.var.event!;
  const id = c.req.param('id');
  const tpl = await one<{ id: string; key: string; name: string }>(
    c.env.DB,
    `SELECT id, key, name FROM email_templates WHERE id = ? AND event_id = ?`,
    id,
    event.id
  );
  if (!tpl) return c.redirect('/app/emails');

  const form = await c.req.parseBody();
  const name = String(form.name ?? '').trim() || tpl.name;
  const subject = String(form.subject ?? '').trim();
  const bodySource = String(form.body ?? '');
  const text = looksRich(bodySource) ? sanitizeRich(bodySource) : bodySource;
  const action = String(form.action ?? 'save');

  await run(
    c.env.DB,
    `UPDATE email_templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?`,
    name,
    subject,
    text,
    now(),
    id
  );

  if (action === 'test') {
    const user = c.var.user!;
    const vars = dummyVars(c.env.APP_ORIGIN, event, user);
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

  return c.redirect(`/app/emails/t/${id}?ok=` + encodeURIComponent(`“${name}” saved`));
});

app.post('/app/emails/t/:id/duplicate', requireOrgRole('admin'), async (c) => {
  const event = c.var.event!;
  const src = await one<TemplateRow>(
    c.env.DB,
    `SELECT * FROM email_templates WHERE id = ? AND event_id = ?`,
    c.req.param('id'),
    event.id
  );
  if (!src) return c.redirect('/app/emails');

  // From the editor page the form fields ride along — the copy keeps unsaved
  // edits; from the list row the form is empty and the stored row is copied.
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const baseName = String(form.name ?? '').trim() || src.name;
  const subject = String(form.subject ?? '').trim() || src.subject;
  const bodySource = typeof form.body === 'string' && form.body ? form.body : src.body;
  const body = looksRich(bodySource) ? sanitizeRich(bodySource) : bodySource;

  const id = newId('etp');
  const name = `Copy of ${baseName}`;
  try {
    await run(
      c.env.DB,
      `INSERT INTO email_templates (id, event_id, key, name, subject, body, updated_at) VALUES (?,?,?,?,?,?,?)`,
      id,
      event.id,
      src.key,
      name,
      subject,
      body,
      now()
    );
  } catch {
    return c.redirect(
      '/app/emails?ok=' + encodeURIComponent(`Couldn't duplicate — the database still allows one template per key`)
    );
  }
  return c.redirect(`/app/emails/t/${id}?ok=` + encodeURIComponent(`Duplicated — now editing “${name}”`));
});

export default app;
