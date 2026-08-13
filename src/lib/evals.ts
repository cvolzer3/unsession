/**
 * Evaluation mechanics (spec B3). OWNER: B3.
 *
 * Plan membership is computed from the plan's rules on every read — nothing is
 * materialized — exactly like the prototype's `matchesRules`, plus any explicit
 * per-submission includes (`eval_plan_includes`, migration 0014) an organizer
 * added from the submission drawer. Assignment is the prototype's round-robin
 * `assignedFor`, seeded by submission id and capped by `reviews_per`; explicit
 * reviewer pins (`eval_reviewer_pins`, migration 0018) fill a submission's
 * slots ahead of the round-robin. Chairs see everything and score nothing.
 */
import { all, jsonParse, now, one, run } from './db';
import { newId } from './ids';
import { logActivity } from './activity';
import { roleLabel } from './speaker-roles';
import type { Bindings } from '../types';

/* ------------------------------------------------------------------ types */

export type CriterionType = 'scale' | 'select' | 'text';

export type Criterion = {
  name: string;
  hint: string;
  /** 'scale' = numeric rating, 'select' = dropdown, 'text' = free text. */
  type: CriterionType;
  /** Top of the numeric range — scale criteria only. */
  scale: number;
  /** Dropdown choices — select criteria only. */
  options: string[];
  /** Relative weight in the star aggregate — scale criteria only. */
  weight: number;
};

export type Rules = {
  /** 'all' | taxonomy_options.id of the Track taxonomy */
  track: string;
  /** 'all' | forms.id */
  form: string;
  /** 'all' | the format label exactly as stored in answers ("Talk (30 min)") */
  format: string;
  /** 'all' | level name */
  level: string;
  /** 'active' (= in_review, i.e. undecided) | 'all' | a single status */
  status: string;
};

export type Automation = {
  on: boolean;
  minLeft: number;
  d14: boolean;
  d7: boolean;
  d3: boolean;
  over: boolean;
  cooldown: number;
};

export type PlanReviewer = { userId: string; role: 'chair' | 'member'; name: string; email: string };

export type EvalPlan = {
  id: string;
  eventId: string;
  name: string;
  instructions: string;
  /** Date the round opens for review (YYYY-MM-DD). */
  opensAt: string | null;
  deadline: string | null;
  anonymized: boolean;
  reminders: boolean;
  reviewsPer: number;
  rules: Rules;
  criteria: Criterion[];
  automation: Automation;
  createdAt: string;
  reviewers: PlanReviewer[];
  /** Submissions explicitly assigned to this plan, beyond what the rules match. */
  includeIds: string[];
  /** Reviewers explicitly pinned to a submission (submission id → user ids, pin order). */
  pins: Record<string, string[]>;
};

export type EvalSpeaker = { name: string; email: string; bio: string; role: string };

export type EvalSubmission = {
  id: string;
  seq: number;
  displayId: string;
  status: string;
  title: string;
  abstract: string;
  formId: string;
  trackOptionId: string | null;
  trackName: string;
  trackColor: string;
  format: string;
  level: string;
  submittedAt: string | null;
  speakers: EvalSpeaker[];
  answers: Record<string, unknown>;
};

export type Evaluation = {
  id: string;
  planId: string;
  submissionId: string;
  reviewerId: string;
  /** Criterion name → number (scale), option string (select), or free text. */
  scores: Record<string, number | string>;
  note: string;
  abstained: boolean;
  createdAt: string;
};

export type TaxOption = { id: string; name: string; color: string | null; duration: number | null };

export type EvalContext = {
  plans: EvalPlan[];
  submissions: EvalSubmission[];
  evaluations: Evaluation[];
  tracks: TaxOption[];
  formats: string[];
  levels: string[];
  forms: { id: string; name: string }[];
};

export const DEFAULT_AUTOMATION: Automation = {
  on: true,
  minLeft: 1,
  d14: false,
  d7: true,
  d3: true,
  over: true,
  cooldown: 3,
};

export const DEFAULT_CRITERIA: Criterion[] = [
  { name: 'Relevance', hint: 'Fits this audience?', type: 'scale', scale: 5, options: [], weight: 1 },
  { name: 'Depth', hint: 'Substance over hype?', type: 'scale', scale: 5, options: [], weight: 1 },
  { name: 'Delivery', hint: 'Will it land on stage?', type: 'scale', scale: 5, options: [], weight: 1 },
];

export const DEFAULT_RULES: Rules = { track: 'all', form: 'all', format: 'all', level: 'all', status: 'active' };

export const NO_TRACK_COLOR = '#c9cbd3';

/* ---------------------------------------------------------------- loaders */

type PlanRow = {
  id: string;
  event_id: string;
  name: string;
  instructions: string;
  opens_at: string | null;
  deadline: string | null;
  anonymized: number;
  reminders: number;
  reviews_per: number;
  rules_json: string;
  criteria_json: string;
  automation_json: string | null;
  created_at: string;
};

export function normalizeCriteria(raw: unknown): Criterion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c): Criterion => {
      const o = (c ?? {}) as Record<string, unknown>;
      const scale = Number(o.scale);
      const weight = Number(o.weight);
      return {
        name: String(o.name ?? '').trim(),
        hint: String(o.hint ?? ''),
        // Rows saved before criterion types existed carry no `type` — they are scale.
        type: o.type === 'select' || o.type === 'text' ? o.type : 'scale',
        scale: scale === 3 || scale === 5 || scale === 10 ? scale : 5,
        options: Array.isArray(o.options) ? o.options.map((x) => String(x ?? '').trim()).filter(Boolean) : [],
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      };
    })
    .filter((c) => !!c.name && (c.type !== 'select' || c.options.length > 0));
}

function normalizeRules(raw: unknown): Rules {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pick = (k: keyof Rules, fallback: string) => (typeof o[k] === 'string' && o[k] ? String(o[k]) : fallback);
  return {
    track: pick('track', 'all'),
    form: pick('form', 'all'),
    format: pick('format', 'all'),
    level: pick('level', 'all'),
    status: pick('status', 'active'),
  };
}

export function normalizeAutomation(raw: unknown): Automation {
  const o = (raw ?? {}) as Record<string, unknown>;
  const bool = (k: keyof Automation, fallback: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : fallback);
  const num = (k: keyof Automation, fallback: number) => (Number.isFinite(Number(o[k])) ? Number(o[k]) : fallback);
  return {
    on: bool('on', DEFAULT_AUTOMATION.on),
    minLeft: num('minLeft', DEFAULT_AUTOMATION.minLeft),
    d14: bool('d14', DEFAULT_AUTOMATION.d14),
    d7: bool('d7', DEFAULT_AUTOMATION.d7),
    d3: bool('d3', DEFAULT_AUTOMATION.d3),
    over: bool('over', DEFAULT_AUTOMATION.over),
    cooldown: num('cooldown', DEFAULT_AUTOMATION.cooldown),
  };
}

export async function loadPlans(db: D1Database, eventId: string): Promise<EvalPlan[]> {
  const rows = await all<PlanRow>(
    db,
    `SELECT * FROM eval_plans WHERE event_id = ? ORDER BY created_at`,
    eventId
  );
  if (!rows.length) return [];
  const reviewers = await all<{ plan_id: string; user_id: string; role: string; name: string | null; email: string }>(
    db,
    // Insertion order, explicitly: `assignedFor()` round-robins over this list,
    // so an unspecified row order would silently reshuffle who reviews what.
    `SELECT r.plan_id, r.user_id, r.role, u.name, u.email
       FROM eval_plan_reviewers r
       JOIN users u ON u.id = r.user_id
       JOIN eval_plans p ON p.id = r.plan_id
      WHERE p.event_id = ?
      ORDER BY r.rowid`,
    eventId
  );
  const includes = await all<{ plan_id: string; submission_id: string }>(
    db,
    `SELECT i.plan_id, i.submission_id FROM eval_plan_includes i
       JOIN eval_plans p ON p.id = i.plan_id WHERE p.event_id = ?`,
    eventId
  );
  const pins = await all<{ plan_id: string; submission_id: string; user_id: string }>(
    db,
    // Pin order matters: pins fill the first review slots in that order.
    `SELECT n.plan_id, n.submission_id, n.user_id FROM eval_reviewer_pins n
       JOIN eval_plans p ON p.id = n.plan_id WHERE p.event_id = ? ORDER BY n.rowid`,
    eventId
  );
  const pinsByPlan = new Map<string, Record<string, string[]>>();
  for (const n of pins) {
    const bySub = pinsByPlan.get(n.plan_id) ?? {};
    (bySub[n.submission_id] ??= []).push(n.user_id);
    pinsByPlan.set(n.plan_id, bySub);
  }
  return rows.map((p) => ({
    id: p.id,
    eventId: p.event_id,
    name: p.name,
    instructions: p.instructions ?? '',
    opensAt: p.opens_at,
    deadline: p.deadline,
    anonymized: !!p.anonymized,
    reminders: !!p.reminders,
    reviewsPer: p.reviews_per || 1,
    rules: normalizeRules(jsonParse<unknown>(p.rules_json, {})),
    criteria: normalizeCriteria(jsonParse<unknown>(p.criteria_json, [])),
    automation: normalizeAutomation(jsonParse<unknown>(p.automation_json, {})),
    createdAt: p.created_at,
    reviewers: reviewers
      .filter((r) => r.plan_id === p.id)
      .map((r) => ({
        userId: r.user_id,
        role: r.role === 'chair' ? 'chair' : 'member',
        name: r.name || r.email.split('@')[0],
        email: r.email,
      })),
    includeIds: includes.filter((i) => i.plan_id === p.id).map((i) => i.submission_id),
    pins: pinsByPlan.get(p.id) ?? {},
  }));
}

export async function loadTaxonomy(db: D1Database, eventId: string) {
  const rows = await all<{
    tax: string;
    has_color: number;
    has_duration: number;
    id: string;
    name: string;
    color: string | null;
    duration_min: number | null;
  }>(
    db,
    `SELECT t.name AS tax, t.has_color, t.has_duration, o.id, o.name, o.color, o.duration_min
       FROM taxonomies t JOIN taxonomy_options o ON o.taxonomy_id = t.id
      WHERE t.event_id = ? ORDER BY t.position, o.position`,
    eventId
  );
  const pickTax = (name: string, flag?: 'color' | 'duration') =>
    rows.filter(
      (r) =>
        r.tax.toLowerCase() === name ||
        (flag === 'color' && r.has_color === 1 && r.tax.toLowerCase() !== 'format') ||
        (flag === 'duration' && r.has_duration === 1)
    );
  const tracks = (rows.filter((r) => r.tax.toLowerCase() === 'track').length
    ? rows.filter((r) => r.tax.toLowerCase() === 'track')
    : pickTax('track', 'color')
  ).map((r) => ({ id: r.id, name: r.name, color: r.color, duration: r.duration_min }));
  const formatRows = rows.filter((r) => r.tax.toLowerCase() === 'format').length
    ? rows.filter((r) => r.tax.toLowerCase() === 'format')
    : pickTax('format', 'duration');
  const levelRows = rows.filter((r) => r.tax.toLowerCase() === 'level');
  return {
    tracks,
    /** Both the bare option name and the prototype's "Talk (30 min)" label. */
    formatLabels: formatRows.flatMap((r) =>
      r.duration_min ? [r.name, `${r.name} (${r.duration_min} min)`] : [r.name]
    ),
    levels: levelRows.map((r) => r.name),
  };
}

export async function loadSubmissions(db: D1Database, eventId: string): Promise<EvalSubmission[]> {
  const [rows, speakers, tax] = await Promise.all([
    all<{
      id: string;
      seq: number;
      status: string;
      title: string;
      abstract: string;
      form_id: string;
      answers_json: string;
      submitted_at: string | null;
    }>(
      db,
      `SELECT id, seq, status, title, abstract, form_id, answers_json, submitted_at
         FROM submissions WHERE event_id = ? AND status <> 'draft' ORDER BY seq DESC`,
      eventId
    ),
    all<{ submission_id: string; name: string; email: string; bio: string; role: string; position: number }>(
      db,
      `SELECT sp.submission_id, sp.name, sp.email, sp.bio, sp.role, sp.position
         FROM submission_speakers sp JOIN submissions s ON s.id = sp.submission_id
        WHERE s.event_id = ? ORDER BY sp.position`,
      eventId
    ),
    loadTaxonomy(db, eventId),
  ]);

  const trackByName = new Map(tax.tracks.map((t) => [t.name, t]));
  const levelSet = new Set(tax.levels);
  const formatSet = new Set(tax.formatLabels);

  return rows.map((r) => {
    const answers = jsonParse<Record<string, unknown>>(r.answers_json, {});
    let trackName = '';
    let format = '';
    let level = '';
    for (const key of Object.keys(answers)) {
      const v = answers[key];
      if (typeof v !== 'string' || !v) continue;
      if (!trackName && trackByName.has(v)) trackName = v;
      else if (!format && formatSet.has(v)) format = v;
      else if (!level && levelSet.has(v)) level = v;
    }
    const track = trackName ? trackByName.get(trackName)! : null;
    return {
      id: r.id,
      seq: r.seq,
      displayId: `SUB-${r.seq}`,
      status: r.status,
      title: r.title,
      abstract: r.abstract,
      formId: r.form_id,
      trackOptionId: track?.id ?? null,
      trackName: track?.name ?? '—',
      trackColor: track?.color ?? NO_TRACK_COLOR,
      format,
      level,
      submittedAt: r.submitted_at,
      speakers: speakers
        .filter((s) => s.submission_id === r.id)
        .map((s) => ({ name: s.name, email: s.email, bio: s.bio, role: roleLabel(s.role, s.position) })),
      answers,
    };
  });
}

export async function loadEvaluations(db: D1Database, eventId: string): Promise<Evaluation[]> {
  const rows = await all<{
    id: string;
    plan_id: string;
    submission_id: string;
    reviewer_id: string;
    scores_json: string;
    note: string;
    abstained: number;
    created_at: string;
  }>(
    db,
    `SELECT e.* FROM evaluations e JOIN eval_plans p ON p.id = e.plan_id WHERE p.event_id = ?`,
    eventId
  );
  return rows.map((r) => ({
    id: r.id,
    planId: r.plan_id,
    submissionId: r.submission_id,
    reviewerId: r.reviewer_id,
    scores: jsonParse<Record<string, number | string>>(r.scores_json, {}),
    note: r.note ?? '',
    abstained: !!r.abstained,
    createdAt: r.created_at,
  }));
}

export async function loadEvalContext(db: D1Database, eventId: string): Promise<EvalContext> {
  const [plans, submissions, evaluations, tax, forms] = await Promise.all([
    loadPlans(db, eventId),
    loadSubmissions(db, eventId),
    loadEvaluations(db, eventId),
    loadTaxonomy(db, eventId),
    all<{ id: string; name: string }>(db, `SELECT id, name FROM forms WHERE event_id = ? ORDER BY created_at`, eventId),
  ]);
  // Formats/levels offered as rules come from what submissions actually carry,
  // falling back to the taxonomy so an empty event still offers choices.
  const formats = new Set<string>();
  const levels = new Set<string>();
  submissions.forEach((s) => {
    if (s.format) formats.add(s.format);
    if (s.level) levels.add(s.level);
  });
  tax.formatLabels.filter((l) => l.includes('(')).forEach((l) => formats.add(l));
  tax.levels.forEach((l) => levels.add(l));
  return {
    plans,
    submissions,
    evaluations,
    tracks: tax.tracks.map((t) => ({ id: t.id, name: t.name, color: t.color, duration: t.duration })),
    formats: [...formats],
    levels: [...levels],
    forms,
  };
}

/** Evaluator-visible fields of a form version, tolerant of both schema shapes. */
export type VisibleField = { id: string; label: string; type: string };

export async function loadEvaluatorFields(db: D1Database, eventId: string): Promise<Map<string, VisibleField[]>> {
  const rows = await all<{ form_id: string; schema_json: string; version: number }>(
    db,
    `SELECT fv.form_id, fv.schema_json, fv.version FROM form_versions fv
       JOIN forms f ON f.id = fv.form_id WHERE f.event_id = ? ORDER BY fv.version`,
    eventId
  );
  const out = new Map<string, VisibleField[]>();
  rows.forEach((r) => {
    const schema = jsonParse<{ fields?: unknown[] }>(r.schema_json, {});
    const fields = Array.isArray(schema.fields) ? schema.fields : [];
    out.set(
      r.form_id,
      fields
        .map((raw) => {
          const f = (raw ?? {}) as Record<string, unknown>;
          const flags = (f.flags ?? {}) as Record<string, unknown>;
          const visible = typeof flags.evaluatorVisible === 'boolean' ? flags.evaluatorVisible : !!f.eval;
          return visible && f.type !== 'GRP' && f.type !== 'HDR'
            ? { id: String(f.id ?? ''), label: String(f.label ?? ''), type: String(f.type ?? 'TXT') }
            : null;
        })
        .filter((f): f is VisibleField => !!f && !!f.id)
    );
  });
  return out;
}

/**
 * Filenames of everything attached to this event's submissions, by file id —
 * what turns a FILE answer (a list of ids) into a download the reviewer can
 * read. Kept out of `loadEvalContext` so only the screens that render answers
 * pay for the query.
 */
export async function loadSubmissionFileNames(db: D1Database, eventId: string): Promise<Map<string, string>> {
  const rows = await all<{ id: string; filename: string }>(
    db,
    `SELECT id, filename FROM files WHERE event_id = ? AND subject_type = 'submission'`,
    eventId
  );
  return new Map(rows.map((r) => [r.id, r.filename]));
}

/* ------------------------------------------------------------- mechanics */

export function matchesRules(s: EvalSubmission, r: Rules): boolean {
  if (r.track !== 'all' && s.trackOptionId !== r.track) return false;
  if (r.form !== 'all' && s.formId !== r.form) return false;
  if (r.format !== 'all' && s.format !== r.format) return false;
  if (r.level !== 'all' && s.level !== r.level) return false;
  // 'active' = still undecided. Since migration 0011 that is exactly `in_review`;
  // draft never reaches here (loadSubmissions filters it out).
  if (r.status === 'active') return s.status === 'in_review';
  if (r.status !== 'all' && s.status !== r.status) return false;
  return true;
}

export function members(plan: Pick<EvalPlan, 'reviewers'>): PlanReviewer[] {
  return plan.reviewers.filter((r) => r.role !== 'chair');
}

export function effRp(plan: Pick<EvalPlan, 'reviewsPer' | 'reviewers'>): number {
  const m = members(plan).length;
  return Math.max(1, Math.min(plan.reviewsPer, m || 1));
}

export function seedOf(id: string): number {
  let n = 0;
  for (let i = 0; i < id.length; i++) n += id.charCodeAt(i);
  return n;
}

/**
 * Who reviews this submission: pinned reviewers (migration 0018) fill the
 * first slots in pin order, round-robin seeded by submission id (prototype
 * `assignedFor`) fills the rest. Pinning more members than `reviews_per`
 * grows the slot count; a pin whose user left the plan is ignored.
 */
export function assignedFor(
  plan: Pick<EvalPlan, 'reviewsPer' | 'reviewers' | 'pins'>,
  sub: Pick<EvalSubmission, 'id'>
): PlanReviewer[] {
  const sc = members(plan);
  if (!sc.length) return [];
  const out = (plan.pins[sub.id] ?? [])
    .map((uid) => sc.find((r) => r.userId === uid))
    .filter((r): r is PlanReviewer => !!r);
  const slots = Math.max(effRp(plan), out.length);
  const start = seedOf(sub.id) % sc.length;
  for (let i = 0; out.length < slots && i < sc.length; i++) {
    const r = sc[(start + i) % sc.length];
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** Rule match OR explicit include — the plan's live scope. */
export function inPlanScope(plan: EvalPlan, s: EvalSubmission): boolean {
  return matchesRules(s, plan.rules) || plan.includeIds.includes(s.id);
}

export function matchedSubmissions(plan: EvalPlan, subs: EvalSubmission[]): EvalSubmission[] {
  return subs.filter((s) => inPlanScope(plan, s));
}

/**
 * What the plan covers today: everything matching the rules or explicitly
 * assigned, plus anything that already carries an evaluation under this plan
 * (a decision made later must not erase the review record).
 */
export function planSubmissions(plan: EvalPlan, subs: EvalSubmission[], evals: Evaluation[]): EvalSubmission[] {
  const scored = new Set(evals.filter((e) => e.planId === plan.id).map((e) => e.submissionId));
  return subs.filter((s) => inPlanScope(plan, s) || scored.has(s.id));
}

/** The criteria that carry a numeric rating — the only ones aggregates count. */
export function scaleCriteria(criteria: Criterion[]): Criterion[] {
  return criteria.filter((c) => c.type === 'scale');
}

export function cumMaxOf(criteria: Criterion[]): number {
  return scaleCriteria(criteria).reduce((a, c) => a + (Number(c.scale) || 5), 0);
}

export function cumulativeOf(plan: EvalPlan, e: Evaluation): number {
  return scaleCriteria(plan.criteria).reduce((a, c) => a + (Number(e.scores[c.name]) || 0), 0);
}

/** Weighted mean criterion value of one evaluation, normalized to the 1–5 star scale. */
export function starAvgOf(plan: EvalPlan, e: Evaluation): number | null {
  const vals = scaleCriteria(plan.criteria)
    .map((c) => ({ v: Number(e.scores[c.name]), scale: Number(c.scale) || 5, w: Number(c.weight) > 0 ? Number(c.weight) : 1 }))
    .filter((x) => Number.isFinite(x.v) && x.v > 0);
  if (!vals.length) return null;
  const wSum = vals.reduce((a, x) => a + x.w, 0);
  return vals.reduce((a, x) => a + x.w * (x.v / x.scale) * 5, 0) / wSum;
}

export type PlanProgress = { done: number; total: number; pct: number };

export function planProgress(plan: EvalPlan, subs: EvalSubmission[], evals: Evaluation[]): PlanProgress {
  const list = planSubmissions(plan, subs, evals);
  let total = 0;
  let done = 0;
  list.forEach((s) => {
    // Per submission, not a flat reviews_per: pins can grow a slot count.
    const slots = assignedFor(plan, s).length || effRp(plan);
    const n = evals.filter((e) => e.planId === plan.id && e.submissionId === s.id && !e.abstained).length;
    total += slots;
    done += Math.min(n, slots);
  });
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

export function avgCumulative(plan: EvalPlan, subs: EvalSubmission[], evals: Evaluation[]): number | null {
  const cums: number[] = [];
  planSubmissions(plan, subs, evals).forEach((s) => {
    const list = evals.filter((e) => e.planId === plan.id && e.submissionId === s.id && !e.abstained);
    if (!list.length) return;
    cums.push(list.reduce((a, e) => a + cumulativeOf(plan, e), 0) / list.length);
  });
  return cums.length ? cums.reduce((a, b) => a + b, 0) / cums.length : null;
}

export type SubmissionScore = {
  /** 1–5 star average across every evaluation of this submission, any plan. */
  avg: number | null;
  /** Evaluations in (non-abstained). */
  n: number;
  /** Expected evaluations across the plans this submission belongs to. */
  expected: number;
  remaining: number;
};

export function submissionScore(
  sub: EvalSubmission,
  plans: EvalPlan[],
  subs: EvalSubmission[],
  evals: Evaluation[]
): SubmissionScore {
  let expected = 0;
  let n = 0;
  const stars: number[] = [];
  plans.forEach((p) => {
    if (!planSubmissions(p, subs, evals).some((s) => s.id === sub.id)) return;
    expected += assignedFor(p, sub).length || effRp(p);
    evals
      .filter((e) => e.planId === p.id && e.submissionId === sub.id && !e.abstained)
      .forEach((e) => {
        n += 1;
        const st = starAvgOf(p, e);
        if (st != null) stars.push(st);
      });
  });
  return {
    avg: stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : null,
    n,
    expected,
    remaining: Math.max(0, expected - n),
  };
}

export type ReviewerLoad = { load: number; done: number; remaining: number };

/** How much work a member has in one plan. Chairs have no queue. */
export function reviewerLoad(
  plan: EvalPlan,
  userId: string,
  subs: EvalSubmission[],
  evals: Evaluation[]
): ReviewerLoad {
  const rev = plan.reviewers.find((r) => r.userId === userId);
  if (!rev || rev.role === 'chair') return { load: 0, done: 0, remaining: 0 };
  let load = 0;
  let done = 0;
  matchedSubmissions(plan, subs).forEach((s) => {
    if (!assignedFor(plan, s).some((r) => r.userId === userId)) return;
    load += 1;
    if (evals.some((e) => e.planId === plan.id && e.submissionId === s.id && e.reviewerId === userId)) done += 1;
  });
  return { load, done, remaining: load - done };
}

export type QueueItem = { plan: EvalPlan; submission: EvalSubmission; done: boolean; evaluation: Evaluation | null };

/** Everything assigned to one reviewer across the plans they sit on. */
export function reviewerQueue(
  plans: EvalPlan[],
  subs: EvalSubmission[],
  evals: Evaluation[],
  userId: string
): QueueItem[] {
  const out: QueueItem[] = [];
  plans.forEach((plan) => {
    const rev = plan.reviewers.find((r) => r.userId === userId);
    if (!rev || rev.role === 'chair') return;
    matchedSubmissions(plan, subs).forEach((s) => {
      if (!assignedFor(plan, s).some((r) => r.userId === userId)) return;
      const ev = evals.find((e) => e.planId === plan.id && e.submissionId === s.id && e.reviewerId === userId) ?? null;
      out.push({ plan, submission: s, done: !!ev, evaluation: ev });
    });
  });
  // Anything already scored but no longer matching the rules stays visible as reviewed.
  evals
    .filter((e) => e.reviewerId === userId)
    .forEach((e) => {
      if (out.some((q) => q.plan.id === e.planId && q.submission.id === e.submissionId)) return;
      const plan = plans.find((p) => p.id === e.planId);
      const sub = subs.find((s) => s.id === e.submissionId);
      if (plan && sub) out.push({ plan, submission: sub, done: true, evaluation: e });
    });
  return out;
}

/* ------------------------------------------------------------------ write */

export type ScoreInput = {
  planId: string;
  submissionId: string;
  reviewerId: string;
  scores: Record<string, number | string>;
  note: string;
  abstained: boolean;
};

/** Scores are final: one row per (plan, submission, reviewer), never updated. */
export async function recordEvaluation(db: D1Database, input: ScoreInput): Promise<{ ok: boolean; error?: string }> {
  const existing = await one<{ id: string }>(
    db,
    `SELECT id FROM evaluations WHERE plan_id = ? AND submission_id = ? AND reviewer_id = ?`,
    input.planId,
    input.submissionId,
    input.reviewerId
  );
  if (existing) return { ok: false, error: 'You already submitted a score for this one — scores are final.' };
  await run(
    db,
    `INSERT INTO evaluations (id, plan_id, submission_id, reviewer_id, scores_json, note, abstained, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    newId('evl'),
    input.planId,
    input.submissionId,
    input.reviewerId,
    JSON.stringify(input.scores),
    input.note,
    input.abstained ? 1 : 0,
    now()
  );
  return { ok: true };
}

/* ----------------------------------------------------------------- format */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}`;
}

export function daysUntil(iso: string | null | undefined, from = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(`${iso.slice(0, 10)}T09:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.round((t - from.getTime()) / 86_400_000);
}

/** Merge tags fill in per recipient; both `{tag}` and `{{tag}}` are accepted. */
export function mergeTags(str: string, vars: Record<string, string>): string {
  return (str || '').replace(/\{\{?\s*([\w.]+)\s*\}?\}/g, (whole, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? whole : String(v);
  });
}

export function initialsOfName(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
