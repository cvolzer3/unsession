/**
 * API domain: speakers, task templates and the review loop (spec C parity
 * round 2). Complements the round-1 tools (list_speakers, update_speaker,
 * assign_task, complete_task, list_tasks) with the rest of the admin Speakers
 * surface: template CRUD with snapshot pinning, rule previews, deliverable
 * review (approve / request changes), the two-phase reminder queue, direct
 * speaker email, organizer-created speaker profiles, and content-version
 * history/restore for sessions and speaker profiles.
 */
import type { Hono } from 'hono';
import type { Bindings, Event } from '../types';
import { apiActor, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import {
  bad,
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
import { all, jsonParse, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { renderTemplate, sendEmail } from '../lib/email';
import * as T from '../lib/tasks';
import { queueTaskReminder } from '../lib/reminder-queue';
import { addContactToEvent, upsertOrgContact } from '../lib/org-contacts';
import { linksJson, normalizeLinks, type SpeakerLinks } from '../lib/speaker-links';
import {
  listContentVersions,
  recordContentVersion,
  restoreSummary,
  sessionSnapshotOf,
  snapshotOf,
  speakerSnapshotOf,
  type SessionSnapshot,
  type SpeakerSnapshot,
} from '../lib/content-versions';

/* ---------------------------------------------------------- task templates */

function shapeTemplate(t: T.TaskTemplateRow, counts?: { open: number; done: number; pendingReview: number }) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    type: t.type,
    target: t.target,
    trigger: t.trigger,
    required: !!t.required,
    lockOnComplete: !!t.lock_on_complete,
    due: jsonParse(t.due_json, T.DEFAULT_DUE),
    grace: jsonParse(t.grace_json ?? 'null', T.DEFAULT_GRACE),
    clauses: jsonParse<T.ClauseSpec[]>(t.clauses_json, []),
    reminders: jsonParse(t.reminders_json, { on: true, days: [7, 2], subject: T.REM_SUBJ, body: T.REM_BODY }),
    settings: jsonParse<T.TaskSettings>(t.settings_json, {}),
    archived: !!t.archived,
    builtinKey: t.builtin_key ?? null,
    instances: counts ?? null,
    createdAt: t.created_at,
  };
}

export async function listTaskTemplates(env: Bindings, auth: ApiAuth, ref: string) {
  const event = await resolveEvent(env, auth, ref);
  const [templates, counts] = await Promise.all([
    all<T.TaskTemplateRow>(env.DB, `SELECT * FROM task_templates WHERE event_id = ? ORDER BY created_at`, event.id),
    all<{ template_id: string; status: string; n: number }>(
      env.DB,
      `SELECT template_id, status, COUNT(*) AS n FROM tasks WHERE event_id = ? AND template_id IS NOT NULL GROUP BY template_id, status`,
      event.id
    ),
  ]);
  const byTemplate = new Map<string, { open: number; done: number; pendingReview: number }>();
  for (const c of counts) {
    const cur = byTemplate.get(c.template_id) ?? { open: 0, done: 0, pendingReview: 0 };
    if (c.status === 'open') cur.open += c.n;
    else if (c.status === 'done') cur.done += c.n;
    else if (c.status === 'pending_review') cur.pendingReview += c.n;
    byTemplate.set(c.template_id, cur);
  }
  return templates.map((t) => shapeTemplate(t, byTemplate.get(t.id) ?? { open: 0, done: 0, pendingReview: 0 }));
}

const TASK_TYPES: T.TaskType[] = ['checkbox', 'file', 'form', 'profile'];
const TASK_TARGETS: T.TaskTargetKind[] = ['speaker', 'session'];
const TASK_TRIGGERS: T.TemplateTrigger[] = ['acceptance', 'confirmation', 'manual'];

export type SaveTaskTemplateInput = {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  target?: string;
  trigger?: string;
  required?: boolean;
  lockOnComplete?: boolean;
  settings?: T.TaskSettings;
  due?: T.DueSpec;
  grace?: T.GraceSpec;
  clauses?: T.ClauseSpec[];
  reminders?: T.ReminderSpec;
  /** Update only: 'future' (default) or 'open' — re-date open instances to the new rule. */
  applyMode?: string;
};

/**
 * CREATE or UPDATE a task template (id present = update; omitted fields keep
 * their values). Editing first pins the old wording onto live instances so
 * speakers never see silently rewritten tasks; applyMode 'open' then re-dates
 * open instances to the new definition.
 */
export async function saveTaskTemplate(env: Bindings, auth: ApiAuth, ref: string, input: SaveTaskTemplateInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const actor = apiActor(auth);

  const existing = input.id
    ? await one<T.TaskTemplateRow>(env.DB, `SELECT * FROM task_templates WHERE id = ? AND event_id = ?`, input.id, event.id)
    : null;
  if (input.id && !existing) throw notFound('Template not found');

  const name = (input.name ?? existing?.name ?? '').trim();
  if (!name) throw bad('Name the template first');
  const type = (input.type ?? existing?.type ?? '') as T.TaskType;
  if (!TASK_TYPES.includes(type)) throw bad(`type must be one of ${TASK_TYPES.join(', ')}`);
  const target = (input.target ?? existing?.target ?? 'speaker') as T.TaskTargetKind;
  if (!TASK_TARGETS.includes(target)) throw bad(`target must be one of ${TASK_TARGETS.join(', ')}`);
  const trigger = (input.trigger ?? existing?.trigger ?? 'manual') as T.TemplateTrigger;
  if (!TASK_TRIGGERS.includes(trigger)) throw bad(`trigger must be one of ${TASK_TRIGGERS.join(', ')}`);

  const due = input.due ?? (existing ? jsonParse(existing.due_json, T.DEFAULT_DUE) : T.DEFAULT_DUE);
  const grace = input.grace ?? (existing ? jsonParse(existing.grace_json ?? 'null', T.DEFAULT_GRACE) : T.DEFAULT_GRACE);
  const clauses = input.clauses ?? (existing ? jsonParse<T.ClauseSpec[]>(existing.clauses_json, []) : []);
  const reminders =
    input.reminders ??
    (existing
      ? jsonParse(existing.reminders_json, { on: true, days: [7, 2], subject: T.REM_SUBJ, body: T.REM_BODY })
      : { on: true, days: [7, 2], subject: T.REM_SUBJ, body: T.REM_BODY });
  const settings = input.settings ?? (existing ? jsonParse<T.TaskSettings>(existing.settings_json, {}) : {});

  const cols = [
    name,
    input.description ?? existing?.description ?? '',
    type,
    target,
    JSON.stringify(settings),
    (input.required ?? !!existing?.required) ? 1 : 0,
    (input.lockOnComplete ?? !!existing?.lock_on_complete) ? 1 : 0,
    JSON.stringify(due),
    JSON.stringify(grace),
    trigger,
    JSON.stringify(clauses),
    JSON.stringify(reminders),
  ];

  if (existing) {
    // Pin the wording speakers have already seen onto every live instance
    // before the template changes underneath them (tasks-spec §4.8.3).
    await run(
      env.DB,
      `UPDATE tasks SET snapshot_json = ?
        WHERE template_id = ? AND snapshot_json IS NULL AND status != 'cancelled'`,
      JSON.stringify({ name: existing.name, description: existing.description }),
      existing.id
    );
    await run(
      env.DB,
      `UPDATE task_templates SET name = ?, description = ?, type = ?, target = ?, settings_json = ?, required = ?,
         lock_on_complete = ?, due_json = ?, grace_json = ?, trigger = ?, clauses_json = ?, reminders_json = ?
       WHERE id = ?`,
      ...cols,
      existing.id
    );
    let updated = 0;
    if (input.applyMode === 'open') {
      // Open instances follow the new definition: drop the pin and re-date them.
      // Completed instances keep their snapshot and never change.
      const open = await all<T.TaskRow>(
        env.DB,
        `SELECT * FROM tasks WHERE template_id = ? AND status IN ('open','pending_review')`,
        existing.id
      );
      for (const t of open) {
        const nextDue = T.computeDueDate(due, event.start_date, t.created_at.slice(0, 10));
        await run(env.DB, `UPDATE tasks SET due_date = ?, snapshot_json = NULL WHERE id = ?`, nextDue, t.id);
      }
      updated = open.length;
    }
    await logActivity(env.DB, {
      eventId: event.id,
      subjectType: 'task',
      subjectId: existing.id,
      actor,
      action: 'Task template saved',
      detail:
        input.applyMode === 'open'
          ? `“${name}” — ${updated} open instances updated, completed ones untouched`
          : `“${name}” — future assignments only`,
    });
    const fresh = (await one<T.TaskTemplateRow>(env.DB, `SELECT * FROM task_templates WHERE id = ?`, existing.id))!;
    return { ...shapeTemplate(fresh), openInstancesUpdated: input.applyMode === 'open' ? updated : 0 };
  }

  const id = newId('tsk');
  await run(
    env.DB,
    `INSERT INTO task_templates (id, event_id, name, description, type, target, settings_json, required,
       lock_on_complete, due_json, grace_json, trigger, clauses_json, reminders_json, archived, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    id,
    event.id,
    ...cols,
    now()
  );
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'task',
    subjectId: id,
    actor,
    action: 'Task template created',
    detail: `“${name}” · ${trigger}`,
  });
  const fresh = (await one<T.TaskTemplateRow>(env.DB, `SELECT * FROM task_templates WHERE id = ?`, id))!;
  return shapeTemplate(fresh);
}

/** ARCHIVE (or restore) a template — archived templates stop assigning; open instances stay. */
export async function archiveTaskTemplate(env: Bindings, auth: ApiAuth, id: string) {
  requireWrite(auth);
  const tpl = await one<T.TaskTemplateRow>(env.DB, `SELECT * FROM task_templates WHERE id = ?`, (id ?? '').trim());
  if (!tpl) throw notFound('Template not found');
  const event = await eventOf(env, auth, tpl.event_id);
  const next = tpl.archived ? 0 : 1;
  await run(env.DB, `UPDATE task_templates SET archived = ? WHERE id = ?`, next, tpl.id);
  const open = await one<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM tasks WHERE template_id = ? AND status IN ('open','pending_review')`,
    tpl.id
  );
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'task',
    subjectId: tpl.id,
    actor: apiActor(auth),
    action: next ? 'Task template archived' : 'Task template restored',
    detail: tpl.name,
  });
  return { id: tpl.id, name: tpl.name, archived: !!next, openInstancesKept: open?.n ?? 0 };
}

/** Who would an assignment rule reach right now? Read-only preview. */
export async function previewTaskRule(
  env: Bindings,
  auth: ApiAuth,
  ref: string,
  input: { trigger?: string; clauses?: T.ClauseSpec[] }
) {
  const event = await resolveEvent(env, auth, ref);
  const trigger = TASK_TRIGGERS.includes(input.trigger as T.TemplateTrigger)
    ? (input.trigger as T.TemplateTrigger)
    : 'acceptance';
  return T.previewTemplateMatch(env, event.id, {
    trigger,
    clauses: Array.isArray(input.clauses) ? input.clauses : [],
  });
}

/* ------------------------------------------------------------------- tasks */

async function taskByRef(env: Bindings, auth: ApiAuth, taskId: string) {
  const task = await one<T.TaskRow>(env.DB, `SELECT * FROM tasks WHERE id = ?`, (taskId ?? '').trim());
  if (!task) throw notFound('Task not found');
  const event = await eventOf(env, auth, task.event_id);
  const name = await T.taskLabel(env, task);
  return { task, event, name };
}

/** REMOVE (cancel) an open task — completed tasks are kept for the record. */
export async function removeTask(env: Bindings, auth: ApiAuth, taskId: string) {
  requireWrite(auth);
  const { task, event, name } = await taskByRef(env, auth, taskId);
  if (task.status === 'done') throw bad('Completed tasks are kept for the record');
  await run(env.DB, `UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?`, now(), task.id);
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'task',
    subjectId: task.id,
    actor: apiActor(auth),
    action: 'Task removed',
    detail: `“${name}”`,
  });
  return { id: task.id, name, status: 'cancelled' };
}

export type ReviewTaskInput = { action?: string; message?: string };

/**
 * REVIEW a pending_review deliverable: approve, or request changes with a
 * message — which EMAILS every speaker who can act on the task.
 */
export async function reviewTask(env: Bindings, auth: ApiAuth, taskId: string, input: ReviewTaskInput) {
  requireWrite(auth);
  const { task, event, name } = await taskByRef(env, auth, taskId);
  const actor = apiActor(auth);

  if (input.action === 'approve') {
    await T.approveTask(env, task, actor);
    return { id: task.id, name, status: 'done', approved: true };
  }
  if (input.action !== 'request_changes') throw bad('action must be approve or request_changes');

  const message = (input.message ?? '').trim();
  if (!message) throw bad('Add a short message — we never deny silently');
  await T.requestChanges(env, task, message, actor);

  // Notify every speaker who can act on it (session tasks reach all co-speakers).
  const recipients = task.speaker_profile_id
    ? await all<{ name: string; email: string }>(
        env.DB,
        `SELECT name, email FROM speaker_profiles WHERE id = ?`,
        task.speaker_profile_id
      )
    : await all<{ name: string; email: string }>(
        env.DB,
        `SELECT sp.name, sp.email FROM speaker_profiles sp
           JOIN session_speakers ss ON ss.speaker_profile_id = sp.id WHERE ss.session_id = ?`,
        task.session_id ?? ''
      );
  for (const r of recipients) {
    await sendEmail(env, {
      eventId: event.id,
      to: r.email,
      toName: r.name,
      templateKey: 'task_nag',
      subject: `Changes requested: “${name}” — ${event.name}`,
      text:
        `Hi ${r.name},\n\nWe had a look at your upload for “${name}” and need one change:\n\n${message}\n\n` +
        `Re-upload from your speaker portal — your previous file is kept as a version:\n${env.APP_ORIGIN}/${event.slug}/portal\n\n— The ${event.name} program team`,
      subjectType: 'task',
      subjectId: task.id,
    });
  }
  return { id: task.id, name, status: 'open', changesRequested: true, emailed: recipients.length };
}

export type QueueTaskReminderInput = { speakerProfileId?: string; taskId?: string };

/**
 * QUEUE task reminder(s) for a speaker into the outbox (two-phase, like
 * decisions). One task, or every open task when taskId is omitted; everything
 * queued for a speaker goes out as ONE email when send_outbox runs.
 */
export async function queueTaskReminders(env: Bindings, auth: ApiAuth, input: QueueTaskReminderInput) {
  requireWrite(auth);
  const actorName = apiActor(auth);

  if (input.taskId) {
    const { task, event, name } = await taskByRef(env, auth, input.taskId);
    if (task.status === 'done') throw bad('Already complete — no reminder needed');
    const speakerId = input.speakerProfileId ?? task.speaker_profile_id;
    if (!speakerId) throw bad('Pass speakerProfileId — session tasks need to know which speaker to remind');
    const profile = await one<{ id: string; name: string }>(
      env.DB,
      `SELECT id, name FROM speaker_profiles WHERE id = ? AND event_id = ?`,
      speakerId,
      event.id
    );
    if (!profile) throw notFound('Speaker not found');
    await queueTaskReminder(env, {
      eventId: event.id,
      taskId: task.id,
      speakerProfileId: profile.id,
      taskName: name,
      actorName,
    });
    return { queued: 1, speaker: profile.name, tasks: [name] };
  }

  const profile = await one<{ id: string; name: string; event_id: string }>(
    env.DB,
    `SELECT id, name, event_id FROM speaker_profiles WHERE id = ?`,
    input.speakerProfileId ?? ''
  );
  if (!profile) throw notFound('Speaker not found');
  const event = await eventOf(env, auth, profile.event_id);

  const sessionIds = (
    await all<{ session_id: string }>(env.DB, `SELECT session_id FROM session_speakers WHERE speaker_profile_id = ?`, profile.id)
  ).map((r) => r.session_id);
  const open = T.dedupeTasks(
    await all<T.TaskRow & { tpl_name: string | null }>(
      env.DB,
      `SELECT t.*, tt.name AS tpl_name
         FROM tasks t LEFT JOIN task_templates tt ON tt.id = t.template_id
        WHERE t.event_id = ? AND t.status NOT IN ('cancelled','done')
          AND (t.speaker_profile_id = ?${sessionIds.length ? ` OR t.session_id IN (${sessionIds.map(() => '?').join(',')})` : ''})`,
      event.id,
      profile.id,
      ...sessionIds
    )
  );
  if (!open.length) throw bad(`Nothing to remind — ${profile.name} has no open tasks`);

  const names: string[] = [];
  for (const t of open) {
    const name =
      T.snapshotOf(t)?.name ??
      t.tpl_name ??
      jsonParse<T.OneOffSpec>(t.one_off_json, { name: 'Task', type: 'checkbox' }).name;
    names.push(name);
    await queueTaskReminder(env, {
      eventId: event.id,
      taskId: t.id,
      speakerProfileId: profile.id,
      taskName: name,
      actorName,
    });
  }
  return { queued: open.length, speaker: profile.name, tasks: names };
}

/* ---------------------------------------------------------------- speakers */

export type EmailSpeakerInput = { speakerProfileId?: string; subject?: string; body?: string };

/** EMAIL one speaker directly, immediately. {{speaker_name}} {{event_name}} {{portal_link}} merge. */
export async function emailSpeaker(env: Bindings, auth: ApiAuth, input: EmailSpeakerInput) {
  requireWrite(auth);
  const profile = await one<{ id: string; name: string; email: string; event_id: string }>(
    env.DB,
    `SELECT id, name, email, event_id FROM speaker_profiles WHERE id = ?`,
    input.speakerProfileId ?? ''
  );
  if (!profile) throw notFound('Speaker not found');
  const event = await eventOf(env, auth, profile.event_id);
  const subject = (input.subject ?? '').trim();
  if (!subject) throw bad('Add a subject line');

  const vars = {
    speaker_name: profile.name,
    event_name: event.name,
    portal_link: `${env.APP_ORIGIN}/${event.slug}/portal`,
  };
  const res = await sendEmail(env, {
    eventId: event.id,
    to: profile.email,
    toName: profile.name,
    templateKey: null,
    subject: renderTemplate(subject, vars),
    text: renderTemplate(input.body ?? '', vars),
    subjectType: 'speaker',
    subjectId: profile.id,
  });
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'speaker',
    subjectId: profile.id,
    actor: apiActor(auth),
    action: 'Email sent',
    detail: subject,
  });
  return { to: profile.email, speaker: profile.name, status: res.status };
}

export type CreateSpeakerInput = {
  name?: string;
  email?: string;
  bio?: string;
  jobTitle?: string;
  company?: string;
  pronouns?: string;
  links?: SpeakerLinks;
};

/**
 * CREATE a speaker profile on an event (organizer-added, like the CSV import /
 * directory add): upserts the org-directory contact, then adds them to the
 * event — idempotent by email. Fields never overwrite existing directory data.
 */
export async function createSpeaker(env: Bindings, auth: ApiAuth, ref: string, input: CreateSpeakerInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, ref);
  const email = (input.email ?? '').trim();
  if (!email.includes('@')) throw bad('A valid email is required — speakers are keyed by email');

  const contactId = await upsertOrgContact(
    env.DB,
    event.org_id,
    {
      email,
      name: (input.name ?? '').trim(),
      bio: (input.bio ?? '').trim() || undefined,
      job_title: (input.jobTitle ?? '').trim() || undefined,
      company: (input.company ?? '').trim() || undefined,
      pronouns: (input.pronouns ?? '').trim() || undefined,
      links_json: input.links ? linksJson(normalizeLinks(input.links)) ?? undefined : undefined,
    },
    'manual'
  );
  if (!contactId) throw bad('A valid email is required');
  const res = await addContactToEvent(env.DB, contactId, event.id);
  if (!res) throw bad('Could not add the speaker to this event');
  if (res.created) {
    await logActivity(env.DB, {
      eventId: event.id,
      subjectType: 'speaker',
      subjectId: res.profileId,
      actor: apiActor(auth),
      action: 'Speaker added',
      detail: `${(input.name ?? '').trim() || email} · via API`,
    });
  }
  const profile = (await one<{ id: string; name: string; email: string; slug: string }>(
    env.DB,
    `SELECT id, name, email, slug FROM speaker_profiles WHERE id = ?`,
    res.profileId
  ))!;
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    profileUrl: `${env.APP_ORIGIN}/${event.slug}/speakers/${profile.slug}`,
    created: res.created,
    alreadyOnEvent: !res.created,
  };
}

type FullProfileRow = {
  id: string;
  event_id: string;
  name: string;
  email: string;
  bio: string;
  job_title: string | null;
  company: string | null;
  tagline: string | null;
  pronouns: string | null;
  links_json: string | null;
  headshot_file_id: string | null;
  travel_notes: string | null;
  slug: string;
  created_at: string;
};

/** One speaker in full: profile, travel notes, sessions, tasks (with latest files), version history. */
export async function getSpeaker(env: Bindings, auth: ApiAuth, id: string) {
  const profile = await one<FullProfileRow>(env.DB, `SELECT * FROM speaker_profiles WHERE id = ?`, (id ?? '').trim());
  if (!profile) throw notFound('Speaker not found');
  const event = await eventOf(env, auth, profile.event_id);

  const sessions = await all<{ id: string; title: string; status: string; day: number | null }>(
    env.DB,
    `SELECT s.id, s.title, s.status, s.day FROM session_speakers ss JOIN sessions s ON s.id = ss.session_id
      WHERE ss.speaker_profile_id = ? ORDER BY ss.position`,
    profile.id
  );
  const sessionIds = sessions.map((s) => s.id);
  const tasks = T.dedupeTasks(
    await all<T.TaskRow & { tpl_name: string | null; tpl_type: string | null }>(
      env.DB,
      `SELECT t.*, tt.name AS tpl_name, tt.type AS tpl_type
         FROM tasks t LEFT JOIN task_templates tt ON tt.id = t.template_id
        WHERE t.event_id = ? AND t.status != 'cancelled'
          AND (t.speaker_profile_id = ?${sessionIds.length ? ` OR t.session_id IN (${sessionIds.map(() => '?').join(',')})` : ''})`,
      event.id,
      profile.id,
      ...sessionIds
    )
  );
  const taskIds = tasks.map((t) => t.id);
  const files = taskIds.length
    ? await all<{ id: string; subject_id: string; filename: string; version: number; created_at: string }>(
        env.DB,
        `SELECT id, subject_id, filename, version, created_at FROM files
          WHERE subject_type = 'task' AND subject_id IN (${taskIds.map(() => '?').join(',')})
          ORDER BY version DESC`,
        ...taskIds
      )
    : [];
  const latestFile = new Map<string, { id: string; filename: string; version: number; createdAt: string }>();
  for (const f of files) {
    if (!latestFile.has(f.subject_id)) {
      latestFile.set(f.subject_id, { id: f.id, filename: f.filename, version: f.version, createdAt: f.created_at });
    }
  }
  const versions = await listContentVersions(env.DB, 'speaker', profile.id);

  const today = T.todayISO();
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    bio: profile.bio,
    jobTitle: profile.job_title,
    company: profile.company,
    tagline: profile.tagline,
    pronouns: profile.pronouns,
    links: jsonParse<Record<string, string>>(profile.links_json, {}),
    headshotUrl: profile.headshot_file_id ? `${env.APP_ORIGIN}/files/${profile.headshot_file_id}` : null,
    profileUrl: `${env.APP_ORIGIN}/${event.slug}/speakers/${profile.slug}`,
    travelNotes: profile.travel_notes,
    sessions,
    tasks: tasks.map((t) => {
      const oneOff = t.template_id ? null : jsonParse<T.OneOffSpec>(t.one_off_json, { name: 'Task', type: 'checkbox' });
      const file = latestFile.get(t.id) ?? null;
      return {
        id: t.id,
        name: T.snapshotOf(t)?.name ?? t.tpl_name ?? oneOff?.name ?? 'Task',
        type: t.tpl_type ?? oneOff?.type ?? 'checkbox',
        status: t.status,
        dueDate: t.due_date,
        overdue: T.isOverdue(t, today),
        reviewNote: t.review_note,
        completedBy: t.completed_by,
        completedAt: t.completed_at,
        latestFile: file ? { ...file, url: `${env.APP_ORIGIN}/files/${file.id}` } : null,
      };
    }),
    versionHistory: versions.map((v) => ({
      versionId: v.id,
      editor: v.editor,
      summary: v.summary,
      createdAt: v.created_at,
    })),
  };
}

/* --------------------------------------------------------- content versions */

const VERSION_SUBJECTS = ['session', 'speaker'];

async function versionSubject(
  env: Bindings,
  auth: ApiAuth,
  subjectType: string,
  subjectId: string
): Promise<{ event: Event }> {
  if (!VERSION_SUBJECTS.includes(subjectType)) throw bad('subjectType must be session or speaker');
  const table = subjectType === 'session' ? 'sessions' : 'speaker_profiles';
  const row = await one<{ event_id: string }>(env.DB, `SELECT event_id FROM ${table} WHERE id = ?`, subjectId);
  if (!row) throw notFound(`${subjectType === 'session' ? 'Session' : 'Speaker'} not found`);
  return { event: await eventOf(env, auth, row.event_id) };
}

/** Version history for a session's title/abstract or a speaker profile. */
export async function listContentVersionsApi(env: Bindings, auth: ApiAuth, subjectType: string, subjectId: string) {
  await versionSubject(env, auth, subjectType, subjectId);
  const versions = await listContentVersions(env.DB, subjectType as 'session' | 'speaker', subjectId);
  return versions.map((v) => ({
    versionId: v.id,
    editor: v.editor,
    summary: v.summary,
    snapshot: jsonParse<Record<string, unknown>>(v.snapshot_json, {}),
    createdAt: v.created_at,
  }));
}

/** RESTORE a content version — applies the snapshot and appends a new version (history is append-only). */
export async function restoreContentVersion(
  env: Bindings,
  auth: ApiAuth,
  subjectType: string,
  subjectId: string,
  versionId: string
) {
  requireWrite(auth);
  const { event } = await versionSubject(env, auth, subjectType, subjectId);
  const actor = apiActor(auth);
  const version = (
    await listContentVersions(env.DB, subjectType as 'session' | 'speaker', subjectId)
  ).find((v) => v.id === versionId);
  if (!version) throw notFound('Version not found');

  if (subjectType === 'session') {
    const cur = (await one<{ id: string; title: string; abstract: string; created_at: string }>(
      env.DB,
      `SELECT id, title, abstract, created_at FROM sessions WHERE id = ?`,
      subjectId
    ))!;
    const snap = snapshotOf<SessionSnapshot>(version, sessionSnapshotOf(cur));
    const title = (snap.title ?? '').trim() || cur.title;
    const abstract = String(snap.abstract ?? '');
    await run(env.DB, `UPDATE sessions SET title = ?, abstract = ?, updated_at = ? WHERE id = ?`, title, abstract, now(), cur.id);
    await recordContentVersion(env.DB, {
      eventId: event.id,
      subjectType: 'session',
      subjectId: cur.id,
      editor: actor,
      before: sessionSnapshotOf(cur),
      after: { title, abstract },
      subjectCreatedAt: cur.created_at,
      summary: restoreSummary(version),
    });
    await logActivity(env.DB, {
      eventId: event.id,
      subjectType: 'session',
      subjectId: cur.id,
      actor,
      action: 'Version restored',
      detail: title,
    });
    return { subjectType, subjectId, restored: true, title };
  }

  const cur = (await one<FullProfileRow>(env.DB, `SELECT * FROM speaker_profiles WHERE id = ?`, subjectId))!;
  const snap = snapshotOf<SpeakerSnapshot>(version, speakerSnapshotOf(cur));
  const name = (snap.name ?? '').trim() || cur.name;
  // Keep the current photo rather than restore a pointer to a file that no longer exists.
  let headshot = snap.headshot_file_id ?? null;
  if (headshot && !(await one(env.DB, `SELECT 1 FROM files WHERE id = ?`, headshot))) {
    headshot = cur.headshot_file_id;
  }
  const after = {
    name,
    tagline: snap.tagline ?? null,
    bio: String(snap.bio ?? ''),
    pronouns: snap.pronouns ?? null,
    links_json: snap.links_json ?? null,
    headshot_file_id: headshot,
  };
  await run(
    env.DB,
    `UPDATE speaker_profiles SET name = ?, tagline = ?, bio = ?, pronouns = ?, links_json = ?, headshot_file_id = ? WHERE id = ?`,
    after.name,
    after.tagline,
    after.bio,
    after.pronouns,
    after.links_json,
    after.headshot_file_id,
    cur.id
  );
  await recordContentVersion(env.DB, {
    eventId: event.id,
    subjectType: 'speaker',
    subjectId: cur.id,
    editor: actor,
    before: speakerSnapshotOf(cur),
    after,
    subjectCreatedAt: cur.created_at,
    summary: restoreSummary(version),
  });
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'speaker',
    subjectId: cur.id,
    actor,
    action: 'Version restored',
    detail: after.name,
  });
  return { subjectType, subjectId, restored: true, name: after.name };
}

/* -------------------------------------------------------------- REST routes */

export function registerSpeakerTaskRoutes(app: Hono<ApiCtx>): void {
  app.get('/api/v1/events/:event/task-templates', handle((c) => listTaskTemplates(c.env, c.var.apiAuth, p(c, 'event'))));
  app.post(
    '/api/v1/events/:event/task-templates',
    handle(async (c) => saveTaskTemplate(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.post('/api/v1/task-templates/:id/archive', handle((c) => archiveTaskTemplate(c.env, c.var.apiAuth, p(c, 'id'))));
  app.post(
    '/api/v1/events/:event/task-templates/preview',
    handle(async (c) => previewTaskRule(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.post('/api/v1/tasks/:id/remove', handle((c) => removeTask(c.env, c.var.apiAuth, p(c, 'id'))));
  app.post('/api/v1/tasks/:id/review', handle(async (c) => reviewTask(c.env, c.var.apiAuth, p(c, 'id'), await jsonBody(c))));
  app.post('/api/v1/task-reminders', handle(async (c) => queueTaskReminders(c.env, c.var.apiAuth, await jsonBody(c))));
  app.post('/api/v1/speakers/email', handle(async (c) => emailSpeaker(c.env, c.var.apiAuth, await jsonBody(c))));
  app.post(
    '/api/v1/events/:event/speakers',
    handle(async (c) => createSpeaker(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.get('/api/v1/speakers/:id', handle((c) => getSpeaker(c.env, c.var.apiAuth, p(c, 'id'))));
  app.get(
    '/api/v1/content-versions/:subjectType/:id',
    handle((c) => listContentVersionsApi(c.env, c.var.apiAuth, p(c, 'subjectType'), p(c, 'id')))
  );
  app.post(
    '/api/v1/content-versions/:subjectType/:id/restore',
    handle(async (c) => {
      const body = await jsonBody<{ versionId?: string }>(c);
      return restoreContentVersion(c.env, c.var.apiAuth, p(c, 'subjectType'), p(c, 'id'), str(body.versionId));
    })
  );
}

/* --------------------------------------------------------------- MCP tools */

export const SPEAKER_TASK_TOOLS: Tool[] = [
  {
    name: 'list_task_templates',
    description:
      'List an event’s task templates: type (checkbox|file|form|profile), target (speaker|session), trigger (acceptance|confirmation|manual), due rule, assignment clauses, reminder config, archived flag, and live instance counts. Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => listTaskTemplates(env, auth, str(a.event)),
  },
  {
    name: 'save_task_template',
    description:
      'CREATE or UPDATE a task template (id present = update; omitted fields keep their values). Editing pins the old wording onto live instances first, so speakers never see tasks silently rewritten; applyMode "open" re-dates open instances to the new rule (completed ones never change). Trigger rules assign on future acceptance/confirmation only — never retroactively. Activity-logged; saving sends no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        id: { type: 'string', description: 'Template id (tsk_…) to update; omit to create.' },
        name: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['checkbox', 'file', 'form', 'profile'] },
        target: { type: 'string', enum: ['speaker', 'session'] },
        trigger: { type: 'string', enum: ['acceptance', 'confirmation', 'manual'] },
        required: { type: 'boolean' },
        lockOnComplete: { type: 'boolean' },
        settings: { type: 'object', description: 'Type-specific settings (file caps, review flag, mini-form key…).' },
        due: { type: 'object', description: '{mode: "after"|"before"|"abs", n, date?} — days after assignment / before event / absolute.' },
        grace: { type: 'object', description: '{mode: "none"|"lock", days}.' },
        clauses: { type: 'array', items: { type: 'object' }, description: 'Assignment rule clauses [{field, value}].' },
        reminders: { type: 'object', description: '{on, days: [7,2], subject, body} — automatic due-date reminders.' },
        applyMode: { type: 'string', enum: ['future', 'open'], description: 'Update only. Default future.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => saveTaskTemplate(env, auth, str(a.event), a as SaveTaskTemplateInput),
  },
  {
    name: 'archive_task_template',
    description: 'ARCHIVE a template (stops assigning; open instances kept) or RESTORE an archived one — the call toggles.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Template id (tsk_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => archiveTaskTemplate(env, auth, str(a.id)),
  },
  {
    name: 'preview_task_rule',
    description:
      'Preview who an assignment rule reaches right now: matching speakers/sessions for a trigger + clauses combination, before saving the template. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        trigger: { type: 'string', enum: ['acceptance', 'confirmation', 'manual'] },
        clauses: { type: 'array', items: { type: 'object' } },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) =>
      previewTaskRule(env, auth, str(a.event), {
        trigger: a.trigger === undefined ? undefined : str(a.trigger),
        clauses: a.clauses as T.ClauseSpec[] | undefined,
      }),
  },
  {
    name: 'remove_task',
    description: 'CANCEL an open task instance. Completed tasks are kept for the record and cannot be removed. Activity-logged; no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task instance id (tsi_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => removeTask(env, auth, str(a.id)),
  },
  {
    name: 'review_task',
    description:
      'REVIEW a pending_review deliverable: approve marks it done; request_changes (message required — we never deny silently) reopens it and EMAILS every speaker who can act on it, pointing at their portal. Activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task instance id (tsi_…).' },
        action: { type: 'string', enum: ['approve', 'request_changes'] },
        message: { type: 'string', description: 'Required for request_changes — what to fix.' },
      },
      required: ['id', 'action'],
      additionalProperties: false,
    },
    run: (env, auth, a) => reviewTask(env, auth, str(a.id), a as ReviewTaskInput),
  },
  {
    name: 'queue_task_reminder',
    description:
      'QUEUE task reminder(s) for a speaker into the outbox (two-phase, like decisions — nothing sends until send_outbox). One task via taskId, or every open task when omitted. Everything queued for a speaker goes out as ONE batched email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        speakerProfileId: { type: 'string', description: 'Speaker profile id (spk_…).' },
        taskId: { type: 'string', description: 'One task (tsi_…); omit to queue every open task.' },
      },
      required: ['speakerProfileId'],
      additionalProperties: false,
    },
    run: (env, auth, a) =>
      queueTaskReminders(env, auth, {
        speakerProfileId: str(a.speakerProfileId),
        taskId: a.taskId === undefined ? undefined : str(a.taskId),
      }),
  },
  {
    name: 'email_speaker',
    description:
      'EMAIL one speaker directly, immediately (not via the outbox). {{speaker_name}}, {{event_name}} and {{portal_link}} merge tags work in subject and body. Logged in the email log and activity feed.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        speakerProfileId: { type: 'string', description: 'Speaker profile id (spk_…).' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['speakerProfileId', 'subject', 'body'],
      additionalProperties: false,
    },
    run: (env, auth, a) => emailSpeaker(env, auth, a as EmailSpeakerInput),
  },
  {
    name: 'create_speaker',
    description:
      'CREATE a speaker profile on an event (organizer-added, keyed by email — idempotent, reports alreadyOnEvent). Also upserts the org contact directory, never overwriting existing directory data. Use update_speaker afterwards to change fields. Sends no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        name: { type: 'string' },
        email: { type: 'string' },
        bio: { type: 'string' },
        jobTitle: { type: 'string' },
        company: { type: 'string' },
        pronouns: { type: 'string' },
        links: { type: 'object', description: '{linkedin, x, website, other} URLs.' },
      },
      required: ['event', 'email'],
      additionalProperties: false,
    },
    run: (env, auth, a) => createSpeaker(env, auth, str(a.event), a as CreateSpeakerInput),
  },
  {
    name: 'get_speaker',
    description:
      'One speaker in full: profile fields, organizer-only travel & logistics notes, sessions, every task with status/due/review note and the latest uploaded file, and the profile version history. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Speaker profile id (spk_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => getSpeaker(env, auth, str(a.id)),
  },
  {
    name: 'list_content_versions',
    description:
      'Version history for a session’s title/abstract or a speaker profile — every edit with editor, summary and the full snapshot. History is append-only. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectType: { type: 'string', enum: ['session', 'speaker'] },
        id: { type: 'string', description: 'Session (ses_…) or speaker profile (spk_…) id.' },
      },
      required: ['subjectType', 'id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => listContentVersionsApi(env, auth, str(a.subjectType), str(a.id)),
  },
  {
    name: 'restore_content_version',
    description:
      'RESTORE a content version: applies the snapshot (session title/abstract, or speaker name/tagline/bio/pronouns/links/headshot) and appends a new version row — a restore is itself undoable. Activity-logged; no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        subjectType: { type: 'string', enum: ['session', 'speaker'] },
        id: { type: 'string', description: 'Session (ses_…) or speaker profile (spk_…) id.' },
        versionId: { type: 'string', description: 'Version id from list_content_versions.' },
      },
      required: ['subjectType', 'id', 'versionId'],
      additionalProperties: false,
    },
    run: (env, auth, a) => restoreContentVersion(env, auth, str(a.subjectType), str(a.id), str(a.versionId)),
  },
];
