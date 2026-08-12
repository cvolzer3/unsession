/**
 * Scheduled work (cron: every 15 min): the three reminder automations the spec calls for
 * (§4.7): task deadline nags, evaluator reminders, CFP-closing notices to
 * unsubmitted drafts. Every send goes through sendEmail (so it lands in the
 * email log) and the log itself is the dedup source — a reminder fires at most
 * once per subject per day, so the 15-minute cadence is safe.
 */
import { all, one, now } from './db';
import { sendEmail, renderTemplate } from './email';
import {
  parseReminders,
  parseDue,
  daysBetween,
  todayISO,
  type TaskTemplateRow,
} from './tasks';
import {
  loadPlans,
  loadSubmissions,
  loadEvaluations,
  planSubmissions,
  assignedFor,
  members,
  mergeTags,
} from './evals';
import type { Bindings } from '../types';

/** Free-plan CPU is tight — cap outbound work per tick; the rest catches up next tick. */
const MAX_SENDS_PER_TICK = 40;

type EventRow = { id: string; name: string; slug: string; start_date: string };

async function alreadySentToday(
  env: Bindings,
  templateKey: string,
  subjectId: string,
  to?: string
): Promise<boolean> {
  const today = todayISO();
  const row = to
    ? await one(
        env.DB,
        `SELECT 1 FROM emails WHERE template_key = ? AND subject_id = ? AND to_email = ? AND created_at >= ? LIMIT 1`,
        templateKey,
        subjectId,
        to,
        `${today}T00:00:00Z`
      )
    : await one(
        env.DB,
        `SELECT 1 FROM emails WHERE template_key = ? AND subject_id = ? AND created_at >= ? LIMIT 1`,
        templateKey,
        subjectId,
        `${today}T00:00:00Z`
      );
  return !!row;
}

/* ------------------------------------------------- 1 · task deadline nags */

async function taskReminders(env: Bindings, ev: EventRow, budget: { left: number }): Promise<void> {
  const rows = await all<{
    task_id: string;
    due_date: string;
    template_id: string;
    name: string;
    description: string;
    reminders_json: string;
    due_json: string;
    target_type: string;
    speaker_profile_id: string | null;
    session_id: string | null;
  }>(
    env.DB,
    `SELECT t.id AS task_id, t.due_date, t.target_type, t.speaker_profile_id, t.session_id,
            tt.id AS template_id, tt.name, tt.description, tt.reminders_json, tt.due_json
     FROM tasks t JOIN task_templates tt ON tt.id = t.template_id
     WHERE t.event_id = ? AND t.status = 'open' AND t.due_date IS NOT NULL AND tt.archived = 0`,
    ev.id
  );
  const today = todayISO();
  for (const r of rows) {
    if (budget.left <= 0) return;
    const rem = parseReminders(r);
    if (!rem.on || !rem.days.length) continue;
    const daysLeft = daysBetween(today, r.due_date);
    if (!rem.days.includes(daysLeft)) continue;
    if (await alreadySentToday(env, 'task_reminder', r.task_id)) continue;

    // Recipients: the speaker, or every co-speaker for session tasks.
    const recipients =
      r.target_type === 'speaker' && r.speaker_profile_id
        ? await all<{ name: string; email: string }>(
            env.DB,
            `SELECT name, email FROM speaker_profiles WHERE id = ?`,
            r.speaker_profile_id
          )
        : r.session_id
          ? await all<{ name: string; email: string }>(
              env.DB,
              `SELECT sp.name, sp.email FROM session_speakers ss JOIN speaker_profiles sp ON sp.id = ss.speaker_profile_id
               WHERE ss.session_id = ?`,
              r.session_id
            )
          : [];
    const session = r.session_id
      ? await one<{ title: string }>(env.DB, `SELECT title FROM sessions WHERE id = ?`, r.session_id)
      : null;

    for (const p of recipients) {
      if (budget.left <= 0) return;
      if (!p.email) continue;
      const vars = {
        speaker_name: p.name || p.email,
        task_name: r.name,
        event_name: ev.name,
        due_date: r.due_date,
        days_left: daysLeft === 0 ? 'due today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        portal_link: `${env.APP_ORIGIN}/${ev.slug}/portal`,
        session_title: session?.title ?? '',
      };
      await sendEmail(env, {
        eventId: ev.id,
        to: p.email,
        toName: p.name,
        templateKey: 'task_reminder',
        subject: renderTemplate(rem.subject, vars),
        text: renderTemplate(rem.body, vars),
        subjectType: 'task',
        subjectId: r.task_id,
      });
      budget.left--;
    }
  }
}

/* --------------------------------------------- 2 · evaluator reminders */

async function evaluatorReminders(env: Bindings, ev: EventRow, budget: { left: number }): Promise<void> {
  const [plans, subs, evals] = await Promise.all([
    loadPlans(env.DB, ev.id),
    loadSubmissions(env.DB, ev.id),
    loadEvaluations(env.DB, ev.id),
  ]);
  const today = todayISO();
  const tpl = await one<{ subject: string; body: string }>(
    env.DB,
    `SELECT subject, body FROM email_templates WHERE event_id = ? AND key = 'reminder'`,
    ev.id
  );
  if (!tpl) return;

  for (const plan of plans) {
    if (budget.left <= 0) return;
    const auto = plan.automation;
    if (!auto?.on || !plan.deadline) continue;
    const daysLeft = daysBetween(today, plan.deadline);
    const firesToday =
      (auto.d14 && daysLeft === 14) ||
      (auto.d7 && daysLeft === 7) ||
      (auto.d3 && daysLeft === 3) ||
      (auto.over && daysLeft === -1);
    if (!firesToday) continue;

    const inPlan = planSubmissions(plan, subs, evals);
    const chairs = plan.reviewers.filter((r) => r.role === 'chair');
    for (const reviewer of members(plan)) {
      if (budget.left <= 0) return;
      const mine = inPlan.filter((s) => assignedFor(plan, s).some((a) => a.userId === reviewer.userId));
      const done = mine.filter((s) =>
        evals.some((e) => e.planId === plan.id && e.submissionId === s.id && e.reviewerId === reviewer.userId)
      ).length;
      const remaining = mine.length - done;
      if (remaining < Math.max(1, auto.minLeft)) continue;

      // Cooldown: no automated nag if anything reminder-shaped went to them for this plan recently.
      const cooldownStart = new Date(Date.now() - Math.max(1, auto.cooldown) * 86_400_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      const recent = await one(
        env.DB,
        `SELECT 1 FROM emails WHERE template_key IN ('reminder','auto_reminder') AND subject_type = 'eval_plan'
         AND subject_id = ? AND to_email = ? AND created_at >= ? LIMIT 1`,
        plan.id,
        reviewer.email,
        cooldownStart
      );
      if (recent) continue;

      const vars = {
        first_name: (reviewer.name || reviewer.email).split(' ')[0],
        remaining: String(remaining),
        deadline: plan.deadline,
      };
      await sendEmail(env, {
        eventId: ev.id,
        to: reviewer.email,
        toName: reviewer.name,
        templateKey: 'auto_reminder',
        subject: mergeTags(tpl.subject, vars),
        text:
          mergeTags(tpl.body, vars) +
          `\n\nYour queue: ${env.APP_ORIGIN}/${ev.slug}/evaluate`,
        subjectType: 'eval_plan',
        subjectId: plan.id,
      });
      budget.left--;

      if (daysLeft === -1 && auto.over) {
        for (const chair of chairs) {
          if (budget.left <= 0) return;
          if (await alreadySentToday(env, 'auto_reminder_chair', plan.id, chair.email)) continue;
          await sendEmail(env, {
            eventId: ev.id,
            to: chair.email,
            toName: chair.name,
            templateKey: 'auto_reminder_chair',
            subject: `Overdue reviews on “${plan.name}”`,
            text: `Hi ${(chair.name || chair.email).split(' ')[0]},\n\n${reviewer.name} still has ${remaining} evaluation${remaining === 1 ? '' : 's'} outstanding on “${plan.name}” (deadline was ${plan.deadline}).\n\nPlan overview: ${env.APP_ORIGIN}/app/evaluation?tab=plans&plan=${plan.id}\n\n— Unsession`,
            subjectType: 'eval_plan',
            subjectId: plan.id,
          });
          budget.left--;
        }
      }
    }
  }
}

/* --------------------------------------- 3 · CFP-closing draft reminders */

const CFP_REMINDER_DAYS = [7, 2];

async function cfpClosingReminders(env: Bindings, ev: EventRow, budget: { left: number }): Promise<void> {
  const forms = await all<{ id: string; name: string; slug: string; closes_at: string }>(
    env.DB,
    `SELECT id, name, slug, closes_at FROM forms WHERE event_id = ? AND status = 'open' AND closes_at IS NOT NULL`,
    ev.id
  );
  const today = todayISO();
  for (const form of forms) {
    if (budget.left <= 0) return;
    const daysLeft = daysBetween(today, form.closes_at.slice(0, 10));
    if (!CFP_REMINDER_DAYS.includes(daysLeft)) continue;
    const drafts = await all<{ id: string; title: string; email: string; name: string | null }>(
      env.DB,
      `SELECT s.id, s.title, u.email, u.name FROM submissions s JOIN users u ON u.id = s.owner_user_id
       WHERE s.form_id = ? AND s.status = 'draft'`,
      form.id
    );
    for (const d of drafts) {
      if (budget.left <= 0) return;
      if (await alreadySentToday(env, 'cfp_closing', d.id)) continue;
      const who = (d.name || d.email).split(' ')[0];
      await sendEmail(env, {
        eventId: ev.id,
        to: d.email,
        toName: d.name,
        templateKey: 'cfp_closing',
        subject: `“${form.name}” closes in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — your draft is waiting`,
        text: `Hi ${who},\n\nYour draft${d.title ? ` “${d.title}”` : ''} for ${ev.name} isn’t submitted yet, and ${form.name} closes in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.\n\nPick it up where you left off:\n${env.APP_ORIGIN}/${ev.slug}/${form.slug}?draft=${d.id}\n\nDrafts don’t carry over after the deadline — hit submit when you’re ready.\n\n— The ${ev.name} program team`,
        subjectType: 'submission',
        subjectId: d.id,
      });
      budget.left--;
    }
  }
}

/* ------------------------------------------------------------------ main */

export async function runScheduledJobs(env: Bindings, event: ScheduledController): Promise<void> {
  const at = new Date(event.scheduledTime).toISOString();
  const budget = { left: MAX_SENDS_PER_TICK };
  let eventsScanned = 0;
  try {
    const events = await all<EventRow>(env.DB, `SELECT id, name, slug, start_date FROM events`);
    eventsScanned = events.length;
    for (const ev of events) {
      if (budget.left <= 0) break;
      await taskReminders(env, ev, budget);
      await evaluatorReminders(env, ev, budget);
      await cfpClosingReminders(env, ev, budget);
    }
  } catch (err) {
    console.error('[cron] scheduled jobs failed', err);
  }
  console.log(
    `[cron] runScheduledJobs cron=${event.cron} at=${at} events=${eventsScanned} sends=${MAX_SENDS_PER_TICK - budget.left}`
  );
}
