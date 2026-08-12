/**
 * Decision engine (spec B2 §6) — THE way a submission reaches
 * accepted / declined / waitlisted.
 *
 * Per submission it: flips the status, creates the Session copy on accept via
 * `sessions-core.createSessionFromSubmission`, renders the event's email
 * template per recipient (individual feedback merged for declines, a fresh
 * confirmation link for accepts), queues the mail through `sendEmail` so the
 * `emails` row is written either way, and writes the activity trail.
 *
 * Waitlist promotion is not a separate path: run the accept flow later.
 */
import { all, now, one, run } from './db';
import { CONFIRM_TOKEN_MINUTES, createMagicToken } from './auth';
import { logActivity } from './activity';
import { renderTemplate, sendEmail } from './email';
import { createSessionFromSubmission } from './sessions-core';
import { generateTasksOnTrigger } from './tasks';
import type { Bindings } from '../types';

export type DecisionKind = 'accept' | 'decline' | 'waitlist';

export const DECISION_STATUS: Record<DecisionKind, string> = {
  accept: 'accepted',
  decline: 'declined',
  waitlist: 'waitlisted',
};

/** `email_templates.key` per decision — same word, but keep the mapping explicit. */
export const DECISION_TEMPLATE: Record<DecisionKind, string> = {
  accept: 'accept',
  decline: 'decline',
  waitlist: 'waitlist',
};

export const DECISION_PAST: Record<DecisionKind, string> = {
  accept: 'Accepted',
  decline: 'Declined',
  waitlist: 'Waitlisted',
};

export function isDecision(v: unknown): v is DecisionKind {
  return v === 'accept' || v === 'decline' || v === 'waitlist';
}

export type ApplyDecisionInput = {
  eventId: string;
  ids: string[];
  decision: DecisionKind;
  /** Subject/body as edited in the decision modal; falls back to the event template. */
  subject?: string | null;
  body?: string | null;
  /** submissionId -> individual feedback, merged into `{{individual_feedback}}`. */
  perRecipientFeedback?: Record<string, string>;
  /** Accept only. Off = status flips to accepted and the email omits the link. */
  requestConfirmation?: boolean;
  /**
   * False = run everything (status flip, session copy, confirmation token)
   * but send no email — the API's `sendEmail: false`. UI callers omit it.
   */
  sendEmail?: boolean;
  actorName: string;
};

export type DecisionItem = {
  id: string;
  seq: number;
  title: string;
  status: string;
  to: string | null;
  emailId: string | null;
  emailStatus: 'sent' | 'failed' | 'simulated' | null;
  sessionId: string | null;
  sessionCreated: boolean;
  confirmationLink: string | null;
};

export type ApplyDecisionResult = {
  status: string;
  templateName: string;
  updated: number;
  emailed: number;
  sessionsCreated: number;
  simulated: number;
  items: DecisionItem[];
  skipped: { id: string; reason: string }[];
};

type SubRow = {
  id: string;
  seq: number;
  status: string;
  title: string;
  event_id: string;
};

type SpeakerRow = { name: string; email: string };

/**
 * Mint a `confirm_participation` magic token and return the URL the
 * `/confirm/:token` route consumes.
 *
 * `requestMagicLink` is deliberately not used: it builds `/auth/verify?token=…`
 * and sends its own generic email, while the accept mail must carry
 * `${APP_ORIGIN}/confirm/<raw>` inside the event's own template. Same table and
 * hashing (`auth.createMagicToken`), 7-day TTL to match the "confirm within 7
 * days" copy.
 */
export async function createConfirmationLink(
  env: Bindings,
  input: { email: string; submissionId: string; eventSlug?: string | null }
): Promise<string> {
  const { raw } = await createMagicToken(
    env,
    input.email.trim(),
    'confirm_participation',
    {
      submissionId: input.submissionId,
      next: input.eventSlug ? `/${input.eventSlug}/portal` : '/app',
    },
    CONFIRM_TOKEN_MINUTES
  );
  return `${env.APP_ORIGIN}/confirm/${raw}`;
}

/** Collapse the whitespace a removed placeholder leaves behind. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Drop every line carrying `{{key}}` — plus the lead-in line above it when
 * that line ends in a colon, so "Please confirm within 7 days:" does not
 * dangle over nothing.
 */
function omitPlaceholder(text: string, key: string): string {
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (line.includes(`{{${key}}}`)) {
      while (kept.length && /:\s*$/.test(kept[kept.length - 1])) kept.pop();
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function fmtDateRange(start: string, end: string): string {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [sy, sm, sd] = start.slice(0, 10).split('-').map(Number);
  const [ey, em, ed] = (end || start).slice(0, 10).split('-').map(Number);
  if (!sm || !sd) return start;
  if (start.slice(0, 10) === (end || start).slice(0, 10)) return `${M[sm - 1]} ${sd}, ${sy}`;
  if (sy === ey && sm === em) return `${M[sm - 1]} ${sd}–${ed}, ${sy}`;
  return `${M[sm - 1]} ${sd} – ${M[em - 1]} ${ed}, ${ey}`;
}

/** Statuses that are not a decision's business. */
const UNDECIDABLE: Record<string, string> = {
  draft: 'still a draft — never submitted',
  withdrawn: 'withdrawn by the speaker',
};

export async function applyDecision(env: Bindings, input: ApplyDecisionInput): Promise<ApplyDecisionResult> {
  const status = DECISION_STATUS[input.decision];
  const templateKey = DECISION_TEMPLATE[input.decision];

  const event = await one<{
    id: string;
    name: string;
    slug: string;
    start_date: string;
    end_date: string;
    venue: string | null;
  }>(env.DB, `SELECT id, name, slug, start_date, end_date, venue FROM events WHERE id = ?`, input.eventId);
  if (!event) throw new Error(`event not found: ${input.eventId}`);

  const template = await one<{ name: string; subject: string; body: string }>(
    env.DB,
    `SELECT name, subject, body FROM email_templates WHERE event_id = ? AND key = ?`,
    event.id,
    templateKey
  );

  const subjectTpl = (input.subject ?? '').trim() || template?.subject || `Your ${event.name} submission`;
  const bodyTpl = (input.body ?? '').trim() || template?.body || '';
  const feedback = input.perRecipientFeedback ?? {};
  const wantsConfirmation = input.decision === 'accept' && input.requestConfirmation !== false;

  const result: ApplyDecisionResult = {
    status,
    templateName: template?.name ?? templateKey,
    updated: 0,
    emailed: 0,
    sessionsCreated: 0,
    simulated: 0,
    items: [],
    skipped: [],
  };

  for (const id of input.ids) {
    const sub = await one<SubRow>(
      env.DB,
      `SELECT id, seq, status, title, event_id FROM submissions WHERE id = ? AND event_id = ?`,
      id,
      event.id
    );
    if (!sub) {
      result.skipped.push({ id, reason: 'not found in this event' });
      continue;
    }
    if (UNDECIDABLE[sub.status]) {
      result.skipped.push({ id, reason: UNDECIDABLE[sub.status] });
      continue;
    }

    const speakers = await all<SpeakerRow>(
      env.DB,
      `SELECT name, email FROM submission_speakers WHERE submission_id = ? ORDER BY position`,
      sub.id
    );
    const owner = speakers.find((s) => s.email) ?? null;

    await run(env.DB, `UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?`, status, now(), sub.id);
    result.updated++;

    let sessionId: string | null = null;
    let sessionCreated = false;
    if (input.decision === 'accept') {
      const session = await createSessionFromSubmission(env, sub.id, input.actorName);
      sessionId = session.sessionId;
      sessionCreated = session.created;
      if (session.created) result.sessionsCreated++;
      await generateTasksOnTrigger(env, { submissionId: sub.id, trigger: 'acceptance' });
    }

    let confirmationLink: string | null = null;
    if (wantsConfirmation && owner?.email) {
      confirmationLink = await createConfirmationLink(env, {
        email: owner.email,
        submissionId: sub.id,
        eventSlug: event.slug,
      });
    }

    const individual = (feedback[sub.id] ?? '').trim();
    let subject = subjectTpl;
    let body = bodyTpl;
    if (!individual) body = omitPlaceholder(body, 'individual_feedback');
    if (!confirmationLink) {
      body = omitPlaceholder(body, 'confirmation_link');
      subject = subject.replace(/\{\{\s*confirmation_link\s*\}\}/g, '');
    }

    const vars: Record<string, string> = {
      speaker_name: owner?.name || 'there',
      first_name: (owner?.name || 'there').split(/\s+/)[0],
      session_title: sub.title,
      event_name: event.name,
      event_dates: fmtDateRange(event.start_date, event.end_date),
      event_venue: event.venue ?? 'the venue',
      confirmation_link: confirmationLink ?? '',
      individual_feedback: individual,
      portal_link: `${env.APP_ORIGIN}/${event.slug}/portal`,
      slot_time: 'to be scheduled',
    };

    const suppressEmail = input.sendEmail === false;
    let emailId: string | null = null;
    let emailStatus: DecisionItem['emailStatus'] = null;
    if (owner?.email && !suppressEmail) {
      const sent = await sendEmail(env, {
        eventId: event.id,
        to: owner.email,
        toName: owner.name || null,
        templateKey,
        subject: tidy(renderTemplate(subject, vars)),
        text: tidy(renderTemplate(body, vars)),
        subjectType: 'submission',
        subjectId: sub.id,
      });
      emailId = sent.id;
      emailStatus = sent.status;
      result.emailed++;
      if (sent.status === 'simulated') result.simulated++;
    }

    const detail = !owner?.email
      ? 'No speaker email on file — status changed without an email'
      : suppressEmail
        ? 'Email suppressed (sendEmail: false) — status changed without an email' +
          (confirmationLink ? ' · confirmation link minted' : '')
        : `Decision email sent to ${owner.email} (template “${result.templateName}”)` +
          (individual ? ' · individual feedback merged' : '') +
          (confirmationLink ? ' · confirmation requested' : '');
    await logActivity(env.DB, {
      eventId: event.id,
      subjectType: 'submission',
      subjectId: sub.id,
      actor: input.actorName,
      action: DECISION_PAST[input.decision],
      detail,
    });

    result.items.push({
      id: sub.id,
      seq: sub.seq,
      title: sub.title,
      status,
      to: owner?.email ?? null,
      emailId,
      emailStatus,
      sessionId,
      sessionCreated,
      confirmationLink,
    });
  }

  return result;
}
