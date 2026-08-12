/**
 * Evaluator workspace — `/{event}/evaluate`.
 *
 * OWNER: B3. Markup ported from
 * `prototype/design_handoff_program/design/Evaluator Workspace.dc.html`:
 * admin-neutral chrome (minimal sidebar), a focused review card, and the
 * "Exit review" list. Scores are final — there is no edit affordance anywhere.
 *
 * The queue itself (card/list modes, plan chips, progress, the
 * `/js/evaluate.js` island contract) lives in `src/views/eval-queue.tsx`,
 * shared with the admin "My Evaluations" tab. The score/abstain endpoints
 * below serve both surfaces.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { ADMIN_BASE_CSS, GOOGLE_FONTS, MONO, Toast, initials } from '../views/layout';
import { EVAL_QUEUE_CSS, EvalQueue } from '../views/eval-queue';
import { loadPublicEvent } from '../lib/public';
import { now, run } from '../lib/db';
import { logActivity } from '../lib/activity';
import {
  assignedFor,
  cumMaxOf,
  loadEvalContext,
  loadEvaluatorFields,
  recordEvaluation,
  type EvalPlan,
  type EvalSubmission,
} from '../lib/evals';

const app = new Hono<Ctx>();

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
      <style>{raw(ADMIN_BASE_CSS + EVAL_QUEUE_CSS)}</style>
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

  const fields = await loadEvaluatorFields(c.env.DB, event.id);
  const kicker = `REVIEWER · ${myPlans.length} PLAN${myPlans.length === 1 ? '' : 'S'}`;

  return c.html(
    <Shell eventName={event.name} userName={userName} kicker={kicker} toast={c.req.query('ok') ?? null} scripts={['/js/evaluate.js']}>
      <div style="max-width:1120px;margin:0 auto;padding:26px 28px;">
        <EvalQueue
          ctx={ctx}
          myPlans={myPlans}
          userId={user.id}
          slug={event.slug}
          fields={fields}
          basePath={`/${event.slug}/evaluate`}
          query={(k) => c.req.query(k)}
        />
      </div>
    </Shell>
  );
});

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
