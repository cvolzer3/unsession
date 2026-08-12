/**
 * Speaker portal — `/{event}/portal`.
 *
 * Ported from `prototype/design_handoff_program/design/Speaker Portal.dc.html`,
 * themed with the event's tokens. Everything a speaker can do here is a real
 * form POST (confirm, withdraw, task toggle, upload, mini-form, profile) so the
 * portal works with JavaScript off; `public/js/portal.js` only adds the file
 * picker auto-submit, the headshot preview and the jump-to-profile scroll.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import type { Ctx, Event, Theme } from '../types';
import { PublicLayout, fmtDate } from '../views/layout';
import { loadPublicEvent } from '../lib/public';
import { all, one, run, now, jsonParse } from '../lib/db';
import { requestMagicLink } from '../lib/auth';
import { logActivity } from '../lib/activity';
import { sendEmail, renderTemplate } from '../lib/email';
import { confirmParticipation } from '../lib/confirm';
import { filesEnabled, saveUpload } from '../lib/files';
import * as T from '../lib/tasks';

const app = new Hono<Ctx>();

/* ---------------------------------------------------------------- styles */

const MONO = 'var(--font-mono)';
const LABEL = `font-family:${MONO};font-size:10.5px;letter-spacing:0.14em;color:var(--muted);`;
const CARD = 'background:var(--card);border:1px solid var(--border);';
const INPUT = 'width:100%;padding:9px 11px;border:1px solid var(--border-strong);font-size:13.5px;background:var(--card);color:var(--text);';
const DARK_BTN =
  'padding:8px 14px;background:var(--accent);color:#fff;border:none;font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;';
const SMALL_BTN =
  'padding:6px 12px;background:var(--card);border:1px solid var(--border-strong);font-size:12px;color:var(--text-secondary);cursor:pointer;';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function slotLine(event: Event, session: SessionRow, roomName: string | null): string | null {
  if (session.day === null || session.start_min === null) return null;
  const date = T.addDays(event.start_date, session.day);
  const dow = DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const hhmm = (min: number) => {
    const total = 8 * 60 + min;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  const end = session.end_min ?? session.start_min + (session.duration_min || 30);
  return `${dow} ${fmtDate(date)} · ${hhmm(session.start_min)}–${hhmm(end)}${roomName ? ` · ${roomName}` : ''}`;
}

/* ------------------------------------------------------------------ data */

type SessionRow = {
  id: string;
  title: string;
  day: number | null;
  start_min: number | null;
  end_min: number | null;
  duration_min: number;
  room_id: string | null;
  status: string;
  submission_id: string | null;
};

type SubmissionCard = {
  id: string;
  seq: number;
  status: string;
  title: string;
  formSlug: string;
  coSpeakers: string[];
  session: SessionRow | null;
  slot: string | null;
};

type ChecklistTask = {
  id: string;
  name: string;
  description: string;
  type: T.TaskType;
  required: boolean;
  status: string;
  due: string | null;
  overdue: boolean;
  locked: boolean;
  graceLocked: boolean;
  settings: T.TaskSettings;
  reviewNote: string | null;
  completedBy: string | null;
  sessionId: string | null;
  sessionTitle: string | null;
  files: { id: string; filename: string; version: number; created_at: string }[];
  form: T.MiniForm | null;
  response: Record<string, unknown> | null;
};

type PortalData = {
  profile: { id: string; name: string; email: string; bio: string; headshot_file_id: string | null } | null;
  submissions: SubmissionCard[];
  drafts: { id: string; title: string; formSlug: string }[];
  tasks: ChecklistTask[];
  confirmable: SubmissionCard[];
  confirmed: boolean;
};

async function loadPortal(env: Ctx['Bindings'], event: Event, email: string): Promise<PortalData> {
  const profile = await one<{ id: string; name: string; email: string; bio: string; headshot_file_id: string | null }>(
    env.DB,
    `SELECT id, name, email, bio, headshot_file_id FROM speaker_profiles WHERE event_id = ? AND email = ?`,
    event.id,
    email
  );

  const subs = await all<{
    id: string;
    seq: number;
    status: string;
    title: string;
    form_slug: string;
  }>(
    env.DB,
    `SELECT DISTINCT s.id, s.seq, s.status, s.title, f.slug AS form_slug
       FROM submissions s
       JOIN forms f ON f.id = s.form_id
       LEFT JOIN submission_speakers sp ON sp.submission_id = s.id
      WHERE s.event_id = ? AND (sp.email = ? OR s.owner_user_id IN (SELECT id FROM users WHERE email = ?))
      ORDER BY s.seq DESC`,
    event.id,
    email,
    email
  );

  const cards: SubmissionCard[] = [];
  const drafts: { id: string; title: string; formSlug: string }[] = [];
  for (const s of subs) {
    if (s.status === 'draft') {
      drafts.push({ id: s.id, title: s.title, formSlug: s.form_slug });
      continue;
    }
    const co = await all<{ name: string; email: string }>(
      env.DB,
      `SELECT name, email FROM submission_speakers WHERE submission_id = ? ORDER BY position`,
      s.id
    );
    const session = await one<SessionRow>(
      env.DB,
      `SELECT id, title, day, start_min, end_min, duration_min, room_id, status, submission_id
         FROM sessions WHERE submission_id = ? LIMIT 1`,
      s.id
    );
    const room = session?.room_id
      ? await one<{ name: string }>(env.DB, `SELECT name FROM rooms WHERE id = ?`, session.room_id)
      : null;
    cards.push({
      id: s.id,
      seq: s.seq,
      status: s.status,
      title: s.title,
      formSlug: s.form_slug,
      coSpeakers: co.filter((x) => x.email.toLowerCase() !== email.toLowerCase()).map((x) => x.name),
      session: session ?? null,
      slot: session ? slotLine(event, session, room?.name ?? null) : null,
    });
  }

  const sessionIds = profile
    ? (
        await all<{ session_id: string }>(
          env.DB,
          `SELECT session_id FROM session_speakers WHERE speaker_profile_id = ?`,
          profile.id
        )
      ).map((r) => r.session_id)
    : [];

  const taskRows = profile
    ? await all<T.TaskRow & { tpl_name: string | null; tpl_type: string | null; tpl_desc: string | null; tpl_required: number | null; tpl_lock: number | null; tpl_settings: string | null; tpl_grace: string | null }>(
        env.DB,
        `SELECT t.*, tt.name AS tpl_name, tt.type AS tpl_type, tt.description AS tpl_desc,
                tt.required AS tpl_required, tt.lock_on_complete AS tpl_lock,
                tt.settings_json AS tpl_settings, tt.grace_json AS tpl_grace
           FROM tasks t LEFT JOIN task_templates tt ON tt.id = t.template_id
          WHERE t.event_id = ? AND t.status != 'cancelled'
            AND (t.speaker_profile_id = ?${sessionIds.length ? ` OR t.session_id IN (${sessionIds.map(() => '?').join(',')})` : ''})`,
        event.id,
        profile.id,
        ...sessionIds
      )
    : [];

  const today = T.todayISO();
  const tasks: ChecklistTask[] = [];
  for (const t of T.dedupeTasks(taskRows)) {
    const oneOff = t.template_id ? null : jsonParse<T.OneOffSpec>(t.one_off_json, { name: 'Task', type: 'checkbox' });
    const settings = jsonParse<T.TaskSettings>(t.tpl_settings, {});
    const grace = T.parseGrace({ grace_json: t.tpl_grace });
    const type = (t.tpl_type ?? oneOff?.type ?? 'checkbox') as T.TaskType;
    const session = t.session_id
      ? await one<{ title: string }>(env.DB, `SELECT title FROM sessions WHERE id = ?`, t.session_id)
      : null;
    const files =
      type === 'file'
        ? await all<{ id: string; filename: string; version: number; created_at: string }>(
            env.DB,
            `SELECT id, filename, version, created_at FROM files
              WHERE subject_type = 'task' AND subject_id = ? ORDER BY version DESC`,
            t.id
          )
        : [];
    tasks.push({
      id: t.id,
      // A snapshot means the template changed after this instance was stamped —
      // the speaker keeps the wording they were given (tasks-spec §4.8.3).
      name: T.snapshotOf(t)?.name ?? t.tpl_name ?? oneOff?.name ?? 'Task',
      description: T.snapshotOf(t)?.description ?? t.tpl_desc ?? '',
      type,
      required: !!t.tpl_required,
      status: t.status,
      due: t.due_date,
      overdue: T.isOverdue(t, today),
      locked: !!t.tpl_lock && t.status === 'done',
      graceLocked: T.isGraceLocked(t, grace, today),
      settings,
      reviewNote: t.review_note,
      completedBy: t.completed_by,
      sessionId: t.session_id,
      sessionTitle: session?.title ?? null,
      files,
      form: type === 'form' ? T.formSpecOf(settings) : null,
      response: jsonParse<Record<string, unknown> | null>(t.response_json, null),
    });
  }
  tasks.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return (a.due ?? '9999').localeCompare(b.due ?? '9999');
  });

  return {
    profile,
    submissions: cards,
    drafts,
    tasks,
    confirmable: cards.filter((s) => s.status === 'accepted'),
    confirmed: cards.some((s) => s.status === 'confirmed'),
  };
}

/* ------------------------------------------------------------- fragments */

const StatusBadge: FC<{ status: string }> = ({ status }) => {
  const map: Record<string, [string, string, string]> = {
    accepted: ['ACCEPTED — CONFIRM TO GO PUBLIC', '#2b8a3e', '#e6f4ea'],
    confirmed: ['CONFIRMED ✓', '#087f5b', '#dcf2eb'],
    withdrawn: ['WITHDRAWN', '#868e96', '#f1f3f5'],
    declined: ['NOT THIS TIME', '#868e96', '#f1f3f5'],
    waitlisted: ['WAITLISTED', '#9c36b5', '#f6e8f9'],
    submitted: ['IN REVIEW', '#1c7ed6', '#e7f1fb'],
    in_review: ['IN REVIEW', '#1c7ed6', '#e7f1fb'],
  };
  const [label, fg, bg] = map[status] ?? [status.toUpperCase(), '#868e96', '#f1f3f5'];
  return (
    <span style={`display:inline-block;padding:3px 9px;font-size:11px;font-weight:600;color:${fg};background:${bg};font-family:${MONO};`}>
      {label}
    </span>
  );
};

const TaskRow: FC<{ task: ChecklistTask; slug: string; files: boolean }> = ({ task, slug, files }) => {
  const done = task.status === 'done';
  const review = task.status === 'pending_review';
  const boxStyle = `display:inline-grid;place-items:center;width:22px;height:22px;border:1.5px solid ${
    done ? 'var(--primary)' : review ? '#e8d79a' : 'var(--border-strong)'
  };background:${done ? 'var(--primary)' : review ? '#fdf5dc' : 'var(--card)'};color:${
    done ? 'var(--on-primary)' : '#b08800'
  };font-size:13px;flex-shrink:0;padding:0;`;
  const nameStyle = `font-size:14px;font-weight:600;${done ? 'color:var(--muted);text-decoration:line-through;' : ''}`;

  const cap = T.capMbOf(task.settings);
  const dueLine = done
    ? task.completedBy
      ? `Done — ${task.completedBy} ✓`
      : 'Done — thank you!'
    : review
      ? 'Pending review — the organizers will email you'
      : task.type === 'profile'
        ? 'Auto-completes when your profile is filled'
        : (task.overdue ? `Overdue — was due ${fmtDate(task.due)}` : task.due ? `Due ${fmtDate(task.due)}` : 'No due date') +
          (task.type === 'file'
            ? ` · ${(task.settings.ext || 'any file').toUpperCase()} · ${cap} MB · versioned`
            : task.type === 'form'
              ? ' · 2-minute mini-form'
              : '');
  const dueColor = task.overdue && !done ? '#c92a2a' : 'var(--muted)';

  const canAct = !done && !task.locked && !task.graceLocked;

  return (
    <div style="border-bottom:1px solid var(--chip);">
      <div style="display:flex;gap:12px;align-items:center;padding:13px 18px;">
        {task.type === 'checkbox' && !task.locked ? (
          <form method="post" action={`/${slug}/portal/task/toggle`} style="display:flex;">
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="done" value={done ? '0' : '1'} />
            <button type="submit" title={done ? 'Mark as not done' : 'Mark as done'} style={`${boxStyle}cursor:pointer;`}>
              {done ? '✓' : ''}
            </button>
          </form>
        ) : (
          <span style={`${boxStyle}cursor:default;`}>{done ? '✓' : review ? '⋯' : ''}</span>
        )}
        <div style="flex:1;min-width:0;">
          <div style={nameStyle}>
            {task.name}
            {task.required ? (
              <span style={`font-family:${MONO};font-size:9px;color:#b08800;margin-left:7px;`}>REQUIRED</span>
            ) : null}
          </div>
          <div style={`font-size:11.5px;color:${dueColor};`}>{dueLine}</div>
          {task.description ? (
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;line-height:1.45;">{task.description}</div>
          ) : null}
          {task.reviewNote ? (
            <div style="margin-top:6px;background:#fdf5dc;border:1px solid #e8d79a;color:#7a5c0a;padding:7px 9px;font-size:12px;line-height:1.45;">
              Changes requested: {task.reviewNote}
            </div>
          ) : null}
          {task.files.length ? (
            <div style={`font-family:${MONO};font-size:10.5px;color:var(--muted);margin-top:5px;`}>
              {task.files.length > 1
                ? `v${task.files[0].version} replaced v${task.files[1].version} · ${fmtDate(task.files[0].created_at)} · ${task.files[0].filename}`
                : `v1 · ${fmtDate(task.files[0].created_at)} · ${task.files[0].filename}`}
            </div>
          ) : null}
          {task.locked ? (
            <div style={`font-family:${MONO};font-size:10.5px;color:var(--muted);margin-top:5px;`}>
              🔒 LOCKED — CONTACT THE ORGANIZERS TO CHANGE THIS
            </div>
          ) : null}
          {task.graceLocked && !done ? (
            <div style={`font-family:${MONO};font-size:10.5px;color:#c92a2a;margin-top:5px;`}>
              PAST THE GRACE PERIOD — CONTACT THE ORGANIZERS
            </div>
          ) : null}
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex:none;">
          {task.type === 'checkbox' && task.settings.link && canAct ? (
            <a href={task.settings.link} target="_blank" rel="noreferrer" style={`${SMALL_BTN}text-decoration:none;`}>
              Open link ↗
            </a>
          ) : null}
          {task.type === 'file' && task.settings.sampleFileId ? (
            <a href={`/files/${task.settings.sampleFileId}`} style={`${SMALL_BTN}text-decoration:none;`}>
              Sample ↓
            </a>
          ) : null}
          {task.type === 'file' && canAct ? (
            files ? (
              <form method="post" action={`/${slug}/portal/task/upload`} enctype="multipart/form-data" data-upload style="display:flex;gap:6px;align-items:center;">
                <input type="hidden" name="taskId" value={task.id} />
                <label style={`${SMALL_BTN}display:inline-block;`}>
                  {task.files.length ? 'Replace' : 'Upload'}
                  <input type="file" name="file" hidden accept={(task.settings.ext || '').split(/[,\s]+/).filter(Boolean).map((e) => `.${e}`).join(',') || undefined} />
                </label>
                <noscript>
                  <button type="submit" style={SMALL_BTN}>
                    Send
                  </button>
                </noscript>
              </form>
            ) : (
              <span title="File storage not yet enabled" style={`${SMALL_BTN}color:var(--faint);cursor:not-allowed;`}>
                Upload
              </span>
            )
          ) : null}
          {task.type === 'form' && canAct ? (
            <button type="button" data-dialog-open={`#form-${task.id}`} style={SMALL_BTN}>
              {task.response ? 'Edit answers' : 'Open form'}
            </button>
          ) : null}
          {task.type === 'profile' && !done ? (
            <button type="button" data-jump-profile style={SMALL_BTN}>
              Jump to profile
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const MiniFormDialog: FC<{ task: ChecklistTask; slug: string }> = ({ task, slug }) => {
  if (!task.form) return null;
  const answers = task.response ?? {};
  return (
    <div id={`form-${task.id}`} data-dialog hidden style="position:fixed;inset:0;background:rgba(26,26,46,0.45);z-index:60;display:grid;place-items:center;padding:20px;">
      <div style="background:var(--card);width:460px;max-width:100%;padding:24px;">
        <div style="font-size:17px;font-weight:700;margin-bottom:4px;">{task.name}</div>
        <div style={`${LABEL}margin-bottom:14px;`}>{task.form.name.toUpperCase()}</div>
        <form method="post" action={`/${slug}/portal/task/form`} style="display:grid;gap:12px;">
          <input type="hidden" name="taskId" value={task.id} />
          {task.form.fields.map((f) => {
            const value = answers[f.id];
            return (
              <div>
                <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">
                  {f.label}
                  {f.required ? ' *' : ''}
                </div>
                {f.type === 'LONG' ? (
                  <textarea name={f.id} rows={3} required={f.required} placeholder={f.placeholder} style={`${INPUT}resize:vertical;font-family:inherit;`}>
                    {typeof value === 'string' ? value : ''}
                  </textarea>
                ) : f.type === 'SEL' ? (
                  <select name={f.id} required={f.required} style={INPUT}>
                    <option value="">Choose…</option>
                    {(f.opts ?? []).map((o) => (
                      <option value={o} selected={value === o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : f.type === 'CHK' ? (
                  <label style="display:flex;gap:8px;align-items:center;font-size:13.5px;">
                    <input type="checkbox" name={f.id} value="1" checked={!!value} required={f.required} />
                    <span>Yes</span>
                  </label>
                ) : (
                  <input
                    type={f.type === 'DATE' ? 'date' : 'text'}
                    name={f.id}
                    required={f.required}
                    placeholder={f.placeholder}
                    value={typeof value === 'string' ? value : ''}
                    style={INPUT}
                  />
                )}
              </div>
            );
          })}
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
            <button type="button" data-dialog-close={`#form-${task.id}`} style={`${SMALL_BTN}padding:9px 16px;font-size:13px;`}>
              Cancel
            </button>
            <button type="submit" style="padding:9px 16px;background:var(--primary);color:var(--on-primary);border:none;font-size:13px;font-weight:600;cursor:pointer;">
              Submit
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------- the page */

app.get('/:event/portal', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const { event, theme } = found;
  const user = c.var.user;
  const toast = c.req.query('ok') ?? null;

  if (!user) return c.html(<SignIn event={event} theme={theme} toast={toast} err={c.req.query('err') ?? null} sent={c.req.query('sent') ?? null} />);

  const data = await loadPortal(c.env, event, user.email);
  const files = filesEnabled(c.env);
  const first = (data.profile?.name || user.name || user.email).split(/[\s@]/)[0];
  const vars = {
    speaker_name: data.profile?.name || user.name || user.email,
    event_name: event.name,
  };

  const personal = data.tasks.filter((t) => !t.sessionId);
  const bySession = new Map<string, ChecklistTask[]>();
  for (const t of data.tasks) {
    if (!t.sessionId) continue;
    const list = bySession.get(t.sessionId) ?? [];
    list.push(t);
    bySession.set(t.sessionId, list);
  }
  const doneCount = data.tasks.filter((t) => t.status === 'done').length;
  const showChecklist = data.confirmed || data.tasks.length > 0;
  const live = data.submissions.filter((s) => s.status === 'accepted' || s.status === 'confirmed');

  return c.html(
    <PublicLayout
      title="Speaker portal"
      event={event}
      theme={theme}
      maxWidth={680}
      toast={toast}
      kicker={`${user.email.toUpperCase()} · MAGIC LINK`}
      scripts={['/js/portal.js']}
    >
      <div style="max-width:680px;margin:0 auto;padding:26px 20px 70px;">
        <h1 style="margin:0 0 4px;font-size:24px;letter-spacing:-0.02em;">{`Hi ${first} 👋`}</h1>
        <p style="margin:0 0 22px;font-size:14px;color:var(--text-secondary);">
          {`Everything about your ${event.name} sessions, in one place.`}
        </p>

        {data.confirmable.map((s) => {
          const confirmTask = data.tasks.find((t) => t.name.toLowerCase().startsWith('confirm'));
          const daysLeft = confirmTask?.due ? T.daysBetween(T.todayISO(), confirmTask.due) : null;
          return (
            <div style="border:2px solid var(--primary);background:var(--card);padding:18px 20px;margin-bottom:18px;">
              <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.14em;color:var(--primary);margin-bottom:6px;`}>
                {daysLeft !== null && daysLeft >= 0 ? `ACTION NEEDED · EXPIRES IN ${daysLeft} DAYS` : 'ACTION NEEDED'}
              </div>
              <div style="font-size:16px;font-weight:700;margin-bottom:4px;">Your session was accepted 🎉 Can you make it?</div>
              <div style="font-size:13.5px;color:var(--text-secondary);margin-bottom:14px;">
                {`Confirming puts “${s.title}” on the public agenda and unlocks your onboarding checklist.`}
              </div>
              <div style="display:flex;gap:8px;">
                <form method="post" action={`/${event.slug}/portal/confirm`}>
                  <input type="hidden" name="submissionId" value={s.id} />
                  <button type="submit" style="padding:10px 18px;background:var(--primary);color:var(--on-primary);border:none;font-size:13.5px;font-weight:700;cursor:pointer;">
                    Confirm participation
                  </button>
                </form>
                <button type="button" data-dialog-open="#dlg-withdraw" style="padding:10px 18px;background:var(--card);border:1px solid var(--border-strong);font-size:13.5px;color:var(--text-secondary);cursor:pointer;">
                  I can’t make it
                </button>
              </div>
            </div>
          );
        })}

        <div style={`${LABEL}margin-bottom:10px;`}>MY SUBMISSIONS</div>
        {data.submissions.length === 0 && data.drafts.length === 0 ? (
          <div style={`${CARD}padding:18px 20px;margin-bottom:24px;font-size:13.5px;color:var(--text-secondary);`}>
            Nothing here yet — this portal fills up once you submit a session and it gets a decision.
          </div>
        ) : null}
        {data.submissions.map((s) => (
          <div style={`${CARD}padding:18px 20px;margin-bottom:10px;`}>
            <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
              <StatusBadge status={s.status} />
              <span style={`font-family:${MONO};font-size:10.5px;color:var(--muted);`}>
                {`SUB-${s.seq}${s.coSpeakers.length ? ` · WITH ${s.coSpeakers.join(', ').toUpperCase()}` : ''}`}
              </span>
            </div>
            <div style="font-size:16.5px;font-weight:700;letter-spacing:-0.01em;">{s.title}</div>
            {s.status === 'confirmed' && s.slot ? (
              <>
                <div style="margin-top:18px;border:1px solid var(--border);background:var(--bg);padding:16px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
                  <div>
                    <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:var(--muted);`}>YOUR SLOT</div>
                    <div style="font-size:14px;font-weight:600;margin-top:2px;">{s.slot}</div>
                  </div>
                  <a href={`/${event.slug}/portal/session/${s.session?.id}.ics`} style={`${DARK_BTN}margin-left:auto;`}>
                    ＋ Add to calendar (.ics)
                  </a>
                </div>
                <div style="font-size:12px;color:var(--muted);margin-top:8px;">
                  If your time or room changes, you’ll get an updated calendar invite automatically.
                </div>
              </>
            ) : null}
            {s.status === 'confirmed' && !s.slot ? (
              <div style="font-size:12.5px;color:var(--muted);margin-top:10px;">
                You’re confirmed — we’ll email you the moment your slot is scheduled.
              </div>
            ) : null}
            {s.status === 'withdrawn' ? (
              <div style="margin-top:10px;font-size:13px;color:var(--muted);">
                You withdrew this session. The organizers were notified and it was removed from the agenda.
              </div>
            ) : null}
          </div>
        ))}
        {data.drafts.map((d) => (
          <div style={`${CARD}padding:14px 20px;margin-bottom:10px;display:flex;align-items:center;gap:10px;`}>
            <span style={`font-family:${MONO};font-size:10px;background:var(--chip);color:var(--muted);padding:3px 8px;font-weight:600;`}>
              DRAFT
            </span>
            <div style="font-size:14px;font-weight:600;color:var(--text-secondary);">
              {d.title || 'Untitled draft'}
            </div>
            <a href={`/${event.slug}/${d.formSlug}?draft=${d.id}`} style="margin-left:auto;font-size:12.5px;">
              Continue editing →
            </a>
          </div>
        ))}
        <div style="margin-bottom:24px;"></div>

        {showChecklist ? (
          <>
            <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px;">
              <div style={LABEL}>YOUR CHECKLIST</div>
              <div style={`font-family:${MONO};font-size:10.5px;color:var(--primary);`}>
                {`${doneCount} OF ${data.tasks.length} DONE`}
              </div>
            </div>
            <div style={`${CARD}margin-bottom:24px;`}>
              {data.tasks.length === 0 ? (
                <div style="padding:16px 18px;font-size:13px;color:var(--muted);">
                  No tasks yet — the organizers will add them here.
                </div>
              ) : null}
              {personal.map((t) => (
                <TaskRow task={{ ...t, description: renderTemplate(t.description, vars) }} slug={event.slug} files={files} />
              ))}
              {[...bySession.entries()].map(([sid, list]) => (
                <div>
                  <div style="padding:11px 18px;background:var(--bg);border-bottom:1px solid var(--chip);display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">
                    <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:var(--muted);`}>SESSION</div>
                    <div style="font-size:12.5px;font-weight:600;">{list[0].sessionTitle}</div>
                    <div style="font-size:11.5px;color:var(--muted);margin-left:auto;">any co-speaker can complete</div>
                  </div>
                  {list.map((t) => (
                    <TaskRow
                      task={{
                        ...t,
                        description: renderTemplate(t.description, { ...vars, session_title: t.sessionTitle ?? '' }),
                      }}
                      slug={event.slug}
                      files={files}
                    />
                  ))}
                  <div hidden data-session={sid}></div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div style={`${LABEL}margin-bottom:10px;`} id="profile">
          MY PROFILE · SHOWN ON THE PUBLIC AGENDA
        </div>
        <form
          method="post"
          action={`/${event.slug}/portal/profile`}
          enctype="multipart/form-data"
          style={`${CARD}padding:18px 20px;display:grid;gap:12px;margin-bottom:26px;`}
        >
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">Name</div>
              <input name="name" value={data.profile?.name ?? user.name ?? ''} style={INPUT} />
            </div>
            <div>
              <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">Email (locked by organizer)</div>
              <input
                value={user.email}
                disabled
                style={`${INPUT}background:var(--bg);color:var(--muted);font-family:${MONO};font-size:12.5px;`}
              />
            </div>
          </div>
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">Bio</div>
            <textarea name="bio" rows={2} style={`${INPUT}resize:vertical;font-family:inherit;`}>
              {data.profile?.bio ?? ''}
            </textarea>
          </div>
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">Headshot</div>
            <div style="display:flex;gap:12px;align-items:center;">
              <div
                id="headshot-preview"
                style={`width:56px;height:56px;border:1px solid var(--border-strong);background:${
                  data.profile?.headshot_file_id ? `url(/files/${data.profile.headshot_file_id}) center/cover` : 'var(--bg)'
                };display:grid;place-items:center;font-family:${MONO};font-size:9.5px;color:var(--muted);flex:none;`}
              >
                {data.profile?.headshot_file_id ? '' : 'NONE'}
              </div>
              {files ? (
                <label style={`${SMALL_BTN}display:inline-block;`}>
                  {data.profile?.headshot_file_id ? 'Replace headshot' : 'Upload headshot'}
                  <input type="file" name="headshot" accept="image/*" hidden data-headshot />
                </label>
              ) : (
                <span title="File storage not yet enabled" style={`${SMALL_BTN}color:var(--faint);cursor:not-allowed;`}>
                  Upload headshot
                </span>
              )}
              <span id="headshot-name" style={`font-family:${MONO};font-size:11px;color:var(--muted);`}></span>
            </div>
          </div>
          <button type="submit" style={`${DARK_BTN}justify-self:start;`}>
            Save profile
          </button>
        </form>

        {live.length ? (
          <div style="border-top:1px solid var(--border);padding-top:16px;font-size:12.5px;color:var(--muted);">
            Can’t speak anymore?{' '}
            <button type="button" data-dialog-open="#dlg-withdraw" style="background:none;border:none;color:#c92a2a;font-size:12.5px;cursor:pointer;text-decoration:underline;padding:0;">
              Withdraw your session
            </button>
            . The organizers are notified and your slot is freed.
          </div>
        ) : null}
      </div>

      {data.tasks.filter((t) => t.type === 'form').map((t) => (
        <MiniFormDialog task={t} slug={event.slug} />
      ))}

      {live.length ? (
        <div id="dlg-withdraw" data-dialog hidden style="position:fixed;inset:0;background:rgba(26,26,46,0.45);z-index:60;display:grid;place-items:center;padding:20px;">
          <div style="background:var(--card);width:440px;max-width:100%;padding:24px;">
            <div style="font-size:17px;font-weight:700;margin-bottom:8px;">{`Withdraw “${live[0].title}”?`}</div>
            <div style="font-size:13.5px;color:var(--text-secondary);line-height:1.55;margin-bottom:14px;">
              {`This notifies the ${event.name} organizers, removes your session from the published agenda, and cancels your calendar invite.${
                live[0].coSpeakers.length ? ` Your co-speaker ${live[0].coSpeakers[0].split(' ')[0]} will be notified too.` : ''
              } This can’t be undone from the portal.`}
            </div>
            <form method="post" action={`/${event.slug}/portal/withdraw`}>
              {live.length > 1 ? (
                <div style="margin-bottom:12px;">
                  <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Which session?</div>
                  <select name="submissionId" style={INPUT}>
                    {live.map((s) => (
                      <option value={s.id}>{s.title}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <input type="hidden" name="submissionId" value={live[0].id} />
              )}
              <div style="margin-bottom:16px;">
                <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Why are you withdrawing? (optional)</div>
                <textarea
                  name="reason"
                  rows={2}
                  placeholder="e.g. Schedule conflict — happy to speak next year"
                  style={`${INPUT}resize:vertical;font-family:inherit;`}
                ></textarea>
              </div>
              <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" data-dialog-close="#dlg-withdraw" style="padding:9px 16px;background:var(--card);border:1px solid var(--border-strong);font-size:13px;cursor:pointer;">
                  Cancel withdraw
                </button>
                <button type="submit" style="padding:9px 16px;background:#c92a2a;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">
                  Withdraw
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </PublicLayout>
  );
});

/* ------------------------------------------------------------- sign-in */

const SignIn: FC<{ event: Event; theme: Theme; toast: string | null; err: string | null; sent: string | null }> = ({
  event,
  theme,
  toast,
  err,
  sent,
}) => (
  <PublicLayout title="Speaker portal" event={event} theme={theme} maxWidth={520} toast={toast} kicker="SPEAKER PORTAL">
    <div style="max-width:520px;margin:0 auto;padding:40px 20px 70px;">
      <h1 style="margin:0 0 4px;font-size:24px;letter-spacing:-0.02em;">Speaker portal</h1>
      <p style="margin:0 0 22px;font-size:14px;color:var(--text-secondary);">
        {`Sign in with the email you used to submit to ${event.name}. No password — we send a magic link.`}
      </p>
      {sent ? (
        <div style="border:1px solid var(--primary-border);background:var(--primary-tint);padding:14px 16px;margin-bottom:16px;">
          <div style="font-size:13.5px;font-weight:600;margin-bottom:4px;">Check your email</div>
          <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5;">
            The link works once and expires in 30 minutes.
          </div>
          {sent.startsWith('http') ? (
            <div style="margin-top:10px;font-size:12.5px;word-break:break-all;">
              <div style={`${LABEL}margin-bottom:4px;`}>DEV MODE — EMAIL SENDING NOT YET ENABLED</div>
              <a href={sent}>{sent}</a>
            </div>
          ) : null}
        </div>
      ) : null}
      {err ? (
        <div style="border:1px solid #e03131;background:#fbe9e9;color:#c92a2a;padding:9px 11px;font-size:12.5px;margin-bottom:14px;">
          {err}
        </div>
      ) : null}
      <form method="post" action={`/${event.slug}/portal/signin`} style={`${CARD}padding:20px;display:grid;gap:12px;`}>
        <div>
          <div style={`${LABEL}margin-bottom:5px;`}>EMAIL</div>
          <input name="email" type="email" required placeholder="you@example.com" style={INPUT} />
        </div>
        <button type="submit" style="padding:11px;background:var(--primary);color:var(--on-primary);border:none;font-size:14px;font-weight:600;cursor:pointer;">
          Email me a sign-in link
        </button>
      </form>
    </div>
  </PublicLayout>
);

app.post('/:event/portal/signin', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const body = await c.req.parseBody();
  const email = String(body.email ?? '').trim();
  const back = `/${found.event.slug}/portal`;
  if (!email.includes('@')) return c.redirect(`${back}?err=${encodeURIComponent('Enter a valid email address')}`);
  const res = await requestMagicLink(
    c.env,
    email,
    'signin',
    { next: back },
    {
      eventId: found.event.id,
      subject: `Your ${found.event.name} speaker portal link`,
      text: `Here is your sign-in link for the ${found.event.name} speaker portal. It works once and expires in 30 minutes.`,
    }
  );
  return c.redirect(`${back}?sent=${encodeURIComponent(res.simulatedLink ?? '1')}`);
});

/* ------------------------------------------------------------ mutations */

type Guard = { event: Event; email: string; profileId: string | null; name: string };

async function guard(c: Context<Ctx>): Promise<Guard | Response> {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event') ?? '');
  if (!found) return c.notFound();
  const user = c.var.user;
  if (!user) return c.redirect(`/${found.event.slug}/portal`);
  const profile = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM speaker_profiles WHERE event_id = ? AND email = ?`,
    found.event.id,
    user.email
  );
  // Completions are attributed by name — co-speakers read "Done — Maria ✓".
  return {
    event: found.event,
    email: user.email,
    profileId: profile?.id ?? null,
    name: profile?.name || user.name || user.email,
  };
}

function back(c: { redirect: (u: string) => Response }, slug: string, message: string): Response {
  return c.redirect(`/${slug}/portal?ok=${encodeURIComponent(message)}`);
}

/** Is this task the signed-in speaker's to complete? */
async function ownsTask(
  env: Ctx['Bindings'],
  g: Guard,
  taskId: string
): Promise<(T.TaskRow & { tpl_type: string | null; tpl_settings: string | null; tpl_lock: number | null; tpl_grace: string | null; tpl_name: string | null }) | null> {
  const task = await one<
    T.TaskRow & { tpl_type: string | null; tpl_settings: string | null; tpl_lock: number | null; tpl_grace: string | null; tpl_name: string | null }
  >(
    env.DB,
    `SELECT t.*, tt.type AS tpl_type, tt.settings_json AS tpl_settings, tt.lock_on_complete AS tpl_lock,
            tt.grace_json AS tpl_grace, tt.name AS tpl_name
       FROM tasks t LEFT JOIN task_templates tt ON tt.id = t.template_id
      WHERE t.id = ? AND t.event_id = ? AND t.status != 'cancelled'`,
    taskId,
    g.event.id
  );
  if (!task || !g.profileId) return null;
  if (task.speaker_profile_id === g.profileId) return task;
  if (task.session_id) {
    const link = await one(
      env.DB,
      `SELECT 1 FROM session_speakers WHERE session_id = ? AND speaker_profile_id = ?`,
      task.session_id,
      g.profileId
    );
    if (link) return task;
  }
  return null;
}

app.post('/:event/portal/confirm', async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  const body = await c.req.parseBody();
  const submissionId = String(body.submissionId ?? '');
  const owns = await one(
    c.env.DB,
    `SELECT 1 FROM submissions s JOIN submission_speakers sp ON sp.submission_id = s.id
      WHERE s.id = ? AND s.event_id = ? AND sp.email = ?`,
    submissionId,
    g.event.id,
    g.email
  );
  if (!owns) return back(c, g.event.slug, 'That session isn’t yours to confirm');
  const res = await confirmParticipation(c.env, submissionId, g.name);
  if (!res.ok) return back(c, g.event.slug, 'That session can’t be confirmed right now');
  const open = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM tasks WHERE event_id = ? AND status = 'open'
       AND (speaker_profile_id = ? OR session_id IN (SELECT session_id FROM session_speakers WHERE speaker_profile_id = ?))`,
    g.event.id,
    g.profileId ?? '',
    g.profileId ?? ''
  );
  return back(
    c,
    g.event.slug,
    res.already
      ? 'Already confirmed — see you there!'
      : `Confirmed! You’re on the agenda — ${open?.n ?? 0} onboarding tasks generated below.`
  );
});

app.post('/:event/portal/withdraw', async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  const body = await c.req.parseBody();
  const submissionId = String(body.submissionId ?? '');
  const reason = String(body.reason ?? '').trim();
  const sub = await one<{ id: string; title: string; status: string }>(
    c.env.DB,
    `SELECT s.id, s.title, s.status FROM submissions s JOIN submission_speakers sp ON sp.submission_id = s.id
      WHERE s.id = ? AND s.event_id = ? AND sp.email = ?`,
    submissionId,
    g.event.id,
    g.email
  );
  if (!sub) return back(c, g.event.slug, 'That session isn’t yours to withdraw');

  await run(
    c.env.DB,
    `UPDATE submissions SET status = 'withdrawn', withdraw_reason = ?, updated_at = ? WHERE id = ?`,
    reason || null,
    now(),
    sub.id
  );
  const sessions = await all<{ id: string; title: string }>(
    c.env.DB,
    `SELECT id, title FROM sessions WHERE submission_id = ?`,
    sub.id
  );
  for (const s of sessions) {
    await run(
      c.env.DB,
      `UPDATE sessions SET day = NULL, start_min = NULL, end_min = NULL, room_id = NULL, published = 0,
         status = 'pending', updated_at = ? WHERE id = ?`,
      now(),
      s.id
    );
  }
  await T.cancelOpenTasks(c.env, sub.id);

  // Organizers (org owners/admins) + co-speakers hear about it immediately.
  const organizers = await all<{ email: string; name: string | null }>(
    c.env.DB,
    `SELECT u.email, u.name FROM org_members m JOIN users u ON u.id = m.user_id
       JOIN events e ON e.org_id = m.org_id
      WHERE e.id = ? AND m.role IN ('owner','admin')`,
    g.event.id
  );
  const cospeakers = await all<{ email: string; name: string }>(
    c.env.DB,
    `SELECT email, name FROM submission_speakers WHERE submission_id = ? AND email != ?`,
    sub.id,
    g.email
  );
  const who = g.name;

  for (const o of organizers) {
    await sendEmail(c.env, {
      eventId: g.event.id,
      to: o.email,
      toName: o.name,
      templateKey: null,
      subject: `Withdrawn: “${sub.title}” — ${g.event.name}`,
      text:
        `${who} (${g.email}) withdrew “${sub.title}” from ${g.event.name}.\n\n` +
        (reason ? `Reason given: ${reason}\n\n` : 'No reason given.\n\n') +
        `The session was unscheduled and unpublished, and its open tasks were cancelled.\n${c.env.APP_ORIGIN}/app/submissions`,
      subjectType: 'submission',
      subjectId: sub.id,
    });
  }
  for (const cs of cospeakers) {
    await sendEmail(c.env, {
      eventId: g.event.id,
      to: cs.email,
      toName: cs.name,
      templateKey: null,
      subject: `“${sub.title}” was withdrawn from ${g.event.name}`,
      text:
        `Hi ${cs.name},\n\n${who} withdrew “${sub.title}” from ${g.event.name}. The organizers have been notified and the session is off the agenda.\n\n` +
        `If that is a surprise, talk to the organizers before the schedule is republished.\n\n${c.env.APP_ORIGIN}/${g.event.slug}/portal`,
      subjectType: 'submission',
      subjectId: sub.id,
    });
  }

  await logActivity(c.env.DB, {
    eventId: g.event.id,
    subjectType: 'submission',
    subjectId: sub.id,
    actor: who,
    action: 'Speaker withdrew',
    detail: `${reason ? `“${reason}” · ` : ''}${organizers.length} organizer(s) and ${cospeakers.length} co-speaker(s) notified`,
  });

  return back(
    c,
    g.event.slug,
    'Withdrawn. Organizers notified — your slot is free again and your open tasks were cancelled.'
  );
});

app.post('/:event/portal/task/toggle', async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  const body = await c.req.parseBody();
  const task = await ownsTask(c.env, g, String(body.taskId ?? ''));
  if (!task) return back(c, g.event.slug, 'That task isn’t on your checklist');
  if (task.tpl_lock && task.status === 'done') return back(c, g.event.slug, 'That task is locked — contact the organizers');
  const done = String(body.done ?? '1') === '1';
  await T.setTaskDone(c.env, task, done, g.name);
  return back(c, g.event.slug, done ? `“${task.tpl_name ?? 'Task'}” done ✓` : `“${task.tpl_name ?? 'Task'}” reopened`);
});

app.post('/:event/portal/task/upload', async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  if (!filesEnabled(c.env)) return back(c, g.event.slug, 'File storage not yet enabled');
  const form = await c.req.formData();
  const task = await ownsTask(c.env, g, String(form.get('taskId') ?? ''));
  if (!task) return back(c, g.event.slug, 'That task isn’t on your checklist');
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) return back(c, g.event.slug, 'Pick a file first');
  const settings = jsonParse<T.TaskSettings>(task.tpl_settings, {});
  const res = await saveUpload(c.env, {
    eventId: g.event.id,
    kind: 'task_file',
    subjectType: 'task',
    subjectId: task.id,
    file,
    uploadedBy: g.email,
    maxMb: T.capMbOf(settings),
    allowedExts: settings.ext,
  });
  if (!res.ok) return back(c, g.event.slug, res.error);
  // A headshot request feeds the profile picture the agenda and the ZIP use.
  const exts = (settings.ext || '')
    .split(/[\s,]+/)
    .map((e) => e.replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  const isHeadshot =
    (task.tpl_name ?? '').toLowerCase().includes('headshot') ||
    (exts.length > 0 && exts.every((e) => ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(e)));
  if (isHeadshot && g.profileId && task.target_type !== 'session') {
    await run(c.env.DB, `UPDATE speaker_profiles SET headshot_file_id = ? WHERE id = ?`, res.file.id, g.profileId);
    await T.autoCompleteProfileTasks(c.env, g.profileId, g.name);
  }
  const status = await T.completeFileTask(c.env, task, settings, g.name, res.file.filename);
  return back(
    c,
    g.event.slug,
    status === 'pending_review'
      ? `Uploaded — “${task.tpl_name ?? 'File'}” is pending review${res.file.version > 1 ? ` · v${res.file.version} replaced v${res.file.version - 1}` : ''}`
      : `Uploaded — “${task.tpl_name ?? 'File'}” is done${res.file.version > 1 ? ` · v${res.file.version} replaced v${res.file.version - 1}` : ''}`
  );
});

app.post('/:event/portal/task/form', async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  const body = await c.req.parseBody();
  const task = await ownsTask(c.env, g, String(body.taskId ?? ''));
  if (!task) return back(c, g.event.slug, 'That task isn’t on your checklist');
  const spec = T.formSpecOf(jsonParse<T.TaskSettings>(task.tpl_settings, {}));
  const answers: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const raw = body[f.id];
    answers[f.id] = f.type === 'CHK' ? raw === '1' || raw === 'on' : String(raw ?? '');
    if (f.required && !answers[f.id]) return back(c, g.event.slug, `“${f.label}” is required`);
  }
  await T.submitTaskForm(c.env, task, answers, g.name);
  return back(c, g.event.slug, `“${task.tpl_name ?? 'Form'}” submitted — thank you!`);
});

app.post('/:event/portal/profile', async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  const form = await c.req.formData();
  const name = String(form.get('name') ?? '').trim();
  const bio = String(form.get('bio') ?? '').trim();

  let profileId = g.profileId;
  if (!profileId) {
    const { slugify, uniqueSlug } = await import('../lib/slugify');
    const slug = await uniqueSlug(slugify(name || g.email.split('@')[0], 'speaker'), async (candidate) =>
      !!(await one(c.env.DB, `SELECT 1 FROM speaker_profiles WHERE event_id = ? AND slug = ?`, g.event.id, candidate))
    );
    const { newId } = await import('../lib/ids');
    profileId = newId('spk');
    await run(
      c.env.DB,
      `INSERT INTO speaker_profiles (id, event_id, user_id, email, name, bio, headshot_file_id, slug, created_at)
       VALUES (?,?,?,?,?,?,NULL,?,?)`,
      profileId,
      g.event.id,
      c.var.user?.id ?? null,
      g.email,
      name || g.email,
      bio,
      slug,
      now()
    );
  } else {
    await run(c.env.DB, `UPDATE speaker_profiles SET name = ?, bio = ? WHERE id = ?`, name, bio, profileId);
  }

  const headshot = form.get('headshot');
  let uploaded = false;
  if (headshot instanceof File && headshot.size && filesEnabled(c.env)) {
    const res = await saveUpload(c.env, {
      eventId: g.event.id,
      kind: 'headshot',
      subjectType: 'speaker',
      subjectId: profileId,
      file: headshot,
      uploadedBy: g.email,
      maxMb: 25,
      allowedExts: 'jpg, jpeg, png, webp',
    });
    if (!res.ok) return back(c, g.event.slug, res.error);
    await run(c.env.DB, `UPDATE speaker_profiles SET headshot_file_id = ? WHERE id = ?`, res.file.id, profileId);
    uploaded = true;
  }

  const auto = await T.autoCompleteProfileTasks(c.env, profileId, g.name);
  await logActivity(c.env.DB, {
    eventId: g.event.id,
    subjectType: 'speaker',
    subjectId: profileId,
    actor: g.name,
    action: 'Profile updated',
    detail: uploaded ? 'Name, bio, headshot' : 'Name, bio',
  });
  return back(
    c,
    g.event.slug,
    auto
      ? 'Profile saved — “Complete profile” ticked itself off ✓'
      : 'Profile saved — the public agenda updates on next publish'
  );
});

export default app;
