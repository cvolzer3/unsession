/**
 * Evaluator workspace — `/{event}/evaluate`.
 *
 * OWNER: B3. Markup ported from
 * `prototype/design_handoff_program/design/Evaluator Workspace.dc.html`:
 * admin-neutral chrome (minimal sidebar), a focused review card, and the
 * "Exit review" list. Scores are final — there is no edit affordance anywhere.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { ADMIN_BASE_CSS, GOOGLE_FONTS, MONO, Toast, initials } from '../views/layout';
import { loadPublicEvent } from '../lib/public';
import { now, run } from '../lib/db';
import { logActivity } from '../lib/activity';
import {
  assignedFor,
  cumMaxOf,
  fmtDay,
  loadEvalContext,
  loadEvaluatorFields,
  recordEvaluation,
  reviewerQueue,
  starAvgOf,
  type EvalPlan,
  type EvalSubmission,
  type QueueItem,
} from '../lib/evals';

const app = new Hono<Ctx>();

const PAGE_CSS = `
  [data-row-hover]:hover{background:#f8f9fc;}
  [data-star]:hover{border-color:#4c5fd5;}
`;

const chip = (bg: string, fg: string) =>
  `display:inline-block;padding:2px 8px;font-size:10.5px;font-weight:600;font-family:${MONO};background:${bg};color:${fg};`;

const Shell: FC<
  PropsWithChildren<{
    eventName: string;
    userName: string;
    kicker: string;
    toast?: string | null;
    scripts?: string[];
  }>
> = (props) => (
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{`${props.eventName} — Evaluation queue`}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href={GOOGLE_FONTS} rel="stylesheet" />
      <style>{raw(ADMIN_BASE_CSS + PAGE_CSS)}</style>
    </head>
    <body>
      <div style="display:grid;grid-template-columns:216px 1fr;min-height:100vh;">
        <nav style="background:#fff;border-right:1px solid #e2e3e8;padding:20px 0;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto;">
          <div style="padding:0 20px 18px;display:flex;align-items:center;gap:8px;">
            <div style={`width:22px;height:22px;background:#4c5fd5;color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:12px;font-weight:600;`}>
              U
            </div>
            <div style="font-weight:700;font-size:15px;letter-spacing:-0.01em;">Unsession</div>
          </div>
          <div style={`padding:6px 20px 4px;font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`}>
            PROGRAM
          </div>
          <div style="display:block;padding:7px 20px;color:#4c5fd5;font-size:13.5px;background:#eef0fb;font-weight:600;">
            Evaluation Queue
          </div>
          <div style="padding:14px 20px 0;font-size:11.5px;line-height:1.5;color:#9a9da6;">You have evaluation access.</div>
          <div style="margin-top:auto;padding:16px 20px 0;border-top:1px solid #eceded;">
            <div style="display:flex;align-items:center;gap:9px;">
              <div style={`width:28px;height:28px;border-radius:50%;background:#4c5fd5;color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:10.5px;font-weight:600;`}>
                {initials(props.userName)}
              </div>
              <div style="min-width:0;">
                <div style="font-size:12.5px;font-weight:600;">{props.userName}</div>
                <a href="/auth/signout" style="font-size:11px;color:#9a9da6;text-decoration:none;">
                  Sign out
                </a>
              </div>
            </div>
          </div>
        </nav>
        <main style="min-width:0;">
          <header style="background:#fff;border-bottom:1px solid #e2e3e8;padding:14px 28px;display:flex;align-items:center;gap:14px;">
            <div style="font-weight:700;font-size:16px;letter-spacing:-0.01em;">{props.eventName}</div>
            <div style={`margin-left:auto;font-family:${MONO};font-size:10.5px;letter-spacing:0.08em;color:#9a9da6;`}>
              {props.kicker}
            </div>
          </header>
          {props.children}
        </main>
      </div>
      <Toast message={props.toast} />
      <script type="module" src="/js/ui.js"></script>
      {(props.scripts ?? []).map((s) => (
        <script type="module" src={s}></script>
      ))}
    </body>
  </html>
);

/* ------------------------------------------------------------------ page */

const PAGE_SIZE = 8;

app.get('/:event/evaluate', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const event = found.event;
  const user = c.var.user;
  if (!user) return c.redirect(`/signin?next=${encodeURIComponent(`/${event.slug}/evaluate`)}`);

  const ctx = await loadEvalContext(c.env.DB, event.id);
  const myPlans = ctx.plans.filter((p) => p.reviewers.some((r) => r.userId === user.id));
  const userName = user.name || user.email;

  if (!myPlans.length) {
    return c.html(
      <Shell eventName={event.name} userName={userName} kicker="NO EVALUATION ACCESS">
        <div style="max-width:680px;margin:0 auto;padding:48px 28px;">
          <div style="background:#fff;border:1px solid #e2e3e8;padding:40px 28px;text-align:center;">
            <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:8px;`}>
              NOTHING ASSIGNED
            </div>
            <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:6px;">
              You are not a reviewer on this event
            </div>
            <div style="font-size:13.5px;color:#686b74;line-height:1.6;">
              {`Signed in as ${user.email}. If you were expecting a review queue for ${event.name}, ask the organizers to add you to an evaluation plan — you will get an email with a link straight back here.`}
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  const chairOnly = myPlans.every((p) => p.reviewers.find((r) => r.userId === user.id)?.role === 'chair');
  const planFilter = c.req.query('plan') ?? 'all';
  const mode = c.req.query('mode') === 'list' ? 'list' : 'card';
  const skipList = (c.req.query('skip') ?? '').split(',').filter(Boolean);
  const reviewedKey = c.req.query('reviewed') ?? '';

  const allItems = reviewerQueue(ctx.plans, ctx.submissions, ctx.evaluations, user.id);
  const items = planFilter === 'all' ? allItems : allItems.filter((i) => i.plan.id === planFilter);
  const keyOf = (i: QueueItem) => `${i.plan.id}:${i.submission.id}`;
  const focusKey = c.req.query('focus') ?? '';
  const todo = items.filter((i) => !i.done);
  const ordered = [
    // "Review →" from the list jumps straight to that submission.
    ...todo.filter((i) => keyOf(i) === focusKey),
    ...todo.filter((i) => keyOf(i) !== focusKey && !skipList.includes(keyOf(i))),
    ...todo.filter((i) => keyOf(i) !== focusKey && skipList.includes(keyOf(i))),
  ];
  const doneItems = items.filter((i) => i.done);
  const total = items.length;
  const doneCount = doneItems.length;

  const fields = await loadEvaluatorFields(c.env.DB, event.id);
  const current = ordered[0] ?? null;
  const reviewed = reviewedKey ? items.find((i) => keyOf(i) === reviewedKey && i.done) ?? null : null;

  const baseParams = new URLSearchParams();
  if (planFilter !== 'all') baseParams.set('plan', planFilter);
  if (skipList.length) baseParams.set('skip', skipList.join(','));
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams(baseParams);
    Object.entries(extra).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    const s = p.toString();
    return `/${event.slug}/evaluate${s ? `?${s}` : ''}`;
  };

  const island = {
    slug: event.slug,
    current: current
      ? {
          planId: current.plan.id,
          submissionId: current.submission.id,
          key: keyOf(current),
          criteria: current.plan.criteria,
        }
      : null,
    back: qs({ mode: mode === 'list' ? 'list' : '' }),
    skipUrl: current ? qs({ skip: [...skipList.filter((k) => k !== keyOf(current)), keyOf(current)].join(',') }) : '',
  };

  const kicker = `REVIEWER · ${myPlans.length} PLAN${myPlans.length === 1 ? '' : 'S'}`;
  const listFilters: ListFilters = {
    q: c.req.query('q') ?? '',
    quick: c.req.query('quick') ?? 'all',
    track: c.req.query('track') || 'all',
    format: c.req.query('format') || 'all',
    page: Math.max(0, Number(c.req.query('page') ?? '0') || 0),
  };

  return c.html(
    <Shell eventName={event.name} userName={userName} kicker={kicker} toast={c.req.query('ok') ?? null} scripts={['/js/evaluate.js']}>
      <div style="max-width:1120px;margin:0 auto;padding:26px 28px;">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap;">
          <h1 style="margin:0;font-size:20px;letter-spacing:-0.02em;">Your review queue</h1>
          <div style={`font-family:${MONO};font-size:12px;color:#686b74;`}>{`${doneCount} of ${total} done`}</div>
          <div style="flex:1;height:6px;background:#e7e8ec;max-width:220px;">
            <div style={`height:6px;width:${total ? Math.round((doneCount / total) * 100) : 0}%;background:#4c5fd5;`}></div>
          </div>
          <div style="margin-left:auto;">
            <a
              href={qs({ mode: mode === 'card' ? 'list' : '' })}
              style={
                mode === 'card'
                  ? 'padding:6px 14px;background:#c0392b;border:1px solid #c0392b;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none;'
                  : 'padding:6px 14px;background:#4c5fd5;border:1px solid #4c5fd5;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none;'
              }
            >
              {mode === 'card' ? 'Exit review' : 'Start review'}
            </a>
          </div>
        </div>

        {myPlans.length > 1 ? (
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
            <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;margin-right:4px;`}>PLAN</div>
            {[{ id: 'all', name: 'All plans' }, ...myPlans.map((p) => ({ id: p.id, name: p.name }))].map((p) => {
              const on = planFilter === p.id || (p.id === 'all' && planFilter === 'all');
              return (
                <a
                  href={`/${event.slug}/evaluate${p.id === 'all' ? '' : `?plan=${p.id}`}${
                    mode === 'list' ? (p.id === 'all' ? '?mode=list' : '&mode=list') : ''
                  }`}
                  style={`padding:5px 11px;border:1px solid ${on ? '#4c5fd5' : '#e2e3e8'};background:${
                    on ? '#eef0fb' : '#fff'
                  };color:${on ? '#4c5fd5' : '#686b74'};font-size:12px;font-weight:600;text-decoration:none;`}
                >
                  {p.name}
                </a>
              );
            })}
          </div>
        ) : null}

        {chairOnly && !total ? (
          <div style="background:#fff;border:1px solid #e2e3e8;padding:40px 28px;text-align:center;">
            <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:8px;`}>CHAIR</div>
            <div style="font-size:18px;font-weight:700;">You chair this plan — no queue of your own</div>
            <div style="font-size:13.5px;color:#686b74;margin-top:6px;">
              Chairs see every score in the organizer view; nothing is assigned to you here.
            </div>
          </div>
        ) : mode === 'list' ? (
          ListMode({ filters: listFilters, items, keyOf, qs, ctx })
        ) : reviewed ? (
          ReviewedCard({ item: reviewed, qs, fields })
        ) : current ? (
          ReviewCard({ item: current, fields, plansCount: myPlans.length })
        ) : (
          <div style="background:#fff;border:1px solid #e2e3e8;padding:64px 32px;text-align:center;">
            <div style="font-size:34px;margin-bottom:8px;">✓</div>
            <div style="font-size:19px;font-weight:700;">{`Queue clear — ${doneCount} of ${total} reviewed`}</div>
            <div style="font-size:13.5px;color:#686b74;margin-top:6px;">
              The organizers can see your scores now. Nothing else is assigned to you.
            </div>
          </div>
        )}

        {mode === 'card' && !reviewed ? (
          <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
            {items.map((it, i) => {
              const isCurrent = current ? keyOf(it) === keyOf(current) : false;
              const bg = it.done ? '#4c5fd5' : isCurrent ? '#9aa4e8' : '#e2e3e8';
              return <div title={it.done ? 'Reviewed' : isCurrent ? 'Current' : 'Pending'} style={`width:22px;height:8px;background:${bg};`} data-i={String(i)}></div>;
            })}
          </div>
        ) : null}
      </div>
      <script type="application/json" id="data-evaluate">
        {raw(JSON.stringify(island).replace(/</g, '\\u003c'))}
      </script>
    </Shell>
  );
});

/* ------------------------------------------------------------------ views */

function metaCells(item: QueueItem, fieldsMap: Map<string, { id: string; label: string; type: string }[]>) {
  const { plan, submission } = item;
  const cells = [
    { label: 'ID', val: submission.displayId },
    { label: 'SUBMITTED', val: fmtDay(submission.submittedAt) },
    { label: 'PLAN', val: plan.name },
    {
      label: 'SPEAKERS',
      val: plan.anonymized ? 'Hidden — blind review' : submission.speakers.map((s) => s.name).join(', ') || '—',
    },
  ];
  const extra = (fieldsMap.get(submission.formId) ?? [])
    .map((f) => {
      const v = submission.answers[f.id];
      if (v === undefined || v === null || v === '') return null;
      const val = Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
      if (val === submission.title || val === submission.abstract) return null;
      if (val === submission.format || val === submission.level || val === submission.trackName) return null;
      return { label: f.label.toUpperCase(), val };
    })
    .filter((x): x is { label: string; val: string } => !!x);
  return [...cells, ...extra];
}

const MetaGrid: FC<{ cells: { label: string; val: string }[] }> = ({ cells }) => (
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:16px;">
    {cells.map((m) => (
      <div>
        <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;`}>{m.label}</div>
        <div style="font-size:13px;font-weight:600;margin-top:3px;">{m.val}</div>
      </div>
    ))}
  </div>
);

const TrackBadge: FC<{ sub: EvalSubmission }> = ({ sub }) => (
  <span
    style={`display:inline-block;padding:3px 8px;font-size:11px;font-weight:600;color:#fff;background:${sub.trackColor};font-family:${MONO};`}
  >
    {sub.trackName}
  </span>
);

function ReviewCard(opts: {
  item: QueueItem;
  fields: Map<string, { id: string; label: string; type: string }[]>;
  plansCount: number;
}) {
  const { item, fields } = opts;
  const { plan, submission } = item;
  return (
    <div style="background:#fff;border:1px solid #e2e3e8;" id="review-card">
      <div style="padding:22px 26px;border-bottom:1px solid #eceded;">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">
          <TrackBadge sub={submission} />
          <span style="font-size:12px;color:#686b74;">{`${submission.format || '—'} · ${submission.level || '—'}`}</span>
          {plan.anonymized ? (
            <span
              style={`margin-left:auto;font-family:${MONO};font-size:10.5px;letter-spacing:0.06em;color:#9c36b5;`}
            >
              ANONYMIZED — SPEAKERS HIDDEN
            </span>
          ) : null}
        </div>
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;">{submission.title}</div>
        <div style="font-size:14.5px;line-height:1.6;color:#33343c;margin-top:10px;">{submission.abstract}</div>
        <MetaGrid cells={metaCells(item, fields)} />
      </div>
      {!plan.anonymized && submission.speakers.length ? (
        <div style="padding:18px 26px;border-bottom:1px solid #eceded;">
          <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;margin-bottom:10px;`}>SPEAKERS</div>
          <div style="display:grid;gap:10px;">
            {submission.speakers.map((p) => (
              <div style="display:flex;gap:12px;align-items:baseline;">
                <div style="font-size:13.5px;font-weight:600;">{p.name}</div>
                <div style={`font-size:12px;color:#4c5fd5;font-family:${MONO};`}>{p.email}</div>
                <div style="font-size:12.5px;color:#686b74;">{p.bio}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {plan.instructions ? (
        <div style="padding:16px 26px;border-bottom:1px solid #eceded;">
          <div style="font-size:12.5px;line-height:1.55;color:#33343c;background:#f8f8fa;border:1px solid #eceded;padding:10px 12px;">
            {plan.instructions}
          </div>
        </div>
      ) : null}
      <div style="padding:20px 26px;display:grid;gap:16px;">
        {plan.criteria.map((crit) => (
          <div style="display:grid;grid-template-columns:130px 1fr;gap:14px;align-items:center;">
            <div>
              <div style="font-size:13.5px;font-weight:600;">{crit.name}</div>
              <div style="font-size:11.5px;color:#9a9da6;">{crit.hint}</div>
            </div>
            <div style="display:flex;gap:4px;" data-crit={crit.name}>
              {Array.from({ length: crit.scale || 5 }, (_, i) => i + 1).map((n) => (
                <button
                  type="button"
                  data-star={String(n)}
                  style={`width:40px;height:36px;border:1px solid #e2e3e8;background:#fff;color:#686b74;font-size:13.5px;font-weight:600;cursor:pointer;font-family:${MONO};`}
                >
                  {String(n)}
                </button>
              ))}
            </div>
          </div>
        ))}
        <textarea
          id="note"
          placeholder="Comment for the organizers (optional, evaluator-only)…"
          rows={2}
          style="width:100%;padding:10px 12px;border:1px solid #e2e3e8;font-size:13px;line-height:1.5;resize:vertical;outline-color:#4c5fd5;font-family:inherit;"
        ></textarea>
        <div style="display:flex;align-items:center;gap:10px;">
          <button
            type="button"
            id="submit-score"
            style="padding:10px 20px;background:#c0c5e8;color:#fff;border:none;font-size:13.5px;font-weight:600;cursor:not-allowed;"
          >
            Submit score →
          </button>
          <button type="button" id="skip" style="padding:10px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;">
            Skip for now
          </button>
          <button
            type="button"
            id="abstain"
            style="margin-left:auto;padding:10px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;color:#686b74;cursor:pointer;"
          >
            Abstain
          </button>
        </div>
        <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;`}>
          {`KEYS 1–5 FILL THE NEXT CRITERION · ENTER SUBMITS · CUMULATIVE MAX ${cumMaxOf(plan.criteria)}`}
        </div>
      </div>
    </div>
  );
}

function ReviewedCard(opts: {
  item: QueueItem;
  qs: (extra: Record<string, string>) => string;
  fields: Map<string, { id: string; label: string; type: string }[]>;
}) {
  const { item, qs, fields } = opts;
  const { plan, submission, evaluation } = item;
  const star = evaluation ? starAvgOf(plan, evaluation) : null;
  return (
    <div style="background:#fff;border:1px solid #e2e3e8;">
      <div style="padding:22px 26px;border-bottom:1px solid #eceded;">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">
          <TrackBadge sub={submission} />
          <span style="font-size:12px;color:#686b74;">{`${submission.format || '—'} · ${submission.level || '—'}`}</span>
          <span style={`margin-left:auto;font-family:${MONO};font-size:10.5px;color:#2b8a3e;`}>
            {evaluation?.abstained ? 'ABSTAINED · REMOVED FROM YOUR QUEUE' : 'REVIEWED · SCORE LOCKED'}
          </span>
        </div>
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;">{submission.title}</div>
        <div style="font-size:14.5px;line-height:1.6;color:#33343c;margin-top:10px;">{submission.abstract}</div>
      </div>
      <div style="padding:18px 26px;border-bottom:1px solid #eceded;">
        <MetaGrid cells={metaCells(item, fields)} />
      </div>
      {!plan.anonymized && submission.speakers.length ? (
        <div style="padding:18px 26px;border-bottom:1px solid #eceded;">
          <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;margin-bottom:10px;`}>SPEAKERS</div>
          <div style="display:grid;gap:10px;">
            {submission.speakers.map((p) => (
              <div style="display:flex;gap:12px;align-items:baseline;">
                <div style="font-size:13.5px;font-weight:600;">{p.name}</div>
                <div style={`font-size:12px;color:#4c5fd5;font-family:${MONO};`}>{p.email}</div>
                <div style="font-size:12.5px;color:#686b74;">{p.bio}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div style="padding:18px 26px;border-bottom:1px solid #eceded;display:grid;gap:8px;">
        <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;`}>YOUR SCORES</div>
        {evaluation && !evaluation.abstained ? (
          plan.criteria.map((crit) => {
            const v = Number(evaluation.scores[crit.name]) || 0;
            return (
              <div style="display:grid;grid-template-columns:130px 1fr 30px;gap:12px;align-items:center;font-size:12.5px;color:#686b74;">
                <div style="font-weight:600;color:#16171d;">{crit.name}</div>
                <div style="height:5px;background:#eef0f3;">
                  <div style={`height:5px;width:${Math.round((v / (crit.scale || 5)) * 100)}%;background:#4c5fd5;`}></div>
                </div>
                <div style={`font-family:${MONO};font-size:12px;font-weight:700;text-align:right;`}>{v || '—'}</div>
              </div>
            );
          })
        ) : (
          <div style="font-size:12.5px;color:#9a9da6;">You abstained on this submission.</div>
        )}
        {evaluation?.note ? (
          <div style="border-left:2px solid #e2e3e8;padding:2px 0 2px 12px;margin-top:6px;font-size:12.5px;color:#33343c;">
            {evaluation.note}
          </div>
        ) : null}
      </div>
      <div style="padding:20px 26px;display:flex;align-items:center;gap:28px;flex-wrap:wrap;">
        <div>
          <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;`}>YOUR SCORE</div>
          <div style="font-size:24px;font-weight:700;">{star != null ? `${star.toFixed(1)}★` : '—'}</div>
        </div>
        <div>
          <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;`}>CUMULATIVE</div>
          <div style="font-size:24px;font-weight:700;">
            {evaluation && !evaluation.abstained
              ? `${plan.criteria.reduce((a, cr) => a + (Number(evaluation.scores[cr.name]) || 0), 0)} / ${cumMaxOf(plan.criteria)}`
              : '—'}
          </div>
        </div>
        <div style="margin-left:auto;font-size:12px;color:#9a9da6;">Submitted scores are final and can’t be edited.</div>
      </div>
      <div style="padding:0 26px 20px;">
        <a href={qs({ mode: 'list' })} style="display:inline-block;padding:9px 16px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;color:#16171d;text-decoration:none;">
          ← Back to list
        </a>
      </div>
    </div>
  );
}

type ListFilters = { q: string; quick: string; track: string; format: string; page: number };

function ListMode(opts: {
  filters: ListFilters;
  items: QueueItem[];
  keyOf: (i: QueueItem) => string;
  qs: (extra: Record<string, string>) => string;
  ctx: Awaited<ReturnType<typeof loadEvalContext>>;
}) {
  const { filters, items, keyOf, qs, ctx } = opts;
  const q = filters.q.trim().toLowerCase();
  const quick = filters.quick;
  const fTrack = filters.track;
  const fFormat = filters.format;
  const page = filters.page;

  let rows = items.slice();
  if (quick === 'todo') rows = rows.filter((i) => !i.done);
  if (quick === 'done') rows = rows.filter((i) => i.done);
  if (fTrack !== 'all') rows = rows.filter((i) => i.submission.trackOptionId === fTrack);
  if (fFormat !== 'all') rows = rows.filter((i) => i.submission.format === fFormat);
  if (q) {
    rows = rows.filter((i) =>
      `${i.submission.title} ${i.submission.displayId} ${i.submission.trackName}`.toLowerCase().includes(q)
    );
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cur = Math.min(page, pages - 1);
  const pageRows = rows.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);
  const hasFilters = !!(q || quick !== 'all' || fTrack !== 'all' || fFormat !== 'all');
  const seg = (on: boolean) =>
    `padding:7px 12px;border:none;font-size:12px;cursor:pointer;font-weight:600;text-decoration:none;display:inline-block;background:${
      on ? '#eef0fb' : '#fff'
    };color:${on ? '#4c5fd5' : '#686b74'};`;
  const link = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    p.set('mode', 'list');
    if (q) p.set('q', q);
    if (quick !== 'all') p.set('quick', quick);
    if (fTrack !== 'all') p.set('track', fTrack);
    if (fFormat !== 'all') p.set('format', fFormat);
    Object.entries(extra).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    return `${qs({ mode: 'list' }).split('?')[0]}?${p.toString()}`;
  };

  return (
    <div>
      <form method="get" data-autosubmit style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
        <input type="hidden" name="mode" value="list" />
        <input
          name="q"
          value={q}
          placeholder="Search title or ID…"
          style="width:240px;padding:7px 12px;border:1px solid #e2e3e8;font-size:13px;outline-color:#4c5fd5;background:#fff;"
        />
        <div style="display:flex;border:1px solid #e2e3e8;background:#fff;">
          <a href={link({ quick: '' })} style={seg(quick === 'all')}>
            All
          </a>
          <a href={link({ quick: 'todo' })} style={seg(quick === 'todo')}>
            Not reviewed
          </a>
          <a href={link({ quick: 'done' })} style={seg(quick === 'done')}>
            Reviewed
          </a>
        </div>
        <select name="track" style="padding:7px 10px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;color:#33343c;cursor:pointer;outline-color:#4c5fd5;">
          <option value="all" selected={fTrack === 'all'}>
            All tracks
          </option>
          {ctx.tracks.map((t) => (
            <option value={t.id} selected={fTrack === t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select name="format" style="padding:7px 10px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;color:#33343c;cursor:pointer;outline-color:#4c5fd5;">
          <option value="all" selected={fFormat === 'all'}>
            All formats
          </option>
          {ctx.formats.map((f) => (
            <option value={f} selected={fFormat === f}>
              {f}
            </option>
          ))}
        </select>
        {hasFilters ? (
          <a href={qs({ mode: 'list' })} style="padding:7px 10px;color:#4c5fd5;font-size:12.5px;font-weight:600;text-decoration:none;">
            Clear ×
          </a>
        ) : null}
      </form>
      <div style="background:#fff;border:1px solid #e2e3e8;">
        <div
          style={`display:grid;grid-template-columns:56px minmax(0,1fr) 110px 150px 96px 92px;gap:16px;padding:9px 16px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`}
        >
          <div>ID</div>
          <div>TITLE</div>
          <div>TRACK</div>
          <div>FORMAT</div>
          <div>STATUS</div>
          <div style="text-align:right;">YOUR SCORE</div>
        </div>
        {pageRows.map((i) => {
          const star = i.evaluation && !i.evaluation.abstained ? starAvgOf(i.plan, i.evaluation) : null;
          const href = i.done ? qs({ reviewed: keyOf(i) }) : qs({ focus: keyOf(i) });
          return (
            <a
              data-row-hover
              href={href}
              style="display:grid;grid-template-columns:56px minmax(0,1fr) 110px 150px 96px 92px;gap:16px;padding:11px 16px;border-bottom:1px solid #f2f3f5;align-items:center;cursor:pointer;color:#16171d;text-decoration:none;"
            >
              <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{i.submission.displayId}</div>
              <div style="font-size:13px;font-weight:600;line-height:1.35;">{i.submission.title}</div>
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#33343c;">
                <span style={`width:8px;height:8px;background:${i.submission.trackColor};flex:none;`}></span>
                {i.submission.trackName}
              </div>
              <div style="font-size:12px;color:#686b74;">{`${i.submission.format || '—'} · ${i.submission.level || '—'}`}</div>
              <div>
                {i.done ? (
                  <span style={chip('#e6f4ea', '#2b8a3e')}>{i.evaluation?.abstained ? 'Abstained' : 'Reviewed'}</span>
                ) : (
                  <span style={chip('#eef0fb', '#4c5fd5')}>Pending</span>
                )}
              </div>
              <div style="text-align:right;">
                {i.done ? (
                  <span style={`font-family:${MONO};font-size:12.5px;font-weight:600;`}>{star != null ? `${star.toFixed(1)}★` : '—'}</span>
                ) : (
                  <span style="padding:5px 10px;background:#fff;border:1px solid #4c5fd5;color:#4c5fd5;font-size:11.5px;font-weight:600;">
                    Review →
                  </span>
                )}
              </div>
            </a>
          );
        })}
        {rows.length === 0 ? (
          <div style="padding:36px 16px;text-align:center;font-size:13px;color:#686b74;">
            No submissions match —{' '}
            <a href={qs({ mode: 'list' })} style="color:#4c5fd5;font-weight:600;">
              clear filters
            </a>
          </div>
        ) : null}
        <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid #eceded;">
          <div style={`font-family:${MONO};font-size:11px;color:#686b74;`}>
            {rows.length === 0 ? '0 of 0' : `${cur * PAGE_SIZE + 1}–${Math.min(rows.length, (cur + 1) * PAGE_SIZE)} of ${rows.length}`}
          </div>
          {pages > 1 ? (
            <div style="margin-left:auto;display:flex;gap:5px;align-items:center;">
              {Array.from({ length: pages }, (_, i) => i).map((i) => (
                <a
                  href={link({ page: String(i) })}
                  style={`width:30px;padding:6px 0;border:1px solid ${i === cur ? '#4c5fd5' : '#e2e3e8'};background:${
                    i === cur ? '#eef0fb' : '#fff'
                  };color:${i === cur ? '#4c5fd5' : '#686b74'};font-size:12px;font-weight:600;cursor:pointer;font-family:${MONO};text-align:center;text-decoration:none;`}
                >
                  {String(i + 1)}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- APIs */

type ScoreBody = {
  slug?: string;
  planId?: string;
  submissionId?: string;
  scores?: Record<string, number>;
  note?: string;
};

async function guardedItem(
  c: Context<Ctx>,
  body: ScoreBody
): Promise<{ error?: string; plan?: EvalPlan; sub?: EvalSubmission; eventId?: string }> {
  const user = c.var.user;
  if (!user) return { error: 'Sign in to score submissions' };
  const found = await loadPublicEvent(c.env.DB, body.slug ?? '');
  if (!found) return { error: 'Event not found' };
  const ctx = await loadEvalContext(c.env.DB, found.event.id);
  const plan = ctx.plans.find((p) => p.id === body.planId);
  if (!plan) return { error: 'That evaluation plan no longer exists' };
  const rev = plan.reviewers.find((r) => r.userId === user.id);
  if (!rev || rev.role === 'chair') return { error: 'You are not a reviewer on that plan' };
  const sub = ctx.submissions.find((s) => s.id === body.submissionId);
  if (!sub) return { error: 'That submission no longer exists' };
  if (!assignedFor(plan, sub).some((r) => r.userId === user.id)) {
    return { error: 'That submission is not assigned to you' };
  }
  return { plan, sub, eventId: found.event.id };
}

app.post('/p/api/evaluate/score', async (c) => {
  const user = c.var.user;
  const body = await c.req.json<ScoreBody>();
  const g = await guardedItem(c, body);
  if (g.error || !g.plan || !g.sub || !user) return c.json({ ok: false, error: g.error ?? 'Not allowed' }, 400);

  const scores: Record<string, number> = {};
  for (const crit of g.plan.criteria) {
    const v = Number((body.scores ?? {})[crit.name]);
    if (!Number.isFinite(v) || v < 1 || v > (crit.scale || 5)) {
      return c.json({ ok: false, error: `Score every criterion first (${crit.name} is missing)` }, 400);
    }
    scores[crit.name] = Math.round(v);
  }

  const res = await recordEvaluation(c.env.DB, {
    planId: g.plan.id,
    submissionId: g.sub.id,
    reviewerId: user.id,
    scores,
    note: (body.note ?? '').trim(),
    abstained: false,
  });
  if (!res.ok) return c.json({ ok: false, error: res.error }, 400);

  if (g.sub.status === 'submitted') {
    await run(c.env.DB, `UPDATE submissions SET status = 'in_review', updated_at = ? WHERE id = ?`, now(), g.sub.id);
  }
  await logActivity(c.env.DB, {
    eventId: g.eventId!,
    subjectType: 'submission',
    subjectId: g.sub.id,
    actor: user.name || user.email,
    action: 'Scored',
    detail: `“${g.plan.name}” · cumulative ${Object.values(scores).reduce((a, b) => a + b, 0)} of ${cumMaxOf(
      g.plan.criteria
    )}`,
  });
  return c.json({ ok: true });
});

app.post('/p/api/evaluate/abstain', async (c) => {
  const user = c.var.user;
  const body = await c.req.json<ScoreBody>();
  const g = await guardedItem(c, body);
  if (g.error || !g.plan || !g.sub || !user) return c.json({ ok: false, error: g.error ?? 'Not allowed' }, 400);

  const res = await recordEvaluation(c.env.DB, {
    planId: g.plan.id,
    submissionId: g.sub.id,
    reviewerId: user.id,
    scores: {},
    note: (body.note ?? '').trim(),
    abstained: true,
  });
  if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
  await logActivity(c.env.DB, {
    eventId: g.eventId!,
    subjectType: 'submission',
    subjectId: g.sub.id,
    actor: user.name || user.email,
    action: 'Abstained',
    detail: `“${g.plan.name}” — removed from their queue`,
  });
  return c.json({ ok: true });
});

export default app;
