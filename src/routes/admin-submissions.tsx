/**
 * `/app/submissions` — the submissions table, detail drawer, decision modal,
 * CSV import, CSV/XLSX export and the group-mail composer (spec B2). Internal
 * comments and the activity log are hidden from the drawer for now (deferred,
 * not cut — see DECISIONS); their endpoints and queries stay live below.
 *
 * Markup and inline styles are ported from
 * `prototype/design_handoff_program/design/Submissions.dc.html`. The decision
 * modal QUEUES decisions (lib/decision-queue) — nothing reaches the speaker
 * until the organizer sends the queue, from the review panel above the table
 * (or Emails → Outbox), so a queued decision is still revertible.
 *
 * OWNER: B2. JSON endpoints live under `/app/api/submissions/...`.
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Ctx, Bindings, Event } from '../types';
import { AdminLayout, MONO, STATUS_COLORS, fmtDate, initials } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, batch, jsonParse, now, one, run } from '../lib/db';
import { bumpSeq, newId } from '../lib/ids';
import { requireOrgRole } from '../lib/auth';
import { logActivity } from '../lib/activity';
import { renderTemplate, sendEmail } from '../lib/email';
import { isDecision, type DecisionKind } from '../lib/decisions';
import { queueDecisions, listDecisionQueue, OUTBOX_SEND_LIMIT } from '../lib/decision-queue';
import { csvHeaders, parseCsvTable, toCsv, type CsvRow } from '../lib/csv';
import { assignedFor, members, type PlanReviewer } from '../lib/evals';
import { toXlsx, xlsxHeaders } from '../lib/xlsx';

const app = new Hono<Ctx>();

/* ------------------------------------------------------------------ styles */

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const GRID = 'grid-template-columns:36px 76px minmax(220px,1fr) 150px 130px 96px 110px 104px;';
const ROW_STYLE = `display:grid;${GRID}min-width:1000px;padding:10px 12px;border-bottom:1px solid #f2f3f5;align-items:center;cursor:pointer;background:#fff;`;
const HEAD_BTN = 'padding:7px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const SELECT = 'padding:7px 10px;border:1px solid #e2e3e8;background:#fff;font-size:13px;color:#16171d;';
const MODAL_WRAP = 'position:fixed;inset:0;background:rgba(22,23,29,0.4);z-index:60;place-items:center;padding:24px;';
const MODAL_PANEL =
  'background:#fff;width:620px;max-width:100%;max-height:88vh;overflow-y:auto;box-shadow:0 24px 64px rgba(22,23,29,0.22);';
const INPUT = 'width:100%;padding:8px 12px;border:1px solid #e2e3e8;font-size:13px;outline-color:#4c5fd5;';

/**
 * Detail drawer shell. Sizing lives here (not inline) so the full-screen
 * toggle is one attribute: ui.js flips `data-expanded` on #drawer, and — like
 * the forms drawer — expanding widens the shell, not the text: the bands grow
 * their side padding (`--band-x`) so the body stays a readable column.
 */
const DRAWER_CSS = `
  #drawer-panel{position:fixed;top:0;right:0;bottom:0;--band-x:24px;width:520px;max-width:92vw;background:#fff;z-index:41;box-shadow:-12px 0 40px rgba(22,23,29,0.14);animation:slidein 0.18s ease;overflow-y:auto;transition:width 0.16s ease;}
  #drawer[data-expanded] #drawer-panel{width:100vw;max-width:100vw;--band-x:max(24px,calc((100vw - 880px) / 2));}
  .us-icon-btn{background:none;border:none;color:#9a9da6;cursor:pointer;padding:4px;display:flex;align-items:center;line-height:0;}
  .us-icon-btn:hover{color:#16171d;}
  #drawer .ic-min{display:none;}
  #drawer[data-expanded] .ic-max{display:none;}
  #drawer[data-expanded] .ic-min{display:block;}
`;
const TEXTAREA =
  'width:100%;padding:10px 12px;border:1px solid #e2e3e8;font-size:13px;line-height:1.5;resize:vertical;outline-color:#4c5fd5;font-family:inherit;';

/** Rows shipped to the browser in one page. Past this the island filters server-side. */
// R2 benchmark (2026-08-12, production, 4,034 rows): TTFB 663ms, DOMContentLoaded
// ~1.0s, 132KB HTML, client filter pass 3.5ms, sort compare 8ms — everything
// ships and filters client-side at realistic scale. The cap survives only as a
// pathological-event guard, far above the few-thousand-row realistic ceiling.
const ROW_CAP = 10000;

/**
 * Submission lifecycle, in pipeline order (migration 0011). No `submitted` —
 * everything past draft is submitted by definition — and no `confirmed`: the
 * speaker confirms the SESSION, so that lives on `sessions.status`.
 */
const STATUS_ORDER = ['draft', 'in_review', 'accepted', 'waitlisted', 'declined', 'withdrawn'];

const IMPORTABLE_STATUS = new Set(STATUS_ORDER);

/**
 * What the table shows, which is NOT the stored vocabulary: `in_review` splits
 * into "Needs Assigned" (no evaluation plan's rules cover the row, so nobody
 * will ever review it) and "In Review" (a plan does). Both are the same stored
 * status — the split is derived per render from plan coverage, so it can never
 * go stale the way a flipped flag would. `BoardRow.chip` carries the bucket;
 * `BoardRow.status` stays the real status for decisions, export and import.
 */
const CHIP_ORDER = ['draft', 'needs_assigned', 'in_review', 'outbox', 'accepted', 'waitlisted', 'declined', 'withdrawn'];

/** Undecided with no plan covering it — the row nobody is going to look at. */
function chipFor(status: string, reviewsExpected: number): string {
  return status === 'in_review' && reviewsExpected === 0 ? 'needs_assigned' : status;
}

/**
 * Pre-0011 vocabulary, still accepted on import — CSVs exported from this app
 * before the migration (or from another CFP tool) carry these words.
 */
const RETIRED_STATUS: Record<string, string> = { submitted: 'in_review', confirmed: 'accepted' };

function statusMeta(status: string) {
  return STATUS_COLORS[status] ?? { label: status, fg: '#686b74', bg: '#f1f3f5' };
}

function badgeStyle(status: string): string {
  const c = statusMeta(status);
  return `display:inline-block;padding:3px 8px;font-size:11px;font-weight:600;color:${c.fg};background:${c.bg};font-family:${MONO};`;
}

/** Dashed chip for a decision sitting in the outbox — pending, not sent. */
const QUEUED_COLOR: Record<DecisionKind, string> = { accept: '#2b8a3e', decline: '#c92a2a', waitlist: '#9c36b5' };
function queuedChipStyle(kind: DecisionKind): string {
  return `display:inline-block;padding:2px 7px;font-size:10px;font-weight:600;color:${QUEUED_COLOR[kind]};border:1px dashed ${QUEUED_COLOR[kind]};font-family:${MONO};letter-spacing:0.04em;`;
}

/** Status-column label for a row whose display bucket is `outbox`. */
const QUEUED_LABEL: Record<DecisionKind, string> = {
  accept: 'Accept · Queued',
  decline: 'Decline · Queued',
  waitlist: 'Waitlist · Queued',
};

/* ------------------------------------------------------------------ shapes */

type FormRow = { id: string; name: string; slug: string; status: string; created_at: string };
type VersionRow = { id: string; form_id: string; schema_json: string };
type OptionRow = { id: string; name: string; color: string | null; duration_min: number | null; taxonomy: string };
type SpeakerRow = {
  id: string;
  submission_id: string;
  position: number;
  name: string;
  email: string;
  bio: string;
  headshot_file_id: string | null;
};
type SubmissionRow = {
  id: string;
  seq: number;
  status: string;
  title: string;
  abstract: string;
  answers_json: string;
  submitted_at: string | null;
  created_at: string;
  form_id: string;
  form_version_id: string | null;
};
type EvalRow = { submission_id: string; plan_id: string; reviewer_id: string; scores_json: string; abstained: number };
type PlanRow = { id: string; name: string; reviews_per: number; rules_json: string; criteria_json: string };
type FileRow = { id: string; filename: string; size: number; subject_type: string | null; subject_id: string | null };

type FormField = {
  id: string;
  type?: string;
  label?: string;
  core?: boolean;
  opts?: string[];
};

type BoardRow = {
  id: string;
  seq: number;
  num: string;
  status: string;
  /** Display bucket — `status`, except `in_review` may render as `needs_assigned`. */
  chip: string;
  title: string;
  abstract: string;
  formId: string;
  formName: string;
  via: string;
  trackId: string | null;
  trackName: string;
  trackColor: string;
  formatId: string | null;
  format: string;
  formatLong: string;
  levelId: string | null;
  level: string;
  speakers: SpeakerRow[];
  avg: number | null;
  done: number;
  total: number;
  submittedAt: string | null;
  submitted: string;
  search: string;
  answers: Record<string, unknown>;
  fields: FormField[];
  usedFieldIds: string[];
};

type Board = {
  rows: BoardRow[];
  forms: FormRow[];
  tracks: OptionRow[];
  counts: Record<string, number>;
  primaryFormId: string | null;
  fieldsByForm: Record<string, FormField[]>;
};

/* ------------------------------------------------------------------ loading */

/** Resolve "Deep Dive (45 min)" / "AI & ML" answers onto their taxonomy option. */
function matchOption(options: OptionRow[], taxonomy: string, answer: unknown): OptionRow | null {
  if (typeof answer !== 'string' || !answer) return null;
  const pool = options.filter((o) => o.taxonomy === taxonomy);
  const exact = pool.find((o) => o.name === answer);
  if (exact) return exact;
  const stripped = answer.replace(/\s*\(.+\)\s*$/, '');
  return pool.find((o) => o.name === stripped) ?? null;
}

function resolveMeta(answers: Record<string, unknown>, options: OptionRow[]) {
  const used: string[] = [];
  const pick = (taxonomy: string): OptionRow | null => {
    for (const [fieldId, value] of Object.entries(answers)) {
      const hit = matchOption(options, taxonomy, value);
      if (hit) {
        used.push(fieldId);
        return hit;
      }
    }
    return null;
  };
  return { track: pick('Track'), format: pick('Format'), level: pick('Level'), used };
}

function planCovers(rules: Record<string, string>, row: { formId: string; trackId: string | null; formatId: string | null; levelId: string | null; status: string }): boolean {
  const f = rules.form ?? 'all';
  if (f !== 'all' && f !== row.formId) return false;
  const t = rules.track ?? 'all';
  if (t !== 'all' && t !== row.trackId) return false;
  const fmt = rules.format ?? 'all';
  if (fmt !== 'all' && fmt !== row.formatId) return false;
  const lvl = rules.level ?? 'all';
  if (lvl !== 'all' && lvl !== row.levelId) return false;
  const st = rules.status ?? 'active';
  if (st === 'all') return true;
  if (st === 'active') return !['draft', 'withdrawn', 'declined'].includes(row.status);
  return st === row.status;
}

function meanOf(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function loadBoard(env: Bindings, event: Event): Promise<Board> {
  const [forms, versions, options, subs, speakers, evals, plans, includes, pins] = await Promise.all([
    all<FormRow>(
      env.DB,
      `SELECT id, name, slug, status, created_at FROM forms WHERE event_id = ?
        ORDER BY (status = 'open') DESC, created_at`,
      event.id
    ),
    all<VersionRow>(
      env.DB,
      `SELECT fv.id, fv.form_id, fv.schema_json FROM form_versions fv
         JOIN forms f ON f.id = fv.form_id WHERE f.event_id = ? ORDER BY fv.version`,
      event.id
    ),
    all<OptionRow>(
      env.DB,
      `SELECT o.id, o.name, o.color, o.duration_min, t.name AS taxonomy
         FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
        WHERE t.event_id = ? ORDER BY t.position, o.position`,
      event.id
    ),
    all<SubmissionRow>(
      env.DB,
      `SELECT id, seq, status, title, abstract, answers_json, submitted_at, created_at, form_id, form_version_id
         FROM submissions WHERE event_id = ?
        ORDER BY COALESCE(submitted_at, created_at) DESC, seq DESC`,
      event.id
    ),
    all<SpeakerRow>(
      env.DB,
      `SELECT ss.* FROM submission_speakers ss JOIN submissions s ON s.id = ss.submission_id
        WHERE s.event_id = ? ORDER BY ss.position`,
      event.id
    ),
    all<EvalRow>(
      env.DB,
      `SELECT ev.submission_id, ev.plan_id, ev.reviewer_id, ev.scores_json, ev.abstained FROM evaluations ev
         JOIN submissions s ON s.id = ev.submission_id WHERE s.event_id = ?`,
      event.id
    ),
    all<PlanRow>(env.DB, `SELECT id, name, reviews_per, rules_json, criteria_json FROM eval_plans WHERE event_id = ?`, event.id),
    all<{ plan_id: string; submission_id: string }>(
      env.DB,
      `SELECT i.plan_id, i.submission_id FROM eval_plan_includes i
         JOIN eval_plans p ON p.id = i.plan_id WHERE p.event_id = ?`,
      event.id
    ),
    all<{ plan_id: string; submission_id: string }>(
      env.DB,
      `SELECT n.plan_id, n.submission_id FROM eval_reviewer_pins n
         JOIN eval_plans p ON p.id = n.plan_id WHERE p.event_id = ?`,
      event.id
    ),
  ]);

  const formById = new Map(forms.map((f) => [f.id, f]));
  const primaryFormId = forms[0]?.id ?? null;

  const fieldsByVersion = new Map<string, FormField[]>();
  const fieldsByForm: Record<string, FormField[]> = {};
  for (const v of versions) {
    const fields = jsonParse<{ fields?: FormField[] }>(v.schema_json, {}).fields ?? [];
    fieldsByVersion.set(v.id, fields);
    fieldsByForm[v.form_id] = fields; // latest version wins (ordered by version)
  }

  const speakersBySub = new Map<string, SpeakerRow[]>();
  for (const sp of speakers) {
    const list = speakersBySub.get(sp.submission_id) ?? [];
    list.push(sp);
    speakersBySub.set(sp.submission_id, list);
  }

  const evalsBySub = new Map<string, EvalRow[]>();
  for (const ev of evals) {
    const list = evalsBySub.get(ev.submission_id) ?? [];
    list.push(ev);
    evalsBySub.set(ev.submission_id, list);
  }

  const parsedPlans = plans.map((p) => ({
    ...p,
    rules: jsonParse<Record<string, string>>(p.rules_json, {}),
  }));
  // Explicit per-submission assignments (migration 0014) — additive to the rules.
  const included = new Set(includes.map((i) => `${i.plan_id}:${i.submission_id}`));
  // Pinned reviewers (migration 0018) — can grow a submission's slot count.
  const pinCounts = new Map<string, number>();
  for (const n of pins) {
    const key = `${n.plan_id}:${n.submission_id}`;
    pinCounts.set(key, (pinCounts.get(key) ?? 0) + 1);
  }

  const counts: Record<string, number> = {};
  const rows: BoardRow[] = subs.map((s) => {
    const answers = jsonParse<Record<string, unknown>>(s.answers_json, {});
    const meta = resolveMeta(answers, options);
    const subSpeakers = speakersBySub.get(s.id) ?? [];
    const mine = evalsBySub.get(s.id) ?? [];

    const scores: number[] = [];
    let done = 0;
    for (const ev of mine) {
      if (ev.abstained) continue;
      done++;
      for (const v of Object.values(jsonParse<Record<string, number>>(ev.scores_json, {}))) {
        if (typeof v === 'number' && !Number.isNaN(v)) scores.push(v);
      }
    }

    const shape = {
      formId: s.form_id,
      trackId: meta.track?.id ?? null,
      formatId: meta.format?.id ?? null,
      levelId: meta.level?.id ?? null,
      status: s.status,
    };
    let expected = 0;
    for (const p of parsedPlans) {
      if (planCovers(p.rules, shape) || included.has(`${p.id}:${s.id}`))
        expected += Math.max(p.reviews_per, pinCounts.get(`${p.id}:${s.id}`) ?? 0);
    }

    const chip = chipFor(s.status, expected);
    counts[chip] = (counts[chip] ?? 0) + 1;
    const form = formById.get(s.form_id);
    const fields = (s.form_version_id ? fieldsByVersion.get(s.form_version_id) : null) ?? fieldsByForm[s.form_id] ?? [];

    return {
      id: s.id,
      seq: s.seq,
      num: `SUB-${s.seq}`,
      status: s.status,
      chip,
      title: s.title,
      abstract: s.abstract,
      formId: s.form_id,
      formName: form?.name ?? 'Form',
      via: s.form_id !== primaryFormId ? `· via ${form?.name ?? 'form'}` : '',
      trackId: meta.track?.id ?? null,
      trackName: meta.track?.name ?? '—',
      trackColor: meta.track?.color ?? '#adb5bd',
      formatId: meta.format?.id ?? null,
      format: meta.format?.name ?? '—',
      formatLong: meta.format
        ? meta.format.duration_min
          ? `${meta.format.name} (${meta.format.duration_min} min)`
          : meta.format.name
        : '—',
      levelId: meta.level?.id ?? null,
      level: meta.level?.name ?? '—',
      speakers: subSpeakers,
      avg: meanOf(scores),
      done,
      total: Math.max(done, expected),
      submittedAt: s.submitted_at,
      submitted: s.submitted_at ? fmtDate(s.submitted_at, true) : '—',
      search: `${s.title} ${subSpeakers.map((x) => `${x.name} ${x.email}`).join(' ')}`.toLowerCase(),
      answers,
      fields,
      usedFieldIds: meta.used,
    };
  });

  return {
    rows,
    forms,
    tracks: options.filter((o) => o.taxonomy === 'Track'),
    counts,
    primaryFormId,
    fieldsByForm,
  };
}

/* ------------------------------------------------------------------ helpers */

function answerText(field: FormField, value: unknown, files: Map<string, FileRow>): string {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) {
    if ((field.type ?? '') === 'FILE') {
      return value.map((v) => files.get(String(v))?.filename ?? String(v)).join('; ');
    }
    return value.map((v) => String(v)).join('; ');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if ((field.type ?? '') === 'FILE') return files.get(String(value))?.filename ?? String(value);
  return String(value);
}

function fileIdsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string' && value) return [value];
  return [];
}

function fmtBytes(size: number): string {
  if (!size) return '0 KB';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toUpperCase().slice(0, 4) : 'FILE';
}

function matchesFilter(
  row: BoardRow,
  f: { status: string; form: string; track: string; q: string }
): boolean {
  // Filters against the display bucket so ?status=needs_assigned round-trips.
  if (f.status !== 'all' && row.chip !== f.status) return false;
  if (f.form !== 'all' && row.formId !== f.form) return false;
  if (f.track !== 'all' && (row.trackId ?? '') !== f.track) return false;
  if (f.q && !row.search.includes(f.q)) return false;
  return true;
}

function dataScript(id: string, value: unknown) {
  return (
    <script type="application/json" id={id}>
      {raw(JSON.stringify(value).replace(/</g, '\\u003c'))}
    </script>
  );
}

/* ------------------------------------------------------------------ page */

app.get('/app/submissions', async (c) => {
  const event = c.var.event;
  const props = await adminProps(c, 'Submissions', { scripts: ['/js/submissions.js'] });
  if (!event) return c.redirect('/app/events/new');

  const board = await loadBoard(c.env, event);

  // The outbox lives here, where deciding happens — the full rows feed the
  // review-and-send panel above the table. A queued decision becomes the row's
  // display bucket: the table shows "Accept · Queued" instead of the stale
  // status, and the chips row grows a Queued filter (bucket key `outbox` —
  // `queued` is the email log's word in STATUS_COLORS).
  const outbox = await listDecisionQueue(c.env, event.id);
  const queued = new Map(outbox.map((r) => [r.submission_id, r.decision]));
  for (const r of board.rows) {
    if (!queued.has(r.id)) continue;
    board.counts[r.chip] = (board.counts[r.chip] ?? 1) - 1;
    r.chip = 'outbox';
    board.counts.outbox = (board.counts.outbox ?? 0) + 1;
  }

  const filter = {
    status: c.req.query('status') ?? 'all',
    form: c.req.query('form') ?? 'all',
    track: c.req.query('track') ?? 'all',
    q: (c.req.query('q') ?? '').trim().toLowerCase(),
  };
  const matched = board.rows.filter((r) => matchesFilter(r, filter));
  const total = board.rows.length;
  // Up to ROW_CAP rows ship whole and filter instantly in the island. Past that
  // the server does the filtering and the island round-trips through the URL.
  const serverFilter = total > ROW_CAP;
  const rendered = serverFilter ? matched.slice(0, ROW_CAP) : board.rows;
  const shownCount = serverFilter ? Math.min(matched.length, ROW_CAP) : matched.length;

  const templates = await all<{ key: string; name: string; subject: string; body: string }>(
    c.env.DB,
    `SELECT key, name, subject, body FROM email_templates WHERE event_id = ? ORDER BY key`,
    event.id
  );
  const members = await all<{ id: string; name: string | null; email: string }>(
    c.env.DB,
    `SELECT u.id, u.name, u.email FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? ORDER BY COALESCE(u.name, u.email)`,
    event.org_id
  );

  const origin = c.env.APP_ORIGIN.replace(/\/$/, '');
  const host = origin.replace(/^https?:\/\//, '');
  const formSlug = props.publicFormSlug;
  const formUrl = formSlug ? `${origin}/${event.slug}/${formSlug}` : null;
  const canWrite = c.var.role === 'admin' || c.var.role === 'owner';

  const tplMap: Record<string, { name: string; subject: string; body: string }> = {};
  for (const t of templates) tplMap[t.key] = { name: t.name, subject: t.subject, body: t.body };

  const payload = {
    eventName: event.name,
    eventSlug: event.slug,
    origin,
    canWrite,
    open: c.req.query('open') ?? null,
    action: c.req.query('action') ?? null,
    filter,
    serverFilter,
    total,
    statuses: Object.fromEntries(CHIP_ORDER.map((s) => [s, statusMeta(s)])),
    templates: tplMap,
    mailTemplates: templates.map((t) => ({ key: t.key, name: t.name, subject: t.subject, body: t.body })),
    // Typeahead targets: teammates only — mentioning yourself notifies nobody.
    members: members
      .filter((m) => m.id !== c.var.user?.id)
      .map((m) => ({ id: m.id, name: m.name || m.email.split('@')[0], email: m.email })),
    forms: board.forms.map((f) => ({
      id: f.id,
      name: f.name,
      fields: (board.fieldsByForm[f.id] ?? [])
        .filter((x) => (x.type ?? '') !== 'GRP' && (x.type ?? '') !== 'HDR')
        .map((x) => ({ id: x.id, label: x.label ?? x.id, type: x.type ?? 'TXT' })),
    })),
    primaryFormId: board.primaryFormId,
    rows: rendered.map((r) => ({
      id: r.id,
      num: r.num,
      title: r.title,
      status: r.status,
      queued: queued.get(r.id) ?? null,
      formId: r.formId,
      speakers: r.speakers.map((s) => ({ name: s.name, email: s.email })),
    })),
  };

  const chips = [
    { key: 'all', label: 'All', count: total },
    ...CHIP_ORDER.filter((s) => (board.counts[s] ?? 0) > 0).map((s) => ({
      key: s,
      label: statusMeta(s).label,
      count: board.counts[s] ?? 0,
    })),
  ];

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:22px 28px;">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:16px;">
          <h1 style="margin:0;font-size:21px;letter-spacing:-0.02em;">Submissions</h1>
          <div id="count-label" style={`font-family:${MONO};font-size:12px;color:#686b74;`}>
            {`${shownCount} of ${total} shown`}
          </div>
          <div style="margin-left:auto;display:flex;gap:8px;">
            {canWrite ? (
              <button type="button" id="btn-import" style={HEAD_BTN}>
                Import CSV
              </button>
            ) : null}
            <button type="button" id="btn-export-csv" style={HEAD_BTN}>
              Export CSV
            </button>
            <button type="button" id="btn-export-xlsx" style={HEAD_BTN}>
              Export XLSX
            </button>
          </div>
        </div>

        {total === 0 ? (
          <div style="background:#fff;border:1px solid #e2e3e8;padding:72px 32px;text-align:center;">
            <div style={`font-family:${MONO};font-size:11px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:10px;`}>
              0 SUBMISSIONS
            </div>
            <div style="font-size:19px;font-weight:600;margin-bottom:8px;">
              Your call for speakers is live. Nothing has landed yet.
            </div>
            <div style="font-size:14px;color:#686b74;max-width:440px;margin:0 auto 20px;">
              Share your form link — submissions appear here in real time, with filters, bulk actions, and evaluation
              baked in.
            </div>
            {formUrl ? (
              <div style="display:inline-flex;align-items:center;gap:0;border:1px solid #e2e3e8;background:#f8f8fa;">
                <span style={`font-family:${MONO};font-size:12.5px;padding:9px 14px;color:#16171d;`}>
                  {`${host}/${event.slug}/${formSlug}`}
                </span>
                <button
                  type="button"
                  data-copy={formUrl}
                  data-copy-msg="Form link copied to clipboard"
                  style="padding:9px 14px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
                >
                  Copy link
                </button>
              </div>
            ) : (
              <div style="display:inline-flex;align-items:center;gap:0;border:1px solid #e2e3e8;background:#f8f8fa;">
                <span style={`font-family:${MONO};font-size:12.5px;padding:9px 14px;color:#686b74;`}>
                  No form published yet
                </span>
                <a
                  href="/app/forms"
                  style="padding:9px 14px;background:#4c5fd5;color:#fff;font-size:13px;font-weight:600;text-decoration:none;"
                >
                  Build a form
                </a>
              </div>
            )}
            {canWrite ? (
              <div style="margin-top:16px;font-size:13px;">
                <a href="#" id="empty-import">
                  Import from CSV instead
                </a>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {outbox.length > 0 ? (
              <div style="background:#fbf4e2;border:1px solid #e6d29a;margin-bottom:12px;">
                <div style="padding:10px 14px;display:flex;align-items:center;gap:12px;font-size:13px;color:#33343c;flex-wrap:wrap;">
                  <span>
                    <strong>{`${outbox.length} queued decision${outbox.length === 1 ? '' : 's'}`}</strong>
                    {' — nothing has been sent to speakers yet.'}
                  </span>
                  {canWrite ? (
                    <form method="post" action="/app/emails/outbox/send" style="margin-left:auto;">
                      <input type="hidden" name="back" value="/app/submissions" />
                      <button
                        type="submit"
                        style="padding:8px 16px;background:#2b8a3e;color:#fff;border:none;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;"
                      >
                        {outbox.length > OUTBOX_SEND_LIMIT
                          ? `Send ${OUTBOX_SEND_LIMIT} of ${outbox.length} now`
                          : `Send all ${outbox.length} now`}
                      </button>
                    </form>
                  ) : null}
                </div>
                <details>
                  <summary
                    style={`padding:8px 14px;border-top:1px solid #e6d29a;cursor:pointer;font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;color:#8a6d1a;`}
                  >
                    REVIEW THE QUEUE
                  </summary>
                  <div style="background:#fff;border-top:1px solid #e6d29a;max-height:320px;overflow-y:auto;">
                    {outbox.map((q) => (
                      <div style="display:grid;grid-template-columns:108px 64px minmax(0,1fr) 220px 78px;gap:10px;padding:8px 14px;border-bottom:1px solid #f2f3f5;align-items:center;">
                        <span style={queuedChipStyle(q.decision)}>{q.decision.toUpperCase()}</span>
                        <span style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{`SUB-${q.seq}`}</span>
                        <a
                          href={`/app/submissions?open=${q.submission_id}`}
                          style="font-size:12.5px;font-weight:600;color:#16171d;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                        >
                          {q.title}
                        </a>
                        <span style={`font-family:${MONO};font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                          {q.speaker_email || 'no speaker email — status only'}
                        </span>
                        {canWrite ? (
                          <form method="post" action="/app/emails/outbox/remove" style="justify-self:end;">
                            <input type="hidden" name="id" value={q.id} />
                            <input type="hidden" name="back" value="/app/submissions" />
                            <button
                              type="submit"
                              style="padding:4px 10px;background:#fff;border:1px solid #e2e3e8;font-size:11.5px;color:#c92a2a;cursor:pointer;"
                            >
                              Undo
                            </button>
                          </form>
                        ) : null}
                      </div>
                    ))}
                    <div style="padding:8px 14px;font-size:11.5px;color:#9a9da6;">
                      Also lives at{' '}
                      <a href="/app/emails?tab=outbox" style="color:#4c5fd5;">
                        Emails → Outbox
                      </a>
                      . Undo takes a decision back as if it never happened; sending flips statuses and emails everyone
                      above.
                    </div>
                  </div>
                </details>
              </div>
            ) : null}
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">
              {chips.map((chip) => {
                const on = filter.status === chip.key;
                return (
                  <button
                    type="button"
                    data-chip={chip.key}
                    style={`display:inline-flex;gap:6px;align-items:center;padding:6px 11px;font-size:12.5px;cursor:pointer;border:1px solid ${
                      on ? '#4c5fd5' : '#e2e3e8'
                    };background:${on ? '#eef0fb' : '#fff'};color:${on ? '#4c5fd5' : '#33343c'};font-weight:${
                      on ? '600' : '400'
                    };`}
                  >
                    {chip.label}
                    <span style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;`}>{chip.count}</span>
                  </button>
                );
              })}
              <div style="flex:1;"></div>
              <select id="filter-form" style={SELECT}>
                <option value="all">All forms</option>
                {board.forms.map((f) => (
                  <option value={f.id} selected={filter.form === f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <select id="filter-track" style={SELECT}>
                <option value="all">All tracks</option>
                {board.tracks.map((t) => (
                  <option value={t.id} selected={filter.track === t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <input
                id="filter-q"
                value={c.req.query('q') ?? ''}
                placeholder="Search title or speaker…"
                style="padding:7px 12px;border:1px solid #e2e3e8;background:#fff;font-size:13px;width:220px;outline-color:#4c5fd5;"
              />
            </div>

            <div
              id="bulk-bar"
              hidden
              style="display:flex;align-items:center;gap:8px;background:#16171d;color:#fff;padding:10px 14px;margin-bottom:0;"
            >
              <span id="bulk-count" style={`font-family:${MONO};font-size:12px;`}>
                0 selected
              </span>
              <div style="width:1px;height:18px;background:#3a3b44;margin:0 4px;"></div>
              {canWrite ? (
                <>
                  <button
                    type="button"
                    data-bulk="accept"
                    style="padding:6px 12px;background:#2b8a3e;color:#fff;border:none;font-size:12.5px;font-weight:600;cursor:pointer;"
                  >
                    Accept…
                  </button>
                  <button
                    type="button"
                    data-bulk="waitlist"
                    style="padding:6px 12px;background:#9c36b5;color:#fff;border:none;font-size:12.5px;font-weight:600;cursor:pointer;"
                  >
                    Waitlist…
                  </button>
                  <button
                    type="button"
                    data-bulk="decline"
                    style="padding:6px 12px;background:#c92a2a;color:#fff;border:none;font-size:12.5px;font-weight:600;cursor:pointer;"
                  >
                    Decline…
                  </button>
                  <button
                    type="button"
                    id="bulk-email"
                    style="padding:6px 12px;background:transparent;color:#fff;border:1px solid #4a4b55;font-size:12.5px;cursor:pointer;"
                  >
                    Send email
                  </button>
                </>
              ) : null}
              <button
                type="button"
                id="bulk-export-csv"
                style="padding:6px 12px;background:transparent;color:#fff;border:1px solid #4a4b55;font-size:12.5px;cursor:pointer;"
              >
                Export CSV
              </button>
              <button
                type="button"
                id="bulk-export-xlsx"
                style="padding:6px 12px;background:transparent;color:#fff;border:1px solid #4a4b55;font-size:12.5px;cursor:pointer;"
              >
                Export XLSX
              </button>
              <button
                type="button"
                id="bulk-clear"
                style="margin-left:auto;padding:6px 10px;background:transparent;color:#9a9da6;border:none;font-size:12.5px;cursor:pointer;"
              >
                Clear
              </button>
            </div>

            <div style="background:#fff;border:1px solid #e2e3e8;overflow-x:auto;">
              <div
                style={`display:grid;${GRID}gap:0;padding:9px 12px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;color:#9a9da6;align-items:center;min-width:1000px;`}
              >
                <input type="checkbox" id="check-all" style="accent-color:#4c5fd5;" />
                <div>ID</div>
                <div data-sort="title" style="cursor:pointer;">
                  SESSION <span data-arrow=""></span>
                </div>
                <div data-sort="track" style="cursor:pointer;">
                  TRACK <span data-arrow=""></span>
                </div>
                <div>FORMAT</div>
                <div data-sort="score" style="cursor:pointer;">
                  SCORE <span data-arrow=""></span>
                </div>
                <div data-sort="status" style="cursor:pointer;">
                  STATUS <span data-arrow=""></span>
                </div>
                <div data-sort="submitted" style="cursor:pointer;">
                  SUBMITTED <span data-arrow=""></span>
                </div>
              </div>
              <div id="rows">
                {rendered.map((r) => (
                  <div
                    data-row
                    data-id={r.id}
                    data-status={r.chip}
                    data-form={r.formId}
                    data-track={r.trackId ?? ''}
                    data-track-name={r.trackId ? r.trackName : ''}
                    data-title={r.title}
                    data-submitted={r.submittedAt ?? ''}
                    data-score={r.avg === null ? '' : r.avg.toFixed(3)}
                    data-search={r.search}
                    style={ROW_STYLE + (matchesFilter(r, filter) ? '' : 'display:none;')}
                  >
                    <input type="checkbox" data-check style="accent-color:#4c5fd5;" />
                    <div style={`font-family:${MONO};font-size:11.5px;color:#9a9da6;`}>{r.num}</div>
                    <div style="min-width:0;padding-right:14px;">
                      <div style="font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        {r.title}
                      </div>
                      <div style="font-size:12px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        {r.speakers.map((s) => s.name).join(', ')}{' '}
                        <span style={`font-family:${MONO};font-size:10px;color:#9c36b5;`}>{r.via}</span>
                      </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;">
                      <span style={`display:inline-block;width:8px;height:8px;background:${r.trackColor};`}></span>
                      {r.trackName}
                    </div>
                    <div style="font-size:12.5px;color:#686b74;">{r.format}</div>
                    <div style={`font-family:${MONO};font-size:12px;`}>
                      <span style="font-weight:600;">{r.avg === null ? '—' : r.avg.toFixed(1)}</span>{' '}
                      <span style="color:#9a9da6;font-size:10.5px;">{`${r.done}/${r.total}`}</span>
                    </div>
                    <div>
                      <span
                        title={r.chip === 'outbox' ? 'Decision queued in the outbox — nothing sent yet' : undefined}
                        style={badgeStyle(r.chip)}
                      >
                        {r.chip === 'outbox' ? QUEUED_LABEL[queued.get(r.id)!] : statusMeta(r.chip).label}
                      </span>
                    </div>
                    <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{r.submitted}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ------------------------------------------------------------ drawer */}
      {raw(`<style>${DRAWER_CSS}</style>`)}
      <div id="drawer" data-drawer hidden>
        <div id="drawer-backdrop" style="position:fixed;inset:0;background:rgba(22,23,29,0.28);z-index:40;"></div>
        <aside id="drawer-panel"></aside>
      </div>

      {/* --------------------------------------------------- decision modal */}
      <div id="decision-modal" data-dialog hidden style={`display:grid;${MODAL_WRAP}`}>
        <div style={MODAL_PANEL}>
          <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
            <div id="decision-heading" style="font-size:17px;font-weight:700;"></div>
            <button
              type="button"
              data-dialog-close="#decision-modal"
              style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
            >
              ✕
            </button>
          </div>
          <div style="padding:20px 24px;display:grid;gap:16px;">
            <div>
              <div id="decision-recip-label" style={`${MICRO}margin-bottom:8px;`}></div>
              <div id="decision-recipients"></div>
            </div>
            <div>
              <div id="decision-template" style={`${MICRO}margin-bottom:6px;`}></div>
              <select id="decision-template-select" hidden style={`${SELECT}width:100%;margin-bottom:6px;`}></select>
              <input
                id="decision-subject"
                style={`${INPUT}font-weight:600;margin-bottom:6px;`}
                placeholder="Subject"
              />
              <textarea id="decision-body" rows={12} style={TEXTAREA}></textarea>
              <div id="decision-vars" style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:4px;`}></div>
            </div>
            <label
              id="decision-confirm-row"
              hidden
              style="display:flex;gap:8px;align-items:center;font-size:13px;color:#33343c;"
            >
              <input type="checkbox" id="decision-request-confirmation" checked style="accent-color:#4c5fd5;" />
              Request confirmation — speakers must confirm before they appear on the public agenda
            </label>
          </div>
          <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
            <button
              type="button"
              data-dialog-close="#decision-modal"
              style="padding:9px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;"
            >
              Cancel
            </button>
            <button type="button" id="decision-send" style="padding:9px 18px;background:#2b8a3e;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"></button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- group mail */}
      <div id="mail-modal" data-dialog hidden style={`display:grid;${MODAL_WRAP}`}>
        <div style={MODAL_PANEL}>
          <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
            <div id="mail-heading" style="font-size:17px;font-weight:700;">
              Send email
            </div>
            <button
              type="button"
              data-dialog-close="#mail-modal"
              style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
            >
              ✕
            </button>
          </div>
          <div style="padding:20px 24px;display:grid;gap:16px;">
            <div>
              <div id="mail-recip-label" style={`${MICRO}margin-bottom:8px;`}></div>
              <div
                id="mail-recipients"
                style="border:1px solid #e2e3e8;padding:10px 12px;font-size:12.5px;color:#686b74;max-height:120px;overflow-y:auto;"
              ></div>
            </div>
            <div>
              <div style={`${MICRO}margin-bottom:6px;`}>TEMPLATE</div>
              <select id="mail-template" style={`${SELECT}width:100%;`}>
                <option value="">Blank message</option>
                {templates.map((t) => (
                  <option value={t.key}>{t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <div style={`${MICRO}margin-bottom:6px;`}>EMAIL · EDITABLE PER SEND</div>
              <input id="mail-subject" style={`${INPUT}font-weight:600;margin-bottom:6px;`} placeholder="Subject" />
              <textarea id="mail-body" rows={12} style={TEXTAREA}></textarea>
              <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:4px;`}>
                {'Variables resolve per recipient: {{speaker_name}} {{session_title}} {{event_name}} {{portal_link}}'}
              </div>
            </div>
            <div>
              <button
                type="button"
                id="mail-preview-toggle"
                style="background:none;border:none;padding:0;font-size:12.5px;color:#4c5fd5;cursor:pointer;"
              >
                Preview first recipient
              </button>
              <div
                id="mail-preview"
                hidden
                style="margin-top:8px;border:1px solid #e2e3e8;background:#f8f8fa;padding:12px 14px;font-size:12.5px;line-height:1.55;color:#33343c;white-space:pre-wrap;"
              ></div>
            </div>
          </div>
          <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
            <button
              type="button"
              data-dialog-close="#mail-modal"
              style="padding:9px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;"
            >
              Cancel
            </button>
            <button
              type="button"
              id="mail-send"
              style="padding:9px 18px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* ----------------------------------------------------------- import */}
      <div id="import-modal" data-dialog hidden style={`display:grid;${MODAL_WRAP}`}>
        <div style={MODAL_PANEL}>
          <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
            <div style="font-size:17px;font-weight:700;">Import submissions from CSV</div>
            <button
              type="button"
              data-dialog-close="#import-modal"
              style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
            >
              ✕
            </button>
          </div>
          <div style="padding:20px 24px;display:grid;gap:16px;">
            <div>
              <div style={`${MICRO}margin-bottom:6px;`}>CSV FILE</div>
              <input type="file" id="import-file" accept=".csv,text/csv" style="font-size:13px;" />
              <div style="font-size:12.5px;color:#686b74;margin-top:6px;">
                First row is treated as the header. Quoted fields with commas and line breaks are supported.
              </div>
            </div>
            <div>
              <div style={`${MICRO}margin-bottom:6px;`}>TARGET FORM</div>
              <select id="import-form" style={`${SELECT}width:100%;`}>
                {board.forms.map((f) => (
                  <option value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
            <div id="import-mapping-wrap" hidden>
              <div style={`${MICRO}margin-bottom:8px;`}>MAP COLUMNS</div>
              <div id="import-mapping" style="display:grid;gap:6px;"></div>
            </div>
            <div
              id="import-preview"
              hidden
              style="background:#f8f8fa;border:1px solid #e2e3e8;padding:10px 14px;font-size:12.5px;color:#686b74;"
            ></div>
          </div>
          <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
            <button
              type="button"
              data-dialog-close="#import-modal"
              style="padding:9px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;"
            >
              Cancel
            </button>
            <button
              type="button"
              id="import-run"
              disabled
              style="padding:9px 18px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
            >
              Import
            </button>
          </div>
        </div>
      </div>

      {dataScript('data-submissions', payload)}
    </AdminLayout>
  );
});

/* ------------------------------------------------------------------ export */

/** Shared row builder for the CSV and XLSX exports — same filters/ids handling, same columns. */
async function exportTable(
  env: Bindings,
  event: Event,
  q: Record<string, string | undefined>
): Promise<{ rows: CsvRow[]; columns: string[] }> {
  const board = await loadBoard(env, event);

  const idsParam = (q.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const filter = {
    status: q.status ?? 'all',
    form: q.form ?? 'all',
    track: q.track ?? 'all',
    q: (q.q ?? '').trim().toLowerCase(),
  };
  const wanted = idsParam.length
    ? board.rows.filter((r) => idsParam.includes(r.id))
    : board.rows.filter((r) => matchesFilter(r, filter));

  const fileRows = await all<FileRow>(
    env.DB,
    `SELECT id, filename, size, subject_type, subject_id FROM files WHERE event_id = ?`,
    event.id
  );
  const filesById = new Map(fileRows.map((f) => [f.id, f]));

  const base = [
    'id',
    'title',
    'status',
    'track',
    'format',
    'level',
    'speakers',
    'score',
    'evalDone',
    'evalTotal',
    'submitted_at',
    'form',
  ];
  const extra: string[] = [];
  const rows: CsvRow[] = wanted.map((r) => {
    const row: CsvRow = {
      id: r.num,
      title: r.title,
      status: r.status,
      track: r.trackName,
      format: r.formatLong,
      level: r.level,
      speakers: r.speakers.map((s) => `${s.name} <${s.email}>`).join(' ; '),
      score: r.avg === null ? '' : r.avg.toFixed(2),
      evalDone: r.done,
      evalTotal: r.total,
      submitted_at: r.submittedAt ?? '',
      form: r.formName,
    };
    for (const field of r.fields) {
      const type = field.type ?? 'TXT';
      if (type === 'GRP' || type === 'HDR') continue;
      const label = field.label ?? field.id;
      if (!base.includes(label) && !extra.includes(label)) extra.push(label);
      row[label] = answerText(field, r.answers[field.id], filesById);
    }
    return row;
  });

  return { rows, columns: [...base, ...extra] };
}

app.get('/app/api/submissions/export.csv', async (c) => {
  const event = c.var.event;
  if (!event) return c.text('No event', 400);
  const { rows, columns } = await exportTable(c.env, event, c.req.query());
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(rows, columns), { headers: csvHeaders(`submissions-${event.slug}-${stamp}.csv`) });
});

app.get('/app/api/submissions/export.xlsx', async (c) => {
  const event = c.var.event;
  if (!event) return c.text('No event', 400);
  const { rows, columns } = await exportTable(c.env, event, c.req.query());
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(toXlsx(rows, columns, 'Submissions'), {
    headers: xlsxHeaders(`submissions-${event.slug}-${stamp}.xlsx`),
  });
});

/* ------------------------------------------------------------------ detail */

app.get('/app/api/submissions/:id', async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event' }, 400);
  const id = c.req.param('id');

  const board = await loadBoard(c.env, event);
  const row = board.rows.find((r) => r.id === id);
  if (!row) return c.json({ ok: false, error: 'Submission not found' }, 404);

  const [files, comments, activity, evals, plans, planIncludes, planReviewers, reviewerPins] = await Promise.all([
    all<FileRow>(
      c.env.DB,
      `SELECT id, filename, size, subject_type, subject_id FROM files WHERE event_id = ?`,
      event.id
    ),
    all<{ id: string; body: string; created_at: string; name: string | null; email: string }>(
      c.env.DB,
      `SELECT c.id, c.body, c.created_at, u.name, u.email FROM comments c
         JOIN users u ON u.id = c.author_user_id
        WHERE c.submission_id = ? ORDER BY c.created_at`,
      id
    ),
    all<{ actor: string; action: string; detail: string | null; created_at: string }>(
      c.env.DB,
      `SELECT actor, action, detail, created_at FROM activity
        WHERE subject_type = 'submission' AND subject_id = ? ORDER BY created_at`,
      id
    ),
    all<EvalRow>(
      c.env.DB,
      `SELECT submission_id, plan_id, reviewer_id, scores_json, abstained FROM evaluations WHERE submission_id = ?`,
      id
    ),
    all<PlanRow>(
      c.env.DB,
      `SELECT id, name, reviews_per, rules_json, criteria_json FROM eval_plans WHERE event_id = ? ORDER BY created_at`,
      event.id
    ),
    all<{ plan_id: string }>(c.env.DB, `SELECT plan_id FROM eval_plan_includes WHERE submission_id = ?`, id),
    all<{ plan_id: string; user_id: string; role: string; name: string | null; email: string }>(
      c.env.DB,
      // Insertion order — assignedFor() round-robins over this list (see loadPlans).
      `SELECT r.plan_id, r.user_id, r.role, u.name, u.email
         FROM eval_plan_reviewers r
         JOIN users u ON u.id = r.user_id
         JOIN eval_plans p ON p.id = r.plan_id
        WHERE p.event_id = ? ORDER BY r.rowid`,
      event.id
    ),
    all<{ plan_id: string; user_id: string }>(
      c.env.DB,
      `SELECT plan_id, user_id FROM eval_reviewer_pins WHERE submission_id = ? ORDER BY rowid`,
      id
    ),
  ]);

  const filesById = new Map(files.map((f) => [f.id, f]));
  const rendered: { label: string; value: string; files: { id: string; name: string; size: string; ext: string }[] }[] = [];
  const seenFiles = new Set<string>();
  for (const field of row.fields) {
    const type = field.type ?? 'TXT';
    if (type === 'GRP' || type === 'HDR') continue;
    if (row.usedFieldIds.includes(field.id)) continue; // track/format/level already have cards
    const value = row.answers[field.id];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
    if (field.core && (type === 'TXT' || type === 'LONG')) {
      // Title/abstract are already the drawer headline — skip the duplicate.
      if (String(value) === row.title || String(value) === row.abstract) continue;
    }
    const attached =
      type === 'FILE'
        ? fileIdsOf(value)
            .map((fid) => filesById.get(fid))
            .filter((f): f is FileRow => !!f)
            .map((f) => {
              seenFiles.add(f.id);
              return { id: f.id, name: f.filename, size: fmtBytes(f.size), ext: extOf(f.filename) };
            })
        : [];
    rendered.push({
      label: field.label ?? field.id,
      value: type === 'FILE' ? '' : answerText(field, value, filesById),
      files: attached,
    });
  }

  const uploads = files
    .filter((f) => f.subject_type === 'submission' && f.subject_id === id && !seenFiles.has(f.id))
    .map((f) => ({ id: f.id, name: f.filename, size: fmtBytes(f.size), ext: extOf(f.filename) }));

  // Per-criterion averages across every reviewer who scored this submission.
  const byCriterion = new Map<string, number[]>();
  for (const ev of evals) {
    if (ev.abstained) continue;
    for (const [name, value] of Object.entries(jsonParse<Record<string, number>>(ev.scores_json, {}))) {
      if (typeof value !== 'number') continue;
      const list = byCriterion.get(name) ?? [];
      list.push(value);
      byCriterion.set(name, list);
    }
  }
  const criteria = [...byCriterion.entries()].map(([name, values]) => {
    const avg = meanOf(values) ?? 0;
    return { name, val: avg.toFixed(1), pct: Math.round((avg / 5) * 100) };
  });

  // Which plans cover this row — by rules or by explicit assignment. The drawer
  // renders both and lets an admin assign to (or unassign from) the rest.
  const assignedPlanIds = new Set(planIncludes.map((p) => p.plan_id));
  const shape = { formId: row.formId, trackId: row.trackId, formatId: row.formatId, levelId: row.levelId, status: row.status };
  const planList = plans.map((p) => {
    const ruled = planCovers(jsonParse<Record<string, string>>(p.rules_json, {}), shape);
    const assigned = assignedPlanIds.has(p.id);
    // Per-plan reviewer slots (lib/evals assignedFor: pins first, round-robin
    // fill) so the drawer can show who reviews this and pin someone specific.
    const reviewers: PlanReviewer[] = planReviewers
      .filter((r) => r.plan_id === p.id)
      .map((r) => ({
        userId: r.user_id,
        role: r.role === 'chair' ? 'chair' : 'member',
        name: r.name || r.email.split('@')[0],
        email: r.email,
      }));
    const pinnedIds = reviewerPins.filter((n) => n.plan_id === p.id).map((n) => n.user_id);
    const stub = { reviewsPer: p.reviews_per || 1, reviewers, pins: { [id]: pinnedIds } };
    const slots = ruled || assigned ? assignedFor(stub, { id }) : [];
    const scoredBy = new Set(evals.filter((e) => e.plan_id === p.id).map((e) => e.reviewer_id));
    const pinned = new Set(pinnedIds);
    const revList = slots.map((r) => ({
      id: r.userId,
      name: r.name,
      pinned: pinned.has(r.userId),
      scored: scoredBy.has(r.userId),
    }));
    // A score from someone no longer in the slots (rules or roster changed)
    // still counts — keep the reviewer visible.
    for (const r of reviewers) {
      if (scoredBy.has(r.userId) && !revList.some((x) => x.id === r.userId))
        revList.push({ id: r.userId, name: r.name, pinned: false, scored: true });
    }
    return {
      id: p.id,
      name: p.name,
      ruled,
      assigned,
      reviewers: revList,
      addable:
        ruled || assigned
          ? members(stub)
              .filter((m) => !slots.some((s) => s.userId === m.userId))
              .map((m) => ({ id: m.userId, name: m.name }))
          : [],
    };
  });

  const activityLines = [
    ...(row.submittedAt
      ? [
          {
            when: fmtDate(row.submittedAt),
            text: `Submitted via “${row.formName}”${row.speakers[0] ? ` by ${row.speakers[0].name}` : ''}`,
          },
        ]
      : []),
    ...activity.map((a) => ({
      when: fmtDate(a.created_at),
      text:
        `${a.action}${a.detail ? ` — ${a.detail}` : ''}` +
        (a.actor && a.actor !== 'System' ? ` · ${a.actor}` : ''),
    })),
  ];

  return c.json({
    ok: true,
    sub: {
      id: row.id,
      num: row.num,
      status: row.status,
      statusLabel: statusMeta(row.chip).label,
      badge: badgeStyle(row.chip),
      title: row.title,
      abstract: row.abstract,
      trackName: row.trackName,
      trackColor: row.trackColor,
      format: row.formatLong,
      level: row.level,
      formName: row.formName,
      speakers: row.speakers.map((s) => ({
        name: s.name,
        email: s.email,
        bio: s.bio,
        initials: initials(s.name || s.email),
        headshot: s.headshot_file_id ? `/files/${s.headshot_file_id}` : null,
      })),
      answers: rendered,
      uploads,
      evaluation: {
        avg: row.avg === null ? '—' : row.avg.toFixed(1),
        label: `${row.done} OF ${row.total} EVALUATIONS IN`,
        criteria,
      },
      plans: planList,
      comments: comments.map((cm) => ({
        who: cm.name || cm.email,
        text: cm.body,
        when: fmtDate(cm.created_at),
      })),
      activity: activityLines,
    },
  });
});

/* ------------------------------------------------------------ plan assign */

/**
 * Explicitly pull one submission into an evaluation plan (or drop the explicit
 * include again). Additive to the plan's rules: removing an include never
 * hides a rule-matched submission, and reviews already recorded always keep
 * the submission visible in the plan (lib/evals `planSubmissions`).
 */
app.post('/app/api/submissions/assign-plan', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event' }, 400);
  const input = await c.req.json<{ submissionId?: string; planId?: string; remove?: boolean }>();

  const sub = await one<{ id: string; seq: number; title: string }>(
    c.env.DB,
    `SELECT id, seq, title FROM submissions WHERE id = ? AND event_id = ?`,
    input.submissionId ?? '',
    event.id
  );
  if (!sub) return c.json({ ok: false, error: 'Submission not found' }, 404);
  const plan = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM eval_plans WHERE id = ? AND event_id = ?`,
    input.planId ?? '',
    event.id
  );
  if (!plan) return c.json({ ok: false, error: 'That evaluation plan no longer exists' }, 404);

  if (input.remove) {
    await run(c.env.DB, `DELETE FROM eval_plan_includes WHERE plan_id = ? AND submission_id = ?`, plan.id, sub.id);
  } else {
    await run(
      c.env.DB,
      `INSERT OR IGNORE INTO eval_plan_includes (plan_id, submission_id, created_at) VALUES (?,?,?)`,
      plan.id,
      sub.id,
      now()
    );
  }

  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'submission',
    subjectId: sub.id,
    actor: c.var.user?.name || c.var.user?.email || 'Organizer',
    action: input.remove ? 'Removed from evaluation plan' : 'Assigned to evaluation plan',
    detail: `“${plan.name}”`,
  });

  return c.json({ ok: true, planName: plan.name });
});

/* -------------------------------------------------------- reviewer assign */

/**
 * Pin a specific reviewer onto one submission's review slots (or drop the pin
 * again). Pins fill slots ahead of the round-robin (`assignedFor` in
 * lib/evals), so the pinned reviewer sees the submission in their queue
 * immediately. Removing a pin never touches a recorded evaluation.
 */
app.post('/app/api/submissions/assign-reviewer', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event' }, 400);
  const input = await c.req.json<{ submissionId?: string; planId?: string; userId?: string; remove?: boolean }>();

  const sub = await one<{ id: string }>(
    c.env.DB,
    `SELECT id FROM submissions WHERE id = ? AND event_id = ?`,
    input.submissionId ?? '',
    event.id
  );
  if (!sub) return c.json({ ok: false, error: 'Submission not found' }, 404);
  const plan = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM eval_plans WHERE id = ? AND event_id = ?`,
    input.planId ?? '',
    event.id
  );
  if (!plan) return c.json({ ok: false, error: 'That evaluation plan no longer exists' }, 404);
  const reviewer = await one<{ user_id: string; role: string; name: string | null; email: string }>(
    c.env.DB,
    `SELECT r.user_id, r.role, u.name, u.email FROM eval_plan_reviewers r
       JOIN users u ON u.id = r.user_id WHERE r.plan_id = ? AND r.user_id = ?`,
    plan.id,
    input.userId ?? ''
  );
  if (!input.remove) {
    if (!reviewer) return c.json({ ok: false, error: 'That person is not a reviewer on this plan' }, 400);
    if (reviewer.role === 'chair')
      return c.json({ ok: false, error: 'Chairs see everything but do not score — pick a member' }, 400);
  }
  const reviewerName = reviewer ? reviewer.name || reviewer.email.split('@')[0] : 'a former reviewer';

  if (input.remove) {
    await run(
      c.env.DB,
      `DELETE FROM eval_reviewer_pins WHERE plan_id = ? AND submission_id = ? AND user_id = ?`,
      plan.id,
      sub.id,
      input.userId ?? ''
    );
  } else {
    await run(
      c.env.DB,
      `INSERT OR IGNORE INTO eval_reviewer_pins (plan_id, submission_id, user_id, created_at) VALUES (?,?,?,?)`,
      plan.id,
      sub.id,
      input.userId,
      now()
    );
  }

  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'submission',
    subjectId: sub.id,
    actor: c.var.user?.name || c.var.user?.email || 'Organizer',
    action: input.remove ? 'Unassigned reviewer' : 'Assigned reviewer',
    detail: `${reviewerName} — “${plan.name}”`,
  });

  return c.json({ ok: true, reviewerName, planName: plan.name });
});

/* ---------------------------------------------------------------- decisions */

app.post('/app/api/submissions/decide', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event' }, 400);
  const body = await c.req.json<{
    ids?: string[];
    decision?: string;
    subject?: string;
    body?: string;
    feedback?: Record<string, string>;
    requestConfirmation?: boolean;
  }>();

  const ids = (body.ids ?? []).filter((x) => typeof x === 'string');
  if (!ids.length) return c.json({ ok: false, error: 'Select at least one submission.' }, 400);
  if (ids.length > 100) return c.json({ ok: false, error: 'Decide at most 100 submissions per batch.' }, 400);
  if (!isDecision(body.decision)) return c.json({ ok: false, error: 'Unknown decision.' }, 400);

  // Queues only — status, session, tasks and email all happen when the
  // organizer sends from Emails → Outbox (lib/decision-queue).
  const result = await queueDecisions(c.env, {
    eventId: event.id,
    ids,
    decision: body.decision,
    subject: body.subject ?? null,
    body: body.body ?? null,
    perRecipientFeedback: body.feedback ?? {},
    requestConfirmation: body.requestConfirmation !== false,
    actorName: c.var.user?.name || c.var.user?.email || 'Organizer',
  });

  return c.json({ ok: true, result });
});

/* ----------------------------------------------------------------- comments */

app.post('/app/api/submissions/comment', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  const user = c.var.user;
  if (!event || !user) return c.json({ ok: false, error: 'No active event' }, 400);
  const input = await c.req.json<{ submissionId?: string; body?: string }>();
  const text = (input.body ?? '').trim();
  if (!input.submissionId || !text) return c.json({ ok: false, error: 'Write something first.' }, 400);

  const sub = await one<{ id: string; seq: number; title: string }>(
    c.env.DB,
    `SELECT id, seq, title FROM submissions WHERE id = ? AND event_id = ?`,
    input.submissionId,
    event.id
  );
  if (!sub) return c.json({ ok: false, error: 'Submission not found' }, 404);

  await run(
    c.env.DB,
    `INSERT INTO comments (id, submission_id, author_user_id, body, created_at) VALUES (?,?,?,?,?)`,
    newId('cmt'),
    sub.id,
    user.id,
    text,
    now()
  );

  // @-mentions: match org members by name, first name or email.
  const members = await all<{ id: string; name: string | null; email: string }>(
    c.env.DB,
    `SELECT u.id, u.name, u.email FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?`,
    event.org_id
  );
  const lower = text.toLowerCase();
  const mentioned = members.filter((m) => {
    if (m.id === user.id) return false;
    const handles = [m.email, m.name ?? '', (m.name ?? '').split(/\s+/)[0]].filter(Boolean);
    return handles.some((h) => lower.includes(`@${h.toLowerCase()}`));
  });

  const link = `${c.env.APP_ORIGIN}/app/submissions?open=${sub.id}`;
  for (const m of mentioned) {
    await sendEmail(c.env, {
      eventId: event.id,
      to: m.email,
      toName: m.name,
      templateKey: 'mention',
      subject: `${user.name || user.email} mentioned you on SUB-${sub.seq}`,
      text: `${user.name || user.email} mentioned you in an internal comment on “${sub.title}” (SUB-${sub.seq}):\n\n${text}\n\nOpen the submission:\n${link}\n\n— ${event.name}`,
      subjectType: 'submission',
      subjectId: sub.id,
    });
  }

  return c.json({
    ok: true,
    comment: { who: user.name || user.email, text, when: 'Just now' },
    mentioned: mentioned.map((m) => m.email),
  });
});

/* --------------------------------------------------------------- group mail */

app.post('/app/api/submissions/mail', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event' }, 400);
  const input = await c.req.json<{ ids?: string[]; subject?: string; body?: string; templateKey?: string }>();
  const ids = (input.ids ?? []).filter((x) => typeof x === 'string');
  const subject = (input.subject ?? '').trim();
  const body = (input.body ?? '').trim();
  if (!ids.length) return c.json({ ok: false, error: 'Select at least one submission.' }, 400);
  if (ids.length > 100) return c.json({ ok: false, error: 'Send to at most 100 submissions per batch.' }, 400);
  if (!subject || !body) return c.json({ ok: false, error: 'Subject and body are both required.' }, 400);

  const placeholders = ids.map(() => '?').join(',');
  const subs = await all<{ id: string; title: string }>(
    c.env.DB,
    `SELECT id, title FROM submissions WHERE event_id = ? AND id IN (${placeholders})`,
    event.id,
    ...ids
  );
  const speakers = await all<{ submission_id: string; name: string; email: string }>(
    c.env.DB,
    `SELECT submission_id, name, email FROM submission_speakers WHERE submission_id IN (${placeholders}) ORDER BY position`,
    ...ids
  );
  const titleOf = new Map(subs.map((s) => [s.id, s.title]));

  const seen = new Set<string>();
  let sent = 0;
  let simulated = 0;
  for (const sp of speakers) {
    const email = (sp.email || '').trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    if (!titleOf.has(sp.submission_id)) continue;
    seen.add(email.toLowerCase());
    const vars: Record<string, string> = {
      speaker_name: sp.name || 'there',
      first_name: (sp.name || 'there').split(/\s+/)[0],
      session_title: titleOf.get(sp.submission_id) ?? '',
      event_name: event.name,
      portal_link: `${c.env.APP_ORIGIN}/${event.slug}/portal`,
      event_dates: `${event.start_date} – ${event.end_date}`,
      event_venue: event.venue ?? 'the venue',
      individual_feedback: '',
      confirmation_link: `${c.env.APP_ORIGIN}/${event.slug}/portal`,
    };
    const res = await sendEmail(c.env, {
      eventId: event.id,
      to: email,
      toName: sp.name || null,
      templateKey: input.templateKey || 'group_mail',
      subject: renderTemplate(subject, vars),
      text: renderTemplate(body, vars),
      subjectType: 'submission',
      subjectId: sp.submission_id,
    });
    sent++;
    if (res.status === 'simulated') simulated++;
  }

  for (const s of subs) {
    await logActivity(c.env.DB, {
      eventId: event.id,
      subjectType: 'submission',
      subjectId: s.id,
      actor: c.var.user?.name || c.var.user?.email || 'Organizer',
      action: 'Emailed',
      detail: `Group mail “${subject}”`,
    });
  }

  return c.json({ ok: true, sent, simulated, submissions: subs.length });
});

/* -------------------------------------------------------------- csv import */

app.post('/app/api/submissions/import', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event' }, 400);
  const input = await c.req.json<{ text?: string; formId?: string; mapping?: string[] }>();
  const text = input.text ?? '';
  const mapping = input.mapping ?? [];
  if (!text.trim()) return c.json({ ok: false, error: 'The file looked empty.' }, 400);

  const form = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM forms WHERE id = ? AND event_id = ?`,
    input.formId ?? '',
    event.id
  );
  if (!form) return c.json({ ok: false, error: 'Pick a form to import into.' }, 400);
  const version = await one<{ id: string; schema_json: string }>(
    c.env.DB,
    `SELECT id, schema_json FROM form_versions WHERE form_id = ? ORDER BY version DESC LIMIT 1`,
    form.id
  );
  const fields = jsonParse<{ fields?: FormField[] }>(version?.schema_json ?? '{}', {}).fields ?? [];
  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const coreTitle = fields.find((f) => f.core && (f.type ?? '') === 'TXT');
  const coreAbstract = fields.find((f) => f.core && (f.type ?? '') === 'LONG');

  const table = parseCsvTable(text);
  if (!table.rows.length) return c.json({ ok: false, error: 'No data rows found below the header.' }, 400);
  if (table.rows.length > 500) return c.json({ ok: false, error: 'Import at most 500 rows at a time.' }, 400);

  const stamp = now();
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  const startSeq = await bumpSeq(c.env.DB, event.id, 'submission', table.rows.length);
  const stmts: Array<[string, unknown[]]> = [];
  let created = 0;

  table.rows.forEach((cells, index) => {
    const answers: Record<string, unknown> = {};
    let title = '';
    let abstract = '';
    let speakerName = '';
    let speakerEmail = '';
    let status = 'in_review';

    mapping.forEach((target, col) => {
      if (!target || target === 'ignore') return;
      const value = (cells[col] ?? '').trim();
      if (!value) return;
      if (target === 'title') title = value;
      else if (target === 'abstract') abstract = value;
      else if (target === 'speaker_name') speakerName = value;
      else if (target === 'speaker_email') speakerEmail = value;
      else if (target === 'status') {
        const raw = value.toLowerCase().replace(/[\s-]+/g, '_');
        const norm = RETIRED_STATUS[raw] ?? raw;
        status = IMPORTABLE_STATUS.has(norm) ? norm : 'in_review';
      } else if (target.startsWith('field:')) {
        const fieldId = target.slice(6);
        if (!fieldById.has(fieldId)) return;
        answers[fieldId] = value;
        if (coreTitle && fieldId === coreTitle.id && !title) title = value;
        if (coreAbstract && fieldId === coreAbstract.id && !abstract) abstract = value;
      }
    });

    if (!title && !speakerEmail) return; // nothing usable in this line
    if (coreTitle && title) answers[coreTitle.id] = title;
    if (coreAbstract && abstract) answers[coreAbstract.id] = abstract;

    const id = newId('sub');
    stmts.push([
      `INSERT INTO submissions (id, event_id, form_id, form_version_id, seq, status, title, abstract, answers_json,
         owner_user_id, agent_mode, withdraw_reason, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,0,NULL,?,?,?)`,
      [
        id,
        event.id,
        form.id,
        version?.id ?? null,
        startSeq + index,
        status,
        title || '(untitled import)',
        abstract,
        JSON.stringify(answers),
        stamp,
        stamp,
        stamp,
      ],
    ]);
    if (speakerName || speakerEmail) {
      stmts.push([
        `INSERT INTO submission_speakers (id, submission_id, position, name, email, bio, headshot_file_id, user_id)
         VALUES (?,?,0,?,?,'',NULL,NULL)`,
        [newId('ssp'), id, speakerName || speakerEmail, speakerEmail],
      ]);
    }
    stmts.push([
      `INSERT INTO activity (id, event_id, subject_type, subject_id, actor, action, detail, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        newId('act'),
        event.id,
        'submission',
        id,
        actor,
        'Imported from CSV',
        `Row ${index + 2} · form “${form.name}” · status ${status}`,
        stamp,
      ],
    ]);
    created++;
  });

  if (!created) return c.json({ ok: false, error: 'No rows had a title or speaker email — check the mapping.' }, 400);
  await batch(c.env.DB, stmts);
  return c.json({ ok: true, created });
});

export default app;
