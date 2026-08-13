/**
 * Task engine (spec §4.8 + `prototype/design_handoff_program/specs/tasks-spec.md`).
 *
 * One task system, four types (checkbox · file · form · profile), two targets
 * (speaker profile · session), one assignment mechanism (rules + manual).
 * Organizers author **templates**; this module stamps out **instances** when a
 * trigger fires or an organizer assigns manually, and owns every state
 * transition (Open → Pending review → Done, plus cancellation on withdrawal).
 *
 * `src/lib/confirm.ts` and the decision engine call `generateTasksOnTrigger`;
 * `routes/public-portal.tsx` calls the completion helpers; `routes/admin-speakers.tsx`
 * calls the assignment / review helpers. Keep the two exported signatures
 * `generateTasksOnTrigger` / `cancelOpenTasks` stable — foundation code imports them.
 */
import { all, one, run, now, jsonParse } from './db';
import { newId } from './ids';
import { logActivity } from './activity';
import { sendEmail, renderTemplate } from './email';
import { ensureSpeakerProfiles } from './sessions-core';
import type { Bindings } from '../types';

/* ------------------------------------------------------------------ types */

export type TaskTrigger = 'acceptance' | 'confirmation';
export type TemplateTrigger = TaskTrigger | 'manual';
export type TaskType = 'checkbox' | 'file' | 'form' | 'profile';
export type TaskTargetKind = 'speaker' | 'session';
/** open → (pending_review) → done. `cancelled` is withdrawal-only. */
export type TaskStatus = 'open' | 'pending_review' | 'done' | 'cancelled';

export type DueSpec = { mode: 'after' | 'before' | 'abs'; n: number; date?: string | null };
export type GraceSpec = { mode: 'none' | 'lock'; days: number };
export type ClauseSpec = { field: string; value: string };
export type ReminderSpec = { on: boolean; days: number[]; subject: string; body: string };

export type MiniField = {
  id: string;
  type: 'TXT' | 'LONG' | 'SEL' | 'CHK' | 'DATE';
  label: string;
  required?: boolean;
  placeholder?: string;
  opts?: string[];
};
export type MiniForm = { name: string; fields: MiniField[] };

export type TaskSettings = {
  /** checkbox */
  link?: string;
  /** file */
  ext?: string;
  capMb?: number;
  cap?: string;
  maxFiles?: number;
  sampleFileId?: string | null;
  sampleFileName?: string | null;
  sampleFile?: string | null;
  review?: boolean;
  /** form — a built-in name or an inline {name, fields[]} spec */
  formSpec?: string | MiniForm;
};

export type TaskTemplateRow = {
  id: string;
  event_id: string;
  name: string;
  description: string;
  type: TaskType;
  target: TaskTargetKind;
  settings_json: string;
  required: number;
  lock_on_complete: number;
  due_json: string;
  grace_json: string | null;
  trigger: TemplateTrigger;
  clauses_json: string;
  reminders_json: string;
  archived: number;
  created_at: string;
  /** Stable machine key for built-ins (migration 0008) — e.g. 'confirm_participation'. */
  builtin_key?: string | null;
};

export type TaskRow = {
  id: string;
  event_id: string;
  template_id: string | null;
  one_off_json: string | null;
  target_type: TaskTargetKind;
  speaker_profile_id: string | null;
  session_id: string | null;
  status: TaskStatus;
  due_date: string | null;
  completed_by: string | null;
  completed_at: string | null;
  review_note: string | null;
  response_json: string | null;
  /** Wording pinned at the last template edit — see migration 0006. */
  snapshot_json?: string | null;
  created_at: string;
};

/** What an instance showed before its template was last edited. */
export type TaskSnapshot = { name?: string; description?: string };

export function snapshotOf(t: { snapshot_json?: string | null }): TaskSnapshot | null {
  return jsonParse<TaskSnapshot | null>(t.snapshot_json ?? null, null);
}

export type OneOffSpec = { name: string; type: TaskType; due?: string | null };

/* ------------------------------------------------------------------ dates */

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(dateISO: string, n: number): string {
  const [y, m, d] = dateISO.slice(0, 10).split('-').map(Number);
  const t = Date.UTC(y, (m || 1) - 1, d || 1) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toISO.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/* --------------------------------------------------------------- parsing */

export const DEFAULT_DUE: DueSpec = { mode: 'before', n: 14, date: null };
export const DEFAULT_GRACE: GraceSpec = { mode: 'none', days: 3 };

export function parseDue(t: { due_json: string }): DueSpec {
  const d = jsonParse<Partial<DueSpec>>(t.due_json, {});
  const mode = d.mode === 'after' || d.mode === 'abs' ? d.mode : 'before';
  return { mode, n: Number(d.n ?? DEFAULT_DUE.n) || 0, date: d.date ?? null };
}

export function parseGrace(t: { grace_json: string | null }): GraceSpec {
  const g = jsonParse<Partial<GraceSpec>>(t.grace_json, {});
  return { mode: g.mode === 'lock' ? 'lock' : 'none', days: Number(g.days ?? DEFAULT_GRACE.days) || 0 };
}

export function parseClauses(t: { clauses_json: string }): ClauseSpec[] {
  const raw = jsonParse<ClauseSpec[]>(t.clauses_json, []);
  return Array.isArray(raw) ? raw.filter((c) => c && typeof c.field === 'string') : [];
}

export function parseSettings(t: { settings_json: string }): TaskSettings {
  return jsonParse<TaskSettings>(t.settings_json, {});
}

export const REM_SUBJ = 'Reminder: “{{task_name}}” is due {{due_date}}';
export const REM_BODY =
  'Hi {{speaker_name}},\n\nA quick reminder that “{{task_name}}” for {{event_name}} is due {{due_date}} — {{days_left}} to go.\n\nEverything you need is in your speaker portal:\n{{portal_link}}\n\nAlready done? Reminders stop automatically once a task is complete, so you can ignore this.\n\n— The {{event_name}} program team';

export function parseReminders(t: { reminders_json: string }): ReminderSpec {
  const r = jsonParse<Partial<ReminderSpec>>(t.reminders_json, {});
  return {
    on: r.on !== false,
    days: Array.isArray(r.days) ? r.days.map(Number).filter((n) => Number.isFinite(n)) : [7, 2],
    subject: r.subject || REM_SUBJ,
    body: r.body || REM_BODY,
  };
}

/** Size cap in MB — the editor writes `capMb`, the sandbox seed writes either. */
export function capMbOf(s: TaskSettings): number {
  if (typeof s.capMb === 'number' && s.capMb > 0) return s.capMb;
  const m = /(\d+)/.exec(String(s.cap ?? ''));
  return m ? Number(m[1]) : 100;
}

export function capLabel(s: TaskSettings): string {
  return `${capMbOf(s)} MB`;
}

export function sampleNameOf(s: TaskSettings): string {
  return (s.sampleFileName || s.sampleFile || '') as string;
}

/* --------------------------------------------------------- mini-forms */

/** The three built-ins offered by the template editor's mini-form select. */
export const MINI_FORMS: Record<string, MiniForm> = {
  'AV requirements (mini-form)': {
    name: 'AV requirements (mini-form)',
    fields: [
      {
        id: 'av_needs',
        type: 'LONG',
        label: 'What do you need on stage?',
        required: true,
        placeholder: 'Mics, second screen, power strips, network…',
      },
      {
        id: 'av_machine',
        type: 'SEL',
        label: 'Presenting from your own machine?',
        required: true,
        opts: ['Yes — my own laptop', 'No — use the house machine'],
      },
    ],
  },
  'Travel details (mini-form)': {
    name: 'Travel details (mini-form)',
    fields: [
      { id: 'tv_airport', type: 'TXT', label: 'Departure airport', required: true, placeholder: 'e.g. LHR' },
      { id: 'tv_arrive', type: 'DATE', label: 'Arrival date', required: true },
      { id: 'tv_depart', type: 'DATE', label: 'Departure date', required: true },
      { id: 'tv_diet', type: 'TXT', label: 'Dietary requirements', placeholder: 'Vegetarian, allergies…' },
      {
        id: 'tv_notes',
        type: 'LONG',
        label: 'Anything else we should know?',
        placeholder: 'Accessibility needs, arriving late, travelling with a companion…',
      },
    ],
  },
  'Session details confirmation (mini-form)': {
    name: 'Session details confirmation (mini-form)',
    fields: [
      {
        id: 'sd_ok',
        type: 'CHK',
        label: 'The title and abstract on the public agenda are correct',
        required: true,
      },
    ],
  },
};

export const MINI_FORM_NAMES = Object.keys(MINI_FORMS);

/** Resolve a template's `settings.formSpec` (built-in name or inline spec). */
export function formSpecOf(s: TaskSettings): MiniForm {
  const spec = s.formSpec;
  if (spec && typeof spec === 'object' && Array.isArray(spec.fields)) {
    return { name: spec.name || 'Mini-form', fields: spec.fields };
  }
  if (typeof spec === 'string' && MINI_FORMS[spec]) return MINI_FORMS[spec];
  return MINI_FORMS['AV requirements (mini-form)'];
}

/* ----------------------------------------------------- prototype copy */

/** Ported verbatim from `Speakers.dc.html` `dueDesc`. */
export function dueDesc(t: TaskTemplateRow): string {
  if (t.type === 'profile') return 'auto-completes when required fields are filled';
  const due = parseDue(t);
  const grace = parseGrace(t);
  const s = parseSettings(t);
  const rem = parseReminders(t);
  return (
    (due.mode === 'after'
      ? `due ${due.n} days after assignment`
      : due.mode === 'before'
        ? `due ${due.n} days before event`
        : `due ${due.date ?? '—'}`) +
    (grace.mode === 'lock' ? ` · locks ${grace.days}d past due` : '') +
    (t.type === 'file' ? ` · ${s.ext || 'any file'}, ${capLabel(s)}` : '') +
    (s.review ? ' · review' : '') +
    (t.lock_on_complete ? ' · locks on complete' : '') +
    (rem.on && rem.days.length
      ? ' · reminds ' +
        [...rem.days]
          .sort((a, b) => b - a)
          .map((nn) => (nn === 0 ? 'day-of' : nn + 'd before'))
          .join(', ')
      : ' · no reminders')
  );
}

/** Ported verbatim from `Speakers.dc.html` `ruleDesc`. */
export function ruleDesc(t: TaskTemplateRow): string {
  if (t.archived) return 'archived';
  if (t.trigger === 'manual') return 'manual assignment only';
  const clauses = parseClauses(t);
  return (
    `on ${t.trigger}` +
    (clauses.length
      ? ' · when ' +
        clauses.map((c) => `${c.field === 'Form answer' ? '' : c.field + ' = '}${c.value}`).join(' & ')
      : '')
  );
}

export const TYPE_LABEL: Record<TaskType, string> = {
  checkbox: 'CHECK',
  file: 'FILE',
  form: 'FORM',
  profile: 'AUTO',
};

/* ------------------------------------------------------------ due dates */

/** Instance due date, computed once at assignment (§4.8.4). */
export function computeDueDate(due: DueSpec, eventStart: string, assignedOn = todayISO()): string | null {
  if (due.mode === 'abs') return due.date ? due.date.slice(0, 10) : null;
  if (due.mode === 'after') return addDays(assignedOn, due.n);
  return addDays(eventStart, -due.n);
}

export function isOverdue(task: { status: string; due_date: string | null }, today = todayISO()): boolean {
  if (task.status !== 'open' && task.status !== 'pending_review') return false;
  return !!task.due_date && task.due_date < today;
}

/** Grid cell code: c = done · r = pending review · o = overdue · p = to do. */
export function cellState(task: { status: string; due_date: string | null }, today = todayISO()): 'c' | 'r' | 'o' | 'p' {
  if (task.status === 'done') return 'c';
  if (task.status === 'pending_review') return 'r';
  return isOverdue(task, today) ? 'o' : 'p';
}

type TaskIdentity = {
  id: string;
  template_id: string | null;
  session_id: string | null;
  speaker_profile_id: string | null;
  status: string;
};

/** Identity of a task instance: one per (template, session) or (template, speaker). */
export function taskKey(t: TaskIdentity): string {
  if (!t.template_id) return `one:${t.id}`;
  return t.session_id ? `s:${t.template_id}:${t.session_id}` : `p:${t.template_id}:${t.speaker_profile_id}`;
}

const STATUS_RANK: Record<string, number> = { done: 3, pending_review: 2, open: 1, cancelled: 0 };

/**
 * Collapse duplicate instances of the same logical task. A session task belongs
 * to the session, not to each co-speaker — the sandbox seed stamps one row per
 * speaker, and an organizer can assign a session template from two different
 * speakers, so both the grid and the portal fold them into one (keeping the
 * furthest-along status, which is how "any co-speaker can complete it" reads).
 */
export function dedupeTasks<TT extends TaskIdentity>(tasks: TT[]): TT[] {
  const byKey = new Map<string, TT>();
  for (const t of tasks) {
    const key = taskKey(t);
    const prev = byKey.get(key);
    if (!prev || (STATUS_RANK[t.status] ?? 0) > (STATUS_RANK[prev.status] ?? 0)) byKey.set(key, t);
  }
  return [...byKey.values()];
}

/** Past due + past the grace window on a locking template = no longer completable. */
export function isGraceLocked(task: { due_date: string | null }, grace: GraceSpec, today = todayISO()): boolean {
  if (grace.mode !== 'lock' || !task.due_date) return false;
  return today > addDays(task.due_date, grace.days);
}

/* ------------------------------------------------------- clause matching */

type SubmissionFacts = {
  track: string | null;
  format: string | null;
  level: string | null;
  /** answers keyed by field id, plus the field labels of the pinned form version */
  answers: Record<string, unknown>;
  labels: Record<string, string>;
};

function textOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/** Loose equality: "Talk (30 min)" matches the taxonomy option "Talk". */
function looseMatch(actual: string, expected: string): boolean {
  const a = actual.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  if (!b) return false;
  if (a === b) return true;
  const stripped = a.replace(/\s*\(.+\)\s*$/, '');
  return stripped === b || a.includes(b) || b.includes(a);
}

type TaxOption = { name: string; taxonomy: string };

/** First answer that loosely matches one of the taxonomy's options. */
function pickOption(options: TaxOption[], taxonomy: string, answers: Record<string, unknown>): string | null {
  const pool = options.filter((o) => o.taxonomy === taxonomy);
  for (const value of Object.values(answers)) {
    const s = textOf(value);
    if (!s) continue;
    const hit = pool.find((o) => looseMatch(s, o.name));
    if (hit) return hit.name;
  }
  return null;
}

async function submissionFacts(
  env: Bindings,
  sub: { id: string; event_id: string; answers_json: string; form_version_id: string | null }
): Promise<SubmissionFacts> {
  const answers = jsonParse<Record<string, unknown>>(sub.answers_json, {});
  const options = await all<TaxOption>(
    env.DB,
    `SELECT o.name AS name, t.name AS taxonomy
       FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
      WHERE t.event_id = ?`,
    sub.event_id
  );
  const pick = (taxonomy: string): string | null => pickOption(options, taxonomy, answers);
  // A session (created on accept) carries the resolved options — prefer them.
  const session = await one<{ track: string | null; format: string | null; level: string | null }>(
    env.DB,
    `SELECT tr.name AS track, fo.name AS format, s.level AS level
       FROM sessions s
       LEFT JOIN taxonomy_options tr ON tr.id = s.track_option_id
       LEFT JOIN taxonomy_options fo ON fo.id = s.format_option_id
      WHERE s.submission_id = ? LIMIT 1`,
    sub.id
  );

  const labels: Record<string, string> = {};
  if (sub.form_version_id) {
    const fv = await one<{ schema_json: string }>(
      env.DB,
      `SELECT schema_json FROM form_versions WHERE id = ?`,
      sub.form_version_id
    );
    const schema = jsonParse<{ fields?: { id: string; label: string }[] }>(fv?.schema_json, {});
    for (const f of schema.fields ?? []) labels[f.id] = f.label ?? '';
  }

  return {
    track: session?.track ?? pick('Track'),
    format: session?.format ?? pick('Format'),
    level: session?.level ?? pick('Level'),
    answers,
    labels,
  };
}

/**
 * Clause semantics, kept as loose as the prototype:
 * - Track / Format / Level compare against the submission's resolved option.
 * - "Form answer" takes a free-text `Field label = value` and substring-matches
 *   the label against the form schema and the value against the answer.
 */
export function clauseMatches(clause: ClauseSpec, facts: SubmissionFacts): boolean {
  const want = (clause.value ?? '').trim();
  if (!want) return true;
  if (clause.field === 'Track') return !!facts.track && looseMatch(facts.track, want);
  if (clause.field === 'Format') return !!facts.format && looseMatch(facts.format, want);
  if (clause.field === 'Level') return !!facts.level && looseMatch(facts.level, want);

  const eq = want.indexOf('=');
  const labelPart = (eq >= 0 ? want.slice(0, eq) : '').trim().toLowerCase();
  const valuePart = (eq >= 0 ? want.slice(eq + 1) : want).trim().toLowerCase();
  if (!valuePart) return false;

  const entries = Object.entries(facts.answers);
  const scoped = labelPart
    ? entries.filter(([id]) => (facts.labels[id] ?? id).toLowerCase().includes(labelPart))
    : entries;
  const pool = scoped.length ? scoped : labelPart ? [] : entries;
  return pool.some(([, v]) => textOf(v).toLowerCase().includes(valuePart));
}

export function templateMatches(t: TaskTemplateRow, facts: SubmissionFacts): boolean {
  return parseClauses(t).every((c) => clauseMatches(c, facts));
}

/* ------------------------------------------------------ rule match preview */

export type TemplateMatchPreview = {
  /** Distinct existing speaker profiles on matching submissions. */
  speakers: number;
  /** Distinct sessions on matching submissions. */
  sessions: number;
  speakerIds: string[];
  /** Matching speakers with no session — session-target assignment skips them. */
  noSessionIds: string[];
};

const EMPTY_MATCH: TemplateMatchPreview = { speakers: 0, sessions: 0, speakerIds: [], noSessionIds: [] };

/**
 * Who would an assignment rule reach if its trigger fired for everyone right
 * now? Powers the editor's live match line and the post-create "N existing
 * speakers match — assign now?" offer. Read-only: never creates profiles or
 * instances, and loads everything in a fixed handful of queries (the free
 * plan meters subrequests, so no per-submission lookups here).
 */
export async function previewTemplateMatch(
  env: Bindings,
  eventId: string,
  spec: { trigger: TemplateTrigger; clauses: ClauseSpec[] }
): Promise<TemplateMatchPreview> {
  if (spec.trigger === 'manual') return EMPTY_MATCH;
  // Both triggers start from `accepted`; the confirmation trigger additionally
  // requires the speaker to have confirmed, which is the SESSION's state
  // (migration 0011) — the submission stays `accepted` throughout.
  const confirmedOnly = spec.trigger !== 'acceptance';
  const subs = await all<{ id: string; answers_json: string; form_version_id: string | null }>(
    env.DB,
    `SELECT s.id, s.answers_json, s.form_version_id FROM submissions s
      WHERE s.event_id = ? AND s.status = 'accepted'${
        confirmedOnly
          ? ` AND EXISTS (SELECT 1 FROM sessions se WHERE se.submission_id = s.id AND se.status = 'confirmed')`
          : ''
      }`,
    eventId
  );
  if (!subs.length) return EMPTY_MATCH;

  const clauses = (spec.clauses ?? []).filter((c) => c && typeof c.field === 'string');
  const options = await all<TaxOption>(
    env.DB,
    `SELECT o.name AS name, t.name AS taxonomy
       FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
      WHERE t.event_id = ?`,
    eventId
  );
  const sessions = await all<{
    id: string;
    submission_id: string | null;
    track: string | null;
    format: string | null;
    level: string | null;
  }>(
    env.DB,
    `SELECT s.id, s.submission_id, tr.name AS track, fo.name AS format, s.level AS level
       FROM sessions s
       LEFT JOIN taxonomy_options tr ON tr.id = s.track_option_id
       LEFT JOIN taxonomy_options fo ON fo.id = s.format_option_id
      WHERE s.event_id = ?`,
    eventId
  );
  const sessionBySub = new Map<string, (typeof sessions)[number]>();
  for (const s of sessions) if (s.submission_id) sessionBySub.set(s.submission_id, s);

  const speakerRows = await all<{ submission_id: string; profile_id: string }>(
    env.DB,
    `SELECT ss.submission_id AS submission_id, sp.id AS profile_id
       FROM submission_speakers ss
       JOIN submissions s ON s.id = ss.submission_id
       JOIN speaker_profiles sp ON sp.event_id = s.event_id AND sp.email = ss.email COLLATE NOCASE
      WHERE s.event_id = ?`,
    eventId
  );
  const speakersBySub = new Map<string, string[]>();
  for (const r of speakerRows) {
    const list = speakersBySub.get(r.submission_id) ?? [];
    list.push(r.profile_id);
    speakersBySub.set(r.submission_id, list);
  }

  // Form-field labels only matter to "Form answer = …" clauses with a label part.
  const needsLabels = clauses.some((c) => c.field !== 'Track' && c.field !== 'Format' && c.field !== 'Level');
  const fvIds = [...new Set(subs.map((s) => s.form_version_id).filter(Boolean))] as string[];
  const labelsByFv = new Map<string, Record<string, string>>();
  if (needsLabels && fvIds.length) {
    const fvs = await all<{ id: string; schema_json: string }>(
      env.DB,
      `SELECT id, schema_json FROM form_versions WHERE id IN (${fvIds.map(() => '?').join(',')})`,
      ...fvIds
    );
    for (const fv of fvs) {
      const schema = jsonParse<{ fields?: { id: string; label: string }[] }>(fv.schema_json, {});
      const labels: Record<string, string> = {};
      for (const f of schema.fields ?? []) labels[f.id] = f.label ?? '';
      labelsByFv.set(fv.id, labels);
    }
  }

  const linked = new Set(
    (
      await all<{ speaker_profile_id: string }>(
        env.DB,
        `SELECT DISTINCT ss.speaker_profile_id FROM session_speakers ss
           JOIN sessions s ON s.id = ss.session_id WHERE s.event_id = ?`,
        eventId
      )
    ).map((r) => r.speaker_profile_id)
  );

  const speakerIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const sub of subs) {
    const answers = jsonParse<Record<string, unknown>>(sub.answers_json, {});
    const session = sessionBySub.get(sub.id);
    const facts: SubmissionFacts = {
      track: session?.track ?? pickOption(options, 'Track', answers),
      format: session?.format ?? pickOption(options, 'Format', answers),
      level: session?.level ?? pickOption(options, 'Level', answers),
      answers,
      labels: (sub.form_version_id && labelsByFv.get(sub.form_version_id)) || {},
    };
    if (!clauses.every((c) => clauseMatches(c, facts))) continue;
    if (session) sessionIds.add(session.id);
    for (const pid of speakersBySub.get(sub.id) ?? []) speakerIds.add(pid);
  }
  const ids = [...speakerIds];
  return {
    speakers: ids.length,
    sessions: sessionIds.size,
    speakerIds: ids,
    noSessionIds: ids.filter((id) => !linked.has(id)),
  };
}

/* ------------------------------------------------------- instance stamping */

async function instanceExists(
  env: Bindings,
  templateId: string,
  target: { speakerProfileId?: string | null; sessionId?: string | null }
): Promise<boolean> {
  const row = target.sessionId
    ? await one(
        env.DB,
        `SELECT 1 FROM tasks WHERE template_id = ? AND session_id = ? AND status != 'cancelled'`,
        templateId,
        target.sessionId
      )
    : await one(
        env.DB,
        `SELECT 1 FROM tasks WHERE template_id = ? AND speaker_profile_id = ? AND session_id IS NULL AND status != 'cancelled'`,
        templateId,
        target.speakerProfileId ?? ''
      );
  return !!row;
}

export type StampResult = { id: string; created: boolean; dueDate: string | null };

/** Create one instance of `template` for one target. Idempotent per (template, target). */
export async function stampInstance(
  env: Bindings,
  opts: {
    template: TaskTemplateRow;
    eventStart: string;
    speakerProfileId?: string | null;
    sessionId?: string | null;
    actor: string;
    detail?: string;
  }
): Promise<StampResult | null> {
  const { template } = opts;
  if (await instanceExists(env, template.id, { speakerProfileId: opts.speakerProfileId, sessionId: opts.sessionId })) {
    return null;
  }
  const due = computeDueDate(parseDue(template), opts.eventStart);
  const id = newId('tsi');
  await run(
    env.DB,
    `INSERT INTO tasks (id, event_id, template_id, one_off_json, target_type, speaker_profile_id, session_id,
       status, due_date, completed_by, completed_at, review_note, response_json, created_at)
     VALUES (?,?,?,NULL,?,?,?,'open',?,NULL,NULL,NULL,NULL,?)`,
    id,
    template.event_id,
    template.id,
    template.target,
    opts.speakerProfileId ?? null,
    opts.sessionId ?? null,
    due,
    now()
  );
  await logActivity(env.DB, {
    eventId: template.event_id,
    subjectType: 'task',
    subjectId: id,
    actor: opts.actor,
    action: 'Task assigned',
    detail: `“${template.name}”${opts.detail ? ` → ${opts.detail}` : ''}${due ? ` · due ${due}` : ''}`,
  });
  return { id, created: true, dueDate: due };
}

/** One-off task (no template, not reusable) — §4.8.5 manual entry point. */
export async function stampOneOff(
  env: Bindings,
  opts: { eventId: string; speakerProfileId: string; spec: OneOffSpec; actor: string; speakerName?: string }
): Promise<string> {
  const id = newId('tsi');
  await run(
    env.DB,
    `INSERT INTO tasks (id, event_id, template_id, one_off_json, target_type, speaker_profile_id, session_id,
       status, due_date, completed_by, completed_at, review_note, response_json, created_at)
     VALUES (?,?,NULL,?,'speaker',?,NULL,'open',?,NULL,NULL,NULL,NULL,?)`,
    id,
    opts.eventId,
    JSON.stringify(opts.spec),
    opts.speakerProfileId,
    opts.spec.due || null,
    now()
  );
  await logActivity(env.DB, {
    eventId: opts.eventId,
    subjectType: 'task',
    subjectId: id,
    actor: opts.actor,
    action: 'One-off task assigned',
    detail: `“${opts.spec.name}”${opts.speakerName ? ` → ${opts.speakerName}` : ''}`,
  });
  return id;
}

/* ------------------------------------------------------------- generation */

type SubRow = {
  id: string;
  event_id: string;
  status: string;
  title: string;
  answers_json: string;
  form_version_id: string | null;
};

type EventRow = { id: string; name: string; slug: string; start_date: string };

/**
 * Rule-based assignment (§4.8.5). Evaluated on state change only — never
 * retroactively. Speaker-target templates stamp one instance per submission
 * speaker (profiles created from `submission_speakers` when missing);
 * session-target templates stamp one instance for the submission's session.
 */
export async function generateTasksOnTrigger(
  env: Bindings,
  opts: { submissionId: string; trigger: TaskTrigger; actor?: string }
): Promise<{ created: number; skippedNoSession: number }> {
  const none = { created: 0, skippedNoSession: 0 };
  const actor = opts.actor || 'System';
  const sub = await one<SubRow>(
    env.DB,
    `SELECT id, event_id, status, title, answers_json, form_version_id FROM submissions WHERE id = ?`,
    opts.submissionId
  );
  if (!sub) return none;
  const event = await one<EventRow>(
    env.DB,
    `SELECT id, name, slug, start_date FROM events WHERE id = ?`,
    sub.event_id
  );
  if (!event) return none;

  const templates = await all<TaskTemplateRow>(
    env.DB,
    `SELECT * FROM task_templates WHERE event_id = ? AND archived = 0 AND trigger = ? ORDER BY created_at`,
    sub.event_id,
    opts.trigger
  );
  if (!templates.length) return none;

  const facts = await submissionFacts(env, sub);
  const matching = templates.filter((t) => templateMatches(t, facts));
  if (!matching.length) return none;

  const speakers = await all<{
    id: string;
    name: string;
    email: string;
    bio: string;
    job_title: string;
    company: string;
    tagline: string;
    links_json: string | null;
    headshot_file_id: string | null;
    user_id: string | null;
    position: number;
  }>(env.DB, `SELECT * FROM submission_speakers WHERE submission_id = ? ORDER BY position`, sub.id);
  const profileIds = await ensureSpeakerProfiles(env, sub.event_id, speakers);
  const profiles = profileIds.length
    ? await all<{ id: string; name: string; email: string }>(
        env.DB,
        `SELECT id, name, email FROM speaker_profiles WHERE id IN (${profileIds.map(() => '?').join(',')})`,
        ...profileIds
      )
    : [];

  const session = await one<{ id: string; title: string }>(
    env.DB,
    `SELECT id, title FROM sessions WHERE submission_id = ? LIMIT 1`,
    sub.id
  );

  let created = 0;
  /** Session-target templates that matched but had no session to attach to. */
  let skippedNoSession = 0;
  /** profile id → task names created in this batch (for the assignment digest) */
  const digest = new Map<string, string[]>();
  const noteFor = (pid: string, name: string) => {
    const list = digest.get(pid) ?? [];
    list.push(name);
    digest.set(pid, list);
  };

  for (const template of matching) {
    if (template.target === 'session') {
      if (!session) {
        skippedNoSession++;
        continue;
      }
      const res = await stampInstance(env, {
        template,
        eventStart: event.start_date,
        sessionId: session.id,
        actor,
        detail: session.title,
      });
      if (res) {
        created++;
        for (const p of profiles) noteFor(p.id, template.name);
      }
      continue;
    }
    for (const p of profiles) {
      const res = await stampInstance(env, {
        template,
        eventStart: event.start_date,
        speakerProfileId: p.id,
        actor,
        detail: p.name,
      });
      if (res) {
        created++;
        noteFor(p.id, template.name);
      }
    }
  }

  if (created) {
    for (const p of profiles) {
      const names = digest.get(p.id);
      if (names?.length) await sendAssignmentDigest(env, event, p, names, sub.title);
    }
  }
  if (!created && skippedNoSession) {
    // A trigger that fires and assigns nothing must not be silent — the
    // organizer would otherwise only notice weeks later that a checklist
    // never materialized.
    await logActivity(env.DB, {
      eventId: sub.event_id,
      subjectType: 'submission',
      subjectId: sub.id,
      actor,
      action: 'Task trigger skipped',
      detail: `On ${opts.trigger}: ${skippedNoSession} session task template${
        skippedNoSession === 1 ? '' : 's'
      } matched “${sub.title}” but it has no session — no tasks created`,
    });
  }
  return { created, skippedNoSession };
}

/** One email per speaker per generation batch, listing the new tasks (§4.8.7). */
async function sendAssignmentDigest(
  env: Bindings,
  event: EventRow,
  profile: { id: string; name: string; email: string },
  taskNames: string[],
  sessionTitle: string
): Promise<void> {
  const tpl = await one<{ subject: string; body: string }>(
    env.DB,
    `SELECT subject, body FROM email_templates WHERE event_id = ? AND key = 'task_nag'`,
    event.id
  );
  const due = await one<{ d: string | null }>(
    env.DB,
    `SELECT MIN(due_date) AS d FROM tasks
      WHERE event_id = ? AND status = 'open' AND (speaker_profile_id = ? OR session_id IN
        (SELECT session_id FROM session_speakers WHERE speaker_profile_id = ?))`,
    event.id,
    profile.id,
    profile.id
  );
  const vars = {
    speaker_name: profile.name || profile.email,
    event_name: event.name,
    session_title: sessionTitle,
    task_name: taskNames.join(', '),
    due_date: due?.d ?? 'soon',
    days_left: due?.d ? `${Math.max(0, daysBetween(todayISO(), due.d))} days` : 'plenty of time',
    portal_link: `${env.APP_ORIGIN}/${event.slug}/portal`,
  };
  const subject = `Your ${event.name} speaker checklist — ${taskNames.length} new task${
    taskNames.length === 1 ? '' : 's'
  }`;
  const body = tpl
    ? renderTemplate(tpl.body, vars)
    : `Hi ${vars.speaker_name},\n\n${taskNames.length} new task${taskNames.length === 1 ? '' : 's'} for ${
        event.name
      }: ${vars.task_name}.\n\n${vars.portal_link}`;
  await sendEmail(env, {
    eventId: event.id,
    to: profile.email,
    toName: profile.name,
    templateKey: 'task_nag',
    subject,
    text: body,
    subjectType: 'speaker',
    subjectId: profile.id,
  });
}

/* ----------------------------------------------------------- cancellation */

/**
 * Withdrawal hook (§3.1 / §4.8.5). Cancels the withdrawn submission's session
 * tasks, plus the speaker tasks of speakers who have no other live submission
 * in this event — a speaker with a second accepted talk keeps their checklist.
 */
export async function cancelOpenTasks(env: Bindings, submissionId: string): Promise<void> {
  const sub = await one<{ id: string; event_id: string }>(
    env.DB,
    `SELECT id, event_id FROM submissions WHERE id = ?`,
    submissionId
  );
  if (!sub) return;

  const stamp = now();
  const session = await one<{ id: string }>(
    env.DB,
    `SELECT id FROM sessions WHERE submission_id = ? LIMIT 1`,
    sub.id
  );
  let cancelled = 0;
  if (session) {
    const res = await run(
      env.DB,
      `UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE session_id = ? AND status IN ('open','pending_review')`,
      stamp,
      session.id
    );
    cancelled += res.meta?.changes ?? 0;
  }

  const speakers = await all<{ email: string }>(
    env.DB,
    `SELECT email FROM submission_speakers WHERE submission_id = ?`,
    sub.id
  );
  for (const sp of speakers) {
    if (!sp.email) continue;
    const profile = await one<{ id: string }>(
      env.DB,
      `SELECT id FROM speaker_profiles WHERE event_id = ? AND email = ?`,
      sub.event_id,
      sp.email
    );
    if (!profile) continue;
    const other = await one<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n FROM submissions s
         JOIN submission_speakers ss ON ss.submission_id = s.id
        WHERE s.event_id = ? AND s.id != ? AND ss.email = ?
          AND s.status = 'accepted'`,
      sub.event_id,
      sub.id,
      sp.email
    );
    if ((other?.n ?? 0) > 0) continue;
    const res = await run(
      env.DB,
      `UPDATE tasks SET status = 'cancelled', completed_at = ?
        WHERE speaker_profile_id = ? AND session_id IS NULL AND status IN ('open','pending_review')`,
      stamp,
      profile.id
    );
    cancelled += res.meta?.changes ?? 0;
  }

  if (cancelled) {
    await logActivity(env.DB, {
      eventId: sub.event_id,
      subjectType: 'submission',
      subjectId: sub.id,
      actor: 'System',
      action: 'Open tasks cancelled',
      detail: `${cancelled} open task${cancelled === 1 ? '' : 's'} cancelled on withdrawal`,
    });
  }
}

/* ------------------------------------------------------ state transitions */

export async function taskLabel(env: Bindings, task: TaskRow): Promise<string> {
  const snap = snapshotOf(task);
  if (snap?.name) return snap.name;
  if (task.template_id) {
    const t = await one<{ name: string }>(env.DB, `SELECT name FROM task_templates WHERE id = ?`, task.template_id);
    return t?.name ?? 'Task';
  }
  return jsonParse<OneOffSpec>(task.one_off_json, { name: 'Task', type: 'checkbox' }).name;
}

async function logTask(
  env: Bindings,
  task: TaskRow,
  actor: string,
  action: string,
  detail?: string | null
): Promise<void> {
  await logActivity(env.DB, {
    eventId: task.event_id,
    subjectType: 'task',
    subjectId: task.id,
    actor,
    action,
    detail: detail ?? (await taskLabel(env, task)),
  });
}

/** Checkbox / organizer override: flip the done flag. */
export async function setTaskDone(
  env: Bindings,
  task: TaskRow,
  done: boolean,
  actor: string
): Promise<void> {
  if (done) {
    await run(
      env.DB,
      `UPDATE tasks SET status = 'done', completed_by = ?, completed_at = ?, review_note = NULL WHERE id = ?`,
      actor,
      now(),
      task.id
    );
    await logTask(env, task, actor, 'Task completed');
  } else {
    await run(
      env.DB,
      `UPDATE tasks SET status = 'open', completed_by = NULL, completed_at = NULL WHERE id = ?`,
      task.id
    );
    await logTask(env, task, actor, 'Task reopened');
  }
}

/** Mini-form submit → done, response kept on the instance. */
export async function submitTaskForm(
  env: Bindings,
  task: TaskRow,
  answers: Record<string, unknown>,
  actor: string
): Promise<void> {
  await run(
    env.DB,
    `UPDATE tasks SET status = 'done', response_json = ?, completed_by = ?, completed_at = ?, review_note = NULL WHERE id = ?`,
    JSON.stringify(answers),
    actor,
    now(),
    task.id
  );
  await logTask(env, task, actor, 'Task form submitted');
}

/** File upload → done, or pending_review when the template asks for review (§4.8.6). */
export async function completeFileTask(
  env: Bindings,
  task: TaskRow,
  settings: TaskSettings,
  actor: string,
  filename: string
): Promise<TaskStatus> {
  const status: TaskStatus = settings.review ? 'pending_review' : 'done';
  await run(
    env.DB,
    `UPDATE tasks SET status = ?, completed_by = ?, completed_at = ?, review_note = NULL WHERE id = ?`,
    status,
    actor,
    now(),
    task.id
  );
  await logTask(
    env,
    task,
    actor,
    status === 'pending_review' ? 'File uploaded — pending review' : 'File uploaded',
    `${await taskLabel(env, task)} · ${filename}`
  );
  return status;
}

export async function approveTask(env: Bindings, task: TaskRow, actor: string): Promise<void> {
  await run(
    env.DB,
    `UPDATE tasks SET status = 'done', review_note = NULL, completed_at = COALESCE(completed_at, ?) WHERE id = ?`,
    now(),
    task.id
  );
  await logTask(env, task, actor, 'File approved');
}

/**
 * Request changes (§4.8.6): back to Open with a required message, and the
 * speaker is emailed — we never ship a rejection that does not notify.
 */
export async function requestChanges(
  env: Bindings,
  task: TaskRow,
  message: string,
  actor: string
): Promise<void> {
  await run(
    env.DB,
    `UPDATE tasks SET status = 'open', review_note = ?, completed_by = NULL, completed_at = NULL WHERE id = ?`,
    message,
    task.id
  );
  await logTask(env, task, actor, 'Changes requested', `${await taskLabel(env, task)} · ${message}`);
}

/** Profile-completion tasks auto-complete when name + bio + headshot are present. */
export async function autoCompleteProfileTasks(
  env: Bindings,
  speakerProfileId: string,
  actor: string
): Promise<number> {
  const profile = await one<{ id: string; name: string; bio: string; headshot_file_id: string | null }>(
    env.DB,
    `SELECT id, name, bio, headshot_file_id FROM speaker_profiles WHERE id = ?`,
    speakerProfileId
  );
  if (!profile) return 0;
  const complete = !!profile.name.trim() && !!profile.bio.trim() && !!profile.headshot_file_id;
  if (!complete) return 0;
  const open = await all<TaskRow>(
    env.DB,
    `SELECT t.* FROM tasks t JOIN task_templates tt ON tt.id = t.template_id
      WHERE t.speaker_profile_id = ? AND tt.type = 'profile' AND t.status = 'open'`,
    speakerProfileId
  );
  for (const task of open) await setTaskDone(env, task, true, actor);
  return open.length;
}

/* ------------------------------------------------------- manual reminders */

/** Real task_nag send for one instance — the outbox delivers queued drawer "Remind"s through this. */
export async function remindTask(
  env: Bindings,
  opts: {
    task: TaskRow;
    taskName: string;
    event: { id: string; name: string; slug: string };
    profile: { id: string; name: string; email: string };
    sessionTitle?: string | null;
    subject?: string;
    body?: string;
    actor?: string;
  }
): Promise<{ status: string }> {
  const tpl = await one<{ subject: string; body: string }>(
    env.DB,
    `SELECT subject, body FROM email_templates WHERE event_id = ? AND key = 'task_nag'`,
    opts.event.id
  );
  const due = opts.task.due_date;
  const vars = {
    speaker_name: opts.profile.name || opts.profile.email,
    task_name: opts.taskName,
    event_name: opts.event.name,
    due_date: due ?? 'soon',
    days_left: due ? `${Math.max(0, daysBetween(todayISO(), due))} days` : 'plenty of time',
    portal_link: `${env.APP_ORIGIN}/${opts.event.slug}/portal`,
    session_title: opts.sessionTitle ?? '',
  };
  const res = await sendEmail(env, {
    eventId: opts.event.id,
    to: opts.profile.email,
    toName: opts.profile.name,
    templateKey: 'task_nag',
    subject: renderTemplate(opts.subject || tpl?.subject || REM_SUBJ, vars),
    text: renderTemplate(opts.body || tpl?.body || REM_BODY, vars),
    subjectType: 'task',
    subjectId: opts.task.id,
  });
  await logActivity(env.DB, {
    eventId: opts.event.id,
    subjectType: 'task',
    subjectId: opts.task.id,
    actor: opts.actor || 'Organizer',
    action: 'Reminder sent',
    detail: `“${opts.taskName}” → ${opts.profile.email}`,
  });
  return { status: res.status };
}

/**
 * One combined task_nag send for several tasks — the outbox batches every
 * queued reminder for the same speaker into a single email through this.
 * Uses generic wording (per-template custom subject/body only applies when a
 * speaker has exactly one queued reminder, via `remindTask`).
 */
export async function remindTasksBatch(
  env: Bindings,
  opts: {
    event: { id: string; name: string; slug: string };
    profile: { id: string; name: string; email: string };
    items: { task: TaskRow; taskName: string }[];
    actor?: string;
  }
): Promise<{ status: string }> {
  const today = todayISO();
  const lines = opts.items.map(({ task, taskName }) => {
    if (!task.due_date) return `• “${taskName}”`;
    const left = Math.max(0, daysBetween(today, task.due_date));
    return `• “${taskName}” — due ${task.due_date} (${left} day${left === 1 ? '' : 's'} left)`;
  });
  const text =
    `Hi ${opts.profile.name || opts.profile.email},\n\n` +
    `A quick reminder — you have ${opts.items.length} open tasks for ${opts.event.name}:\n\n` +
    `${lines.join('\n')}\n\n` +
    `Everything you need is in your speaker portal:\n${env.APP_ORIGIN}/${opts.event.slug}/portal\n\n` +
    `Already done some of these? Reminders stop automatically once a task is complete, so you can ignore those.\n\n` +
    `— The ${opts.event.name} program team`;
  const res = await sendEmail(env, {
    eventId: opts.event.id,
    to: opts.profile.email,
    toName: opts.profile.name,
    templateKey: 'task_nag',
    subject: `Reminder: ${opts.items.length} open tasks for ${opts.event.name}`,
    text,
    subjectType: 'speaker',
    subjectId: opts.profile.id,
  });
  for (const { task, taskName } of opts.items) {
    await logActivity(env.DB, {
      eventId: opts.event.id,
      subjectType: 'task',
      subjectId: task.id,
      actor: opts.actor || 'Organizer',
      action: 'Reminder sent',
      detail: `“${taskName}” → ${opts.profile.email} · batched, one email with ${opts.items.length} reminders`,
    });
  }
  return { status: res.status };
}
