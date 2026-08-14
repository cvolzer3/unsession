/**
 * API domain: evaluation (spec C parity round 2).
 *
 * Plans, scores and evaluator reminders over the same engine as the admin
 * Evaluation screen (`lib/evals`): rule-matched membership + explicit includes,
 * seeded round-robin assignment with pins, insert-once scoring. Scoring through
 * the API names the reviewer explicitly and enforces the same guards as the
 * reviewer queue (member of the plan, not a chair, assigned to the submission).
 */
import type { Hono } from 'hono';
import type { Bindings, Event } from '../types';
import { apiActor, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import {
  bad,
  EVENT_PROP,
  handle,
  jsonBody,
  notFound,
  p,
  requireWrite,
  resolveEvent,
  str,
  type Tool,
} from '../lib/api-core';
import { all, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { sendEmail } from '../lib/email';
import { findOrCreateUserByEmail, requestPasswordReset } from '../lib/auth';
import {
  assignedFor,
  cumMaxOf,
  DEFAULT_CRITERIA,
  DEFAULT_RULES,
  fmtDay,
  loadEvalContext,
  matchesRules,
  mergeTags,
  normalizeAutomation,
  planProgress,
  recordEvaluation,
  reviewerLoad,
  scaleCriteria,
  submissionScore,
  type Criterion,
  type EvalContext,
  type EvalPlan,
  type Rules,
} from '../lib/evals';

/* ----------------------------------------------------------------- helpers */

async function evalContext(env: Bindings, auth: ApiAuth, ref: string): Promise<{ event: Event; ctx: EvalContext }> {
  const event = await resolveEvent(env, auth, ref);
  const ctx = await loadEvalContext(env.DB, event.id);
  return { event, ctx };
}

function planOf(ctx: EvalContext, planId: string): EvalPlan {
  const plan = ctx.plans.find((pl) => pl.id === planId);
  if (!plan) throw notFound('Evaluation plan not found');
  return plan;
}

function shapePlan(ctx: EvalContext, plan: EvalPlan) {
  const matched = ctx.submissions.filter((s) => matchesRules(s, plan.rules) || plan.includeIds.includes(s.id));
  const progress = planProgress(plan, ctx.submissions, ctx.evaluations);
  return {
    id: plan.id,
    name: plan.name,
    instructions: plan.instructions,
    opensAt: plan.opensAt,
    deadline: plan.deadline,
    anonymized: plan.anonymized,
    reminders: plan.reminders,
    reviewsPer: plan.reviewsPer,
    rules: plan.rules,
    criteria: plan.criteria,
    automation: plan.automation,
    createdAt: plan.createdAt,
    reviewers: plan.reviewers.map((r) => ({
      userId: r.userId,
      name: r.name,
      email: r.email,
      role: r.role,
      load: r.role === 'chair' ? null : reviewerLoad(plan, r.userId, ctx.submissions, ctx.evaluations),
    })),
    submissions: { matched: matched.length, explicitIncludes: plan.includeIds.length },
    progress,
  };
}

/* -------------------------------------------------------------------- read */

export async function listEvaluationPlans(env: Bindings, auth: ApiAuth, ref: string) {
  const { ctx } = await evalContext(env, auth, ref);
  return ctx.plans.map((plan) => shapePlan(ctx, plan));
}

export type ListEvaluationsQuery = { plan?: string; submission?: string; reviewer?: string };

/** Raw evaluations (scores per reviewer per submission) with score summaries per submission. */
export async function listEvaluations(env: Bindings, auth: ApiAuth, ref: string, query: ListEvaluationsQuery = {}) {
  const { ctx } = await evalContext(env, auth, ref);

  let rows = ctx.evaluations;
  if (query.plan) {
    const plan = planOf(ctx, query.plan);
    rows = rows.filter((e) => e.planId === plan.id);
  }
  if (query.submission) rows = rows.filter((e) => e.submissionId === query.submission);

  const users = rows.length
    ? await all<{ id: string; name: string | null; email: string }>(
        env.DB,
        `SELECT id, name, email FROM users WHERE id IN (${[...new Set(rows.map((r) => r.reviewerId))].map(() => '?').join(',')})`,
        ...[...new Set(rows.map((r) => r.reviewerId))]
      )
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  if (query.reviewer) {
    const want = query.reviewer.trim().toLowerCase();
    rows = rows.filter((e) => {
      const u = userById.get(e.reviewerId);
      return e.reviewerId === query.reviewer || (u?.email ?? '').toLowerCase() === want;
    });
  }

  const planById = new Map(ctx.plans.map((pl) => [pl.id, pl]));
  const subById = new Map(ctx.submissions.map((s) => [s.id, s]));
  return rows.map((e) => {
    const u = userById.get(e.reviewerId);
    const sub = subById.get(e.submissionId);
    return {
      id: e.id,
      planId: e.planId,
      planName: planById.get(e.planId)?.name ?? null,
      submissionId: e.submissionId,
      submissionDisplayId: sub?.displayId ?? null,
      submissionTitle: sub?.title ?? null,
      reviewer: { userId: e.reviewerId, name: u?.name ?? null, email: u?.email ?? null },
      scores: e.scores,
      note: e.note,
      abstained: e.abstained,
      createdAt: e.createdAt,
    };
  });
}

/** Score summary per submission across all plans — the Scores tab's numbers. */
export async function getEvaluationScores(env: Bindings, auth: ApiAuth, ref: string) {
  const { ctx } = await evalContext(env, auth, ref);
  return ctx.submissions.map((s) => {
    const score = submissionScore(s, ctx.plans, ctx.submissions, ctx.evaluations);
    return {
      submissionId: s.id,
      displayId: s.displayId,
      title: s.title,
      status: s.status,
      track: s.trackName || null,
      average: score.avg,
      evaluations: score.n,
      expected: score.expected,
      remaining: score.remaining,
    };
  });
}

/* ------------------------------------------------------------------- write */

export type SaveEvaluationPlanInput = {
  id?: string;
  name?: string;
  instructions?: string;
  opensAt?: string | null;
  deadline?: string | null;
  anonymized?: boolean;
  reminders?: boolean;
  reviewsPer?: number;
  criteria?: { name?: string; hint?: string; type?: string; scale?: number; options?: unknown[]; weight?: number }[];
  reviewers?: { userId?: string; email?: string; role?: string }[];
  rules?: Partial<Rules>;
};

/**
 * CREATE or UPDATE an evaluation plan (id present = update; omitted fields keep
 * their current values on update). Mirrors the admin plan editor, including the
 * emails to newly added reviewers.
 */
export async function saveEvaluationPlan(env: Bindings, auth: ApiAuth, ref: string, input: SaveEvaluationPlanInput) {
  requireWrite(auth);
  const { event, ctx } = await evalContext(env, auth, ref);
  const db = env.DB;
  const existing = input.id ? planOf(ctx, input.id) : null;

  const name = (input.name ?? existing?.name ?? '').trim();
  if (!name) throw bad('Name the plan first');

  const criteria: Criterion[] =
    input.criteria === undefined
      ? (existing?.criteria ?? DEFAULT_CRITERIA)
      : input.criteria
          .map(
            (cr): Criterion => ({
              name: String(cr.name ?? '').trim(),
              hint: String(cr.hint ?? ''),
              type: cr.type === 'select' || cr.type === 'text' ? cr.type : 'scale',
              scale: Number(cr.scale) || 5,
              options: Array.isArray(cr.options) ? cr.options.map((o) => String(o ?? '').trim()).filter(Boolean) : [],
              weight: Number.isFinite(Number(cr.weight)) && Number(cr.weight) > 0 ? Number(cr.weight) : 1,
            })
          )
          .filter((cr) => !!cr.name);
  if (!criteria.length) throw bad('Add at least one criterion');
  const emptySelect = criteria.find((cr) => cr.type === 'select' && cr.options.length < 2);
  if (emptySelect) throw bad(`Give “${emptySelect.name}” at least two dropdown options`);

  const rules: Rules = { ...DEFAULT_RULES, ...(existing?.rules ?? {}), ...(input.rules ?? {}) };
  // Explicit per-submission assignments count toward coverage, so tightening
  // the rules on a plan that lives off assignments doesn't lock the editor out.
  const assigned = new Set(existing?.includeIds ?? []);
  const matched = ctx.submissions.filter((s) => matchesRules(s, rules) || assigned.has(s.id));
  if (!matched.length) throw bad('No submissions match — loosen the rules');

  const reviewsPer = Math.max(1, Math.min(3, Number(input.reviewsPer ?? existing?.reviewsPer) || 3));
  const opensAt = input.opensAt === undefined ? (existing?.opensAt ?? null) : (input.opensAt ?? '').slice(0, 10) || null;
  const deadline =
    input.deadline === undefined ? (existing?.deadline ?? null) : (input.deadline ?? '').slice(0, 10) || null;
  if (opensAt && deadline && opensAt > deadline) throw bad('Open date must be on or before the close date');
  const anonymized = input.anonymized ?? existing?.anonymized ?? true;
  const reminders = input.reminders ?? existing?.reminders ?? true;

  // Resolve reviewers: org members by userId or email; email-only outsiders
  // must already hold a pending team invite (same rule as the plan editor).
  let reviewers: { userId: string; role: 'chair' | 'member' }[];
  if (input.reviewers === undefined && existing) {
    reviewers = existing.reviewers.map((r) => ({ userId: r.userId, role: r.role }));
  } else {
    const draft = (input.reviewers ?? []).filter((r) => !!r.userId || !!(r.email ?? '').trim());
    const members = await all<{ user_id: string; email: string }>(
      db,
      `SELECT m.user_id, u.email FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?`,
      event.org_id
    );
    const memberIds = new Set(members.map((m) => m.user_id));
    const memberByEmail = new Map(members.map((m) => [m.email.toLowerCase(), m.user_id]));
    reviewers = [];
    const seen = new Set<string>();
    for (const r of draft) {
      let userId = r.userId ?? '';
      if (userId && !memberIds.has(userId)) throw bad(`Reviewer ${userId} is not a member of this team`);
      if (!userId) {
        const email = String(r.email ?? '').trim();
        userId = memberByEmail.get(email.toLowerCase()) ?? '';
        if (!userId) {
          const invite = await one<{ id: string }>(
            db,
            `SELECT id FROM invites WHERE org_id = ? AND email = ? AND status = 'pending'`,
            event.org_id,
            email
          );
          if (!invite) throw bad(`${email} has no pending invite on this team — invite them first (see invite_teammate)`);
          userId = (await findOrCreateUserByEmail(db, email)).id;
        }
      }
      if (seen.has(userId)) continue;
      seen.add(userId);
      reviewers.push({ userId, role: r.role === 'chair' ? 'chair' : 'member' });
    }
  }
  if (!reviewers.filter((r) => r.role !== 'chair').length) throw bad('Assign at least one member reviewer');

  const automation = { ...(existing?.automation ?? normalizeAutomation({})), on: reminders };
  const planId = existing?.id ?? newId('epl');
  const before = existing ? existing.reviewers.map((r) => r.userId) : [];

  if (existing) {
    await run(
      db,
      `UPDATE eval_plans SET name = ?, instructions = ?, opens_at = ?, deadline = ?, anonymized = ?, reminders = ?, reviews_per = ?,
         rules_json = ?, criteria_json = ?, automation_json = ? WHERE id = ?`,
      name,
      input.instructions ?? existing.instructions,
      opensAt,
      deadline,
      anonymized ? 1 : 0,
      reminders ? 1 : 0,
      reviewsPer,
      JSON.stringify(rules),
      JSON.stringify(criteria),
      JSON.stringify(automation),
      planId
    );
    await run(db, `DELETE FROM eval_plan_reviewers WHERE plan_id = ?`, planId);
  } else {
    await run(
      db,
      `INSERT INTO eval_plans (id, event_id, name, instructions, opens_at, deadline, anonymized, reminders, reviews_per,
         rules_json, criteria_json, automation_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      planId,
      event.id,
      name,
      input.instructions ?? '',
      opensAt,
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
    await run(db, `INSERT INTO eval_plan_reviewers (plan_id, user_id, role) VALUES (?,?,?)`, planId, r.userId, r.role);
  }

  // Tell everyone newly added to the plan where their queue is. Reviewers who
  // don't have a password yet get a set-a-password link; the rest just get the URL.
  const added = reviewers.filter((r) => !before.includes(r.userId));
  const links: { email: string; link: string }[] = [];
  for (const r of added) {
    const u = await one<{ email: string; name: string | null; password_hash: string | null }>(
      db,
      `SELECT email, name, password_hash FROM users WHERE id = ?`,
      r.userId
    );
    if (!u) continue;
    if (!u.password_hash) {
      const res = await requestPasswordReset(env, u.email, {
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
      await sendEmail(env, {
        eventId: event.id,
        to: u.email,
        toName: u.name,
        templateKey: 'reviewer_added',
        subject: `You're reviewing for ${event.name}`,
        text:
          `Hi ${u.name || 'there'},\n\n` +
          `You've been added as a reviewer on “${name}” for ${event.name}.\n\n` +
          `Sign in with your password to open your review queue:\n${env.APP_ORIGIN}/${event.slug}/evaluate`,
        subjectType: 'eval_plan',
        subjectId: planId,
      });
    }
  }

  await logActivity(db, {
    eventId: event.id,
    subjectType: 'plan',
    subjectId: planId,
    actor: apiActor(auth),
    action: existing ? 'Updated evaluation plan' : 'Created evaluation plan',
    detail: `“${name}” · ${criteria.length} criteria · ${reviewers.length} reviewers · ${matched.length} submissions${
      added.length ? ` · ${added.length} invited` : ''
    }`,
  });

  const fresh = await loadEvalContext(db, event.id);
  const shaped = shapePlan(fresh, planOf(fresh, planId));
  return links.length ? { ...shaped, invitedSetupLinks: links } : shaped;
}

export type RecordEvaluationInput = {
  planId?: string;
  submissionId?: string;
  /** The reviewer this score is recorded for — a user id or their email. */
  reviewer?: string;
  scores?: Record<string, unknown>;
  note?: string;
  abstain?: boolean;
};

/**
 * RECORD an evaluation on a reviewer's behalf — same guards as the reviewer
 * queue (member of the plan, not a chair, assigned to the submission) and the
 * same finality: one evaluation per (plan, submission, reviewer), no edits.
 */
export async function recordEvaluationApi(env: Bindings, auth: ApiAuth, ref: string, input: RecordEvaluationInput) {
  requireWrite(auth);
  const { event, ctx } = await evalContext(env, auth, ref);
  const plan = planOf(ctx, str(input.planId));

  const who = (input.reviewer ?? '').trim().toLowerCase();
  if (!who) throw bad('Pass reviewer — the user id or email of the plan reviewer this score is for');
  const reviewer = plan.reviewers.find((r) => r.userId === input.reviewer || r.email.toLowerCase() === who);
  if (!reviewer) throw bad('That person is not a reviewer on this plan');
  if (reviewer.role === 'chair') throw bad('Chairs don’t score — pick a member reviewer');

  const sub = ctx.submissions.find((s) => s.id === input.submissionId);
  if (!sub) throw notFound('Submission not found');
  if (!assignedFor(plan, sub).some((r) => r.userId === reviewer.userId)) {
    throw bad(`${sub.displayId} is not assigned to ${reviewer.name || reviewer.email} on this plan`);
  }

  const abstained = input.abstain === true;
  const scores: Record<string, number | string> = {};
  if (!abstained) {
    for (const crit of plan.criteria) {
      const raw = (input.scores ?? {})[crit.name];
      if (crit.type === 'select') {
        const v = String(raw ?? '');
        if (!crit.options.includes(v)) throw bad(`Pick an option for ${crit.name} first (one of ${crit.options.join(', ')})`);
        scores[crit.name] = v;
      } else if (crit.type === 'text') {
        const v = String(raw ?? '').trim();
        if (v) scores[crit.name] = v;
      } else {
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 1 || v > (crit.scale || 5)) {
          throw bad(`Score every criterion first (${crit.name} is missing — 1 to ${crit.scale || 5})`);
        }
        scores[crit.name] = Math.round(v);
      }
    }
  }

  const res = await recordEvaluation(env.DB, {
    planId: plan.id,
    submissionId: sub.id,
    reviewerId: reviewer.userId,
    scores,
    note: (input.note ?? '').trim(),
    abstained,
  });
  if (!res.ok) throw bad(res.error ?? 'Could not record the evaluation');

  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'submission',
    subjectId: sub.id,
    actor: apiActor(auth),
    action: abstained ? 'Abstained' : 'Scored',
    detail: abstained
      ? `“${plan.name}” — for ${reviewer.name || reviewer.email}`
      : `“${plan.name}” · cumulative ${scaleCriteria(plan.criteria).reduce(
          (a, cr) => a + (Number(scores[cr.name]) || 0),
          0
        )} of ${cumMaxOf(plan.criteria)} · for ${reviewer.name || reviewer.email}`,
  });

  return {
    planId: plan.id,
    submissionId: sub.id,
    displayId: sub.displayId,
    reviewer: { userId: reviewer.userId, name: reviewer.name, email: reviewer.email },
    abstained,
    scores,
  };
}

export type RemindEvaluatorsInput = {
  planId?: string;
  /** User ids or emails. Omit to remind every member reviewer with work left. */
  reviewers?: string[];
  subject?: string;
  body?: string;
};

/** REMIND evaluators with outstanding reviews — immediate emails, like the admin panel. */
export async function remindEvaluators(env: Bindings, auth: ApiAuth, ref: string, input: RemindEvaluatorsInput) {
  requireWrite(auth);
  const { event, ctx } = await evalContext(env, auth, ref);
  const scopePlans = input.planId ? [planOf(ctx, input.planId)] : ctx.plans;
  if (!scopePlans.length) throw bad('This event has no evaluation plans yet');

  let subject = (input.subject ?? '').trim();
  let text = (input.body ?? '').trim();
  if (!subject || !text) {
    const tpl = await one<{ subject: string; body: string }>(
      env.DB,
      `SELECT subject, body FROM email_templates WHERE event_id = ? AND key = 'reminder'`,
      event.id
    );
    if (!tpl) throw bad('Pass subject and body — this event has no saved “reminder” email template to fall back on');
    subject = subject || tpl.subject;
    text = text || tpl.body;
  }

  const wanted = (input.reviewers ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean);
  const allMembers = new Map<string, { name: string; email: string }>();
  for (const plan of scopePlans) {
    for (const r of plan.reviewers) {
      if (r.role !== 'chair') allMembers.set(r.userId, { name: r.name, email: r.email });
    }
  }
  const targetIds = [...allMembers.entries()]
    .filter(
      ([userId, r]) => !wanted.length || wanted.includes(userId.toLowerCase()) || wanted.includes(r.email.toLowerCase())
    )
    .map(([userId]) => userId);
  if (!targetIds.length) throw bad('No matching reviewers on the plan(s)');

  const sentNames: string[] = [];
  const skipped: { email: string; reason: string }[] = [];
  for (const userId of targetIds) {
    let remaining = 0;
    let deadline: string | null = null;
    let planId = scopePlans[0]?.id ?? null;
    let name = '';
    let email = '';
    scopePlans.forEach((plan) => {
      const rev = plan.reviewers.find((r) => r.userId === userId && r.role !== 'chair');
      if (!rev) return;
      name = rev.name;
      email = rev.email;
      const l = reviewerLoad(plan, userId, ctx.submissions, ctx.evaluations);
      remaining += l.remaining;
      if (l.remaining > 0 && (!deadline || (plan.deadline && plan.deadline < deadline))) {
        deadline = plan.deadline;
        planId = plan.id;
      }
    });
    if (!email) continue;
    if (remaining === 0) {
      skipped.push({ email, reason: 'no reviews left' });
      continue;
    }
    const vars: Record<string, string> = {
      first_name: name.split(' ')[0] || name,
      speaker_name: name,
      remaining: String(remaining),
      deadline: fmtDay(deadline),
      event_name: event.name,
      evaluate_link: `${env.APP_ORIGIN}/${event.slug}/evaluate`,
      organizer_name: apiActor(auth),
    };
    await sendEmail(env, {
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
  if (!sentNames.length) throw bad('Nobody selected still has work left');

  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'plan',
    subjectId: input.planId ?? event.id,
    actor: apiActor(auth),
    action: 'Reminded evaluators',
    detail: `${sentNames.length} reminder${sentNames.length === 1 ? '' : 's'} sent — ${sentNames.join(', ')}`,
  });
  return { sent: sentNames.length, names: sentNames, skipped };
}

/* -------------------------------------------------------------- REST routes */

export function registerEvaluationRoutes(app: Hono<ApiCtx>): void {
  app.get('/api/v1/events/:event/evaluation/plans', handle((c) => listEvaluationPlans(c.env, c.var.apiAuth, p(c, 'event'))));
  app.get(
    '/api/v1/events/:event/evaluations',
    handle((c) =>
      listEvaluations(c.env, c.var.apiAuth, p(c, 'event'), {
        plan: c.req.query('plan'),
        submission: c.req.query('submission'),
        reviewer: c.req.query('reviewer'),
      })
    )
  );
  app.get('/api/v1/events/:event/evaluation/scores', handle((c) => getEvaluationScores(c.env, c.var.apiAuth, p(c, 'event'))));
  app.post(
    '/api/v1/events/:event/evaluation/plans',
    handle(async (c) => saveEvaluationPlan(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.post(
    '/api/v1/events/:event/evaluations',
    handle(async (c) => recordEvaluationApi(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.post(
    '/api/v1/events/:event/evaluation/remind',
    handle(async (c) => remindEvaluators(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
}

/* --------------------------------------------------------------- MCP tools */

export const EVALUATION_TOOLS: Tool[] = [
  {
    name: 'list_evaluation_plans',
    description:
      'List an event’s evaluation plans: criteria, scope rules, reviewers (with per-reviewer done/remaining load), matched-submission count and overall progress. Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => listEvaluationPlans(env, auth, str(a.event)),
  },
  {
    name: 'list_evaluations',
    description:
      'List recorded evaluations (per reviewer per submission): scores keyed by criterion name, note, abstained flag. Filters: plan id, submission id, reviewer (id or email). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        plan: { type: 'string', description: 'Filter by plan id (epl_…).' },
        submission: { type: 'string', description: 'Filter by submission id (sub_…).' },
        reviewer: { type: 'string', description: 'Filter by reviewer user id or email.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) =>
      listEvaluations(env, auth, str(a.event), {
        plan: a.plan === undefined ? undefined : str(a.plan),
        submission: a.submission === undefined ? undefined : str(a.submission),
        reviewer: a.reviewer === undefined ? undefined : str(a.reviewer),
      }),
  },
  {
    name: 'get_evaluation_scores',
    description:
      'Score summary per submission across all plans (the admin Scores tab): weighted average, evaluations done, expected, remaining. Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => getEvaluationScores(env, auth, str(a.event)),
  },
  {
    name: 'save_evaluation_plan',
    description:
      'CREATE or UPDATE an evaluation plan (pass id to update; omitted fields keep their values). Criteria: scale (1–N stars, weighted), select (dropdown) or text. Reviewers are org members (userId or email) or pending invitees by email; chairs oversee, members score. Newly added reviewers are EMAILED their queue link (password-less ones get a set-a-password link, returned when simulated). Requires ≥1 member reviewer and ≥1 matched submission.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        id: { type: 'string', description: 'Plan id (epl_…) to update; omit to create.' },
        name: { type: 'string' },
        instructions: { type: 'string', description: 'Shown to reviewers above their queue.' },
        opensAt: { type: ['string', 'null'], description: 'YYYY-MM-DD; null clears.' },
        deadline: { type: ['string', 'null'], description: 'YYYY-MM-DD; null clears.' },
        anonymized: { type: 'boolean', description: 'Hide speaker identities from reviewers. Default true.' },
        reminders: { type: 'boolean', description: 'Automatic evaluator reminders on/off. Default true.' },
        reviewsPer: { type: 'integer', description: 'Reviews per submission, 1–3. Default 3.' },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              hint: { type: 'string' },
              type: { type: 'string', enum: ['scale', 'select', 'text'] },
              scale: { type: 'integer', description: '3, 5 or 10 — scale criteria only.' },
              options: { type: 'array', items: { type: 'string' }, description: 'Select criteria: ≥2 choices.' },
              weight: { type: 'number', description: 'Relative weight in the star aggregate.' },
            },
            additionalProperties: false,
          },
        },
        reviewers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              email: { type: 'string' },
              role: { type: 'string', enum: ['chair', 'member'] },
            },
            additionalProperties: false,
          },
        },
        rules: {
          type: 'object',
          description:
            'Scope rules: {track: "all"|track option id, form: "all"|form id, format: "all"|format label, level: "all"|level name, status: "active"|"all"|a status}.',
        },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => saveEvaluationPlan(env, auth, str(a.event), a as SaveEvaluationPlanInput),
  },
  {
    name: 'record_evaluation',
    description:
      'RECORD an evaluation (or abstention) on a named reviewer’s behalf. Same guards as the reviewer queue: the reviewer must be a member (not chair) of the plan and assigned to the submission. Scores are FINAL — one evaluation per (plan, submission, reviewer), no edits ever. Scores are keyed by criterion name. Activity-logged; sends no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        planId: { type: 'string', description: 'Plan id (epl_…).' },
        submissionId: { type: 'string', description: 'Submission id (sub_…).' },
        reviewer: { type: 'string', description: 'Reviewer user id or email — whose score this is.' },
        scores: {
          type: 'object',
          description: 'Criterion name → integer (scale), option string (select) or free text. Ignored when abstain=true.',
        },
        note: { type: 'string' },
        abstain: { type: 'boolean', description: 'True records an abstention instead of scores.' },
      },
      required: ['event', 'planId', 'submissionId', 'reviewer'],
      additionalProperties: false,
    },
    run: (env, auth, a) => recordEvaluationApi(env, auth, str(a.event), a as RecordEvaluationInput),
  },
  {
    name: 'remind_evaluators',
    description:
      'EMAIL evaluators with outstanding reviews, immediately (not via the outbox). Defaults to every member reviewer with work left; reviewers with nothing left are skipped and reported. Subject/body default to the event’s saved “reminder” template; {{first_name}} {{remaining}} {{deadline}} {{event_name}} {{evaluate_link}} merge tags work.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        planId: { type: 'string', description: 'Restrict to one plan.' },
        reviewers: { type: 'array', items: { type: 'string' }, description: 'User ids or emails; omit for everyone with work left.' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => remindEvaluators(env, auth, str(a.event), a as RemindEvaluatorsInput),
  },
];
