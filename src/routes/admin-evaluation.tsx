/**
 * `/app/evaluation` — Evaluations, Evaluation Plans, reviewer reminders.
 *
 * OWNER: B3. Markup + inline styles ported from
 * `prototype/design_handoff_program/design/Evaluation.dc.html` (organizer view,
 * plan list / editor / detail, reminders modal). The prototype's
 * "Evaluator queue | Organizer view" toggle becomes: admins get
 * All Evaluations + Evaluation Plans, and a "My Evaluations" tab appears when
 * the signed-in user is also a reviewer — the same queue `/{event}/evaluate`
 * renders, shared via `src/views/eval-queue.tsx`.
 */
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { AdminLayout, MONO, STATUS_COLORS } from '../views/layout';
import { adminProps } from '../views/chrome';
import { EVAL_QUEUE_CSS, EvalQueue } from '../views/eval-queue';
import { all, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { requireOrgRole, requestPasswordReset } from '../lib/auth';
import { logActivity } from '../lib/activity';
import { sendEmail } from '../lib/email';
import {
  assignedFor,
  avgCumulative,
  cumMaxOf,
  cumulativeOf,
  daysUntil,
  DEFAULT_AUTOMATION,
  DEFAULT_CRITERIA,
  DEFAULT_RULES,
  effRp,
  fmtDay,
  initialsOfName,
  loadEvalContext,
  loadEvaluatorFields,
  loadSubmissionFileNames,
  matchesRules,
  members,
  mergeTags,
  normalizeAutomation,
  planProgress,
  planSubmissions,
  reviewerLoad,
  starAvgOf,
  submissionScore,
  type Automation,
  type Criterion,
  type EvalContext,
  type EvalPlan,
  type EvalSubmission,
  type Evaluation,
  type Rules,
} from '../lib/evals';

const app = new Hono<Ctx>();

/* ------------------------------------------------------------------ styles */

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`;
const MICRO_WIDE = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const CARD = 'background:#fff;border:1px solid #e2e3e8;';
const PRIMARY_BTN = 'padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;';
const GHOST_BTN = 'padding:9px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const INPUT = 'padding:7px 12px;border:1px solid #e2e3e8;font-size:13px;outline-color:#4c5fd5;background:#fff;';
const SELECT = 'padding:7px 10px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;color:#33343c;cursor:pointer;outline-color:#4c5fd5;';

const chip = (bg: string, fg: string) =>
  `display:inline-block;padding:2px 6px;font-family:${MONO};font-size:10.5px;font-weight:600;background:${bg};color:${fg};`;
const statusChipStyle = (status: string) => {
  const s = STATUS_COLORS[status] ?? { label: status, fg: '#686b74', bg: '#f2f3f5' };
  return chip(s.bg, s.fg);
};
const statusLabel = (status: string) => (STATUS_COLORS[status]?.label ?? status);
const subTab = (on: boolean) =>
  `padding:0 2px 10px;background:none;border:none;border-bottom:2px solid ${
    on ? '#4c5fd5' : 'transparent'
  };margin-bottom:-1px;font-size:13.5px;font-weight:600;color:${on ? '#16171d' : '#686b74'};cursor:pointer;text-decoration:none;display:inline-block;`;
const dot = (color: string) => `width:8px;height:8px;background:${color};flex:none;`;

/**
 * The reminders overlay carries its layout here rather than inline: an inline
 * `display` would beat the `[hidden]` UA rule and the modal would never hide.
 */
const PAGE_CSS = `
  #rem-modal{position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:60;display:grid;justify-items:center;align-items:start;padding:44px 32px;overflow:auto;}
  #rem-modal[hidden]{display:none;}
  [data-row-hover]:hover{background:#f8f9fc;}
  [data-card-href]:hover{border-color:#4c5fd5;background:#fdfdff;}
`;

const DEC_BUTTONS = [
  { key: 'accept', label: 'Approve', on: '#2b8a3e', tint: '#eaf5ec', edge: '#bcdcc4' },
  { key: 'waitlist', label: 'Waitlist', on: '#b08800', tint: '#fbf4e2', edge: '#e6d29a' },
  { key: 'decline', label: 'Deny', on: '#c0392b', tint: '#fbeceb', edge: '#e9bdb8' },
];

const num1 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toFixed(1));

/* ------------------------------------------------------------------ pieces */

const StatCards: FC<{ stats: { label: string; val: string; sub: string }[] }> = ({ stats }) => (
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
    {stats.map((s) => (
      <div style={`${CARD}padding:14px 16px;`}>
        <div style={MICRO}>{s.label}</div>
        <div style={`font-size:24px;font-weight:700;font-family:${MONO};margin-top:4px;`}>{s.val}</div>
        <div style="font-size:11.5px;color:#686b74;">{s.sub}</div>
      </div>
    ))}
  </div>
);

const ReviewerRail: FC<{
  title: string;
  rows: { name: string; frac: string; pct: number; complete: boolean }[];
  remindLabel: string;
  autoLine: string;
  autoOn: boolean;
}> = ({ title, rows, remindLabel, autoLine, autoOn }) => (
  <div style={CARD}>
    <div style="padding:12px 16px;border-bottom:1px solid #e2e3e8;font-size:14px;font-weight:700;">{title}</div>
    {rows.length ? (
      rows.map((e) => (
        <div style="padding:10px 16px;border-bottom:1px solid #f2f3f5;">
          <div style="display:flex;font-size:13px;">
            <span style="font-weight:600;">{e.name}</span>
            <span style={`margin-left:auto;font-family:${MONO};font-size:11.5px;color:#686b74;`}>{e.frac}</span>
          </div>
          <div style="height:5px;background:#eef0f3;margin-top:6px;">
            <div style={`height:5px;width:${e.pct}%;background:${e.complete ? '#2b8a3e' : '#4c5fd5'};`}></div>
          </div>
        </div>
      ))
    ) : (
      <div style="padding:14px 16px;font-size:12.5px;color:#9a9da6;">No reviewers yet.</div>
    )}
    <div style="padding:12px 16px;display:grid;gap:9px;">
      <button type="button" data-open-reminders style="width:100%;padding:9px 0;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">
        {remindLabel}
      </button>
      <div style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:#686b74;">
        <span style={`width:7px;height:7px;flex:none;background:${autoOn ? '#2b8a3e' : '#c9cbd3'};`}></span>
        <span>{autoLine}</span>
      </div>
    </div>
  </div>
);

/* -------------------------------------------------------------- page data */

type PageCtx = EvalContext & {
  peopleById: Map<string, { id: string; name: string; email: string }>;
};

function nameOf(ctx: PageCtx, userId: string): string {
  return ctx.peopleById.get(userId)?.name ?? 'Unknown reviewer';
}

/** Every reviewer of the event with their cross-plan load. */
function reviewerRows(ctx: PageCtx, plans: EvalPlan[]) {
  const seen = new Map<string, { name: string; load: number; done: number; chair: boolean }>();
  plans.forEach((p) => {
    p.reviewers.forEach((r) => {
      const cur = seen.get(r.userId) ?? { name: r.name, load: 0, done: 0, chair: true };
      if (r.role === 'chair') {
        seen.set(r.userId, cur);
        return;
      }
      const l = reviewerLoad(p, r.userId, ctx.submissions, ctx.evaluations);
      seen.set(r.userId, { name: r.name, load: cur.load + l.load, done: cur.done + l.done, chair: false });
    });
  });
  return [...seen.entries()].map(([userId, v]) => ({
    userId,
    name: v.chair ? `${v.name} · chair` : v.name,
    frac: v.chair ? 'no queue' : `${v.done}/${v.load}`,
    pct: v.load ? Math.round((v.done / v.load) * 100) : 0,
    complete: !v.chair && v.load > 0 && v.done === v.load,
  }));
}

/* ------------------------------------------------------------------ route */

app.get('/app/evaluation', async (c) => {
  const event = c.var.event;
  const props = await adminProps(c, 'Evaluation');
  if (!event) return c.redirect('/app/events/new');
  const db = c.env.DB;
  const user = c.var.user!;

  const base = await loadEvalContext(db, event.id);
  const people = await all<{ id: string; name: string | null; email: string }>(
    db,
    `SELECT DISTINCT u.id, u.name, u.email FROM users u
      WHERE u.id IN (SELECT r.user_id FROM eval_plan_reviewers r JOIN eval_plans p ON p.id = r.plan_id WHERE p.event_id = ?)
         OR u.id IN (SELECT e.reviewer_id FROM evaluations e JOIN eval_plans p2 ON p2.id = e.plan_id WHERE p2.event_id = ?)
         OR u.id IN (SELECT m.user_id FROM org_members m WHERE m.org_id = ?)
      ORDER BY u.name`,
    event.id,
    event.id,
    event.org_id
  );
  const ctx: PageCtx = {
    ...base,
    peopleById: new Map(people.map((p) => [p.id, { id: p.id, name: p.name || p.email.split('@')[0], email: p.email }])),
  };

  const iAmReviewer = ctx.plans.some((p) => p.reviewers.some((r) => r.userId === user.id));

  const tabParam = c.req.query('tab');
  const tab = tabParam === 'plans' ? 'plans' : tabParam === 'mine' && iAmReviewer ? 'mine' : 'scores';
  const planParam = c.req.query('plan') ?? '';
  const filters: Filters = {
    q: c.req.query('q') ?? '',
    track: c.req.query('track') || 'all',
    plan: tab === 'plans' ? 'all' : c.req.query('plan') || 'all',
    unreviewed: c.req.query('filter') === 'unreviewed',
  };
  const editing = c.req.query('edit') === '1' || c.req.query('new') === '1';
  const isNew = c.req.query('new') === '1';
  const openSub = c.req.query('open') ?? '';
  const detailPlan = ctx.plans.find((p) => p.id === planParam) ?? null;

  const tabs = (
    <div style="display:flex;gap:18px;border-bottom:1px solid #e2e3e8;margin-bottom:20px;">
      <a href="/app/evaluation" style={subTab(tab === 'scores')}>
        All Evaluations
      </a>
      {iAmReviewer ? (
        <a href="/app/evaluation?tab=mine" style={subTab(tab === 'mine')}>
          My Evaluations
        </a>
      ) : null}
      <a href="/app/evaluation?tab=plans" style={subTab(tab === 'plans')}>
        Evaluation Plans
      </a>
    </div>
  );

  // My Evaluations: the evaluator queue, exactly as `/{event}/evaluate` renders
  // it (shared view + island), inside the admin shell.
  if (tab === 'mine') {
    const myPlans = ctx.plans.filter((p) => p.reviewers.some((r) => r.userId === user.id));
    const [fields, fileNames] = await Promise.all([
      loadEvaluatorFields(db, event.id),
      loadSubmissionFileNames(db, event.id),
    ]);
    return c.html(
      <AdminLayout {...props} scripts={['/js/evaluate.js']}>
        <style>{raw(PAGE_CSS + EVAL_QUEUE_CSS)}</style>
        <div style="padding:24px 28px;">
          {tabs}
          <EvalQueue
            ctx={ctx}
            myPlans={myPlans}
            userId={user.id}
            slug={event.slug}
            fields={fields}
            fileNames={fileNames}
            basePath="/app/evaluation"
            fixedParams={{ tab: 'mine' }}
            query={(k) => c.req.query(k)}
          />
        </div>
      </AdminLayout>
    );
  }

  // reminders modal scope: the plan when we are on a plan page, else the event
  const scopePlans = tab === 'plans' && detailPlan ? [detailPlan] : ctx.plans;
  const reminders = await buildReminders(c, ctx, scopePlans, tab === 'plans' && detailPlan ? detailPlan.id : null);

  const islandData = {
    slug: event.slug,
    eventName: event.name,
    tab,
    planId: detailPlan?.id ?? null,
    editing,
    draft: editing ? draftPayload(isNew ? null : detailPlan) : null,
    submissions: ctx.submissions.map((s) => ({
      id: s.id,
      displayId: s.displayId,
      title: s.title,
      status: s.status,
      statusLabel: statusLabel(s.status),
      statusStyle: statusChipStyle(s.status),
      trackId: s.trackOptionId,
      trackName: s.trackName,
      trackColor: s.trackColor,
      formId: s.formId,
      format: s.format,
      level: s.level,
    })),
    tracks: ctx.tracks.map((t) => ({ id: t.id, name: t.name })),
    forms: ctx.forms,
    formats: ctx.formats,
    levels: ctx.levels,
    people: [...ctx.peopleById.values()],
    reminders,
  };

  return c.html(
    <AdminLayout {...props} scripts={['/js/evaluation.js']}>
      <style>{raw(PAGE_CSS)}</style>
      <div style="padding:24px 28px;">
        {tabs}
        {tab === 'scores'
          ? ScoresTab({ ctx, openSub, reminders, filters })
          : editing
            ? PlanEditor({ plan: isNew ? null : detailPlan, ctx })
            : detailPlan
              ? PlanDetail({ plan: detailPlan, ctx, reminders })
              : PlansList({ ctx })}
      </div>
      {RemindersModal({ reminders })}
      <script type="application/json" id="data-evaluation">
        {raw(JSON.stringify(islandData).replace(/</g, '\\u003c'))}
      </script>
    </AdminLayout>
  );
});

/* ------------------------------------------------------------ scores tab */

type Filters = { q: string; track: string; plan: string; unreviewed: boolean };

function ScoresTab(opts: { ctx: PageCtx; openSub: string; reminders: RemindersData; filters: Filters }) {
  const { ctx, openSub, reminders, filters } = opts;
  const sel = ctx.submissions.find((s) => s.id === openSub) ?? null;

  const scoped = new Set<string>();
  ctx.plans.forEach((p) => planSubmissions(p, ctx.submissions, ctx.evaluations).forEach((s) => scoped.add(s.id)));
  const scopedSubs = ctx.submissions.filter((s) => scoped.has(s.id));
  const scores = new Map(scopedSubs.map((s) => [s.id, submissionScore(s, ctx.plans, ctx.submissions, ctx.evaluations)]));
  const remainingTotal = [...scores.values()].reduce((a, s) => a + s.remaining, 0);
  const fully = [...scores.values()].filter((s) => s.expected > 0 && s.remaining === 0).length;
  const withAvg = [...scores.values()].filter((s) => s.avg != null);
  const avgAll = withAvg.length ? (withAvg.reduce((a, s) => a + (s.avg ?? 0), 0) / withAvg.length).toFixed(1) : '—';

  const stats = [
    { label: 'SUBMISSIONS', val: String(scopedSubs.length), sub: 'in evaluation scope' },
    { label: 'FULLY SCORED', val: String(fully), sub: 'all evaluations in' },
    { label: 'EVALUATIONS REMAINING', val: String(remainingTotal), sub: 'across all evaluators' },
    { label: 'AVG SCORE', val: avgAll, sub: 'across scored submissions' },
  ];

  const rail = (
    <div style="display:grid;gap:16px;">
      <ReviewerRail
        title="Evaluator progress"
        rows={reviewerRows(ctx, ctx.plans)}
        remindLabel="Remind evaluators…"
        autoLine={reminders.autoLine}
        autoOn={reminders.automation.on}
      />
    </div>
  );

  return (
    <div>
      <StatCards stats={stats} />
      <div style="display:grid;grid-template-columns:1fr 300px;gap:16px;align-items:start;">
        <div style="min-width:0;">{sel ? ScoreDetail({ ctx, sub: sel }) : ScoreList({ ctx, scores, filters })}</div>
        {rail}
      </div>
    </div>
  );
}

function ScoreList(opts: { ctx: PageCtx; scores: Map<string, ReturnType<typeof submissionScore>>; filters: Filters }) {
  const { ctx, scores, filters } = opts;
  const q = filters.q.trim().toLowerCase();
  const fTrack = filters.track;
  const fPlan = filters.plan;

  let rows = ctx.submissions.filter((s) => scores.has(s.id));
  if (fPlan !== 'all') {
    const plan = ctx.plans.find((p) => p.id === fPlan);
    if (plan) {
      const ids = new Set(planSubmissions(plan, ctx.submissions, ctx.evaluations).map((s) => s.id));
      rows = rows.filter((s) => ids.has(s.id));
    }
  }
  if (fTrack !== 'all') rows = rows.filter((s) => s.trackOptionId === fTrack);
  if (filters.unreviewed) {
    const reviewed = new Set(ctx.evaluations.map((e) => e.submissionId));
    rows = rows.filter((s) => !reviewed.has(s.id));
  }
  if (q) {
    rows = rows.filter((s) =>
      `${s.title} ${s.displayId} ${s.trackName} ${s.speakers.map((p) => p.name).join(' ')}`.toLowerCase().includes(q)
    );
  }
  rows = rows.slice().sort((a, b) => {
    const sa = scores.get(a.id)!;
    const sb = scores.get(b.id)!;
    return (sb.avg ?? -1) - (sa.avg ?? -1) || sa.remaining - sb.remaining;
  });

  const hasFilters = !!(q || fTrack !== 'all' || fPlan !== 'all' || filters.unreviewed);

  return (
    <div>
      {filters.unreviewed ? (
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px 14px;background:#fdf5dc;border:1px solid #e8d79a;font-size:12.5px;color:#7a5c0a;">
          <span>
            Showing <b>{`${rows.length} submission${rows.length === 1 ? '' : 's'} with no evaluations yet`}</b>. Assign
            evaluators or remind the ones already assigned.
          </span>
          <a
            href="/app/evaluation"
            style="margin-left:auto;color:#7a5c0a;font-size:12.5px;text-decoration:underline;white-space:nowrap;"
          >
            Show all submissions
          </a>
        </div>
      ) : null}
      <form method="get" action="/app/evaluation" data-autosubmit style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
        {filters.unreviewed ? <input type="hidden" name="filter" value="unreviewed" /> : null}
        <input name="q" value={filters.q} placeholder="Search title or author…" style={`width:250px;${INPUT}`} />
        <select name="track" style={SELECT}>
          <option value="all" selected={fTrack === 'all'}>
            All tracks
          </option>
          {ctx.tracks.map((t) => (
            <option value={t.id} selected={fTrack === t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select name="plan" style={SELECT}>
          <option value="all" selected={fPlan === 'all'}>
            All evaluation plans
          </option>
          {ctx.plans.map((p) => (
            <option value={p.id} selected={fPlan === p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {hasFilters ? (
          <a href="/app/evaluation" style="padding:7px 10px;color:#4c5fd5;font-size:12.5px;font-weight:600;text-decoration:none;">
            Clear ×
          </a>
        ) : null}
      </form>
      <div style={CARD}>
        <div
          style={`display:grid;grid-template-columns:56px minmax(0,1fr) 120px 190px 50px 60px 92px;gap:12px;padding:9px 16px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`}
        >
          <div>ID</div>
          <div>TITLE</div>
          <div>TRACK</div>
          <div>SCORES BY EVALUATOR</div>
          <div style="text-align:right;">AVG</div>
          <div style="text-align:right;">LEFT</div>
          <div style="text-align:right;">DECISION</div>
        </div>
        {rows.map((s) => {
          const sc = scores.get(s.id)!;
          const chips = evaluatorChips(ctx, s);
          const rem = sc.remaining;
          const dec = STATUS_COLORS[s.status];
          const decided = ['accepted', 'declined', 'waitlisted'].includes(s.status);
          return (
            <a
              data-row-hover
              href={`/app/evaluation?open=${s.id}`}
              style="display:grid;grid-template-columns:56px minmax(0,1fr) 120px 190px 50px 60px 92px;gap:12px;padding:10px 16px;border-bottom:1px solid #f2f3f5;align-items:center;cursor:pointer;color:#16171d;text-decoration:none;"
            >
              <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{s.displayId}</div>
              <div style="min-width:0;">
                <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {s.title}
                </div>
                <div style="font-size:11px;color:#9a9da6;">
                  {`${s.format.replace(/ \(.+\)/, '') || '—'} · ${s.level || '—'}`}
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#33343c;">
                <span style={dot(s.trackColor)}></span>
                {s.trackName}
              </div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;">
                {chips.map((ch) => (
                  <span title={ch.title} style={chip(ch.done ? '#eef0fb' : '#f2f3f5', ch.done ? '#33343c' : '#c0c2ca')}>
                    {ch.label}
                  </span>
                ))}
              </div>
              <div style={`font-family:${MONO};font-size:13px;font-weight:600;text-align:right;`}>{num1(sc.avg)}</div>
              <div style="text-align:right;">
                {rem === 0 ? (
                  <span style={`font-family:${MONO};font-size:12px;font-weight:600;color:#2b8a3e;`}>✓</span>
                ) : (
                  <span style={chip('#fdf5dc', '#b08800')}>{`${rem} left`}</span>
                )}
              </div>
              <div style="text-align:right;">
                {decided ? (
                  <span style={chip(dec.bg, dec.fg)}>{dec.label.toUpperCase()}</span>
                ) : (
                  <span style={`font-family:${MONO};font-size:11px;color:#c0c2ca;`}>—</span>
                )}
              </div>
            </a>
          );
        })}
        {rows.length === 0 ? (
          <div style="padding:36px 16px;text-align:center;font-size:13px;color:#686b74;">
            No submissions match —{' '}
            <a href="/app/evaluation" style="color:#4c5fd5;font-weight:600;">
              clear filters
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Chip = { label: string; title: string; done: boolean };

function evaluatorChips(ctx: PageCtx, s: EvalSubmission): Chip[] {
  const out: Chip[] = [];
  ctx.plans.forEach((p) => {
    if (!planSubmissions(p, ctx.submissions, ctx.evaluations).some((x) => x.id === s.id)) return;
    const evals = ctx.evaluations.filter((e) => e.planId === p.id && e.submissionId === s.id);
    evals.forEach((e) => {
      const nm = nameOf(ctx, e.reviewerId);
      const star = starAvgOf(p, e);
      out.push(
        e.abstained
          ? { label: `${initialsOfName(nm)} ∅`, title: `${nm} — abstained`, done: false }
          : { label: `${initialsOfName(nm)} ${num1(star)}`, title: `${nm}: ${num1(star)}★ · ${p.name}`, done: true }
      );
    });
    assignedFor(p, s).forEach((r) => {
      if (evals.some((e) => e.reviewerId === r.userId)) return;
      out.push({ label: `${initialsOfName(r.name)} —`, title: `${r.name} — not submitted yet`, done: false });
    });
  });
  return out;
}

function ScoreDetail(opts: { ctx: PageCtx; sub: EvalSubmission }) {
  const { ctx, sub } = opts;
  const sc = submissionScore(sub, ctx.plans, ctx.submissions, ctx.evaluations);
  const rem = sc.remaining;
  const inPlans = ctx.plans.filter((p) => planSubmissions(p, ctx.submissions, ctx.evaluations).some((s) => s.id === sub.id));

  return (
    <div style={CARD}>
      <div style="padding:22px 26px;border-bottom:1px solid #eceded;">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">
          <span
            style={`display:inline-block;padding:3px 8px;font-size:11px;font-weight:600;color:#fff;background:${sub.trackColor};font-family:${MONO};`}
          >
            {sub.trackName}
          </span>
          <span style="font-size:12px;color:#686b74;">{`${sub.format || '—'} · ${sub.level || '—'}`}</span>
          <span style={statusChipStyle(sub.status)}>{statusLabel(sub.status).toUpperCase()}</span>
          <span
            style={`margin-left:auto;font-family:${MONO};font-size:10.5px;font-weight:600;color:${rem === 0 ? '#2b8a3e' : '#b08800'};`}
          >
            {rem === 0 ? 'ALL EVALUATIONS IN' : `${rem} EVALUATION${rem === 1 ? '' : 'S'} REMAINING`}
          </span>
        </div>
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;">{sub.title}</div>
        <div style="font-size:14.5px;line-height:1.6;color:#33343c;margin-top:10px;">{sub.abstract}</div>
      </div>
      <div style="padding:18px 26px;border-bottom:1px solid #eceded;display:grid;grid-template-columns:repeat(4,1fr);gap:14px;">
        {[
          { label: 'ID', val: sub.displayId },
          { label: 'SUBMITTED', val: fmtDay(sub.submittedAt) },
          { label: 'PLANS', val: inPlans.map((p) => p.name).join(', ') || '—' },
          { label: 'STATUS', val: statusLabel(sub.status) },
        ].map((m) => (
          <div>
            <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;`}>{m.label}</div>
            <div style="font-size:13px;font-weight:600;margin-top:3px;">{m.val}</div>
          </div>
        ))}
      </div>
      <div style="padding:18px 26px;border-bottom:1px solid #eceded;">
        <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;margin-bottom:10px;`}>SPEAKERS</div>
        <div style="display:grid;gap:10px;">
          {sub.speakers.map((p) => (
            <div style="display:flex;gap:12px;align-items:baseline;">
              <div style="font-size:13.5px;font-weight:600;">{p.name}</div>
              <div style={`font-size:12px;color:#4c5fd5;font-family:${MONO};`}>{p.email}</div>
              <div style="font-size:12.5px;color:#686b74;">{p.bio}</div>
            </div>
          ))}
          {sub.speakers.length === 0 ? <div style="font-size:12.5px;color:#9a9da6;">No speakers on this submission.</div> : null}
        </div>
      </div>
      <div style="padding:18px 26px;border-bottom:1px solid #eceded;">
        <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;margin-bottom:12px;`}>
          SCORES BY EVALUATOR
        </div>
        <div style="display:grid;gap:14px;">
          {inPlans.map((p) => {
            const evals = ctx.evaluations.filter((e) => e.planId === p.id && e.submissionId === sub.id);
            const pending = assignedFor(p, sub).filter((r) => !evals.some((e) => e.reviewerId === r.userId));
            return (
              <div style="display:grid;gap:14px;">
                {inPlans.length > 1 ? <div style={MICRO}>{p.name.toUpperCase()}</div> : null}
                {evals.map((e) => (
                  <div>
                    <div style="display:grid;grid-template-columns:160px 1fr 54px;gap:14px;align-items:center;">
                      <div>
                        <div style="font-size:13px;font-weight:600;">{nameOf(ctx, e.reviewerId)}</div>
                        <div
                          style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.06em;color:${
                            e.abstained ? '#686b74' : '#2b8a3e'
                          };margin-top:2px;`}
                        >
                          {e.abstained ? 'ABSTAINED' : 'SUBMITTED'}
                        </div>
                      </div>
                      <div style="display:grid;gap:5px;">
                        {e.abstained
                          ? [<div style="font-size:12px;color:#9a9da6;">Abstained — conflict of interest</div>]
                          : p.criteria.map((crit) => {
                              const v = Number(e.scores[crit.name]) || 0;
                              return (
                                <div style="display:grid;grid-template-columns:80px 1fr 18px;gap:10px;align-items:center;font-size:11.5px;color:#686b74;">
                                  <div>{crit.name}</div>
                                  <div style="height:4px;background:#eef0f3;">
                                    <div style={`height:4px;width:${Math.round((v / (crit.scale || 5)) * 100)}%;background:#4c5fd5;`}></div>
                                  </div>
                                  <div style={`font-family:${MONO};font-size:11px;font-weight:600;color:#16171d;`}>{v || '—'}</div>
                                </div>
                              );
                            })}
                      </div>
                      <div style={`font-family:${MONO};font-size:14px;font-weight:700;text-align:right;`}>
                        {e.abstained ? '—' : num1(starAvgOf(p, e))}
                      </div>
                    </div>
                    {e.note ? (
                      <div style="border-left:2px solid #e2e3e8;padding:2px 0 2px 12px;margin:8px 0 0 174px;font-size:12.5px;color:#33343c;">
                        {e.note}
                      </div>
                    ) : null}
                  </div>
                ))}
                {pending.map((r) => (
                  <div style="display:grid;grid-template-columns:160px 1fr 54px;gap:14px;align-items:center;">
                    <div>
                      <div style="font-size:13px;font-weight:600;">{r.name}</div>
                      <div style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.06em;color:#b08800;margin-top:2px;`}>PENDING</div>
                    </div>
                    <div style="font-size:12px;color:#9a9da6;">Not submitted yet</div>
                    <div style={`font-family:${MONO};font-size:14px;font-weight:700;text-align:right;`}>—</div>
                  </div>
                ))}
              </div>
            );
          })}
          {inPlans.length === 0 ? (
            <div style="font-size:12.5px;color:#9a9da6;">This submission is not covered by any evaluation plan yet.</div>
          ) : null}
        </div>
      </div>
      <div style="padding:20px 26px;display:flex;align-items:center;gap:28px;flex-wrap:wrap;">
        <div>
          <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;`}>AVG SCORE</div>
          <div style="font-size:24px;font-weight:700;">{sc.avg != null ? `${num1(sc.avg)}★` : '—'}</div>
        </div>
        <div>
          <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;`}>EVALUATIONS IN</div>
          <div style="font-size:24px;font-weight:700;">{`${sc.n} of ${sc.expected}`}</div>
        </div>
        <div>
          <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;`}>REMAINING</div>
          <div style="font-size:24px;font-weight:700;">{String(rem)}</div>
        </div>
        <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
          <div
            style={`display:flex;gap:6px;padding-right:8px;margin-right:4px;border-right:1px solid #eceded;${
              rem === 0 ? '' : 'opacity:0.45;'
            }`}
          >
            {DEC_BUTTONS.map((b) => (
              <a
                href={`/app/submissions?open=${sub.id}&action=${b.key}`}
                title={
                  rem === 0
                    ? `Mark as ${b.label.toLowerCase()}`
                    : `${rem} evaluation${rem === 1 ? '' : 's'} still outstanding`
                }
                style={`padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;border:1px solid ${b.edge};background:${b.tint};color:${b.on};`}
              >
                {b.label}
              </a>
            ))}
          </div>
          <a href="/app/evaluation" style={`${GHOST_BTN}text-decoration:none;color:#16171d;`}>
            ← Back to list
          </a>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- plans tab */

function PlansList(opts: { ctx: PageCtx }) {
  const { ctx } = opts;
  return (
    <div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
        <a href="/app/evaluation?tab=plans&new=1" style={`${PRIMARY_BTN}text-decoration:none;`}>
          ＋ New plan
        </a>
        <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
          {`${ctx.plans.length} plan${ctx.plans.length === 1 ? '' : 's'} · ${ctx.peopleById.size} people`}
        </div>
      </div>
      <div style="display:grid;gap:10px;">
        {ctx.plans.map((p) => {
          const pr = planProgress(p, ctx.submissions, ctx.evaluations);
          const cumMax = cumMaxOf(p.criteria);
          const ac = avgCumulative(p, ctx.submissions, ctx.evaluations);
          const chairs = p.reviewers.filter((r) => r.role === 'chair').length;
          const avatars = p.reviewers.slice(0, 5);
          return (
            <div
              data-card-href={`/app/evaluation?tab=plans&plan=${p.id}`}
              style={`${CARD}padding:16px 20px;display:grid;grid-template-columns:minmax(230px,1.3fr) minmax(140px,0.8fr) minmax(200px,1.1fr) 110px 80px;gap:20px;align-items:center;cursor:pointer;color:#16171d;`}
            >
              <div style="min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;">
                  <a
                    href={`/app/evaluation?tab=plans&plan=${p.id}`}
                    style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#16171d;text-decoration:none;"
                  >
                    {p.name}
                  </a>
                  {p.anonymized ? (
                    <span
                      style={`display:inline-block;padding:2px 7px;font-size:9.5px;font-weight:600;font-family:${MONO};letter-spacing:0.06em;background:#f6e8f9;color:#9c36b5;`}
                    >
                      ANONYMIZED
                    </span>
                  ) : null}
                </div>
                <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:7px;">
                  {p.criteria.map((cr) => (
                    <span style="display:inline-block;padding:3px 8px;font-size:11px;font-weight:500;background:#eef0fb;color:#3a4ab8;">
                      {cr.name}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div style="display:flex;gap:4px;">
                  {avatars.map((r) => (
                    <div
                      title={r.name}
                      style={`width:26px;height:26px;display:grid;place-items:center;font-family:${MONO};font-size:10px;font-weight:600;background:${
                        r.role === 'chair' ? '#4c5fd5' : '#eef0fb'
                      };color:${r.role === 'chair' ? '#fff' : '#4c5fd5'};flex:none;`}
                    >
                      {initialsOfName(r.name)}
                    </div>
                  ))}
                  {p.reviewers.length > 5 ? (
                    <div
                      style={`width:26px;height:26px;display:grid;place-items:center;font-family:${MONO};font-size:10px;font-weight:600;background:#f2f3f5;color:#686b74;flex:none;`}
                    >
                      {`+${p.reviewers.length - 5}`}
                    </div>
                  ) : null}
                </div>
                <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:5px;`}>
                  {`${p.reviewers.length} reviewer${p.reviewers.length === 1 ? '' : 's'}${
                    chairs ? ` · ${chairs} chair${chairs > 1 ? 's' : ''}` : ''
                  }`}
                </div>
              </div>
              <div>
                <div style="display:flex;align-items:baseline;gap:8px;">
                  <div style={`font-family:${MONO};font-size:11px;color:#686b74;flex:none;`}>{`${pr.done}/${pr.total} reviews`}</div>
                  <div style="height:6px;background:#e7e8ec;flex:1;">
                    <div style={`height:6px;width:${pr.pct}%;background:${pr.pct === 100 ? '#2b8a3e' : '#4c5fd5'};`}></div>
                  </div>
                  <div style={`font-family:${MONO};font-size:11px;color:#686b74;flex:none;`}>{`${pr.pct}%`}</div>
                </div>
                <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:5px;`}>{`Due ${fmtDay(p.deadline)}`}</div>
              </div>
              <div>
                <div style={`font-family:${MONO};font-size:19px;font-weight:700;`}>{ac != null ? ac.toFixed(1) : '—'}</div>
                <div style={`font-family:${MONO};font-size:10px;color:#9a9da6;`}>{`/ ${cumMax} avg cumulative`}</div>
              </div>
              <a
                data-stop
                href={`/app/evaluation?tab=plans&plan=${p.id}&edit=1`}
                style="padding:6px 12px;background:#fff;border:1px solid #4c5fd5;color:#4c5fd5;font-size:12px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;"
              >
                Edit
              </a>
            </div>
          );
        })}
        {ctx.plans.length === 0 ? (
          <div style={`${CARD}padding:36px 20px;text-align:center;font-size:13px;color:#686b74;`}>
            No evaluation plans yet — create one to route submissions to reviewers.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function draftPayload(plan: EvalPlan | null) {
  return {
    id: plan?.id ?? null,
    name: plan?.name ?? '',
    instructions: plan?.instructions ?? '',
    deadline: plan?.deadline ?? '',
    anonymized: plan ? plan.anonymized : true,
    reminders: plan ? plan.reminders : true,
    reviewsPer: plan?.reviewsPer ?? 3,
    criteria: plan ? plan.criteria.map((c) => ({ ...c })) : DEFAULT_CRITERIA.map((c) => ({ ...c })),
    reviewers: plan ? plan.reviewers.map((r) => ({ userId: r.userId, role: r.role, name: r.name, email: r.email })) : [],
    rules: plan ? { ...plan.rules } : { ...DEFAULT_RULES },
  };
}

function PlanEditor(opts: { plan: EvalPlan | null; ctx: PageCtx }) {
  const { plan } = opts;
  const backHref = plan ? `/app/evaluation?tab=plans&plan=${plan.id}` : '/app/evaluation?tab=plans';
  return (
    <div>
      <div style="display:flex;align-items:center;gap:16px;margin:0 0 16px;">
        <h1 style="margin:0;font-size:19px;letter-spacing:-0.02em;">{plan ? 'Edit plan' : 'New evaluation plan'}</h1>
        <a
          href={backHref}
          style="margin-left:auto;padding:8px 16px;background:#f4f4f7;border:1px solid #c9cbd4;color:#2b2d33;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;"
        >
          ← Go back
        </a>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;align-items:start;">
        <div style={CARD} id="plan-form">
          <div style="padding:20px 24px;border-bottom:1px solid #eceded;display:grid;gap:14px;">
            <div style={MICRO_WIDE}>01 · PLAN</div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;">
              <div style="flex:1;min-width:260px;">
                <div style={`${MICRO}margin-bottom:6px;`}>NAME</div>
                <input
                  id="p-name"
                  value={plan?.name ?? ''}
                  placeholder="e.g. Main CFP Review"
                  style="width:100%;padding:9px 12px;border:1px solid #e2e3e8;font-size:14px;font-weight:600;outline-color:#4c5fd5;"
                />
              </div>
              <div>
                <div style={`${MICRO}margin-bottom:6px;`}>DEADLINE</div>
                <input
                  id="p-deadline"
                  type="date"
                  value={plan?.deadline ?? ''}
                  style="width:160px;padding:9px 12px;border:1px solid #e2e3e8;font-size:13px;outline-color:#4c5fd5;"
                />
              </div>
            </div>
            <div style="display:grid;gap:12px;">
              <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;">
                <span style="position:relative;display:inline-block;width:34px;height:20px;flex:none;margin-top:1px;">
                  <input id="p-anon" type="checkbox" checked={plan ? plan.anonymized : true} data-toggle-switch style="position:absolute;inset:0;margin:0;opacity:0;cursor:pointer;" />
                  <span data-track style="position:absolute;inset:0;border-radius:10px;transition:background .15s;"></span>
                  <span data-knob style="position:absolute;top:2px;width:16px;height:16px;background:#fff;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s;"></span>
                </span>
                <span style="font-size:12.5px;color:#686b74;line-height:1.45;">
                  <strong style="color:#16171d;font-size:13px;">Anonymized review.</strong> Speaker names, emails, and bios
                  are hidden from reviewers; other reviewers' scores stay hidden until they submit their own.
                </span>
              </label>
              <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;">
                <span style="position:relative;display:inline-block;width:34px;height:20px;flex:none;margin-top:1px;">
                  <input id="p-reminders" type="checkbox" checked={plan ? plan.reminders : true} data-toggle-switch style="position:absolute;inset:0;margin:0;opacity:0;cursor:pointer;" />
                  <span data-track style="position:absolute;inset:0;border-radius:10px;transition:background .15s;"></span>
                  <span data-knob style="position:absolute;top:2px;width:16px;height:16px;background:#fff;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s;"></span>
                </span>
                <span style="font-size:12.5px;color:#686b74;line-height:1.45;">
                  <strong style="color:#16171d;font-size:13px;">Automatic reminders.</strong> Reviewers with work left will
                  be reminded automatically on the schedule you set.
                </span>
              </label>
            </div>
          </div>
          <div style="padding:20px 24px;border-bottom:1px solid #eceded;display:grid;gap:14px;">
            <div style={MICRO_WIDE}>02 · REVIEWER INSTRUCTIONS</div>
            <div>
              <textarea
                id="p-instructions"
                rows={3}
                placeholder="Scoring expectations, conflict-of-interest rules, what a 5 means…"
                style="width:100%;padding:10px 12px;border:1px solid #e2e3e8;font-size:13px;line-height:1.55;resize:vertical;outline-color:#4c5fd5;font-family:inherit;"
              >
                {plan?.instructions ?? ''}
              </textarea>
            </div>
            <div>
              <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;">
                <div style={MICRO}>CRITERIA</div>
                <div style="font-size:11.5px;color:#9a9da6;">
                  Reviewers score each one on its own scale; the sum is their cumulative score.
                </div>
              </div>
              <div id="crit-rows" style="display:grid;gap:8px;"></div>
              <div style="display:flex;gap:16px;align-items:center;margin-top:10px;flex-wrap:wrap;">
                <button type="button" id="add-crit" style="padding:7px 14px;background:#fafafc;border:1px dashed #c9cbd2;color:#686b74;font-size:12.5px;cursor:pointer;">
                  + Add criterion
                </button>
                <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
                  cumulative max <span id="cum-max">0</span>
                </div>
              </div>
            </div>
          </div>
          <div style="padding:20px 24px;border-bottom:1px solid #eceded;display:grid;gap:12px;">
            <div style={MICRO_WIDE}>03 · REVIEWERS</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
              <select id="add-reviewer" style="width:260px;padding:8px 10px;border:1px dashed #c9cbd2;background:#fafafc;font-size:12.5px;color:#686b74;">
                <option value="">+ Add reviewer…</option>
              </select>
            </div>
            <div id="rev-rows" style="display:grid;gap:6px;"></div>
            <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
              <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:#33343c;">
                Reviews per submission
                <select id="p-reviewsper" style="padding:6px 8px;border:1px solid #e2e3e8;background:#fff;font-size:12.5px;">
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                </select>
              </label>
            </div>
          </div>
          <div style="padding:20px 24px;display:grid;gap:10px;">
            <div style="display:flex;align-items:baseline;gap:10px;">
              <div style={MICRO_WIDE}>04 · SUBMISSIONS</div>
              <div style="font-size:11.5px;color:#9a9da6;">Filters work as rules — everything matching all of them is in the plan.</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;" id="rule-row"></div>
            <div style="background:#eef0fb;border:1px solid #d5daf3;padding:10px 14px;">
              <div id="match-label" style="font-size:13px;font-weight:700;color:#3a4ab8;">…</div>
              <div style="font-size:11.5px;color:#686b74;margin-top:2px;">New submissions that match these rules join the plan automatically.</div>
            </div>
            <div style="border:1px solid #eceded;max-height:320px;overflow-y:auto;">
              <div
                style={`display:grid;grid-template-columns:60px minmax(0,1fr) 130px 90px;gap:8px;padding:8px 12px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;position:sticky;top:0;background:#fff;`}
              >
                <div>ID</div>
                <div>TITLE</div>
                <div>TRACK</div>
                <div>STATUS</div>
              </div>
              <div id="pick-rows"></div>
            </div>
          </div>
          <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:10px;align-items:center;">
            <div id="edit-summary" style="font-size:12px;color:#686b74;"></div>
            <div style="margin-left:auto;display:flex;gap:8px;">
              <a href={backHref} style={`${GHOST_BTN}text-decoration:none;color:#16171d;`}>
                Cancel
              </a>
              <button type="button" id="save-plan" style="padding:9px 18px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">
                {plan ? 'Save plan' : 'Create plan'}
              </button>
            </div>
          </div>
        </div>
        <div style="position:sticky;top:16px;display:grid;gap:14px;">
          <div style={CARD}>
            <div style={`padding:10px 16px;border-bottom:1px solid #e2e3e8;${MICRO_WIDE}`}>WHAT REVIEWERS SEE</div>
            <div style="padding:14px 16px;display:grid;gap:12px;">
              <div id="pv-anon" style={`font-family:${MONO};font-size:10px;color:#9c36b5;`}></div>
              <div id="pv-instructions" style="font-size:12px;line-height:1.55;color:#33343c;background:#f8f8fa;border:1px solid #eceded;padding:9px 11px;"></div>
              <div id="pv-crits" style="display:grid;gap:10px;"></div>
              <div style="border-top:1px solid #eceded;padding-top:10px;display:flex;align-items:baseline;gap:8px;">
                <div style="font-size:12.5px;font-weight:600;">Cumulative score</div>
                <div style={`margin-left:auto;font-family:${MONO};font-size:15px;font-weight:700;`}>
                  <span id="demo-cum">—</span>
                  <span style="font-size:11px;color:#9a9da6;font-weight:400;">
                    {' / '}
                    <span id="demo-max">0</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div style={CARD}>
            <div style={`padding:10px 16px;border-bottom:1px solid #e2e3e8;${MICRO_WIDE}`}>SCOPE</div>
            <div id="scope-lines" style="padding:12px 16px;display:grid;gap:7px;"></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanDetail(opts: { plan: EvalPlan; ctx: PageCtx; reminders: RemindersData }) {
  const { plan, ctx, reminders } = opts;
  const pr = planProgress(plan, ctx.submissions, ctx.evaluations);
  const rp = effRp(plan);
  const cumMax = cumMaxOf(plan.criteria);
  const ac = avgCumulative(plan, ctx.submissions, ctx.evaluations);
  const subs = planSubmissions(plan, ctx.submissions, ctx.evaluations);

  const rows = subs
    .map((s) => {
      const evals = ctx.evaluations.filter((e) => e.planId === plan.id && e.submissionId === s.id && !e.abstained);
      const cum = evals.length ? evals.reduce((a, e) => a + cumulativeOf(plan, e), 0) / evals.length : null;
      const critAvgs = plan.criteria.map((crit) => {
        const vals = evals.map((e) => Number(e.scores[crit.name])).filter((v) => Number.isFinite(v) && v > 0);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      });
      const assigned = assignedFor(plan, s);
      return { s, evals, cum, critAvgs, assigned };
    })
    .sort((a, b) => (b.cum ?? -1) - (a.cum ?? -1));

  return (
    <div>
      <a href="/app/evaluation?tab=plans" style="display:inline-block;color:#686b74;font-size:12.5px;margin-bottom:12px;text-decoration:none;">
        ← Evaluation plans
      </a>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
        <h1 style="margin:0;font-size:19px;letter-spacing:-0.02em;">{plan.name}</h1>
        {plan.anonymized ? (
          <span
            style={`display:inline-block;padding:2px 7px;font-size:9.5px;font-weight:600;font-family:${MONO};letter-spacing:0.06em;background:#f6e8f9;color:#9c36b5;`}
          >
            ANONYMIZED
          </span>
        ) : null}
        <a
          href={`/app/evaluation?tab=plans&plan=${plan.id}&edit=1`}
          style="margin-left:auto;padding:7px 14px;background:#fff;border:1px solid #4c5fd5;color:#4c5fd5;font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none;"
        >
          Edit plan
        </a>
      </div>
      <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;margin-bottom:16px;`}>
        {`DUE ${fmtDay(plan.deadline).toUpperCase()} · ${plan.reviewers.length} REVIEWERS · ${rp} REVIEW${
          rp === 1 ? '' : 'S'
        } PER SUBMISSION · CUMULATIVE MAX ${cumMax}`}
      </div>
      <StatCards
        stats={[
          { label: 'SUBMISSIONS', val: String(subs.length), sub: '' },
          { label: 'EVALUATIONS IN', val: `${pr.done}/${pr.total}`, sub: `${pr.pct}% complete` },
          { label: 'AVG CUMULATIVE', val: ac != null ? ac.toFixed(1) : '—', sub: `of ${cumMax} max` },
          { label: 'OUTSTANDING', val: String(Math.max(0, pr.total - pr.done)), sub: 'reviews left' },
        ]}
      />
      <div style="display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:16px;align-items:start;">
        <div style={CARD}>
          <div
            style={`display:grid;grid-template-columns:56px minmax(0,1fr) 250px 160px 100px;gap:12px;padding:9px 16px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`}
          >
            <div>ID</div>
            <div>TITLE</div>
            <div>CRITERION AVERAGES</div>
            <div>REVIEWERS</div>
            <div style="text-align:right;">{`CUM. / ${cumMax}`}</div>
          </div>
          {rows.map((r) => (
            <a
              data-row-hover
              href={`/app/evaluation?open=${r.s.id}`}
              style="display:grid;grid-template-columns:56px minmax(0,1fr) 250px 160px 100px;gap:12px;padding:10px 16px;border-bottom:1px solid #f2f3f5;align-items:center;text-decoration:none;color:#16171d;"
            >
              <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{r.s.displayId}</div>
              <div style="min-width:0;">
                <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{r.s.title}</div>
                <div style="font-size:11px;color:#9a9da6;">{`${r.s.format.replace(/ \(.+\)/, '') || '—'} · ${r.s.trackName}`}</div>
              </div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;">
                {r.cum == null ? (
                  <span style={chip('#f2f3f5', '#c0c2ca')}>no scores yet</span>
                ) : (
                  plan.criteria.map((crit, k) => (
                    <span style={chip('#eef0fb', '#33343c')}>{`${crit.name} ${num1(r.critAvgs[k])}`}</span>
                  ))
                )}
              </div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;">
                {r.evals.map((e) => {
                  const nm = nameOf(ctx, e.reviewerId);
                  const cum = cumulativeOf(plan, e);
                  return (
                    <span title={`${nm}: cumulative ${cum} of ${cumMax}`} style={chip('#eef0fb', '#33343c')}>
                      {`${initialsOfName(nm)} ${cum}`}
                    </span>
                  );
                })}
                {r.assigned
                  .filter((a) => !r.evals.some((e) => e.reviewerId === a.userId))
                  .map((a) => (
                    <span title={`${a.name} — not submitted yet`} style={chip('#f2f3f5', '#c0c2ca')}>
                      {`${initialsOfName(a.name)} —`}
                    </span>
                  ))}
              </div>
              <div style={`text-align:right;font-family:${MONO};font-size:14px;font-weight:700;`}>
                {r.cum != null ? r.cum.toFixed(1) : '—'}
              </div>
            </a>
          ))}
          {rows.length === 0 ? (
            <div style="padding:36px 16px;text-align:center;font-size:13px;color:#686b74;">
              Nothing matches this plan's rules yet.
            </div>
          ) : null}
        </div>
        <ReviewerRail
          title="Reviewer progress"
          rows={reviewerRows(ctx, [plan])}
          remindLabel="Remind reviewers with work left"
          autoLine={
            plan.reminders
              ? reminders.autoLine
              : 'Auto-reminders off — enable them in plan settings'
          }
          autoOn={plan.reminders && reminders.automation.on}
        />
      </div>
    </div>
  );
}

/* --------------------------------------------------------- reminders data */

type RemRow = {
  userId: string;
  name: string;
  email: string;
  coms: string;
  planId: string;
  total: number;
  done: number;
  remaining: number;
  deadline: string | null;
  deadlineLabel: string;
  days: number | null;
  last: string;
};

type RemindersData = {
  scope: 'plan' | 'event';
  planId: string | null;
  planName: string | null;
  rows: RemRow[];
  automation: Automation;
  subject: string;
  body: string;
  mergeTags: string;
  upcoming: { date: string; when: string }[];
  autoLine: string;
  plans: { id: string; name: string; deadline: string | null; users: { userId: string; name: string; remaining: number }[] }[];
  me: string;
};

function upcomingSends(
  plans: RemindersData['plans'],
  a: Automation,
  from = new Date()
): { date: string; when: string }[] {
  const points: { minus: number; label: string }[] = [];
  if (a.d14) points.push({ minus: 14, label: '14 days before' });
  if (a.d7) points.push({ minus: 7, label: '7 days before' });
  if (a.d3) points.push({ minus: 3, label: '3 days before' });
  if (a.over) points.push({ minus: -1, label: '1 day overdue · chair CC’d' });
  const out: { t: number; date: string; when: string }[] = [];
  plans.forEach((p) => {
    if (!p.deadline) return;
    const rec = p.users.filter((u) => u.remaining >= a.minLeft);
    if (!rec.length) return;
    points.forEach((pt) => {
      const dt = new Date(`${p.deadline!.slice(0, 10)}T09:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() - pt.minus);
      if (dt.getTime() < from.getTime()) return;
      out.push({
        t: dt.getTime(),
        date: fmtDay(dt.toISOString()),
        when: `${pt.label} · ${p.name}`,
      });
    });
  });
  out.sort((x, y) => x.t - y.t);
  return out.map(({ date, when }) => ({ date, when }));
}

async function buildReminders(
  c: { env: Ctx['Bindings']; var: { user: Ctx['Variables']['user']; event: Ctx['Variables']['event'] } },
  ctx: PageCtx,
  scopePlans: EvalPlan[],
  planId: string | null
): Promise<RemindersData> {
  const event = c.var.event!;
  const tpl = await one<{ subject: string; body: string }>(
    c.env.DB,
    `SELECT subject, body FROM email_templates WHERE event_id = ? AND key = 'reminder'`,
    event.id
  );
  const reminders = await all<{ to_email: string; last: string }>(
    c.env.DB,
    planId
      ? `SELECT to_email, MAX(created_at) AS last FROM emails
          WHERE event_id = ? AND template_key = 'reminder' AND subject_id = ? GROUP BY to_email`
      : `SELECT to_email, MAX(created_at) AS last FROM emails
          WHERE event_id = ? AND template_key = 'reminder' GROUP BY to_email`,
    ...(planId ? [event.id, planId] : [event.id])
  );
  const lastByEmail = new Map(reminders.map((n) => [n.to_email.toLowerCase(), n.last]));

  const perUser = new Map<
    string,
    { name: string; email: string; plans: string[]; planId: string; total: number; done: number; remaining: number; deadline: string | null }
  >();
  const planPayload: RemindersData['plans'] = [];

  scopePlans.forEach((p) => {
    const users: { userId: string; name: string; remaining: number }[] = [];
    members(p).forEach((r) => {
      const l = reviewerLoad(p, r.userId, ctx.submissions, ctx.evaluations);
      users.push({ userId: r.userId, name: r.name, remaining: l.remaining });
      const cur = perUser.get(r.userId);
      if (!cur) {
        perUser.set(r.userId, {
          name: r.name,
          email: r.email,
          plans: [p.name],
          planId: p.id,
          total: l.load,
          done: l.done,
          remaining: l.remaining,
          deadline: p.deadline,
        });
      } else {
        cur.plans.push(p.name);
        cur.total += l.load;
        cur.done += l.done;
        cur.remaining += l.remaining;
        if (l.remaining > 0 && (!cur.deadline || (p.deadline && p.deadline < cur.deadline))) {
          cur.deadline = p.deadline;
          cur.planId = p.id;
        }
      }
    });
    planPayload.push({ id: p.id, name: p.name, deadline: p.deadline, users });
  });

  const rows: RemRow[] = [...perUser.entries()]
    .map(([userId, v]) => {
      const last = lastByEmail.get(v.email.toLowerCase());
      return {
        userId,
        name: v.name,
        email: v.email,
        coms: v.plans.join(' + '),
        planId: v.planId,
        total: v.total,
        done: v.done,
        remaining: v.remaining,
        deadline: v.deadline,
        deadlineLabel: fmtDay(v.deadline),
        days: daysUntil(v.deadline),
        last: last ? fmtDay(last.slice(0, 10)) : 'Never',
      };
    })
    .sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));

  const automation = scopePlans.length ? scopePlans[0].automation : { ...DEFAULT_AUTOMATION };
  const upcoming = upcomingSends(planPayload, automation);

  return {
    scope: planId ? 'plan' : 'event',
    planId,
    planName: planId ? scopePlans[0]?.name ?? null : null,
    rows,
    automation,
    subject: tpl?.subject ?? 'Reminder: {{remaining}} evaluations due {{deadline}}',
    body: tpl?.body ?? '',
    mergeTags: '{first_name} {remaining} {deadline}',
    upcoming,
    autoLine: automation.on
      ? `Auto-reminders on · next ${upcoming.length ? upcoming[0].date : '—'}`
      : 'Auto-reminders off',
    plans: planPayload,
    me: c.var.user?.email ?? '',
  };
}

/* -------------------------------------------------------- reminders modal */

const REM_TAB = (on: boolean) =>
  `padding:6px 13px;border:none;font-size:12px;cursor:pointer;font-weight:600;background:${on ? '#eef0fb' : '#fff'};color:${
    on ? '#4c5fd5' : '#686b74'
  };`;

function RemindersModal(opts: { reminders: RemindersData }) {
  const r = opts.reminders;
  const eligible = r.rows.filter((x) => x.remaining > 0);
  return (
    <div id="rem-modal" data-dialog hidden>
      <div style="width:1160px;max-width:100%;max-height:calc(100vh - 88px);background:#fff;border:1px solid #e2e3e8;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(22,23,29,0.25);">
        <div style="display:flex;align-items:center;gap:16px;padding:13px 20px;border-bottom:1px solid #e2e3e8;flex:none;">
          <div id="rem-title" style="font-size:15px;font-weight:700;letter-spacing:-0.01em;">
            {r.scope === 'plan' ? `Remind reviewers · ${r.planName}` : 'Remind evaluators'}
          </div>
          <div id="ed-tabs" hidden style="margin-left:auto;display:flex;border:1px solid #e2e3e8;">
            <button type="button" data-ed-view="edit" style={REM_TAB(true)}>
              Edit
            </button>
            <button type="button" data-ed-view="prev" style={REM_TAB(false)}>
              Preview
            </button>
          </div>
          <button
            type="button"
            id="rem-hdr-btn"
            style="margin-left:auto;display:flex;align-items:center;gap:6px;background:#eef0fb;border:1px solid #c3cbee;padding:6px 11px;color:#3548b8;font-size:12px;font-weight:600;cursor:pointer;"
          >
            <span style="font-size:13px;line-height:1;">⚙</span>
            <span id="rem-hdr-label">Automation settings</span>
          </button>
          <button type="button" id="rem-x" style="background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:2px 6px;line-height:1;">
            ×
          </button>
        </div>

        {/* ---------------------------------------------------------- send */}
        <div data-rem-pane="send" style="display:flex;flex-direction:column;min-height:0;flex:1;">
          <div style="display:grid;grid-template-columns:minmax(0,1fr) 420px;overflow:auto;flex:1;min-height:0;">
            <div style="border-right:1px solid #eceded;">
              <div style="display:flex;gap:6px;align-items:center;padding:12px 20px;border-bottom:1px solid #eceded;flex-wrap:wrap;">
                <button type="button" id="sel-left" style="padding:5px 10px;border:1px solid #e2e3e8;background:#fff;font-size:11.5px;font-weight:600;color:#33343c;cursor:pointer;">
                  {`Anyone with work left (${eligible.length})`}
                </button>
                <button type="button" id="sel-none" style="padding:5px 10px;border:1px solid #e2e3e8;background:#fff;font-size:11.5px;font-weight:600;color:#33343c;cursor:pointer;">
                  Clear
                </button>
                <div style={`margin-left:auto;font-family:${MONO};font-size:11px;color:#686b74;`}>
                  <span id="rem-count">{String(eligible.length)}</span> selected
                </div>
              </div>
              <div
                style={`display:grid;grid-template-columns:26px minmax(0,1fr) 130px 100px 92px;gap:12px;padding:8px 20px;border-bottom:1px solid #eceded;font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`}
              >
                <div></div>
                <div>EVALUATOR</div>
                <div>REMAINING</div>
                <div>DUE</div>
                <div>LAST REMINDER</div>
              </div>
              {r.rows.map((row) => {
                const dis = row.remaining === 0;
                return (
                  <div
                    data-rem-row={row.userId}
                    data-remaining={String(row.remaining)}
                    data-name={row.name}
                    data-selected={dis ? '0' : '1'}
                    style={`display:grid;grid-template-columns:26px minmax(0,1fr) 130px 100px 92px;gap:12px;padding:10px 20px;border-bottom:1px solid #f2f3f5;align-items:center;cursor:${
                      dis ? 'default' : 'pointer'
                    };${dis ? 'opacity:0.55;' : ''}`}
                  >
                    <div
                      data-box
                      style={`width:16px;height:16px;border:1px solid ${dis ? '#c9cbd3' : '#4c5fd5'};background:${
                        dis ? '#fff' : '#4c5fd5'
                      };color:#fff;display:grid;place-items:center;font-size:11px;line-height:1;flex:none;${dis ? 'opacity:0.35;' : ''}`}
                    >
                      {dis ? '' : '✓'}
                    </div>
                    <div style="min-width:0;">
                      <div style="display:flex;align-items:center;gap:8px;">
                        <span style="font-size:13px;font-weight:600;">{row.name}</span>
                        {dis ? (
                          <span
                            style={`display:inline-block;padding:1px 7px;font-family:${MONO};font-size:10px;font-weight:600;background:#e6f4ea;color:#2b8a3e;`}
                          >
                            Done
                          </span>
                        ) : null}
                      </div>
                      <div style={`font-size:11px;color:#9a9da6;font-family:${MONO};margin-top:2px;`}>
                        {`${row.email} · ${row.coms}`}
                      </div>
                    </div>
                    <div>
                      <div style={`font-family:${MONO};font-size:12px;font-weight:600;`}>
                        {dis ? 'All done' : `${row.remaining} of ${row.total} left`}
                      </div>
                      <div style="height:4px;background:#eef0f3;margin-top:4px;max-width:90px;">
                        <div
                          style={`height:4px;width:${row.total ? Math.round((row.done / row.total) * 100) : 0}%;background:${
                            dis ? '#2b8a3e' : '#4c5fd5'
                          };`}
                        ></div>
                      </div>
                    </div>
                    <div>
                      <div style="font-size:12.5px;font-weight:600;">{row.deadlineLabel}</div>
                      <div
                        style={`font-size:10.5px;font-family:${MONO};color:${
                          row.days !== null && row.days <= 14 ? '#b08800' : '#9a9da6'
                        };margin-top:1px;`}
                      >
                        {dis ? '—' : row.days === null ? 'no deadline' : row.days < 0 ? `${-row.days} days overdue` : `in ${row.days} days`}
                      </div>
                    </div>
                    <div style="font-size:12px;color:#686b74;">{row.last}</div>
                  </div>
                );
              })}
              {r.rows.length === 0 ? (
                <div style="padding:28px 20px;font-size:13px;color:#686b74;">No reviewers with a queue yet.</div>
              ) : null}
            </div>
            <div style="padding:16px 20px;display:grid;gap:10px;align-content:start;">
              <div style="display:flex;align-items:baseline;gap:8px;">
                <div style={MICRO_WIDE}>REMINDER EMAIL</div>
                <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
                  <button type="button" data-rem-goto="editor" style="padding:5px 10px;background:#fff;border:1px solid #e2e3e8;color:#33343c;font-size:11.5px;cursor:pointer;">
                    Edit email
                  </button>
                  <button type="button" data-send-test style="padding:5px 10px;background:#fdf6e0;border:1px solid #e8d79a;color:#7a5c0a;font-size:11.5px;cursor:pointer;">
                    Send test to me
                  </button>
                </div>
              </div>
              <div>
                <input
                  id="rem-subject"
                  value={r.subject}
                  title="Subject line"
                  style="width:100%;padding:8px 10px;border:1px solid #e2e3e8;border-bottom:none;font-size:12.5px;font-weight:600;background:#fff;outline-color:#4c5fd5;"
                />
                <textarea
                  id="rem-body"
                  rows={9}
                  style="width:100%;padding:9px 10px;border:1px solid #e2e3e8;font-size:12.5px;line-height:1.55;resize:vertical;outline-color:#4c5fd5;font-family:inherit;display:block;"
                >
                  {r.body}
                </textarea>
              </div>
              <div style="font-size:11px;color:#9a9da6;line-height:1.5;">
                {'Merge tags '}
                <span style={`font-family:${MONO};color:#4c5fd5;`}>{r.mergeTags}</span>
                {' fill in per recipient.'}
              </div>
              <div id="rem-preview" style="border:1px solid #eceded;background:#f8f9fc;padding:10px 12px;">
                <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;margin-bottom:6px;`}>
                  {'PREVIEW — '}
                  <span id="pv-name"></span>
                </div>
                <div id="pv-subject" style="font-size:12px;font-weight:600;"></div>
                <div id="pv-body" style="font-size:11.5px;color:#33343c;line-height:1.55;margin-top:5px;white-space:pre-line;"></div>
              </div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;padding:12px 20px;border-top:1px solid #e2e3e8;flex:none;">
            <div style="margin-left:auto;"></div>
            <button
              type="button"
              id="send-rem"
              style="margin-left:auto;padding:10px 18px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;flex:none;"
            >
              {`Send now to ${eligible.length} evaluator${eligible.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>

        {/* ---------------------------------------------------------- auto */}
        <div data-rem-pane="auto" hidden style="display:flex;flex-direction:column;min-height:0;flex:1;">
          <div style="display:grid;grid-template-columns:minmax(0,1fr) 320px;overflow:auto;flex:1;min-height:0;">
            <div style="padding:18px 20px;border-right:1px solid #eceded;display:grid;gap:18px;align-content:start;">
              <div style="display:flex;align-items:center;gap:12px;">
                <button
                  type="button"
                  id="auto-toggle"
                  style={`position:relative;width:38px;height:21px;border:none;background:${
                    r.automation.on ? '#4c5fd5' : '#c9cbd3'
                  };cursor:pointer;padding:0;flex:none;`}
                >
                  <span
                    id="auto-knob"
                    style={`position:absolute;top:2px;left:${
                      r.automation.on ? '19px' : '2px'
                    };width:17px;height:17px;background:#fff;transition:left 0.15s;display:block;`}
                  ></span>
                </button>
                <div>
                  <div id="auto-title" style="font-size:13.5px;font-weight:700;">
                    {r.automation.on ? 'Automatic reminders are on' : 'Automatic reminders are off'}
                  </div>
                  <div style="font-size:11.5px;color:#686b74;">Runs daily at 09:00, using the message from the Send tab.</div>
                </div>
              </div>
              <div id="auto-body" style={`display:grid;gap:18px;${r.automation.on ? '' : 'opacity:0.45;pointer-events:none;'}`}>
                <div>
                  <div style={`${MICRO}margin-bottom:8px;`}>WHO QUALIFIES</div>
                  <div style="display:flex;align-items:center;gap:8px;font-size:13px;flex-wrap:wrap;">
                    <span>Evaluators with at least</span>
                    <select id="auto-minleft" style="padding:5px 8px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;cursor:pointer;outline-color:#4c5fd5;">
                      {[1, 3, 5].map((n) => (
                        <option value={String(n)} selected={r.automation.minLeft === n}>
                          {String(n)}
                        </option>
                      ))}
                    </select>
                    <span>evaluations remaining on a plan</span>
                  </div>
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:4px;`}>WHEN</div>
                  {[
                    { k: 'd14', label: '14 days before plan deadline', sub: 'Early heads-up' },
                    { k: 'd7', label: '7 days before deadline', sub: 'Main reminder' },
                    { k: 'd3', label: '3 days before deadline', sub: 'Final call' },
                    { k: 'over', label: '1 day after deadline', sub: 'Overdue — plan chair CC’d' },
                  ].map((s) => {
                    const on = !!(r.automation as unknown as Record<string, boolean>)[s.k];
                    return (
                      <div data-sched={s.k} data-on={on ? '1' : '0'} style="display:flex;gap:10px;align-items:center;padding:7px 0;cursor:pointer;">
                        <div
                          data-box
                          style={`width:16px;height:16px;border:1px solid ${on ? '#4c5fd5' : '#c9cbd3'};background:${
                            on ? '#4c5fd5' : '#fff'
                          };color:#fff;display:grid;place-items:center;font-size:11px;line-height:1;flex:none;`}
                        >
                          {on ? '✓' : ''}
                        </div>
                        <div>
                          <div style="font-size:13px;font-weight:600;">{s.label}</div>
                          <div style="font-size:11.5px;color:#9a9da6;">{s.sub}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;font-size:13px;flex-wrap:wrap;">
                    <span>Never remind the same person twice within</span>
                    <select id="auto-cooldown" style="padding:5px 8px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;cursor:pointer;outline-color:#4c5fd5;">
                      {[1, 2, 3, 5, 7].map((n) => (
                        <option value={String(n)} selected={r.automation.cooldown === n}>
                          {String(n)}
                        </option>
                      ))}
                    </select>
                    <span>days</span>
                  </div>
                </div>
              </div>
            </div>
            <div style="padding:18px 20px;">
              <div style={`${MICRO}margin-bottom:6px;`}>NEXT SCHEDULED SENDS</div>
              <div id="upcoming"></div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;padding:12px 20px;border-top:1px solid #e2e3e8;flex:none;">
            <button type="button" id="save-auto" style="padding:10px 18px;background:#16171d;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">
              Save automation
            </button>
            <div style="font-size:11.5px;color:#9a9da6;">
              {r.scope === 'plan'
                ? 'Saved on this plan. The scheduler runs in a later phase — the schedule below is what it will use.'
                : 'Saved on every plan of this event. The scheduler runs in a later phase.'}
            </div>
          </div>
        </div>

        {/* -------------------------------------------------------- editor */}
        <div data-rem-pane="editor" hidden style="display:flex;flex-direction:column;min-height:0;flex:1;">
          <div style="flex:1;min-height:0;overflow:auto;padding:18px 20px;">
            <div data-ed-pane="edit" style="display:grid;gap:14px;max-width:720px;margin:0 auto;">
              <div>
                <div style={`${MICRO_WIDE}margin-bottom:6px;`}>SUBJECT</div>
                <input id="ed-subject" value={r.subject} style="width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:12.5px;font-weight:600;background:#fff;outline-color:#4c5fd5;" />
              </div>
              <div>
                <div style={`${MICRO_WIDE}margin-bottom:6px;`}>BODY</div>
                <textarea
                  id="ed-body"
                  rows={12}
                  style="width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;resize:vertical;line-height:1.5;display:block;outline-color:#4c5fd5;font-family:inherit;"
                >
                  {r.body}
                </textarea>
                <div style="font-size:11px;color:#9a9da6;margin-top:5px;line-height:1.45;">
                  {'Merge tags '}
                  <span style={`font-family:${MONO};color:#4c5fd5;`}>{r.mergeTags}</span>
                  {' fill in per recipient.'}
                </div>
              </div>
            </div>
            <div data-ed-pane="prev" hidden style="max-width:720px;margin:0 auto;">
              <div style="border:1px solid #e2e3e8;">
                <div style="padding:10px 14px;border-bottom:1px solid #eceded;display:grid;gap:4px;font-size:12px;color:#686b74;">
                  <div style="display:flex;gap:8px;">
                    <span style={`font-family:${MONO};font-size:9.5px;color:#9a9da6;width:44px;flex:none;padding-top:2px;`}>TO</span>
                    <span id="ed-prev-to"></span>
                  </div>
                  <div style="display:flex;gap:8px;">
                    <span style={`font-family:${MONO};font-size:9.5px;color:#9a9da6;width:44px;flex:none;padding-top:2px;`}>SUBJ</span>
                    <span id="ed-prev-subj" style="font-weight:600;color:#16171d;"></span>
                  </div>
                </div>
                <div id="ed-prev-body" style="padding:16px 14px;font-size:13px;line-height:1.6;white-space:pre-line;color:#16171d;"></div>
              </div>
              <div style={`font-family:${MONO};font-size:10px;color:#9a9da6;margin-top:8px;`}>
                VARIABLES FILLED WITH ONE REAL RECIPIENT
              </div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding:12px 20px;border-top:1px solid #e2e3e8;flex:none;">
            <button type="button" data-send-test style="padding:8px 14px;background:#fdf6e0;border:1px solid #e8d79a;color:#7a5c0a;font-size:12.5px;cursor:pointer;">
              Send test to me
            </button>
            <div style="margin-left:auto;display:flex;gap:8px;">
              <button type="button" data-rem-goto="send" style="padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;">
                Cancel
              </button>
              <button type="button" id="ed-save" style="padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- APIs */

type PlanBody = {
  id?: string | null;
  name?: string;
  deadline?: string;
  anonymized?: boolean;
  reminders?: boolean;
  instructions?: string;
  reviewsPer?: number;
  criteria?: Criterion[];
  reviewers?: { userId: string; role: string }[];
  rules?: Rules;
};

app.post('/app/api/evaluation/plan', requireOrgRole('admin'), async (c) => {
  const event = c.var.event!;
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  const body = await c.req.json<PlanBody>();

  const name = (body.name ?? '').trim();
  const criteria = (body.criteria ?? [])
    .map((cr) => ({ name: String(cr.name ?? '').trim(), hint: String(cr.hint ?? ''), scale: Number(cr.scale) || 5 }))
    .filter((cr) => !!cr.name);
  const reviewers = (body.reviewers ?? []).filter((r) => !!r.userId);
  const memberCount = reviewers.filter((r) => r.role !== 'chair').length;
  const rules: Rules = { ...DEFAULT_RULES, ...(body.rules ?? {}) };

  if (!name) return c.json({ ok: false, error: 'Name the plan first' }, 400);
  if (!criteria.length) return c.json({ ok: false, error: 'Add at least one criterion' }, 400);
  if (!memberCount) return c.json({ ok: false, error: 'Assign at least one member reviewer' }, 400);

  const subs = await loadEvalContext(c.env.DB, event.id);
  // Explicit per-submission assignments count toward coverage, so tightening
  // the rules on a plan that lives off assignments doesn't lock the editor out.
  const assigned = new Set(body.id ? subs.plans.find((p) => p.id === body.id)?.includeIds ?? [] : []);
  const matched = subs.submissions.filter((s) => matchesRules(s, rules) || assigned.has(s.id));
  if (!matched.length) return c.json({ ok: false, error: 'No submissions match — loosen the rules' }, 400);

  const reviewsPer = Math.max(1, Math.min(3, Number(body.reviewsPer) || 3));
  const deadline = (body.deadline ?? '').slice(0, 10) || null;
  const anonymized = body.anonymized !== false;
  const reminders = body.reminders !== false;

  const existing = body.id
    ? await one<{ id: string; automation_json: string | null }>(
        c.env.DB,
        `SELECT id, automation_json FROM eval_plans WHERE id = ? AND event_id = ?`,
        body.id,
        event.id
      )
    : null;

  const automation = { ...normalizeAutomation(existing ? JSON.parse(existing.automation_json || '{}') : {}), on: reminders };
  const planId = existing?.id ?? newId('epl');
  const before = existing
    ? (await all<{ user_id: string }>(c.env.DB, `SELECT user_id FROM eval_plan_reviewers WHERE plan_id = ?`, planId)).map(
        (r) => r.user_id
      )
    : [];

  if (existing) {
    await run(
      c.env.DB,
      `UPDATE eval_plans SET name = ?, instructions = ?, deadline = ?, anonymized = ?, reminders = ?, reviews_per = ?,
         rules_json = ?, criteria_json = ?, automation_json = ? WHERE id = ?`,
      name,
      body.instructions ?? '',
      deadline,
      anonymized ? 1 : 0,
      reminders ? 1 : 0,
      reviewsPer,
      JSON.stringify(rules),
      JSON.stringify(criteria),
      JSON.stringify(automation),
      planId
    );
    await run(c.env.DB, `DELETE FROM eval_plan_reviewers WHERE plan_id = ?`, planId);
  } else {
    await run(
      c.env.DB,
      `INSERT INTO eval_plans (id, event_id, name, instructions, deadline, anonymized, reminders, reviews_per,
         rules_json, criteria_json, automation_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      planId,
      event.id,
      name,
      body.instructions ?? '',
      deadline,
      anonymized ? 1 : 0,
      reminders ? 1 : 0,
      reviewsPer,
      JSON.stringify(rules),
      JSON.stringify(criteria),
      JSON.stringify(automation),
      now()
    );
  }

  for (const r of reviewers) {
    await run(
      c.env.DB,
      `INSERT INTO eval_plan_reviewers (plan_id, user_id, role) VALUES (?,?,?)`,
      planId,
      r.userId,
      r.role === 'chair' ? 'chair' : 'member'
    );
  }

  // Tell everyone newly added to the plan where their queue is. Reviewers who
  // don't have a password yet get a set-a-password link; the rest just get the URL.
  const added = reviewers.filter((r) => !before.includes(r.userId));
  const links: { email: string; link: string }[] = [];
  for (const r of added) {
    const u = await one<{ email: string; name: string | null; password_hash: string | null }>(
      c.env.DB,
      `SELECT email, name, password_hash FROM users WHERE id = ?`,
      r.userId
    );
    if (!u) continue;
    if (!u.password_hash) {
      const res = await requestPasswordReset(c.env, u.email, {
        eventId: event.id,
        next: `/${event.slug}/evaluate`,
        subject: `You're reviewing for ${event.name}`,
        text:
          `Hi ${u.name || 'there'},\n\n` +
          `You've been added as a reviewer on “${name}” for ${event.name}.\n\n` +
          `Set a password with this link and it opens your review queue:\n`,
      });
      if (res.simulatedLink) links.push({ email: u.email, link: res.simulatedLink });
    } else {
      await sendEmail(c.env, {
        eventId: event.id,
        to: u.email,
        toName: u.name,
        templateKey: 'reviewer_added',
        subject: `You're reviewing for ${event.name}`,
        text:
          `Hi ${u.name || 'there'},\n\n` +
          `You've been added as a reviewer on “${name}” for ${event.name}.\n\n` +
          `Sign in with your password to open your review queue:\n${c.env.APP_ORIGIN}/${event.slug}/evaluate`,
        subjectType: 'eval_plan',
        subjectId: planId,
      });
    }
  }

  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'plan',
    subjectId: planId,
    actor,
    action: existing ? 'Updated evaluation plan' : 'Created evaluation plan',
    detail: `“${name}” · ${criteria.length} criteria · ${reviewers.length} reviewers · ${matched.length} submissions${
      added.length ? ` · ${added.length} invited` : ''
    }`,
  });

  const toast = existing
    ? `Plan saved — ${matched.length} submissions match the rules`
    : `“${name}” created — ${reviewers.length} reviewers invited, ${matched.length} submissions matched${
        reminders ? ', reminders scheduled' : ''
      }`;

  return c.json({
    ok: true,
    planId,
    links,
    redirect: `/app/evaluation?tab=plans&plan=${planId}&ok=${encodeURIComponent(toast)}`,
  });
});

type RemindBody = { planId?: string | null; userIds?: string[]; subject?: string; body?: string };

app.post('/app/api/evaluation/remind', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event!;
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  const body = await c.req.json<RemindBody>();
  const ids = body.userIds ?? [];
  if (!ids.length) return c.json({ ok: false, error: 'Select at least one evaluator' }, 400);

  const ctx = await loadEvalContext(c.env.DB, event.id);
  const scopePlans = body.planId ? ctx.plans.filter((p) => p.id === body.planId) : ctx.plans;
  const subject = body.subject ?? '';
  const text = body.body ?? '';
  const sentNames: string[] = [];

  for (const userId of ids) {
    let remaining = 0;
    let deadline: string | null = null;
    let planId = scopePlans[0]?.id ?? null;
    let name = '';
    let email = '';
    scopePlans.forEach((p) => {
      const rev = p.reviewers.find((r) => r.userId === userId && r.role !== 'chair');
      if (!rev) return;
      name = rev.name;
      email = rev.email;
      const l = reviewerLoad(p, userId, ctx.submissions, ctx.evaluations);
      remaining += l.remaining;
      if (l.remaining > 0 && (!deadline || (p.deadline && p.deadline < deadline))) {
        deadline = p.deadline;
        planId = p.id;
      }
    });
    if (!email || remaining === 0) continue;
    const vars: Record<string, string> = {
      first_name: name.split(' ')[0] || name,
      speaker_name: name,
      remaining: String(remaining),
      deadline: fmtDay(deadline),
      event_name: event.name,
      evaluate_link: `${c.env.APP_ORIGIN}/${event.slug}/evaluate`,
      organizer_name: actor,
    };
    await sendEmail(c.env, {
      eventId: event.id,
      to: email,
      toName: name,
      templateKey: 'reminder',
      subject: mergeTags(subject, vars),
      text: mergeTags(text, vars),
      subjectType: 'eval_plan',
      subjectId: planId,
    });
    sentNames.push(name.split(' ')[0] || name);
  }

  if (!sentNames.length) return c.json({ ok: false, error: 'Nobody selected still has work left' }, 400);

  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'plan',
    subjectId: body.planId ?? event.id,
    actor,
    action: 'Reminded evaluators',
    detail: `${sentNames.length} reminder${sentNames.length === 1 ? '' : 's'} sent — ${sentNames.join(', ')}`,
  });

  return c.json({ ok: true, sent: sentNames.length, names: sentNames });
});

app.post('/app/api/evaluation/remind-test', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event!;
  const user = c.var.user!;
  const body = await c.req.json<{ subject?: string; body?: string; planId?: string | null }>();
  const vars: Record<string, string> = {
    first_name: (user.name || user.email).split(' ')[0],
    speaker_name: user.name || user.email,
    remaining: '3',
    deadline: fmtDay(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)),
    event_name: event.name,
    evaluate_link: `${c.env.APP_ORIGIN}/${event.slug}/evaluate`,
    organizer_name: user.name || 'The program team',
  };
  const res = await sendEmail(c.env, {
    eventId: event.id,
    to: user.email,
    toName: user.name,
    templateKey: 'reminder_test',
    subject: `[test] ${mergeTags(body.subject ?? '', vars)}`,
    text: mergeTags(body.body ?? '', vars),
    subjectType: 'eval_plan',
    subjectId: body.planId ?? event.id,
  });
  return c.json({
    ok: true,
    status: res.status,
    message:
      res.status === 'simulated'
        ? `Test logged as simulated — open Emails ▸ Log (sending not yet enabled)`
        : `Test email sent to ${user.email}`,
  });
});

app.post('/app/api/evaluation/reminder-template', requireOrgRole('admin'), async (c) => {
  const event = c.var.event!;
  const body = await c.req.json<{ subject?: string; body?: string }>();
  const tpl = await one<{ id: string }>(
    c.env.DB,
    `SELECT id FROM email_templates WHERE event_id = ? AND key = 'reminder'`,
    event.id
  );
  if (tpl) {
    await run(
      c.env.DB,
      `UPDATE email_templates SET subject = ?, body = ?, updated_at = ? WHERE id = ?`,
      body.subject ?? '',
      body.body ?? '',
      now(),
      tpl.id
    );
  } else {
    await run(
      c.env.DB,
      `INSERT INTO email_templates (id, event_id, key, name, subject, body, updated_at) VALUES (?,?,?,?,?,?,?)`,
      newId('etp'),
      event.id,
      'reminder',
      'Evaluation reminder',
      body.subject ?? '',
      body.body ?? '',
      now()
    );
  }
  return c.json({ ok: true });
});

app.post('/app/api/evaluation/automation', requireOrgRole('admin'), async (c) => {
  const event = c.var.event!;
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  const body = await c.req.json<{ planId?: string | null; automation?: unknown }>();
  const automation = normalizeAutomation(body.automation);
  const plans = body.planId
    ? await all<{ id: string; name: string }>(
        c.env.DB,
        `SELECT id, name FROM eval_plans WHERE id = ? AND event_id = ?`,
        body.planId,
        event.id
      )
    : await all<{ id: string; name: string }>(c.env.DB, `SELECT id, name FROM eval_plans WHERE event_id = ?`, event.id);

  for (const p of plans) {
    await run(
      c.env.DB,
      `UPDATE eval_plans SET automation_json = ?, reminders = ? WHERE id = ?`,
      JSON.stringify(automation),
      automation.on ? 1 : 0,
      p.id
    );
  }
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'plan',
    subjectId: body.planId ?? event.id,
    actor,
    action: automation.on ? 'Enabled reminder automation' : 'Disabled reminder automation',
    detail: `${plans.length} plan${plans.length === 1 ? '' : 's'} · min ${automation.minLeft} left · cooldown ${automation.cooldown}d`,
  });
  return c.json({ ok: true, plans: plans.length });
});

export default app;
