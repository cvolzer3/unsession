/**
 * `/app/files` — the central files library: every upload in the event,
 * aggregated by version chain (the same kind + subject triple `saveUpload`
 * versions on), with speaker/session association, the full version history
 * and the cross-role comment thread from migration 0021.
 *
 * Server-rendered: the kind filter is a set of links, the detail drawer opens
 * via `?file=<id>` and closing it is an anchor back to `/app/files`. The
 * reply form is a real POST that also works with JavaScript off;
 * public/js/files.js intercepts it to append the comment in place, because a
 * reload would re-run the drawer's slide-in animation on every reply.
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { FC } from 'hono/jsx';
import type { Ctx } from '../types';
import { AdminLayout, MONO } from '../views/layout';
import { adminProps, redirectWithToast } from '../views/chrome';
import { all, jsonParse } from '../lib/db';
import { requireOrgRole } from '../lib/auth';
import { logActivity } from '../lib/activity';
import { getFileRow, type FileRow } from '../lib/files';
import { addFileComment, fmtDateTime, listFileComments, type FileCommentRow } from '../lib/file-comments';
import * as T from '../lib/tasks';

const app = new Hono<Ctx>();

/* --------------------------------------------------------------- styles */

const LABEL = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;

/** Library table columns — six of them, so they need ~900px on desktop. */
const COLS = 'minmax(220px,1.4fr) minmax(120px,1fr) minmax(140px,1.2fr) 150px 76px 90px';

/**
 * Page CSS. Every desktop declaration below is byte-for-byte what used to sit
 * inline; the `@media (max-width:768px)` half is the phone shape.
 *
 * The library table is the criterion-7 decision (SPECS/M-mobile.md): six
 * columns need 900px, and the two that carry the review signal — version count
 * and comment count — are the last two, so sideways scrolling would hide
 * exactly what the organizer opens this page for. Below 768px a row reflows
 * into a card: filename and what it is attached to on line one, speaker and
 * session on line two, upload time plus the version and comment counts (now
 * spelled out, since the column heads are gone) on line three. The whole card
 * stays one `<a>`, so the tap target is the card.
 */
const PAGE_CSS = `
  .drawer-file{position:fixed;top:0;right:0;bottom:0;width:460px;max-width:92vw;background:#fff;z-index:70;box-shadow:-12px 0 40px rgba(0,0,0,0.14);display:flex;flex-direction:column;animation:slidein 0.18s ease;}
  .fil-page{padding:24px 28px;}
  .fil-bar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;}
  .fil-filters{margin-left:auto;display:flex;gap:6px;}
  .fil-filter{padding:6px 12px;}
  .fil-head{display:grid;grid-template-columns:${COLS};gap:0 14px;padding:10px 16px;min-width:900px;}
  .fil-row{display:grid;grid-template-columns:${COLS};gap:0 14px;padding:11px 16px;min-width:900px;align-items:center;}
  /* The drawer bands follow the shell's --band-x (22px, 16px on a phone). */
  .fil-band{padding-left:var(--band-x);padding-right:var(--band-x);}
  .fil-verrow{display:flex;align-items:center;gap:10px;padding:9px 12px;}
  .fil-verbtn{padding:6px 12px;}
  .fil-replyrow{display:flex;gap:6px;padding:9px 12px;margin:0;}
  .fil-replyinput{flex:1;}
  .fil-replybtn{padding:6px 12px;}
  @media (max-width:768px){
    .fil-page{padding:14px 14px 28px;}
    .fil-filters{margin-left:0;flex:1 0 100%;flex-wrap:wrap;}
    .fil-filter{flex:1 1 auto;text-align:center;padding:11px 10px;}
    .fil-head{display:none;}
    .fil-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 9px;min-width:0;padding:13px 14px;}
    .fil-c-file{flex:1 0 100%;min-width:0;margin-bottom:2px;}
    .fil-c-file > div{white-space:normal !important;}
    .fil-c-speaker,.fil-c-session,.fil-c-when{flex:0 1 auto;min-width:0;max-width:100%;}
    .fil-c-versions,.fil-c-comments{flex:0 1 auto;text-align:left !important;font-size:11px !important;}
    /* Column heads are gone on a phone, so the meta line separates itself. */
    .fil-c-session::before,.fil-c-when::before,.fil-c-versions::before,.fil-c-comments::before{content:'·';color:#c9cbd2;margin-right:9px;}
    .drawer-file .us-icon-btn{padding:11px;}
    .fil-verrow{flex-wrap:wrap;gap:8px 10px;}
    .fil-verbtn{padding:10px 14px;margin-left:auto;}
    /* Stack the reply: a full-width field, then the button on its own line, so
       neither can squeeze the other out of the row. */
    .fil-replyrow{flex-wrap:wrap;gap:8px;padding:10px 12px;}
    .fil-replyinput{flex:1 0 100%;}
    .fil-replybtn{margin-left:auto;padding:11px 16px;}
  }
`;

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/* ------------------------------------------------------------ page data */

/** One version chain — what a library row shows. */
export type Chain = {
  /** Latest version's file id — the row's `?file=` opener and reply target. */
  fileId: string;
  kind: string;
  subjectType: string | null;
  subjectId: string | null;
  filename: string;
  size: number;
  uploadedBy: string | null;
  uploadedAt: string;
  versions: FileRow[];
  /** What the file is attached to — task name, "Headshot", "Event logo"… */
  label: string;
  speaker: string | null;
  session: string | null;
  comments: number;
};

const KIND_LABEL: Record<string, string> = {
  headshot: 'Headshot',
  logo: 'Event logo',
  sample: 'Task sample',
  upload: 'Upload',
};

export async function loadLibrary(env: Ctx['Bindings'], eventId: string): Promise<Chain[]> {
  const rows = await all<FileRow>(
    env.DB,
    `SELECT * FROM files WHERE event_id = ? ORDER BY version DESC, created_at DESC`,
    eventId
  );
  const byChain = new Map<string, FileRow[]>();
  for (const f of rows) {
    const key = f.subject_type && f.subject_id ? `${f.kind}|${f.subject_type}|${f.subject_id}` : `solo|${f.id}`;
    const list = byChain.get(key) ?? [];
    list.push(f);
    byChain.set(key, list);
  }

  // Resolve what each chain hangs off: the task (name, speaker, session) for
  // deliverables, the speaker for headshots. One IN-query per subject family.
  const taskIds = [...new Set(rows.filter((f) => f.subject_type === 'task').map((f) => f.subject_id!))];
  const taskInfo = new Map<
    string,
    { name: string; speakerId: string | null; speakerName: string | null; sessionTitle: string | null }
  >();
  if (taskIds.length) {
    const tasks = await all<
      T.TaskRow & { tpl_name: string | null; speaker_name: string | null; session_title: string | null }
    >(
      env.DB,
      `SELECT t.*, tt.name AS tpl_name, sp.name AS speaker_name, se.title AS session_title
         FROM tasks t
         LEFT JOIN task_templates tt ON tt.id = t.template_id
         LEFT JOIN speaker_profiles sp ON sp.id = t.speaker_profile_id
         LEFT JOIN sessions se ON se.id = t.session_id
        WHERE t.id IN (${taskIds.map(() => '?').join(',')})`,
      ...taskIds
    );
    for (const t of tasks) {
      const oneOff = t.template_id ? null : jsonParse<T.OneOffSpec>(t.one_off_json, { name: 'Task', type: 'checkbox' });
      taskInfo.set(t.id, {
        name: T.snapshotOf(t)?.name ?? t.tpl_name ?? oneOff?.name ?? 'Task',
        speakerId: t.speaker_profile_id,
        speakerName: t.speaker_name,
        sessionTitle: t.session_title,
      });
    }
  }

  // Speaker names for headshot chains, plus each speaker's first session — a
  // speaker-target deliverable has no session_id of its own, but the library
  // still shows which session the speaker belongs to.
  const speakers = await all<{ id: string; name: string }>(
    env.DB,
    `SELECT id, name FROM speaker_profiles WHERE event_id = ?`,
    eventId
  );
  const speakerName = new Map(speakers.map((s) => [s.id, s.name]));
  const firstSession = new Map<string, string>();
  const links = await all<{ speaker_profile_id: string; title: string }>(
    env.DB,
    `SELECT ss.speaker_profile_id, s.title
       FROM session_speakers ss JOIN sessions s ON s.id = ss.session_id
      WHERE s.event_id = ? ORDER BY ss.position`,
    eventId
  );
  for (const l of links) if (!firstSession.has(l.speaker_profile_id)) firstSession.set(l.speaker_profile_id, l.title);

  const commentCounts = new Map<string, number>();
  for (const r of await all<{ subject_type: string; subject_id: string; n: number }>(
    env.DB,
    `SELECT subject_type, subject_id, COUNT(*) AS n FROM file_comments WHERE event_id = ? GROUP BY subject_type, subject_id`,
    eventId
  )) {
    commentCounts.set(`${r.subject_type}|${r.subject_id}`, r.n);
  }

  const chains: Chain[] = [];
  for (const versions of byChain.values()) {
    const latest = versions[0];
    let label = KIND_LABEL[latest.kind] ?? latest.kind;
    let speaker: string | null = null;
    let session: string | null = null;
    if (latest.subject_type === 'task' && latest.subject_id) {
      const info = taskInfo.get(latest.subject_id);
      label = info?.name ?? 'Task file';
      speaker = info?.speakerName ?? null;
      session = info?.sessionTitle ?? (info?.speakerId ? (firstSession.get(info.speakerId) ?? null) : null);
    } else if (latest.subject_type === 'speaker' && latest.subject_id) {
      speaker = speakerName.get(latest.subject_id) ?? null;
      session = firstSession.get(latest.subject_id) ?? null;
    }
    chains.push({
      fileId: latest.id,
      kind: latest.kind,
      subjectType: latest.subject_type,
      subjectId: latest.subject_id,
      filename: latest.filename,
      size: latest.size,
      uploadedBy: latest.uploaded_by,
      uploadedAt: latest.created_at,
      versions,
      label,
      speaker,
      session,
      comments:
        latest.subject_type && latest.subject_id
          ? (commentCounts.get(`${latest.subject_type}|${latest.subject_id}`) ?? 0)
          : 0,
    });
  }
  chains.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return chains;
}

/* ------------------------------------------------------------ fragments */

const FILTERS: [string, string][] = [
  ['all', 'All'],
  ['deliverables', 'Deliverables'],
  ['headshots', 'Headshots'],
  ['other', 'Other'],
];

function inFilter(chain: Chain, filter: string): boolean {
  if (filter === 'deliverables') return chain.kind === 'task_file';
  if (filter === 'headshots') return chain.kind === 'headshot';
  if (filter === 'other') return chain.kind !== 'task_file' && chain.kind !== 'headshot';
  return true;
}

const Drawer: FC<{ chain: Chain; comments: FileCommentRow[]; backHref: string }> = ({ chain, comments, backHref }) => (
  <div>
    <a href={backHref} aria-label="Close" style="position:fixed;inset:0;background:rgba(22,23,29,0.28);z-index:60;"></a>
    <div class="us-drawer-panel drawer-file">
      <div class="fil-band" style="padding-top:16px;padding-bottom:16px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;">
        <div style={LABEL}>FILE DETAIL</div>
        <a href={backHref} class="us-icon-btn" aria-label="Close" style="margin-left:auto;font-size:18px;line-height:1;text-decoration:none;">
          ×
        </a>
      </div>
      <div class="fil-band" style="flex:1;overflow-y:auto;padding-top:18px;padding-bottom:18px;">
        <div style="font-size:16px;font-weight:700;letter-spacing:-0.01em;word-break:break-all;">{chain.filename}</div>
        <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;margin-top:4px;`}>
          {`${chain.label.toUpperCase()} · ${fmtSize(chain.size)}`}
        </div>

        <div style="margin-top:16px;display:grid;grid-template-columns:110px 1fr;gap:6px 12px;font-size:12.5px;">
          <div style={LABEL}>SPEAKER</div>
          <div>{chain.speaker ?? '—'}</div>
          <div style={LABEL}>SESSION</div>
          <div>{chain.session ?? '—'}</div>
          <div style={LABEL}>UPLOADED BY</div>
          <div style={`font-family:${MONO};font-size:11.5px;`}>{chain.uploadedBy ?? '—'}</div>
        </div>

        <div style={`${LABEL}margin:22px 0 8px;`}>{`VERSIONS · ${chain.versions.length}`}</div>
        <div style="border:1px solid #eceded;">
          {chain.versions.map((v, i) => (
            <div class="fil-verrow" style={i ? 'border-top:1px solid #f2f3f5;' : ''}>
              <span
                style={`font-family:${MONO};font-size:10px;font-weight:600;padding:2px 6px;flex:none;${
                  i === 0 ? 'background:#e6f4ea;color:#2b8a3e;' : 'background:#f1f3f5;color:#686b74;'
                }`}
              >
                {`V${v.version}${i === 0 ? ' · LATEST' : ''}`}
              </span>
              <div style="min-width:0;flex:1;">
                <div style="font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {v.filename}
                </div>
                <div style={`font-family:${MONO};font-size:10px;color:#9a9da6;`}>
                  {`${fmtDateTime(v.created_at)} · ${fmtSize(v.size)}`}
                </div>
              </div>
              <a
                href={`/files/${v.id}`}
                target="_blank"
                rel="noreferrer"
                class="fil-verbtn"
                style="background:#fff;border:1px solid #e2e3e8;font-size:12px;color:#33343c;cursor:pointer;flex:none;text-decoration:none;"
              >
                View ↓
              </a>
            </div>
          ))}
        </div>

        <div style={`${LABEL}margin:22px 0 8px;`} data-comment-count={comments.length}>
          {`COMMENTS · ${comments.length}`}
        </div>
        {chain.subjectType && chain.subjectId ? (
          <div style="border:1px solid #eceded;" data-comment-thread>
            {comments.map((cm) => (
              <div style="padding:9px 12px;border-bottom:1px solid #f2f3f5;">
                <div style={`font-family:${MONO};font-size:10px;color:${cm.author_role === 'organizer' ? '#4c5fd5' : '#9a9da6'};margin-bottom:2px;`}>
                  {`${cm.author_name.toUpperCase()}${cm.author_role === 'organizer' ? ' · ORGANIZER' : ''} · ${fmtDateTime(cm.created_at)}`}
                </div>
                <div style="font-size:12.5px;line-height:1.5;">{cm.body}</div>
              </div>
            ))}
            {comments.length === 0 ? (
              <div data-comment-empty style="padding:9px 12px;font-size:12px;color:#9a9da6;border-bottom:1px solid #f2f3f5;">
                No comments yet.
              </div>
            ) : null}
            <form method="post" action="/app/files/comment" data-comment-form class="fil-replyrow">
              <input type="hidden" name="fileId" value={chain.fileId} />
              <input
                name="body"
                required
                maxlength={2000}
                placeholder="Reply — the speaker sees this in their portal…"
                class="fil-replyinput"
                style="min-width:0;padding:6px 9px;border:1px solid #e2e3e8;font-size:12px;"
              />
              <button type="submit" class="fil-replybtn" style="background:#fff;border:1px solid #e2e3e8;font-size:12px;color:#33343c;cursor:pointer;">
                Comment
              </button>
            </form>
          </div>
        ) : (
          <div style="font-size:12px;color:#9a9da6;">Comments live on speaker deliverables — this file has no thread.</div>
        )}
      </div>
    </div>
  </div>
);

/* -------------------------------------------------------------- the page */

app.get('/app/files', async (c) => {
  const props = await adminProps(c, 'Files');
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');

  const filter = FILTERS.some(([k]) => k === c.req.query('kind')) ? c.req.query('kind')! : 'all';
  const openId = c.req.query('file') ?? null;

  const chains = await loadLibrary(c.env, event.id);
  const shown = chains.filter((ch) => inFilter(ch, filter));
  const open = openId ? (chains.find((ch) => ch.versions.some((v) => v.id === openId)) ?? null) : null;
  const openComments =
    open && open.subjectType && open.subjectId
      ? await listFileComments(c.env.DB, open.subjectType, open.subjectId)
      : [];

  const totalVersions = chains.reduce((n, ch) => n + ch.versions.length, 0);
  const totalBytes = chains.reduce((n, ch) => n + ch.versions.reduce((m, v) => m + v.size, 0), 0);
  const listHref = filter === 'all' ? '/app/files' : `/app/files?kind=${filter}`;

  return c.html(
    <AdminLayout {...props} scripts={['/js/files.js']}>
      {/* raw: the phone rules carry quoted `content:'·'` separators, which JSX
          would escape into broken CSS. */}
      <style>{raw(PAGE_CSS)}</style>
      <div class="fil-page">
        <div class="fil-bar">
          <div style={LABEL}>
            {`FILES LIBRARY · ${chains.length} FILE${chains.length === 1 ? '' : 'S'} · ${totalVersions} VERSION${
              totalVersions === 1 ? '' : 'S'
            } · ${fmtSize(totalBytes)}`}
          </div>
          <div class="fil-filters">
            {FILTERS.map(([key, label]) => (
              <a
                href={key === 'all' ? '/app/files' : `/app/files?kind=${key}`}
                class="fil-filter"
                style={`font-size:12px;text-decoration:none;border:1px solid ${
                  key === filter ? '#4c5fd5' : '#e2e3e8'
                };background:${key === filter ? '#eef0fb' : '#fff'};color:${key === filter ? '#4c5fd5' : '#33343c'};font-weight:${
                  key === filter ? '600' : '400'
                };`}
              >
                {label}
              </a>
            ))}
          </div>
        </div>

        <div class="us-scroll-x" style="background:#fff;border:1px solid #e2e3e8;">
          <div
            class="fil-head"
            style={`border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10px;letter-spacing:0.06em;color:#9a9da6;`}
          >
            <div>FILE</div>
            <div>SPEAKER</div>
            <div>SESSION</div>
            <div>UPLOADED</div>
            <div style="text-align:right;">VERSIONS</div>
            <div style="text-align:right;">COMMENTS</div>
          </div>
          {shown.map((ch) => (
            <a
              href={`${listHref}${listHref.includes('?') ? '&' : '?'}file=${ch.fileId}`}
              class="fil-row"
              style="border-bottom:1px solid #f2f3f5;color:inherit;text-decoration:none;"
            >
              <div class="fil-c-file" style="min-width:0;">
                <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {ch.filename}
                </div>
                <div style="font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {ch.label}
                </div>
              </div>
              <div class="fil-c-speaker" style="font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                {ch.speaker ?? '—'}
              </div>
              <div class="fil-c-session" style="font-size:12.5px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                {ch.session ?? '—'}
              </div>
              <div class="fil-c-when" style={`font-family:${MONO};font-size:11px;color:#686b74;`}>
                {fmtDateTime(ch.uploadedAt)}
              </div>
              <div
                class="fil-c-versions"
                style={`text-align:right;font-family:${MONO};font-size:12px;font-weight:600;color:${ch.versions.length > 1 ? '#4c5fd5' : '#686b74'};`}
              >
                <span class="us-desktop-only">{ch.versions.length}</span>
                <span class="us-mobile-only">{`${ch.versions.length} version${ch.versions.length === 1 ? '' : 's'}`}</span>
              </div>
              <div
                class="fil-c-comments"
                style={`text-align:right;font-family:${MONO};font-size:12px;color:${ch.comments ? '#16171d' : '#c9cbd2'};`}
              >
                <span class="us-desktop-only">{ch.comments || '—'}</span>
                <span class="us-mobile-only">
                  {ch.comments ? `${ch.comments} comment${ch.comments === 1 ? '' : 's'}` : 'no comments'}
                </span>
              </div>
            </a>
          ))}
          {shown.length === 0 ? (
            <div style="padding:32px 16px;text-align:center;font-size:13px;color:#9a9da6;">
              {chains.length === 0
                ? 'No files yet — deliverables speakers upload from their portal land here.'
                : 'No files match this filter.'}
            </div>
          ) : null}
        </div>
      </div>
      {open ? <Drawer chain={open} comments={openComments} backHref={listHref} /> : null}
    </AdminLayout>
  );
});

/* ------------------------------------------------------------- mutations */

app.post('/app/files/comment', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  // files.js posts the same form via fetch with an Accept header — answering
  // JSON lets it append the comment in place instead of reloading the drawer.
  const wantsJson = (c.req.header('accept') ?? '').includes('application/json');
  const fail = (path: string, message: string) =>
    wantsJson ? c.json({ ok: false, error: message }, 400) : redirectWithToast(c, path, message);
  const body = await c.req.parseBody();
  const fileId = String(body.fileId ?? '');
  const text = String(body.body ?? '').trim().slice(0, 2000);
  const file = await getFileRow(c.env, fileId);
  if (!file || file.event_id !== event.id) return fail('/app/files', 'That file isn’t in this event');
  if (!file.subject_type || !file.subject_id) {
    return fail('/app/files', 'Comments live on speaker deliverables — this file has no thread');
  }
  if (!text) return fail(`/app/files?file=${fileId}`, 'Write a comment first');

  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  const comment = await addFileComment(c.env.DB, {
    eventId: event.id,
    kind: file.kind,
    subjectType: file.subject_type,
    subjectId: file.subject_id,
    fileId: file.id,
    authorUserId: c.var.user?.id ?? null,
    authorName: actor,
    authorRole: 'organizer',
    body: text,
  });
  // Deliberately no email — the speaker reads the thread on their task list.
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: file.subject_type === 'task' ? 'task' : file.subject_type === 'speaker' ? 'speaker' : 'event',
    subjectId: file.subject_type === 'task' || file.subject_type === 'speaker' ? file.subject_id : event.id,
    actor,
    action: 'Commented on file',
    detail: `${file.filename} — ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`,
  });
  const message =
    file.subject_type === 'task' ? 'Comment added · visible to the speaker' : 'Comment added';
  if (wantsJson) {
    return c.json({
      ok: true,
      message,
      comment: { author_name: comment.author_name, body: comment.body, when: fmtDateTime(comment.created_at) },
    });
  }
  return redirectWithToast(c, `/app/files?file=${fileId}`, message);
});

export default app;
