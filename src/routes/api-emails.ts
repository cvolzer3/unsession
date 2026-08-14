/**
 * API domain: emails and the outbox (spec C parity round 2).
 *
 * Templates, the email log, and the two-phase send queues. In the product,
 * deciding and informing speakers are separate steps (DECISIONS R14): the
 * decision modal QUEUES into `decision_queue`, task reminders queue into
 * `task_reminder_queue`, and nothing reaches a speaker until the outbox is
 * sent. These tools give agents the same two-phase flow — `queue_decision` +
 * `send_outbox` — alongside the immediate `decide_submission` that spec C
 * gave machine callers from day one.
 */
import type { Hono } from 'hono';
import type { Bindings, Event } from '../types';
import { apiActor, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import {
  bad,
  clampLimit,
  decodeCursor,
  encodeCursor,
  eventOf,
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
import { looksRich, sanitizeRich } from '../lib/rich';
import { isDecision } from '../lib/decisions';
import {
  listDecisionQueue,
  OUTBOX_SEND_LIMIT,
  queueDecisions,
  removeQueuedDecisions,
  sendQueuedDecisions,
  type SendQueuedResult,
} from '../lib/decision-queue';
import { listReminderQueue, removeQueuedReminders, sendQueuedReminders } from '../lib/reminder-queue';

/* -------------------------------------------------------------- templates */

type TemplateRow = {
  id: string;
  event_id: string;
  key: string;
  name: string;
  subject: string;
  body: string;
  updated_at: string;
};

function shapeTemplate(t: TemplateRow, sent: number) {
  return { id: t.id, key: t.key, name: t.name, subject: t.subject, body: t.body, updatedAt: t.updated_at, sent };
}

export async function listEmailTemplates(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  const [templates, counts] = await Promise.all([
    all<TemplateRow>(env.DB, `SELECT * FROM email_templates WHERE event_id = ? ORDER BY key, name`, event.id),
    all<{ template_key: string; n: number }>(
      env.DB,
      `SELECT template_key, COUNT(*) AS n FROM emails WHERE event_id = ? AND template_key IS NOT NULL GROUP BY template_key`,
      event.id
    ),
  ]);
  const sent = new Map(counts.map((c) => [c.template_key, c.n]));
  return templates.map((t) => shapeTemplate(t, sent.get(t.key) ?? 0));
}

async function templateByRef(env: Bindings, auth: ApiAuth, id: string): Promise<{ tpl: TemplateRow; event: Event }> {
  const tpl = await one<TemplateRow>(env.DB, `SELECT * FROM email_templates WHERE id = ?`, (id ?? '').trim());
  if (!tpl) throw notFound('Email template not found');
  const event = await eventOf(env, auth, tpl.event_id);
  return { tpl, event };
}

export type UpdateEmailTemplateInput = { name?: string; subject?: string; body?: string };

/** UPDATE a template's name/subject/body — rich-lite bodies are sanitized like the editor. */
export async function updateEmailTemplate(env: Bindings, auth: ApiAuth, id: string, input: UpdateEmailTemplateInput) {
  requireWrite(auth);
  const { tpl } = await templateByRef(env, auth, id);
  if (input.name === undefined && input.subject === undefined && input.body === undefined) {
    throw bad('Nothing to update — pass name, subject and/or body');
  }
  const name = typeof input.name === 'string' ? input.name.trim() || tpl.name : tpl.name;
  const subject = typeof input.subject === 'string' ? input.subject.trim() : tpl.subject;
  const bodySource = typeof input.body === 'string' ? input.body : tpl.body;
  const text = looksRich(bodySource) ? sanitizeRich(bodySource) : bodySource;
  await run(
    env.DB,
    `UPDATE email_templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?`,
    name,
    subject,
    text,
    now(),
    tpl.id
  );
  const fresh = (await one<TemplateRow>(env.DB, `SELECT * FROM email_templates WHERE id = ?`, tpl.id))!;
  return shapeTemplate(fresh, 0);
}

/** DUPLICATE a template (same key) — the variant becomes usable as decide_submission's templateId. */
export async function duplicateEmailTemplate(env: Bindings, auth: ApiAuth, id: string, name?: string) {
  requireWrite(auth);
  const { tpl, event } = await templateByRef(env, auth, id);
  const copyId = newId('etp');
  const copyName = `Copy of ${(name ?? '').trim() || tpl.name}`;
  await run(
    env.DB,
    `INSERT INTO email_templates (id, event_id, key, name, subject, body, updated_at) VALUES (?,?,?,?,?,?,?)`,
    copyId,
    event.id,
    tpl.key,
    copyName,
    tpl.subject,
    tpl.body,
    now()
  );
  const fresh = (await one<TemplateRow>(env.DB, `SELECT * FROM email_templates WHERE id = ?`, copyId))!;
  return shapeTemplate(fresh, 0);
}

/* -------------------------------------------------------------- email log */

type EmailRow = {
  id: string;
  created_at: string;
  to_email: string;
  to_name: string | null;
  template_key: string | null;
  subject: string;
  status: string;
  subject_type: string | null;
  subject_id: string | null;
};

export type EmailLogQuery = {
  status?: string;
  templateKey?: string;
  to?: string;
  subjectId?: string;
  limit?: string | number;
  cursor?: string;
};

/** The Emails → Log tab: every recorded email (sent, simulated, failed, queued). */
export async function listEmailLog(env: Bindings, auth: ApiAuth, ref: string, query: EmailLogQuery = {}) {
  const event = await resolveEvent(env, auth, ref);
  const limit = clampLimit(query.limit);

  const conds = ['event_id = ?'];
  const params: unknown[] = [event.id];
  if (query.status) {
    conds.push('status = ?');
    params.push(query.status);
  }
  if (query.templateKey) {
    conds.push('template_key = ?');
    params.push(query.templateKey);
  }
  if (query.to) {
    conds.push('to_email LIKE ?');
    params.push(`%${query.to.trim()}%`);
  }
  if (query.subjectId) {
    conds.push('subject_id = ?');
    params.push(query.subjectId);
  }
  if (query.cursor) {
    const [key, id] = decodeCursor(query.cursor);
    conds.push('(created_at < ? OR (created_at = ? AND id > ?))');
    params.push(key, key, id);
  }

  const rows = await all<EmailRow>(
    env.DB,
    `SELECT id, created_at, to_email, to_name, template_key, subject, status, subject_type, subject_id
       FROM emails WHERE ${conds.join(' AND ')}
      ORDER BY created_at DESC, id ASC LIMIT ?`,
    ...params,
    limit + 1
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      to: r.to_email,
      toName: r.to_name,
      templateKey: r.template_key,
      subject: r.subject,
      status: r.status,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      createdAt: r.created_at,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** One logged email in full — body and failure error included. */
export async function getEmail(env: Bindings, auth: ApiAuth, id: string) {
  const row = await one<EmailRow & { event_id: string | null; body: string; error: string | null }>(
    env.DB,
    `SELECT * FROM emails WHERE id = ?`,
    (id ?? '').trim()
  );
  if (!row || !row.event_id) throw notFound('Email not found');
  await eventOf(env, auth, row.event_id);
  return {
    id: row.id,
    to: row.to_email,
    toName: row.to_name,
    templateKey: row.template_key,
    subject: row.subject,
    body: row.body,
    status: row.status,
    error: row.error,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    createdAt: row.created_at,
  };
}

/* ----------------------------------------------------------------- outbox */

/** Everything queued and not yet sent: decisions and task reminders. */
export async function getOutbox(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  const [decisions, reminders] = await Promise.all([listDecisionQueue(env, event.id), listReminderQueue(env, event.id)]);
  return {
    decisions: decisions.map((d) => ({
      queueId: d.id,
      submissionId: d.submission_id,
      displayId: `SUB-${d.seq}`,
      title: d.title,
      decision: d.decision,
      speaker: d.speaker_name,
      speakerEmail: d.speaker_email,
      subject: d.subject || null,
      feedback: d.feedback,
      requestConfirmation: !!d.request_confirmation,
      queuedBy: d.queued_by,
      queuedAt: d.created_at,
    })),
    reminders: reminders.map((r) => ({
      queueId: r.id,
      taskId: r.task_id,
      taskName: r.task_name,
      dueDate: r.due_date,
      speakerProfileId: r.speaker_profile_id,
      speaker: r.speaker_name,
      speakerEmail: r.speaker_email,
      queuedBy: r.queued_by,
      queuedAt: r.created_at,
    })),
    counts: { decisions: decisions.length, reminders: reminders.length },
    sendLimit: OUTBOX_SEND_LIMIT,
  };
}

export type QueueDecisionApiInput = {
  ids?: string[];
  decision?: string;
  subject?: string;
  body?: string;
  /** submissionId → individual feedback, or a single string applied to every id. */
  feedback?: Record<string, string> | string;
  requestConfirmation?: boolean;
};

/** QUEUE decisions into the outbox — the admin decision modal's exact semantics. */
export async function queueDecisionApi(env: Bindings, auth: ApiAuth, ref: string, input: QueueDecisionApiInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const ids = (Array.isArray(input.ids) ? input.ids : []).map(String).filter(Boolean);
  if (!ids.length) throw bad('Pass ids — one or more submission ids (sub_…)');
  if (ids.length > 100) throw bad('At most 100 submissions per call');
  if (!isDecision(input.decision)) throw bad('decision must be accept, decline or waitlist');

  const feedback: Record<string, string> = {};
  if (typeof input.feedback === 'string') {
    for (const id of ids) feedback[id] = input.feedback;
  } else if (input.feedback && typeof input.feedback === 'object') {
    for (const [k, v] of Object.entries(input.feedback)) feedback[k] = String(v ?? '');
  }

  const result = await queueDecisions(env, {
    eventId: event.id,
    ids,
    decision: input.decision,
    subject: input.subject ?? null,
    body: input.body ?? null,
    perRecipientFeedback: feedback,
    requestConfirmation: input.requestConfirmation,
    actorName: apiActor(auth),
  });
  return result;
}

export type SendOutboxInput = { only?: string; limit?: number };

/**
 * SEND the outbox — decisions first, then reminders, sharing one batch budget.
 * Mirrors the admin “Review & send” button, including honest remainders.
 */
export async function sendOutbox(env: Bindings, auth: ApiAuth, ref: string, input: SendOutboxInput = {}) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const actor = apiActor(auth);
  const limit = clampLimit(input.limit, OUTBOX_SEND_LIMIT, OUTBOX_SEND_LIMIT);
  const remindersOnly = input.only === 'reminders';
  const decisions: SendQueuedResult = remindersOnly
    ? { processed: 0, updated: 0, emailed: 0, simulated: 0, sessionsCreated: 0, skipped: [], remaining: 0 }
    : await sendQueuedDecisions(env, event.id, actor, limit);
  // Decisions and reminders share one send budget; reminders take what's left.
  const reminders = await sendQueuedReminders(env, event.id, actor, limit - decisions.processed);
  return {
    decisions: remindersOnly ? null : decisions,
    reminders,
    remaining: decisions.remaining + reminders.remaining,
  };
}

export type RemoveFromOutboxInput = { queueIds?: string[]; kind?: string };

/** REMOVE queued items before they send — the outbox undo. Nothing is emailed. */
export async function removeFromOutbox(env: Bindings, auth: ApiAuth, ref: string, input: RemoveFromOutboxInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const ids = (Array.isArray(input.queueIds) ? input.queueIds : []).map(String).filter(Boolean);
  if (!ids.length) throw bad('Pass queueIds — outbox row ids from get_outbox');
  const actor = apiActor(auth);
  const removed =
    input.kind === 'reminder'
      ? await removeQueuedReminders(env, event.id, ids, actor)
      : await removeQueuedDecisions(env, event.id, ids, actor);
  return { removed, kind: input.kind === 'reminder' ? 'reminder' : 'decision' };
}

/* -------------------------------------------------------------- REST routes */

export function registerEmailRoutes(app: Hono<ApiCtx>): void {
  app.get('/api/v1/events/:event/email-templates', handle((c) => listEmailTemplates(c.env, c.var.apiAuth, p(c, 'event'))));
  app.patch(
    '/api/v1/email-templates/:id',
    handle(async (c) => updateEmailTemplate(c.env, c.var.apiAuth, p(c, 'id'), await jsonBody(c)))
  );
  app.post(
    '/api/v1/email-templates/:id/duplicate',
    handle(async (c) => {
      const body = await jsonBody<{ name?: string }>(c).catch(() => ({}) as { name?: string });
      return duplicateEmailTemplate(c.env, c.var.apiAuth, p(c, 'id'), body.name);
    })
  );
  app.get(
    '/api/v1/events/:event/emails',
    handle((c) =>
      listEmailLog(c.env, c.var.apiAuth, p(c, 'event'), {
        status: c.req.query('status'),
        templateKey: c.req.query('templateKey'),
        to: c.req.query('to'),
        subjectId: c.req.query('subjectId'),
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
      })
    )
  );
  app.get('/api/v1/emails/:id', handle((c) => getEmail(c.env, c.var.apiAuth, p(c, 'id'))));
  app.get('/api/v1/events/:event/outbox', handle((c) => getOutbox(c.env, c.var.apiAuth, p(c, 'event'))));
  app.post(
    '/api/v1/events/:event/outbox/decisions',
    handle(async (c) => queueDecisionApi(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.post(
    '/api/v1/events/:event/outbox/send',
    handle(async (c) => sendOutbox(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody<SendOutboxInput>(c).catch(() => ({}))))
  );
  app.post(
    '/api/v1/events/:event/outbox/remove',
    handle(async (c) => removeFromOutbox(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
}

/* --------------------------------------------------------------- MCP tools */

export const EMAIL_TOOLS: Tool[] = [
  {
    name: 'list_email_templates',
    description:
      'List an event’s email templates (accept, decline, waitlist, reminder, task_nag, schedule_notice, confirm_submission, plus duplicated variants) with subject, body, sent count. Variables are {{snake_case}}. Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => listEmailTemplates(env, auth, str(a.event)),
  },
  {
    name: 'update_email_template',
    description:
      'UPDATE an email template’s name, subject and/or body. Rich-lite HTML bodies are sanitized server-side; plain text passes through. Takes effect on the next send that uses the template.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Template id (etp_…), see list_email_templates.' },
        name: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => updateEmailTemplate(env, auth, str(a.id), a as UpdateEmailTemplateInput),
  },
  {
    name: 'duplicate_email_template',
    description:
      'DUPLICATE a template as a same-key variant (e.g. an alternate accept email). The copy’s id can then be passed as decide_submission’s templateId.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Template id (etp_…).' },
        name: { type: 'string', description: 'Base name for “Copy of …”; defaults to the source name.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => duplicateEmailTemplate(env, auth, str(a.id), a.name === undefined ? undefined : str(a.name)),
  },
  {
    name: 'list_email_log',
    description:
      'The email log — every recorded email with to, subject, template key and status (sent | simulated | failed | queued). Filters: status, templateKey, to (substring), subjectId (e.g. a submission id). Cursor-paginated. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        status: { type: 'string', enum: ['sent', 'simulated', 'failed', 'queued'] },
        templateKey: { type: 'string' },
        to: { type: 'string', description: 'Substring match on the recipient address.' },
        subjectId: { type: 'string', description: 'Filter to emails about one subject (sub_…, ses_…, tsi_…).' },
        limit: { type: 'integer', description: 'Page size, default 100, max 500.' },
        cursor: { type: 'string', description: 'Opaque nextCursor from the previous page.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) =>
      listEmailLog(env, auth, str(a.event), {
        status: a.status === undefined ? undefined : str(a.status),
        templateKey: a.templateKey === undefined ? undefined : str(a.templateKey),
        to: a.to === undefined ? undefined : str(a.to),
        subjectId: a.subjectId === undefined ? undefined : str(a.subjectId),
        limit: a.limit as number | undefined,
        cursor: a.cursor === undefined ? undefined : str(a.cursor),
      }),
  },
  {
    name: 'get_email',
    description: 'One logged email in full — body, status and the failure error when sending failed. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Email id (eml_…), see list_email_log.' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => getEmail(env, auth, str(a.id)),
  },
  {
    name: 'get_outbox',
    description:
      'The outbox: queued decisions and queued task reminders that have NOT been sent yet. Queued items are invisible to speakers and freely removable. Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => getOutbox(env, auth, str(a.event)),
  },
  {
    name: 'queue_decision',
    description:
      'QUEUE decisions into the outbox — the admin decision modal’s semantics: records intent only (no status flip, no session, no email, invisible to speakers) until send_outbox runs. One pending decision per submission; re-queueing replaces it. Use decide_submission instead to apply a decision immediately.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        ids: { type: 'array', items: { type: 'string' }, description: 'Submission ids (sub_…), max 100.' },
        decision: { type: 'string', enum: ['accept', 'decline', 'waitlist'] },
        subject: { type: 'string', description: 'Email subject override; empty = the event template at send time.' },
        body: { type: 'string', description: 'Email body override; empty = the event template at send time.' },
        feedback: {
          description: 'Individual feedback: {submissionId: text} map, or one string applied to every id.',
          type: ['object', 'string'],
        },
        requestConfirmation: { type: 'boolean', description: 'Accepts only: mint a confirmation link at send time. Default true.' },
      },
      required: ['event', 'ids', 'decision'],
      additionalProperties: false,
    },
    run: (env, auth, a) => queueDecisionApi(env, auth, str(a.event), a as QueueDecisionApiInput),
  },
  {
    name: 'send_outbox',
    description:
      'SEND the outbox — the big red button. Runs the real decision engine over queued decisions (status flip, session copy on accept, tasks, confirmation links, decision EMAILS), then sends queued task reminders (batched one email per speaker), sharing a 40-row budget per call. Returns remaining counts — call again to finish. only="reminders" skips decisions.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        only: { type: 'string', enum: ['reminders'], description: 'Restrict to task reminders.' },
        limit: { type: 'integer', description: 'Batch size, max 40 (the per-request send budget).' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => sendOutbox(env, auth, str(a.event), a as SendOutboxInput),
  },
  {
    name: 'remove_from_outbox',
    description:
      'REMOVE queued outbox items before they send (the undo). kind decision (default) or reminder; queueIds come from get_outbox. Nothing is emailed; activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        queueIds: { type: 'array', items: { type: 'string' } },
        kind: { type: 'string', enum: ['decision', 'reminder'] },
      },
      required: ['event', 'queueIds'],
      additionalProperties: false,
    },
    run: (env, auth, a) => removeFromOutbox(env, auth, str(a.event), a as RemoveFromOutboxInput),
  },
];
