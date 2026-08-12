/**
 * Public REST API — `/api/v1/*` (spec C).
 *
 * Bearer-token auth only (`lib/api-tokens`), mounted in `index.tsx` BEFORE the
 * cookie-session middleware and the `/:event` catch-alls. Every route is a thin
 * shell over the exported core functions below, which the MCP endpoint
 * (`routes/mcp.ts`) calls too — one implementation, two protocols.
 *
 * Writes reuse the existing lib engines (decisions, sessions-core, tasks) so
 * the invariants hold for free: Session ≠ Submission, confirmation gating,
 * activity rows with actor `api:<token name>`.
 *
 * Responses: `{ ok: true, data }` / `{ ok: false, error }` with proper status
 * codes. Event-scoped routes 404 outside the token's event restriction.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Bindings, Event } from '../types';
import { apiActor, apiTokenAuth, canWrite, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import { all, batch, jsonParse, now, one, run } from '../lib/db';
import { newId, nextSeq } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { applyDecision, isDecision } from '../lib/decisions';
import { ensureSpeakerProfiles } from '../lib/sessions-core';
import * as T from '../lib/tasks';
import {
  bumpIcsSequence,
  eventDays,
  fmtTime,
  loadAgenda,
  notifyScheduleChange,
  roomNamer,
  slotLabel,
  SNAP,
  type AgendaBundle,
  type SessionRow,
} from '../lib/agenda';
import { publicSessions } from './public-agenda';

/* ------------------------------------------------------------------ errors */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const bad = (msg: string) => new ApiError(400, msg);
const notFound = (msg = 'Not found') => new ApiError(404, msg);

export function requireWrite(auth: ApiAuth): void {
  if (!canWrite(auth)) {
    throw new ApiError(
      403,
      "This token is read-only (scope 'read') — create a token with the read,write scope at /app/api"
    );
  }
}

/* ----------------------------------------------------------- event scoping */

/** Resolve `:event` (slug or id) inside the token's org + event restriction. */
export async function resolveEvent(env: Bindings, auth: ApiAuth, ref: string): Promise<Event> {
  const r = (ref ?? '').trim();
  if (!r) throw bad('Missing event — pass an event slug or id');
  const event = await one<Event>(
    env.DB,
    `SELECT * FROM events WHERE org_id = ? AND (id = ? OR slug = ?)`,
    auth.orgId,
    r,
    r
  );
  if (!event || (auth.eventId && event.id !== auth.eventId)) throw notFound('Event not found');
  return event;
}

/** Scope check for rows reached by id (submission/session/speaker/task). */
async function eventOf(env: Bindings, auth: ApiAuth, eventId: string): Promise<Event> {
  const event = await one<Event>(env.DB, `SELECT * FROM events WHERE id = ? AND org_id = ?`, eventId, auth.orgId);
  if (!event || (auth.eventId && event.id !== auth.eventId)) throw notFound('Not found');
  return event;
}

/* ------------------------------------------------------------- shared bits */

const SUBMISSION_STATUSES = ['draft', 'in_review', 'accepted', 'waitlisted', 'declined', 'withdrawn'];

/**
 * Words retired by migration 0011, still accepted on write so existing API
 * clients don't break. `submitted` was always implied by "not a draft";
 * `confirmed` belongs to the session (`sessions.status`), which the accept
 * flow creates — POSTing it here only ever meant "accepted".
 */
const RETIRED_STATUS: Record<string, string> = { submitted: 'in_review', confirmed: 'accepted' };

type FormField = { id: string; type?: string; label?: string; core?: boolean };
type OptionRow = { id: string; name: string; color: string | null; duration_min: number | null; taxonomy: string };

/** Resolve "Talk (30 min)" / "AI & ML" answers onto a taxonomy option (same logic as the admin board). */
function matchOption(options: OptionRow[], taxonomy: string, answer: unknown): OptionRow | null {
  if (typeof answer !== 'string' || !answer) return null;
  const pool = options.filter((o) => o.taxonomy === taxonomy);
  const exact = pool.find((o) => o.name === answer);
  if (exact) return exact;
  const stripped = answer.replace(/\s*\(.+\)\s*$/, '');
  return pool.find((o) => o.name === stripped) ?? null;
}

function resolveMeta(answers: Record<string, unknown>, options: OptionRow[]) {
  const pick = (taxonomy: string): OptionRow | null => {
    for (const value of Object.values(answers)) {
      const hit = matchOption(options, taxonomy, value);
      if (hit) return hit;
    }
    return null;
  };
  return { track: pick('Track'), format: pick('Format'), level: pick('Level') };
}

async function eventOptions(env: Bindings, eventId: string): Promise<OptionRow[]> {
  return all<OptionRow>(
    env.DB,
    `SELECT o.id, o.name, o.color, o.duration_min, t.name AS taxonomy
       FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
      WHERE t.event_id = ? ORDER BY t.position, o.position`,
    eventId
  );
}

type FieldIndex = { byVersion: Map<string, FormField[]>; byForm: Map<string, FormField[]> };

async function eventFields(env: Bindings, eventId: string): Promise<FieldIndex> {
  const versions = await all<{ id: string; form_id: string; schema_json: string }>(
    env.DB,
    `SELECT fv.id, fv.form_id, fv.schema_json FROM form_versions fv
       JOIN forms f ON f.id = fv.form_id WHERE f.event_id = ? ORDER BY fv.version`,
    eventId
  );
  const byVersion = new Map<string, FormField[]>();
  const byForm = new Map<string, FormField[]>();
  for (const v of versions) {
    const fields = jsonParse<{ fields?: FormField[] }>(v.schema_json, {}).fields ?? [];
    byVersion.set(v.id, fields);
    byForm.set(v.form_id, fields); // latest version wins (ordered by version)
  }
  return { byVersion, byForm };
}

function fieldsFor(index: FieldIndex, sub: { form_id: string; form_version_id: string | null }): FormField[] {
  return (sub.form_version_id ? index.byVersion.get(sub.form_version_id) : null) ?? index.byForm.get(sub.form_id) ?? [];
}

/** Answers as `[{ fieldId, label, value }]` — keyed by both label and id per spec. */
function shapeAnswers(answers: Record<string, unknown>, fields: FormField[]) {
  const labelOf = new Map(fields.map((f) => [f.id, f.label ?? f.id]));
  return Object.entries(answers).map(([fieldId, value]) => ({
    fieldId,
    label: labelOf.get(fieldId) ?? fieldId,
    value,
  }));
}

type SubRow = {
  id: string;
  event_id: string;
  form_id: string;
  form_version_id: string | null;
  seq: number;
  status: string;
  title: string;
  abstract: string;
  answers_json: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

type SubSpeakerRow = { submission_id: string; position: number; name: string; email: string; bio: string };

function shapeSubmission(
  sub: SubRow,
  speakers: SubSpeakerRow[],
  fields: FormField[],
  options: OptionRow[],
  formName: string | null
) {
  const answers = jsonParse<Record<string, unknown>>(sub.answers_json, {});
  const meta = resolveMeta(answers, options);
  return {
    id: sub.id,
    displayId: `SUB-${sub.seq}`,
    seq: sub.seq,
    status: sub.status,
    title: sub.title,
    abstract: sub.abstract,
    form: { id: sub.form_id, name: formName },
    track: meta.track?.name ?? null,
    format: meta.format?.name ?? null,
    level: meta.level?.name ?? null,
    speakers: speakers.map((s) => ({ name: s.name, email: s.email, bio: s.bio })),
    answers: shapeAnswers(answers, fields),
    submittedAt: sub.submitted_at,
    createdAt: sub.created_at,
    updatedAt: sub.updated_at,
  };
}

/* ------------------------------------------------------------------ events */

function eventSummary(e: Event) {
  return {
    id: e.id,
    name: e.name,
    slug: e.slug,
    startDate: e.start_date,
    endDate: e.end_date,
    timezone: e.timezone,
    venue: e.venue,
    published: !!e.published,
  };
}

export async function listEvents(env: Bindings, auth: ApiAuth) {
  const rows = auth.eventId
    ? await all<Event>(env.DB, `SELECT * FROM events WHERE org_id = ? AND id = ?`, auth.orgId, auth.eventId)
    : await all<Event>(env.DB, `SELECT * FROM events WHERE org_id = ? ORDER BY created_at DESC`, auth.orgId);
  return rows.map(eventSummary);
}

export async function getEvent(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  const [rooms, taxonomies, options] = await Promise.all([
    all<{ id: string; name: string; capacity: number | null }>(
      env.DB,
      `SELECT id, name, capacity FROM rooms WHERE event_id = ? ORDER BY priority, name`,
      event.id
    ),
    all<{ id: string; name: string }>(
      env.DB,
      `SELECT id, name FROM taxonomies WHERE event_id = ? ORDER BY position`,
      event.id
    ),
    all<{ id: string; taxonomy_id: string; name: string; color: string | null; duration_min: number | null }>(
      env.DB,
      `SELECT o.id, o.taxonomy_id, o.name, o.color, o.duration_min
         FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
        WHERE t.event_id = ? ORDER BY t.position, o.position`,
      event.id
    ),
  ]);
  return {
    ...eventSummary(event),
    mode: event.mode,
    description: event.description,
    rooms,
    taxonomies: taxonomies.map((t) => ({
      id: t.id,
      name: t.name,
      options: options
        .filter((o) => o.taxonomy_id === t.id)
        .map((o) => ({ id: o.id, name: o.name, color: o.color, durationMin: o.duration_min })),
    })),
  };
}

/* ------------------------------------------------------------------- forms */

export async function listForms(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  const forms = await all<{
    id: string;
    name: string;
    slug: string;
    status: string;
    opens_at: string | null;
    closes_at: string | null;
  }>(
    env.DB,
    `SELECT id, name, slug, status, opens_at, closes_at FROM forms WHERE event_id = ?
      ORDER BY (status = 'open') DESC, created_at`,
    event.id
  );
  return forms.map((f) => ({
    id: f.id,
    name: f.name,
    slug: f.slug,
    status: f.status,
    opensAt: f.opens_at,
    closesAt: f.closes_at,
    url: `${env.APP_ORIGIN}/${event.slug}/${f.slug}`,
  }));
}

/* ------------------------------------------------------------- submissions */

/** Opaque keyset cursor: base64 of [COALESCE(submitted_at, created_at), id]. */
function encodeCursor(sortKey: string, id: string): string {
  return btoa(JSON.stringify([sortKey, id]));
}

function decodeCursor(raw: string): [string, string] {
  try {
    const v = JSON.parse(atob(raw)) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    /* fall through */
  }
  throw bad('Bad cursor — pass the nextCursor value from the previous page');
}

function clampLimit(raw: string | number | undefined): number {
  const n = Math.round(Number(raw ?? 100));
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(n, 500);
}

export type SubmissionListQuery = {
  status?: string;
  form?: string;
  track?: string;
  q?: string;
  limit?: string | number;
  cursor?: string;
};

export async function listSubmissions(env: Bindings, auth: ApiAuth, ref: string, query: SubmissionListQuery = {}) {
  const event = await resolveEvent(env, auth, ref);
  const limit = clampLimit(query.limit);

  const conds = ['s.event_id = ?'];
  const params: unknown[] = [event.id];
  if (query.status) {
    const status = RETIRED_STATUS[query.status] ?? query.status;
    if (!SUBMISSION_STATUSES.includes(status)) {
      throw bad(`Unknown status “${query.status}” — one of ${SUBMISSION_STATUSES.join(', ')}`);
    }
    conds.push('s.status = ?');
    params.push(status);
  }
  if (query.form) {
    const form = await one<{ id: string }>(
      env.DB,
      `SELECT id FROM forms WHERE event_id = ? AND (id = ? OR slug = ?)`,
      event.id,
      query.form,
      query.form
    );
    if (!form) throw bad(`Unknown form “${query.form}” — pass a form id or slug on this event`);
    conds.push('s.form_id = ?');
    params.push(form.id);
  }
  if (query.q) {
    const like = `%${query.q.trim()}%`;
    conds.push(
      `(s.title LIKE ? OR s.id IN (SELECT submission_id FROM submission_speakers WHERE name LIKE ? OR email LIKE ?))`
    );
    params.push(like, like, like);
  }
  if (query.cursor) {
    const [key, id] = decodeCursor(query.cursor);
    conds.push(
      `(COALESCE(s.submitted_at, s.created_at) < ? OR (COALESCE(s.submitted_at, s.created_at) = ? AND s.id > ?))`
    );
    params.push(key, key, id);
  }

  const rows = await all<SubRow & { sort_key: string }>(
    env.DB,
    `SELECT s.*, COALESCE(s.submitted_at, s.created_at) AS sort_key FROM submissions s
      WHERE ${conds.join(' AND ')}
      ORDER BY COALESCE(s.submitted_at, s.created_at) DESC, s.id ASC
      LIMIT ?`,
    ...params,
    limit + 1
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const [options, fields, forms, speakers] = await Promise.all([
    eventOptions(env, event.id),
    eventFields(env, event.id),
    all<{ id: string; name: string }>(env.DB, `SELECT id, name FROM forms WHERE event_id = ?`, event.id),
    page.length
      ? all<SubSpeakerRow>(
          env.DB,
          `SELECT submission_id, position, name, email, bio FROM submission_speakers
            WHERE submission_id IN (${page.map(() => '?').join(',')}) ORDER BY position`,
          ...page.map((r) => r.id)
        )
      : Promise.resolve([] as SubSpeakerRow[]),
  ]);
  const formName = new Map(forms.map((f) => [f.id, f.name]));
  const speakersOf = new Map<string, SubSpeakerRow[]>();
  for (const sp of speakers) {
    const list = speakersOf.get(sp.submission_id) ?? [];
    list.push(sp);
    speakersOf.set(sp.submission_id, list);
  }

  // Track lives in the answers, not a column — filter the page in memory.
  const wantTrack = (query.track ?? '').trim().toLowerCase();
  const items = page
    .filter((r) => {
      if (!wantTrack) return true;
      const meta = resolveMeta(jsonParse<Record<string, unknown>>(r.answers_json, {}), options);
      return meta.track?.id === query.track || (meta.track?.name ?? '').toLowerCase() === wantTrack;
    })
    .map((r) => shapeSubmission(r, speakersOf.get(r.id) ?? [], fieldsFor(fields, r), options, formName.get(r.form_id) ?? null));

  // The cursor points at the last row CONSIDERED (page[limit-1]), matched or
  // not, so a track-filtered page never skips rows on the next request.
  const last = page[page.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.sort_key, last.id) : null };
}

export async function getSubmission(env: Bindings, auth: ApiAuth, id: string) {
  const sub = await one<SubRow>(env.DB, `SELECT * FROM submissions WHERE id = ?`, id);
  if (!sub) throw notFound('Submission not found');
  const event = await eventOf(env, auth, sub.event_id);

  const [options, fields, form, speakers, evals, activity] = await Promise.all([
    eventOptions(env, event.id),
    eventFields(env, event.id),
    one<{ name: string }>(env.DB, `SELECT name FROM forms WHERE id = ?`, sub.form_id),
    all<SubSpeakerRow>(
      env.DB,
      `SELECT submission_id, position, name, email, bio FROM submission_speakers WHERE submission_id = ? ORDER BY position`,
      sub.id
    ),
    all<{ scores_json: string; abstained: number }>(
      env.DB,
      `SELECT scores_json, abstained FROM evaluations WHERE submission_id = ?`,
      sub.id
    ),
    all<{ actor: string; action: string; detail: string | null; created_at: string }>(
      env.DB,
      `SELECT actor, action, detail, created_at FROM activity
        WHERE subject_type = 'submission' AND subject_id = ? ORDER BY created_at DESC LIMIT 20`,
      sub.id
    ),
  ]);

  const allScores: number[] = [];
  const byCriterion = new Map<string, number[]>();
  let done = 0;
  for (const ev of evals) {
    if (ev.abstained) continue;
    done++;
    for (const [name, value] of Object.entries(jsonParse<Record<string, number>>(ev.scores_json, {}))) {
      if (typeof value !== 'number' || Number.isNaN(value)) continue;
      allScores.push(value);
      const list = byCriterion.get(name) ?? [];
      list.push(value);
      byCriterion.set(name, list);
    }
  }
  const mean = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null);

  const session = await one<{ id: string }>(env.DB, `SELECT id FROM sessions WHERE submission_id = ? LIMIT 1`, sub.id);

  return {
    ...shapeSubmission(sub, speakers, fieldsFor(fields, sub), options, form?.name ?? null),
    sessionId: session?.id ?? null,
    scores: {
      average: mean(allScores),
      evaluations: done,
      criteria: [...byCriterion.entries()].map(([name, values]) => ({ name, average: mean(values) })),
    },
    activity: activity.reverse().map((a) => ({
      actor: a.actor,
      action: a.action,
      detail: a.detail,
      createdAt: a.created_at,
    })),
  };
}

export type CreateSubmissionInput = {
  formId?: string;
  title?: string;
  abstract?: string;
  speakers?: { name?: string; email?: string; bio?: string }[];
  answers?: Record<string, unknown>;
  status?: string;
};

/** Organizer-on-behalf create — mirrors the CSV-import creation path. */
export async function createSubmission(env: Bindings, auth: ApiAuth, ref: string, input: CreateSubmissionInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);

  const form = await one<{ id: string; name: string }>(
    env.DB,
    `SELECT id, name FROM forms WHERE event_id = ? AND (id = ? OR slug = ?)`,
    event.id,
    input.formId ?? '',
    input.formId ?? ''
  );
  if (!form) throw bad('Unknown form — pass formId (a form id or slug on this event)');
  const version = await one<{ id: string; schema_json: string }>(
    env.DB,
    `SELECT id, schema_json FROM form_versions WHERE form_id = ? ORDER BY version DESC LIMIT 1`,
    form.id
  );
  const fields = jsonParse<{ fields?: FormField[] }>(version?.schema_json ?? '{}', {}).fields ?? [];

  const title = (input.title ?? '').trim();
  if (!title) throw bad('title is required');
  const abstract = (input.abstract ?? '').trim();

  const requested = input.status ?? 'in_review';
  const status = RETIRED_STATUS[requested] ?? requested;
  if (!SUBMISSION_STATUSES.includes(status)) {
    throw bad(`Unknown status “${requested}” — one of ${SUBMISSION_STATUSES.join(', ')}`);
  }

  const speakers = (Array.isArray(input.speakers) ? input.speakers : []).map((s) => ({
    name: String(s?.name ?? '').trim(),
    email: String(s?.email ?? '').trim(),
    bio: String(s?.bio ?? '').trim(),
  }));
  if (speakers.some((s) => !s.name && !s.email)) throw bad('Each speaker needs a name or an email');

  const { answers, ignored } = resolveAnswerKeys(input.answers ?? {}, fields);
  const coreTitle = fields.find((f) => f.core && (f.type ?? '') === 'TXT');
  const coreAbstract = fields.find((f) => f.core && (f.type ?? '') === 'LONG');
  if (coreTitle) answers[coreTitle.id] = title;
  if (coreAbstract && abstract) answers[coreAbstract.id] = abstract;

  const id = newId('sub');
  const stamp = now();
  const seq = await nextSeq(env.DB, event.id, 'submission');
  const stmts: Array<[string, unknown[]]> = [
    [
      `INSERT INTO submissions (id, event_id, form_id, form_version_id, seq, status, title, abstract, answers_json,
         owner_user_id, agent_mode, withdraw_reason, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,0,NULL,?,?,?)`,
      [
        id,
        event.id,
        form.id,
        version?.id ?? null,
        seq,
        status,
        title,
        abstract,
        JSON.stringify(answers),
        status === 'draft' ? null : stamp,
        stamp,
        stamp,
      ],
    ],
  ];
  speakers.forEach((s, i) => {
    stmts.push([
      `INSERT INTO submission_speakers (id, submission_id, position, name, email, bio, headshot_file_id, user_id)
       VALUES (?,?,?,?,?,?,NULL,NULL)`,
      [newId('ssp'), id, i, s.name || s.email, s.email, s.bio],
    ]);
  });
  stmts.push([
    `INSERT INTO activity (id, event_id, subject_type, subject_id, actor, action, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [newId('act'), event.id, 'submission', id, apiActor(auth), 'Created via API', `Form “${form.name}” · status ${status}`, stamp],
  ]);
  await batch(env.DB, stmts);

  const submission = await getSubmission(env, auth, id);
  return ignored.length ? { ...submission, ignoredAnswerKeys: ignored } : submission;
}

/** Map incoming answer keys onto form fields — by field id, else by label (case-insensitive). */
function resolveAnswerKeys(
  raw: Record<string, unknown>,
  fields: FormField[]
): { answers: Record<string, unknown>; ignored: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('answers must be an object');
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byLabel = new Map(fields.map((f) => [(f.label ?? '').trim().toLowerCase(), f]));
  const answers: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const field = byId.get(key) ?? byLabel.get(key.trim().toLowerCase());
    if (field) answers[field.id] = value;
    else ignored.push(key);
  }
  return { answers, ignored };
}

export type UpdateSubmissionInput = {
  title?: string;
  abstract?: string;
  /** Merged onto existing answers; a null value removes the key. */
  answers?: Record<string, unknown>;
};

export async function updateSubmission(env: Bindings, auth: ApiAuth, id: string, input: UpdateSubmissionInput) {
  requireWrite(auth);
  const sub = await one<SubRow>(env.DB, `SELECT * FROM submissions WHERE id = ?`, id);
  if (!sub) throw notFound('Submission not found');
  const event = await eventOf(env, auth, sub.event_id);

  const hasTitle = typeof input.title === 'string';
  const hasAbstract = typeof input.abstract === 'string';
  const hasAnswers = input.answers !== undefined;
  if (!hasTitle && !hasAbstract && !hasAnswers) throw bad('Nothing to update — pass title, abstract and/or answers');

  const title = hasTitle ? (input.title as string).trim() : sub.title;
  if (hasTitle && !title) throw bad('title cannot be empty');
  const abstract = hasAbstract ? (input.abstract as string).trim() : sub.abstract;

  const fields = fieldsFor(await eventFields(env, event.id), sub);
  const answers = jsonParse<Record<string, unknown>>(sub.answers_json, {});
  let ignored: string[] = [];
  if (hasAnswers) {
    const resolved = resolveAnswerKeys(input.answers ?? {}, fields);
    ignored = resolved.ignored;
    for (const [key, value] of Object.entries(resolved.answers)) {
      if (value === null) delete answers[key];
      else answers[key] = value;
    }
  }
  // Keep the core-field answers in step with title/abstract (they are the same value twice).
  const coreTitle = fields.find((f) => f.core && (f.type ?? '') === 'TXT');
  const coreAbstract = fields.find((f) => f.core && (f.type ?? '') === 'LONG');
  if (hasTitle && coreTitle) answers[coreTitle.id] = title;
  if (hasAbstract && coreAbstract) answers[coreAbstract.id] = abstract;

  await run(
    env.DB,
    `UPDATE submissions SET title = ?, abstract = ?, answers_json = ?, updated_at = ? WHERE id = ?`,
    title,
    abstract,
    JSON.stringify(answers),
    now(),
    sub.id
  );
  const changed = [hasTitle ? 'title' : null, hasAbstract ? 'abstract' : null, hasAnswers ? 'answers' : null]
    .filter(Boolean)
    .join(', ');
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'submission',
    subjectId: sub.id,
    actor: apiActor(auth),
    action: 'Updated via API',
    detail: `Changed ${changed}`,
  });

  const fresh = await getSubmission(env, auth, id);
  return ignored.length ? { ...fresh, ignoredAnswerKeys: ignored } : fresh;
}

export type DecideSubmissionInput = {
  decision?: string;
  /** Default true. False = full engine run (status, session, confirmation link) with no email. */
  sendEmail?: boolean;
  /** An email_templates row id on this event — overrides the default template for the decision. */
  templateId?: string;
  /** Merged into {{individual_feedback}} in the decision email. */
  feedback?: string;
};

export async function decideSubmission(env: Bindings, auth: ApiAuth, id: string, input: DecideSubmissionInput) {
  requireWrite(auth);
  const sub = await one<SubRow>(env.DB, `SELECT * FROM submissions WHERE id = ?`, id);
  if (!sub) throw notFound('Submission not found');
  const event = await eventOf(env, auth, sub.event_id);

  if (!isDecision(input.decision)) throw bad('decision must be accept, decline or waitlist');

  let subject: string | null = null;
  let body: string | null = null;
  if (input.templateId) {
    const tpl = await one<{ subject: string; body: string }>(
      env.DB,
      `SELECT subject, body FROM email_templates WHERE id = ? AND event_id = ?`,
      input.templateId,
      event.id
    );
    if (!tpl) throw bad('Unknown templateId — pass an email template id on this event');
    subject = tpl.subject;
    body = tpl.body;
  }

  const result = await applyDecision(env, {
    eventId: event.id,
    ids: [sub.id],
    decision: input.decision,
    subject,
    body,
    perRecipientFeedback: input.feedback ? { [sub.id]: input.feedback } : {},
    sendEmail: input.sendEmail !== false,
    actorName: apiActor(auth),
  });

  if (!result.updated) {
    throw bad(`Cannot decide SUB-${sub.seq}: ${result.skipped[0]?.reason ?? 'not decidable'}`);
  }
  const item = result.items[0];
  return {
    id: sub.id,
    displayId: `SUB-${sub.seq}`,
    decision: input.decision,
    status: result.status,
    templateName: result.templateName,
    emailStatus: item?.emailStatus ?? null,
    sessionId: item?.sessionId ?? null,
    sessionCreated: item?.sessionCreated ?? false,
    confirmationLink: item?.confirmationLink ?? null,
  };
}

/* ---------------------------------------------------------------- sessions */

function shapeSession(s: SessionRow, bundle: AgendaBundle, event: Event) {
  const days = eventDays(event);
  const roomName = roomNamer(bundle);
  const trackById = new Map(bundle.tracks.map((t) => [t.id, t.name]));
  const formatById = new Map(bundle.formats.map((f) => [f.id, f.name]));
  const scheduled = s.day !== null && s.start_min !== null;
  return {
    id: s.id,
    type: s.type,
    title: s.title,
    abstract: s.abstract,
    status: s.status,
    published: !!s.published,
    track: s.track_option_id ? (trackById.get(s.track_option_id) ?? null) : null,
    format: s.format_option_id ? (formatById.get(s.format_option_id) ?? null) : null,
    level: s.level,
    durationMin: s.duration_min,
    sponsorName: s.sponsor_name,
    submissionId: s.submission_id,
    roomId: s.room_id,
    allRooms: !!s.all_rooms,
    schedule: scheduled
      ? {
          day: s.day,
          date: days[s.day!]?.date ?? null,
          start: fmtTime(s.start_min!),
          end: fmtTime(s.end_min ?? s.start_min! + s.duration_min),
          startMin: s.start_min,
          endMin: s.end_min,
          room: s.all_rooms ? 'All rooms' : roomName(s.room_id),
        }
      : null,
    speakers: (bundle.speakers.get(s.id) ?? []).map((p) => ({ id: p.id, name: p.name, email: p.email, slug: p.slug })),
  };
}

export async function listSessions(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  const bundle = await loadAgenda(env.DB, event.id);
  return bundle.sessions.map((s) => shapeSession(s, bundle, event));
}

export async function getSession(env: Bindings, auth: ApiAuth, id: string) {
  const row = await one<{ event_id: string }>(env.DB, `SELECT event_id FROM sessions WHERE id = ?`, id);
  if (!row) throw notFound('Session not found');
  const event = await eventOf(env, auth, row.event_id);
  const bundle = await loadAgenda(env.DB, event.id);
  const session = bundle.sessions.find((s) => s.id === id);
  if (!session) throw notFound('Session not found');
  return shapeSession(session, bundle, event);
}

export type CreateSessionInput = {
  kind?: string;
  title?: string;
  sponsorName?: string;
  abstract?: string;
  trackId?: string | null;
  formatId?: string | null;
  duration?: number;
  allRooms?: boolean;
  day?: number | null;
  startMin?: number | null;
  speaker?: { name?: string; email?: string; bio?: string } | null;
};

async function validateOption(env: Bindings, eventId: string, optionId: string, what: string): Promise<void> {
  const row = await one(
    env.DB,
    `SELECT o.id FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id WHERE o.id = ? AND t.event_id = ?`,
    optionId,
    eventId
  );
  if (!row) throw bad(`That ${what} option does not belong to this event`);
}

/** Sponsor/service sessions only — talk sessions arrive by accepting a submission. */
export async function createSession(env: Bindings, auth: ApiAuth, ref: string, input: CreateSessionInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);

  const kind = input.kind === 'service' ? 'service' : input.kind === 'sponsor' || !input.kind ? 'sponsor' : null;
  if (!kind) throw bad('kind must be sponsor or service — talk sessions arrive by accepting a submission');
  const title = (input.title ?? '').trim() || (kind === 'service' ? 'New break' : '');
  if (!title) throw bad('Give the session a title');

  let duration = Number(input.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = kind === 'service' ? 60 : 30;
  duration = Math.max(5, Math.min(600, Math.round(duration)));

  const trackId = kind === 'sponsor' ? input.trackId || null : null;
  const formatId = kind === 'sponsor' ? input.formatId || null : null;
  if (trackId) await validateOption(env, event.id, trackId, 'track');
  if (formatId) await validateOption(env, event.id, formatId, 'format');
  const allRooms = kind === 'service' ? input.allRooms !== false : false;

  let day: number | null = null;
  let start: number | null = null;
  if (input.day !== null && input.day !== undefined && input.startMin !== null && input.startMin !== undefined) {
    const days = eventDays(event);
    day = Math.max(0, Math.min(days.length - 1, Math.round(Number(input.day))));
    start = Math.max(0, Math.round(Number(input.startMin) / SNAP) * SNAP);
    if (!Number.isFinite(day) || !Number.isFinite(start)) throw bad('day and startMin must be numbers');
  }
  const end = start === null ? null : start + duration;

  const id = newId('ses');
  const stamp = now();
  await run(
    env.DB,
    `INSERT INTO sessions (id, event_id, submission_id, type, title, abstract, track_option_id, format_option_id,
       level, duration_min, room_id, all_rooms, day, start_min, end_min, status, published, sponsor_name,
       stream_url, visibility_json, ics_sequence, created_at, updated_at)
     VALUES (?,?,NULL,?,?,?,?,?,NULL,?,NULL,?,?,?,?, 'confirmed', 1, ?, NULL, NULL, 0, ?, ?)`,
    id,
    event.id,
    kind,
    title,
    (input.abstract ?? '').trim(),
    trackId,
    formatId,
    duration,
    allRooms ? 1 : 0,
    day,
    start,
    end,
    kind === 'sponsor' ? (input.sponsorName ?? '').trim() || null : null,
    stamp,
    stamp
  );

  if (kind === 'sponsor' && input.speaker?.email && input.speaker?.name) {
    const profiles = await ensureSpeakerProfiles(env, event.id, [
      {
        id: '',
        name: input.speaker.name.trim(),
        email: input.speaker.email.trim(),
        bio: (input.speaker.bio ?? '').trim(),
        tagline: '',
        links_json: null,
        headshot_file_id: null,
        user_id: null,
        position: 0,
      },
    ]);
    for (let i = 0; i < profiles.length; i++) {
      await run(
        env.DB,
        `INSERT OR IGNORE INTO session_speakers (session_id, speaker_profile_id, position) VALUES (?,?,?)`,
        id,
        profiles[i],
        i
      );
    }
  }

  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: id,
    actor: apiActor(auth),
    action: kind === 'sponsor' ? 'Sponsor session created' : 'Service block created',
    detail: title,
  });

  return getSession(env, auth, id);
}

export type UpdateSessionInput = {
  title?: string;
  abstract?: string;
  trackId?: string | null;
  formatId?: string | null;
  level?: string | null;
  duration?: number;
  roomId?: string | null;
  allRooms?: boolean;
  published?: boolean;
  /** day + startMin schedule the session; explicit nulls unschedule it. */
  day?: number | null;
  startMin?: number | null;
};

export async function updateSession(env: Bindings, auth: ApiAuth, id: string, input: UpdateSessionInput) {
  requireWrite(auth);
  const cur = await one<SessionRow>(env.DB, `SELECT * FROM sessions WHERE id = ?`, id);
  if (!cur) throw notFound('Session not found');
  const event = await eventOf(env, auth, cur.event_id);

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    params.push(value);
  };

  if (typeof input.title === 'string') push('title', input.title.trim() || cur.title);
  if (typeof input.abstract === 'string') push('abstract', input.abstract);
  if (input.trackId !== undefined) {
    if (input.trackId) await validateOption(env, event.id, input.trackId, 'track');
    push('track_option_id', input.trackId || null);
  }
  if (input.formatId !== undefined) {
    if (input.formatId) await validateOption(env, event.id, input.formatId, 'format');
    push('format_option_id', input.formatId || null);
  }
  if (input.level !== undefined) push('level', input.level || null);
  if (input.published !== undefined) push('published', input.published ? 1 : 0);

  let duration = cur.duration_min;
  if (input.duration !== undefined) {
    duration = Math.max(5, Math.min(600, Math.round(Number(input.duration))));
    if (!Number.isFinite(duration)) throw bad('duration must be a number of minutes');
    push('duration_min', duration);
  }

  let roomId = cur.room_id;
  let allRooms = cur.all_rooms === 1;
  if (input.roomId !== undefined || input.allRooms !== undefined) {
    if (input.allRooms === true || input.roomId === 'ALL') {
      allRooms = true;
      roomId = null;
    } else {
      allRooms = false;
      roomId = input.roomId || null;
      if (roomId) {
        const room = await one(env.DB, `SELECT id FROM rooms WHERE id = ? AND event_id = ?`, roomId, event.id);
        if (!room) throw bad('That room does not belong to this event');
      }
    }
    push('room_id', roomId);
    push('all_rooms', allRooms ? 1 : 0);
  }

  // Scheduling: {day, startMin} places the session; explicit nulls unschedule.
  let day = cur.day;
  let start = cur.start_min;
  let end = cur.end_min;
  const touchesSlot = input.day !== undefined || input.startMin !== undefined;
  if (touchesSlot) {
    if (input.day === null || input.startMin === null) {
      day = null;
      start = null;
      end = null;
    } else {
      const wantDay = input.day !== undefined ? Number(input.day) : cur.day;
      const wantStart = input.startMin !== undefined ? Number(input.startMin) : cur.start_min;
      if (wantDay === null || wantStart === null || !Number.isFinite(wantDay) || !Number.isFinite(wantStart)) {
        throw bad('To schedule, pass numeric day and startMin (minutes from 08:00); nulls unschedule');
      }
      const days = eventDays(event);
      day = Math.max(0, Math.min(days.length - 1, Math.round(wantDay)));
      start = Math.max(0, Math.round(wantStart / SNAP) * SNAP);
      end = start + duration;
    }
    push('day', day);
    push('start_min', start);
    push('end_min', end);
  } else if (start !== null && duration !== cur.duration_min) {
    // A duration change on a scheduled session moves its end; nothing else shifts.
    end = start + duration;
    push('end_min', end);
  }

  if (!sets.length) throw bad('Nothing to update');
  push('updated_at', now());
  params.push(cur.id);
  await run(env.DB, `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...params);

  const wasScheduled = cur.day !== null && cur.start_min !== null;
  const isScheduled = day !== null && start !== null;
  const scheduleChanged =
    wasScheduled !== isScheduled ||
    (isScheduled &&
      (day !== cur.day ||
        start !== cur.start_min ||
        end !== cur.end_min ||
        (roomId ?? null) !== (cur.room_id ?? null) ||
        allRooms !== (cur.all_rooms === 1)));

  const actor = apiActor(auth);
  const bundle = await loadAgenda(env.DB, event.id);
  const roomLabel = allRooms ? 'All rooms' : roomNamer(bundle)(roomId);
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: cur.id,
    actor,
    action: !scheduleChanged
      ? 'Session edited'
      : !isScheduled
        ? 'Unscheduled'
        : wasScheduled
          ? 'Moved on the agenda'
          : 'Scheduled',
    detail: scheduleChanged
      ? `${cur.title} · ${slotLabel(event, { day, start_min: start, end_min: end }, isScheduled ? roomLabel : '')}`
      : cur.title,
  });
  if (scheduleChanged) {
    await bumpIcsSequence(env.DB, cur.id);
    await notifyScheduleChange(env, event, cur.id, actor);
  }

  return getSession(env, auth, id);
}

/* ---------------------------------------------------------------- speakers */

type ProfileRow = {
  id: string;
  event_id: string;
  name: string;
  email: string;
  bio: string;
  slug: string;
  headshot_file_id: string | null;
  pronouns: string | null;
  links_json: string | null;
};

function shapeSpeaker(env: Bindings, event: Event, p: ProfileRow) {
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    bio: p.bio,
    pronouns: p.pronouns,
    links: jsonParse<Record<string, string>>(p.links_json, {}),
    headshotUrl: p.headshot_file_id ? `${env.APP_ORIGIN}/files/${p.headshot_file_id}` : null,
    slug: p.slug,
    profileUrl: `${env.APP_ORIGIN}/${event.slug}/speakers/${p.slug}`,
  };
}

export async function listSpeakers(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  const [profiles, tasks, links] = await Promise.all([
    all<ProfileRow>(env.DB, `SELECT * FROM speaker_profiles WHERE event_id = ? ORDER BY name`, event.id),
    all<T.TaskRow>(env.DB, `SELECT * FROM tasks WHERE event_id = ? AND status != 'cancelled'`, event.id),
    all<{ speaker_profile_id: string; session_id: string; title: string }>(
      env.DB,
      `SELECT ss.speaker_profile_id, ss.session_id, s.title
         FROM session_speakers ss JOIN sessions s ON s.id = ss.session_id
        WHERE s.event_id = ? ORDER BY ss.position`,
      event.id
    ),
  ]);

  const sessionsOf = new Map<string, { id: string; title: string }[]>();
  for (const l of links) {
    const list = sessionsOf.get(l.speaker_profile_id) ?? [];
    list.push({ id: l.session_id, title: l.title });
    sessionsOf.set(l.speaker_profile_id, list);
  }

  const today = T.todayISO();
  return profiles.map((p) => {
    const mySessions = new Set((sessionsOf.get(p.id) ?? []).map((s) => s.id));
    const mine = T.dedupeTasks(
      tasks.filter((t) => t.speaker_profile_id === p.id || (t.session_id && mySessions.has(t.session_id)))
    );
    return {
      ...shapeSpeaker(env, event, p),
      sessions: sessionsOf.get(p.id) ?? [],
      tasks: {
        assigned: mine.length,
        done: mine.filter((t) => t.status === 'done').length,
        open: mine.filter((t) => t.status === 'open').length,
        pendingReview: mine.filter((t) => t.status === 'pending_review').length,
        overdue: mine.filter((t) => T.isOverdue(t, today)).length,
      },
    };
  });
}

/** Copy of the portal's link normalizer: bare domains get https://, only http(s) allowed. */
function normalizeLink(raw: string): string | null {
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

const LINK_KEYS = ['linkedin', 'x', 'website', 'other'];

export type UpdateSpeakerInput = {
  name?: string;
  bio?: string;
  pronouns?: string | null;
  /** Merged: string values are normalized URLs, null/'' removes the key. */
  links?: Record<string, string | null>;
};

export async function updateSpeaker(env: Bindings, auth: ApiAuth, id: string, input: UpdateSpeakerInput) {
  requireWrite(auth);
  const profile = await one<ProfileRow>(env.DB, `SELECT * FROM speaker_profiles WHERE id = ?`, id);
  if (!profile) throw notFound('Speaker not found');
  const event = await eventOf(env, auth, profile.event_id);

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    params.push(value);
  };

  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw bad('name cannot be empty');
    push('name', name);
  }
  if (input.bio !== undefined) push('bio', String(input.bio).trim());
  if (input.pronouns !== undefined) push('pronouns', String(input.pronouns ?? '').trim() || null);
  if (input.links !== undefined) {
    if (typeof input.links !== 'object' || input.links === null || Array.isArray(input.links)) {
      throw bad('links must be an object with linkedin / x / website / other keys');
    }
    const links = jsonParse<Record<string, string>>(profile.links_json, {});
    for (const [key, value] of Object.entries(input.links)) {
      if (!LINK_KEYS.includes(key)) throw bad(`Unknown link key “${key}” — one of ${LINK_KEYS.join(', ')}`);
      if (value === null || String(value).trim() === '') {
        delete links[key];
        continue;
      }
      const url = normalizeLink(String(value));
      if (!url) throw bad(`The ${key} link needs to be a web address (https://…)`);
      links[key] = url;
    }
    push('links_json', Object.keys(links).length ? JSON.stringify(links) : null);
  }
  if (!sets.length) throw bad('Nothing to update — pass name, bio, pronouns and/or links');

  params.push(profile.id);
  await run(env.DB, `UPDATE speaker_profiles SET ${sets.join(', ')} WHERE id = ?`, ...params);

  const actor = apiActor(auth);
  await T.autoCompleteProfileTasks(env, profile.id, actor);
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'speaker',
    subjectId: profile.id,
    actor,
    action: 'Profile updated',
    detail: 'Updated via API',
  });

  const fresh = (await one<ProfileRow>(env.DB, `SELECT * FROM speaker_profiles WHERE id = ?`, profile.id))!;
  return shapeSpeaker(env, event, fresh);
}

/* ------------------------------------------------------------------ agenda */

/** The published agenda — byte-for-byte the same shape as `/{slug}/agenda.json`. */
export async function getAgenda(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  if (!event.published) throw notFound('Agenda not published yet');
  const bundle = await loadAgenda(env.DB, event.id);
  const roomName = roomNamer(bundle);
  const trackById = new Map(bundle.tracks.map((t) => [t.id, t]));
  const days = eventDays(event);
  return {
    event: {
      name: event.name,
      slug: event.slug,
      start_date: event.start_date,
      end_date: event.end_date,
      timezone: event.timezone,
      venue: event.venue,
      mode: event.mode,
    },
    days: days.map((d) => ({ index: d.index, date: d.date })),
    rooms: bundle.rooms.map((r) => r.name),
    tracks: bundle.tracks.map((t) => ({ name: t.name, color: t.color })),
    sessions: publicSessions(event, bundle).map((s) => ({
      id: s.id,
      title: s.title,
      abstract: s.abstract,
      type: s.type,
      sponsor: s.sponsor_name,
      date: days[s.day!]?.date ?? null,
      day: s.day,
      start: fmtTime(s.start_min!),
      end: fmtTime(s.end_min ?? s.start_min! + s.duration_min),
      start_min: s.start_min,
      end_min: s.end_min,
      room: s.all_rooms ? null : roomName(s.room_id),
      all_rooms: !!s.all_rooms,
      track: s.track_option_id ? (trackById.get(s.track_option_id)?.name ?? null) : null,
      level: s.level,
      speakers: (bundle.speakers.get(s.id) ?? []).map((p) => ({
        name: p.name,
        slug: p.slug,
        url: `${env.APP_ORIGIN}/${event.slug}/speakers/${p.slug}`,
      })),
    })),
  };
}

/* ------------------------------------------------------------------- tasks */

export async function listTasks(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  const [tasks, templates, profiles, sessions] = await Promise.all([
    all<T.TaskRow>(env.DB, `SELECT * FROM tasks WHERE event_id = ? ORDER BY created_at`, event.id),
    all<{ id: string; name: string; type: string }>(
      env.DB,
      `SELECT id, name, type FROM task_templates WHERE event_id = ?`,
      event.id
    ),
    all<{ id: string; name: string }>(env.DB, `SELECT id, name FROM speaker_profiles WHERE event_id = ?`, event.id),
    all<{ id: string; title: string }>(env.DB, `SELECT id, title FROM sessions WHERE event_id = ?`, event.id),
  ]);
  const tplById = new Map(templates.map((t) => [t.id, t]));
  const profileName = new Map(profiles.map((p) => [p.id, p.name]));
  const sessionTitle = new Map(sessions.map((s) => [s.id, s.title]));

  return tasks.map((t) => {
    const snap = T.snapshotOf(t);
    const tpl = t.template_id ? tplById.get(t.template_id) : null;
    const oneOff = t.template_id ? null : jsonParse<T.OneOffSpec>(t.one_off_json, { name: 'Task', type: 'checkbox' });
    return {
      id: t.id,
      name: snap?.name ?? tpl?.name ?? oneOff?.name ?? 'Task',
      type: tpl?.type ?? oneOff?.type ?? 'checkbox',
      status: t.status,
      dueDate: t.due_date,
      templateId: t.template_id,
      oneOff: !t.template_id,
      target:
        t.target_type === 'session'
          ? {
              type: 'session' as const,
              sessionId: t.session_id,
              sessionTitle: t.session_id ? (sessionTitle.get(t.session_id) ?? null) : null,
            }
          : {
              type: 'speaker' as const,
              speakerProfileId: t.speaker_profile_id,
              speakerName: t.speaker_profile_id ? (profileName.get(t.speaker_profile_id) ?? null) : null,
            },
      completedBy: t.completed_by,
      completedAt: t.completed_at,
      createdAt: t.created_at,
    };
  });
}

export type AssignTaskInput = {
  templateId?: string;
  speakerProfileId?: string;
  speakerIds?: string[];
  sessionId?: string;
  oneOff?: { name?: string; type?: string; due?: string | null };
};

type AssignResult = { speakerProfileId: string; status: 'created' | 'skipped'; reason?: string; taskId?: string; dueDate?: string | null };

/** Manual assignment — same honest skip semantics as the admin bulk assign. */
export async function assignTask(env: Bindings, auth: ApiAuth, input: AssignTaskInput) {
  requireWrite(auth);
  const actor = apiActor(auth);

  if (input.oneOff) {
    if (!input.speakerProfileId) throw bad('One-off tasks need speakerProfileId');
    const profile = await one<ProfileRow>(
      env.DB,
      `SELECT * FROM speaker_profiles WHERE id = ?`,
      input.speakerProfileId
    );
    if (!profile) throw notFound('Speaker not found');
    await eventOf(env, auth, profile.event_id);
    const name = (input.oneOff.name ?? '').trim();
    if (!name) throw bad('Name the one-off task first');
    const type = ['checkbox', 'file', 'form', 'profile'].includes(input.oneOff.type ?? '')
      ? (input.oneOff.type as T.TaskType)
      : 'checkbox';
    const taskId = await T.stampOneOff(env, {
      eventId: profile.event_id,
      speakerProfileId: profile.id,
      spec: { name, type, due: input.oneOff.due || null },
      actor,
      speakerName: profile.name,
    });
    return { created: 1, skipped: 0, results: [{ speakerProfileId: profile.id, status: 'created' as const, taskId }] };
  }

  if (!input.templateId) throw bad('Pass templateId (or oneOff for a one-off task)');
  const tpl = await one<T.TaskTemplateRow>(env.DB, `SELECT * FROM task_templates WHERE id = ?`, input.templateId);
  if (!tpl) throw notFound('Template not found');
  const event = await eventOf(env, auth, tpl.event_id);
  if (tpl.archived) throw bad(`“${tpl.name}” is archived — no new assignments`);

  // Session-target template addressed directly by session id.
  if (tpl.target === 'session' && input.sessionId) {
    const session = await one<{ id: string; title: string }>(
      env.DB,
      `SELECT id, title FROM sessions WHERE id = ? AND event_id = ?`,
      input.sessionId,
      event.id
    );
    if (!session) throw notFound('Session not found');
    const res = await T.stampInstance(env, {
      template: tpl,
      eventStart: event.start_date,
      sessionId: session.id,
      actor,
      detail: session.title,
    });
    return res
      ? { created: 1, skipped: 0, results: [{ sessionId: session.id, status: 'created' as const, taskId: res.id, dueDate: res.dueDate }] }
      : { created: 0, skipped: 1, results: [{ sessionId: session.id, status: 'skipped' as const, reason: 'already assigned' }] };
  }

  const speakerIds = (input.speakerIds ?? (input.speakerProfileId ? [input.speakerProfileId] : [])).filter(
    (s): s is string => typeof s === 'string' && !!s
  );
  if (!speakerIds.length) {
    throw bad('Pass speakerProfileId or speakerIds (or sessionId for a session-target template)');
  }

  const results: AssignResult[] = [];
  let created = 0;
  for (const speakerId of speakerIds) {
    const profile = await one<{ id: string; name: string }>(
      env.DB,
      `SELECT id, name FROM speaker_profiles WHERE id = ? AND event_id = ?`,
      speakerId,
      event.id
    );
    if (!profile) {
      results.push({ speakerProfileId: speakerId, status: 'skipped', reason: 'speaker not found in this event' });
      continue;
    }
    let sessionId: string | null = null;
    if (tpl.target === 'session') {
      const s = await one<{ session_id: string }>(
        env.DB,
        `SELECT session_id FROM session_speakers WHERE speaker_profile_id = ? LIMIT 1`,
        profile.id
      );
      if (!s) {
        results.push({ speakerProfileId: speakerId, status: 'skipped', reason: 'no session yet — session tasks need one' });
        continue;
      }
      sessionId = s.session_id;
    }
    const res = await T.stampInstance(env, {
      template: tpl,
      eventStart: event.start_date,
      speakerProfileId: tpl.target === 'session' ? null : profile.id,
      sessionId,
      actor,
      detail: profile.name,
    });
    if (res) {
      created++;
      results.push({ speakerProfileId: speakerId, status: 'created', taskId: res.id, dueDate: res.dueDate });
    } else {
      results.push({ speakerProfileId: speakerId, status: 'skipped', reason: 'already assigned' });
    }
  }

  const skipped = results.filter((r) => r.status === 'skipped');
  if (speakerIds.length > 1) {
    await logActivity(env.DB, {
      eventId: event.id,
      subjectType: 'task',
      subjectId: tpl.id,
      actor,
      action: 'Bulk assignment',
      detail: `“${tpl.name}” · ${created} created${skipped.length ? `, ${skipped.length} skipped` : ''} · via API`,
    });
  }
  return { created, skipped: skipped.length, results };
}

/** Organizer override complete — logged like the drawer checkbox. */
export async function completeTask(env: Bindings, auth: ApiAuth, id: string) {
  requireWrite(auth);
  const task = await one<T.TaskRow>(env.DB, `SELECT * FROM tasks WHERE id = ?`, id);
  if (!task) throw notFound('Task not found');
  await eventOf(env, auth, task.event_id);
  const name = await T.taskLabel(env, task);

  if (task.status === 'cancelled') throw bad(`“${name}” was cancelled — assign it again instead`);
  if (task.status === 'done') {
    return { id: task.id, name, status: 'done', alreadyDone: true, completedBy: task.completed_by, completedAt: task.completed_at };
  }
  const actor = apiActor(auth);
  await T.setTaskDone(env, task, true, actor);
  const fresh = (await one<T.TaskRow>(env.DB, `SELECT * FROM tasks WHERE id = ?`, id))!;
  return { id: fresh.id, name, status: fresh.status, alreadyDone: false, completedBy: fresh.completed_by, completedAt: fresh.completed_at };
}

/* ------------------------------------------------------------------ router */

const app = new Hono<ApiCtx>();

app.use('/api/v1/*', apiTokenAuth);

/** try/catch shell: ApiError → its status, anything else → 500. */
function handle(fn: (c: Context<ApiCtx>) => Promise<unknown>) {
  return async (c: Context<ApiCtx>) => {
    try {
      return c.json({ ok: true, data: await fn(c) });
    } catch (err) {
      if (err instanceof ApiError) return c.json({ ok: false, error: err.message }, err.status as ContentfulStatusCode);
      console.error('[api]', err);
      return c.json({ ok: false, error: 'Something went wrong' }, 500);
    }
  };
}

async function jsonBody<TBody>(c: Context<ApiCtx>): Promise<TBody> {
  try {
    return await c.req.json<TBody>();
  } catch {
    throw bad('Body must be JSON');
  }
}

/** Route param — the `handle` wrapper erases Hono's path typing, so read it loosely. */
function p(c: Context<ApiCtx>, name: string): string {
  return c.req.param(name) ?? '';
}

app.get('/api/v1/events', handle((c) => listEvents(c.env, c.var.apiAuth)));
app.get('/api/v1/events/:event', handle((c) => getEvent(c.env, c.var.apiAuth, p(c, 'event'))));
app.get('/api/v1/events/:event/forms', handle((c) => listForms(c.env, c.var.apiAuth, p(c, 'event'))));

app.get(
  '/api/v1/events/:event/submissions',
  handle((c) =>
    listSubmissions(c.env, c.var.apiAuth, p(c, 'event'), {
      status: c.req.query('status'),
      form: c.req.query('form'),
      track: c.req.query('track'),
      q: c.req.query('q'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    })
  )
);
app.post(
  '/api/v1/events/:event/submissions',
  handle(async (c) => createSubmission(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
);
app.get('/api/v1/submissions/:id', handle((c) => getSubmission(c.env, c.var.apiAuth, p(c, 'id'))));
app.patch(
  '/api/v1/submissions/:id',
  handle(async (c) => updateSubmission(c.env, c.var.apiAuth, p(c, 'id'), await jsonBody(c)))
);
app.post(
  '/api/v1/submissions/:id/decision',
  handle(async (c) => decideSubmission(c.env, c.var.apiAuth, p(c, 'id'), await jsonBody(c)))
);

app.get('/api/v1/events/:event/sessions', handle((c) => listSessions(c.env, c.var.apiAuth, p(c, 'event'))));
app.post(
  '/api/v1/events/:event/sessions',
  handle(async (c) => createSession(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
);
app.get('/api/v1/sessions/:id', handle((c) => getSession(c.env, c.var.apiAuth, p(c, 'id'))));
app.patch(
  '/api/v1/sessions/:id',
  handle(async (c) => updateSession(c.env, c.var.apiAuth, p(c, 'id'), await jsonBody(c)))
);

app.get('/api/v1/events/:event/speakers', handle((c) => listSpeakers(c.env, c.var.apiAuth, p(c, 'event'))));
app.patch(
  '/api/v1/speakers/:id',
  handle(async (c) => updateSpeaker(c.env, c.var.apiAuth, p(c, 'id'), await jsonBody(c)))
);

app.get('/api/v1/events/:event/agenda', handle((c) => getAgenda(c.env, c.var.apiAuth, p(c, 'event'))));
app.get('/api/v1/events/:event/tasks', handle((c) => listTasks(c.env, c.var.apiAuth, p(c, 'event'))));

app.post('/api/v1/tasks', handle(async (c) => assignTask(c.env, c.var.apiAuth, await jsonBody(c))));
app.post('/api/v1/tasks/:id/complete', handle((c) => completeTask(c.env, c.var.apiAuth, p(c, 'id'))));

// Unknown /api/v1 path or wrong method → JSON 404, never the HTML not-found page.
app.all('/api/v1/*', (c) => c.json({ ok: false, error: 'No such API route' }, 404));

export default app;
