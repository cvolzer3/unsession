/**
 * `/app` — port of `Dashboard.dc.html` with every number computed from D1 for
 * the session's active event. Reworked per DECISIONS review R1: task-oriented
 * dashboard — KPI row, a full-width NEEDS ATTENTION feed with quick actions,
 * and a right rail (review progress / my reviews / deadlines).
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { AdminLayout, MONO, fmtDate, firstName } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, one } from '../lib/db';
import { loadEvalContext, reviewerQueue } from '../lib/evals';

const app = new Hono<Ctx>();

/**
 * Responsive layout for the dashboard. Everything that has to change below the
 * mobile breakpoint lives here; the rest stays inline (see SPECS/M-mobile.md).
 * The literal 768 is deliberate — importing MOBILE_MAX into a route module's
 * top-level template crashes the worker at startup.
 */
const PAGE_CSS = `
  .dash-wrap{padding:22px 28px;}
  .dash-empty{padding:24px 28px;}
  .dash-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px;}
  .dash-cols{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px;align-items:start;}
  .dash-att{display:flex;align-items:center;gap:10px;padding:11px 16px;}
  .dash-att-cta{margin-left:auto;padding:5px 12px;}
  .dash-dl{display:flex;align-items:baseline;gap:10px;padding:10px 16px;}
  .dash-dl-left{margin-left:auto;}
  .dash-pub{padding:9px 16px;}
  @media (max-width:768px){
    .dash-wrap{padding:16px 14px;}
    .dash-empty{padding:18px 14px;}
    .dash-kpis{grid-template-columns:repeat(2,1fr);gap:10px;}
    .dash-cols{grid-template-columns:minmax(0,1fr);}
    /* Dot in its own column, title/sub and the action stacked beside it, so a
       long title never squeezes the button off the row. */
    .dash-att{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 10px;align-items:start;padding:12px 14px;}
    .dash-att-dot{margin-top:5px;}
    .dash-att-cta{grid-column:2;justify-self:start;margin-left:0;padding:10px 14px;}
    .dash-dl{flex-wrap:wrap;gap:2px 10px;padding:11px 14px;}
    .dash-dl-what{order:3;flex:1 1 100%;min-width:0;}
    .dash-pub{padding:13px 14px;}
  }
`;

function hourIn(tz: string): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date());
    return Number(s);
  } catch {
    return new Date().getUTCHours();
  }
}

function greeting(tz: string): string {
  const h = hourIn(tz);
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function daysLeft(iso: string): number {
  const then = new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((then - Date.now()) / 86_400_000));
}

/**
 * WHERE clause + params selecting the submissions in scope for a plan's rules.
 * Honours `form`, `status` and `track`; `format`/`level` are not yet applied
 * (no seeded plan uses them) — the evaluation track (B3) owns the full engine.
 */
function planScope(eventId: string, rulesJson: string, optName: Map<string, string>) {
  let rules: { form?: string; status?: string; track?: string } = {};
  try {
    rules = JSON.parse(rulesJson);
  } catch {
    rules = {};
  }
  const where: string[] = ['s.event_id = ?'];
  const params: unknown[] = [eventId];
  if (rules.form && rules.form !== 'all') {
    where.push('s.form_id = ?');
    params.push(rules.form);
  }
  if (!rules.status || rules.status === 'active') where.push("s.status = 'in_review'");
  else if (rules.status !== 'all') {
    where.push('s.status = ?');
    params.push(rules.status);
  } else where.push("s.status <> 'draft'");
  if (rules.track && rules.track !== 'all') {
    where.push(`json_extract(s.answers_json, '$.f_track') = ?`);
    params.push(optName.get(rules.track) ?? '');
  }
  return { clause: where.join(' AND '), params };
}

async function trackOptionNames(db: D1Database, eventId: string): Promise<Map<string, string>> {
  const options = await all<{ id: string; name: string }>(
    db,
    `SELECT o.id, o.name FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id WHERE t.event_id = ?`,
    eventId
  );
  return new Map(options.map((o) => [o.id, o.name]));
}

/** Outstanding reviews per plan, event-wide. */
async function reviewProgress(db: D1Database, eventId: string) {
  const [doneRow, plans, optName] = await Promise.all([
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM evaluations e
         JOIN eval_plans p ON p.id = e.plan_id WHERE p.event_id = ?`,
      eventId
    ),
    all<{ id: string; reviews_per: number; rules_json: string }>(
      db,
      `SELECT id, reviews_per, rules_json FROM eval_plans WHERE event_id = ?`,
      eventId
    ),
    trackOptionNames(db, eventId),
  ]);
  const done = doneRow?.n ?? 0;
  if (!plans.length) return { done, total: done, pct: done ? 100 : 0 };

  const planRows = await Promise.all(
    plans.map((plan) => {
      const { clause, params } = planScope(eventId, plan.rules_json, optName);
      // `evals` must only count reviews on the plan's in-scope submissions,
      // otherwise reviews on out-of-scope submissions cancel real outstanding work.
      return one<{ subs: number; evals: number }>(
        db,
        `SELECT (SELECT COUNT(*) FROM submissions s WHERE ${clause}) AS subs,
                (SELECT COUNT(*) FROM evaluations ev JOIN submissions s ON s.id = ev.submission_id
                  WHERE ev.plan_id = ? AND ${clause}) AS evals`,
        ...params,
        plan.id,
        ...params
      );
    })
  );

  let outstanding = 0;
  for (let i = 0; i < plans.length; i++) {
    const row = planRows[i];
    const expected = (row?.subs ?? 0) * plans[i].reviews_per;
    outstanding += Math.max(0, expected - (row?.evals ?? 0));
  }

  const total = done + outstanding;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * The signed-in organizer's own review queue, if they sit on any evaluation
 * plan of this event (same eval_plan_reviewers check as `/app/evaluation`).
 * Approximation: per plan they're on, in-scope submissions vs their submitted
 * evaluations on those submissions — labelled "in · to go", not exact
 * assignment math.
 */
async function myReviewQueue(db: D1Database, eventId: string, userId: string) {
  const plans = await all<{ id: string; rules_json: string }>(
    db,
    `SELECT p.id, p.rules_json FROM eval_plans p
       JOIN eval_plan_reviewers r ON r.plan_id = p.id
      WHERE p.event_id = ? AND r.user_id = ?`,
    eventId,
    userId
  );
  if (!plans.length) return null;

  // Same assignment math as the My Evaluations queue — plan-scope counting
  // ignores per-reviewer assignment/caps and reads "7 to go" while the queue
  // itself says done.
  const ctx = await loadEvalContext(db, eventId);
  const queue = reviewerQueue(ctx.plans, ctx.submissions, ctx.evaluations, userId);
  const done = queue.filter((i) => i.done).length;
  return { done, remaining: queue.length - done };
}

type AttentionItem = { title: string; sub: string; cta: string; href: string; dot: string; subMono?: boolean };

app.get('/app', async (c) => {
  const event = c.var.event;

  if (!event) {
    const props = await adminProps(c, 'Dashboard');
    return c.html(
      <AdminLayout {...props}>
        <style>{raw(PAGE_CSS)}</style>
        <div class="dash-empty" style="max-width:1160px;">
          <div style="background:#fff;border:1px solid #e2e3e8;padding:40px 28px;text-align:center;">
            <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:8px;`}>
              NO EVENT YET
            </div>
            <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:4px;">
              {`${greeting('UTC')}, ${firstName(c.var.user)}`}
            </div>
            <div style="font-size:13px;color:#686b74;margin-bottom:18px;">
              Create your first event to open the workspace.
            </div>
            <a
              href="/app/events/new"
              style="display:inline-block;padding:9px 16px;background:#4c5fd5;color:#fff;font-size:13px;font-weight:600;text-decoration:none;"
            >
              ＋ New event
            </a>
          </div>
        </div>
      </AdminLayout>
    );
  }

  const db = c.env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Every card below reads independent data — run the queries (and the layout
  // chrome's own lookups) concurrently instead of paying one D1 round trip
  // after another.
  const [
    props,
    statusRows,
    unscheduledRow,
    unreviewedRow,
    confirmedRow,
    overdue,
    conflicts,
    staleAcceptedRow,
    formCountRow,
    review,
    myQueue,
    forms,
    plans,
  ] = await Promise.all([
    adminProps(c, 'Dashboard'),
    all<{ status: string; n: number }>(
      db,
      `SELECT status, COUNT(*) AS n FROM submissions WHERE event_id = ? GROUP BY status`,
      event.id
    ),
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM sessions WHERE event_id = ? AND day IS NULL AND type <> 'service'`,
      event.id
    ),
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM submissions s
        WHERE s.event_id = ? AND s.status = 'in_review'
          AND NOT EXISTS (SELECT 1 FROM evaluations e WHERE e.submission_id = s.id)`,
      event.id
    ),
    // Speaker confirmation lives on the session (migration 0011). Scoped to talks
    // from a submission: sponsor and service sessions are created already
    // `confirmed`, and nobody confirmed those.
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM sessions
        WHERE event_id = ? AND status = 'confirmed' AND type = 'talk' AND submission_id IS NOT NULL`,
      event.id
    ),
    one<{ n: number; speakers: number }>(
      db,
      `SELECT COUNT(*) AS n, COUNT(DISTINCT speaker_profile_id) AS speakers
         FROM tasks WHERE event_id = ? AND status <> 'done' AND due_date IS NOT NULL AND due_date < ?`,
      event.id,
      today
    ),
    // Every double-booked speaker, one row per conflicting session pair.
    all<{ name: string; day: number; start_min: number; rooms: string }>(
      db,
      `SELECT sp.name AS name, s1.day AS day, s1.start_min AS start_min,
              (COALESCE(r1.name,'—') || ' and ' || COALESCE(r2.name,'—')) AS rooms
         FROM sessions s1
         JOIN session_speakers ss1 ON ss1.session_id = s1.id
         JOIN session_speakers ss2 ON ss2.speaker_profile_id = ss1.speaker_profile_id
         JOIN sessions s2 ON s2.id = ss2.session_id AND s2.id <> s1.id
         JOIN speaker_profiles sp ON sp.id = ss1.speaker_profile_id
         LEFT JOIN rooms r1 ON r1.id = s1.room_id
         LEFT JOIN rooms r2 ON r2.id = s2.room_id
        WHERE s1.event_id = ? AND s1.day IS NOT NULL AND s2.day IS NOT NULL
          AND s1.day = s2.day AND s1.start_min < s2.end_min AND s2.start_min < s1.end_min
          AND s1.id < s2.id
        ORDER BY s1.day, s1.start_min`,
      event.id
    ),
    // Accepted more than 7 days ago, speaker still hasn't confirmed. `accepted`
    // no longer implies unconfirmed (migration 0011) — the speaker's
    // confirmation is on the session, so exclude anyone who already confirmed.
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM submissions s
        WHERE s.event_id = ? AND s.status = 'accepted' AND s.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM sessions se WHERE se.submission_id = s.id AND se.status = 'confirmed')`,
      event.id,
      weekAgo
    ),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM forms WHERE event_id = ?`, event.id),
    reviewProgress(db, event.id),
    c.var.user ? myReviewQueue(db, event.id, c.var.user.id) : null,
    all<{ id: string; name: string; closes_at: string | null; status: string }>(
      db,
      `SELECT id, name, closes_at, status FROM forms WHERE event_id = ? AND closes_at IS NOT NULL AND status <> 'draft'`,
      event.id
    ),
    all<{ name: string; deadline: string | null }>(
      db,
      `SELECT name, deadline FROM eval_plans WHERE event_id = ? AND deadline IS NOT NULL`,
      event.id
    ),
  ]);

  const cnt = (s: string) => statusRows.find((r) => r.status === s)?.n ?? 0;
  const totalSubs = statusRows.filter((r) => r.status !== 'draft').reduce((a, r) => a + r.n, 0);
  const unscheduled = unscheduledRow?.n ?? 0;
  const unreviewed = unreviewedRow?.n ?? 0;
  const confirmed = confirmedRow?.n ?? 0;
  const staleAccepted = staleAcceptedRow?.n ?? 0;
  const formCount = formCountRow?.n ?? 0;

  const deadlines = [
    ...plans.map((p) => ({ date: p.deadline!, what: `${p.name} deadline` })),
    ...forms.map((f) => ({ date: f.closes_at!, what: `${f.name} closes` })),
    { date: event.start_date, what: `${event.name} · Day 1` },
  ]
    .filter((d) => !!d.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  const kpis = [
    { label: 'SUBMISSIONS', val: totalSubs, sub: `${unreviewed} awaiting first review`, href: '/app/submissions' },
    { label: 'IN REVIEW', val: cnt('in_review'), sub: `${review.done} of ${review.total} reviews in`, href: '/app/evaluation' },
    {
      label: 'ACCEPTED',
      val: cnt('accepted'),
      sub: `${confirmed} confirmed by speaker`,
      href: '/app/sessions',
    },
    { label: 'UNSCHEDULED', val: unscheduled, sub: 'ready for the agenda', href: '/app/agenda?focus=unscheduled' },
  ];

  const attention: AttentionItem[] = [];

  // Fresh-event leads: no forms yet, or forms but no submissions.
  if (formCount === 0) {
    attention.push({
      title: 'Create your first form',
      sub: 'Publish a call for talks to start collecting submissions.',
      cta: 'Open forms →',
      href: '/app/forms',
      dot: '#4c5fd5',
    });
  } else if (totalSubs === 0) {
    const links = (props.publicForms ?? []).map((f) => `${c.env.APP_ORIGIN}/${event.slug}/${f.slug}`);
    attention.push({
      title: 'Share your form link',
      sub: links.length ? links.join('  ·  ') : 'Publish a form to get a shareable link.',
      subMono: links.length > 0,
      cta: 'Open forms →',
      href: '/app/forms',
      dot: '#4c5fd5',
    });
  }

  for (const conflict of conflicts) {
    attention.push({
      title: `${conflict.name} is double-booked`,
      sub: `Day ${conflict.day + 1}, ${fmtMin(conflict.start_min)} — ${conflict.rooms} at once`,
      cta: 'Review conflicts →',
      href: '/app/agenda?focus=conflicts',
      dot: '#e03131',
    });
  }
  if ((overdue?.n ?? 0) > 0) {
    attention.push({
      title: `${overdue!.n} speaker task${overdue!.n === 1 ? '' : 's'} overdue`,
      sub: `${overdue!.speakers} speaker${overdue!.speakers === 1 ? '' : 's'} behind on onboarding`,
      cta: 'Show who’s behind →',
      href: '/app/speakers?focus=overdue',
      dot: '#e03131',
    });
  }
  for (const f of forms) {
    if (f.status !== 'open' || !f.closes_at || f.closes_at.slice(0, 10) < today) continue;
    const left = daysLeft(f.closes_at);
    if (left > 7) continue;
    attention.push({
      title: `“${f.name}” closes ${fmtDate(f.closes_at)}`,
      sub: left === 0 ? 'Closes today — extend it or announce the deadline' : `${left} day${left === 1 ? '' : 's'} left — extend it or announce the deadline`,
      cta: 'Extend deadline →',
      href: `/app/forms?form=${f.id}&focus=deadline`,
      dot: '#b08800',
    });
  }
  if (staleAccepted > 0) {
    attention.push({
      title:
        staleAccepted === 1
          ? `1 accepted speaker hasn't confirmed`
          : `${staleAccepted} accepted speakers haven't confirmed`,
      sub: 'Accepted more than 7 days ago — send them a reminder',
      cta: 'Show unconfirmed →',
      href: '/app/speakers?focus=unconfirmed',
      dot: '#b08800',
    });
  }
  if (unreviewed > 0) {
    attention.push({
      title: `${unreviewed} submission${unreviewed === 1 ? '' : 's'} have no reviews yet`,
      sub: deadlines.length ? `Assign them before ${fmtDate(deadlines[0].date)}` : 'Assign them to an evaluation plan',
      cta: 'Assign reviewers →',
      href: '/app/evaluation?filter=unreviewed',
      dot: '#b08800',
    });
  }
  if (unscheduled > 0) {
    attention.push({
      title: `${unscheduled} accepted session${unscheduled === 1 ? '' : 's'} not on the agenda`,
      sub: 'Drag them onto a day in the agenda builder',
      cta: 'Open agenda tray →',
      href: '/app/agenda?focus=unscheduled',
      dot: '#b08800',
    });
  }

  return c.html(
    <AdminLayout {...props}>
      <style>{raw(PAGE_CSS)}</style>
      <div class="dash-wrap">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:18px;">
          <h1 style="margin:0;font-size:21px;letter-spacing:-0.02em;">
            {`${greeting(event.timezone)}, ${firstName(c.var.user)}`}
          </h1>
        </div>

        <div class="dash-kpis">
          {kpis.map((k) => (
            <a
              href={k.href}
              style="display:block;background:#fff;border:1px solid #e2e3e8;padding:14px 16px;color:#16171d;text-decoration:none;"
            >
              <div style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;`}>{k.label}</div>
              <div style={`font-size:26px;font-weight:700;font-family:${MONO};margin-top:4px;`}>{k.val}</div>
              <div style="font-size:11.5px;color:#686b74;margin-top:2px;">{k.sub}</div>
            </a>
          ))}
        </div>

        <div class="dash-cols">
          <div style="min-width:0;display:flex;flex-direction:column;gap:12px;">
            <div style="background:#fff;border:1px solid #e2e3e8;">
              <div style={`padding:12px 16px;border-bottom:1px solid #eceded;font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;`}>
                NEEDS ATTENTION
              </div>
              {attention.length ? (
                attention.map((a) => (
                  <a
                    href={a.href}
                    class="dash-att"
                    style="border-bottom:1px solid #f2f3f5;color:#16171d;text-decoration:none;"
                  >
                    <span class="dash-att-dot" style={`width:9px;height:9px;background:${a.dot};flex:none;`}></span>
                    <span style="min-width:0;">
                      <span style="display:block;font-size:13px;font-weight:500;">{a.title}</span>
                      <span
                        style={
                          a.subMono
                            ? `display:block;font-family:${MONO};font-size:11px;color:#686b74;margin-top:2px;word-break:break-all;`
                            : 'display:block;font-size:11.5px;color:#686b74;margin-top:1px;'
                        }
                      >
                        {a.sub}
                      </span>
                    </span>
                    <span class="dash-att-cta" style="flex:none;border:1px solid #cdd2ea;background:#fff;color:#4c5fd5;font-size:12px;font-weight:600;white-space:nowrap;">
                      {a.cta}
                    </span>
                  </a>
                ))
              ) : (
                <div style="padding:16px;font-size:12.5px;color:#9a9da6;">Nothing needs attention right now.</div>
              )}
            </div>

            <div style="background:#fff;border:1px solid #e2e3e8;">
              <div style={`padding:12px 16px;border-bottom:1px solid #eceded;font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;`}>
                UPCOMING DEADLINES
              </div>
              {deadlines.length ? (
                deadlines.map((d) => {
                  const left = daysLeft(d.date);
                  return (
                    <div class="dash-dl" style="border-bottom:1px solid #f2f3f5;">
                      <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;white-space:nowrap;`}>
                        {fmtDate(d.date)}
                      </div>
                      <div class="dash-dl-what" style="font-size:13px;font-weight:500;">
                        {d.what}
                      </div>
                      <div
                        class="dash-dl-left"
                        style={`font-family:${MONO};font-size:10px;color:${
                          left < 15 ? '#c92a2a' : '#9a9da6'
                        };white-space:nowrap;`}
                      >
                        {`${left}d left`}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div style="padding:14px 16px;font-size:12.5px;color:#9a9da6;">Nothing scheduled yet.</div>
              )}
            </div>

            {/* The attendee-facing links that used to crowd the sidebar's
                PUBLIC section. Long form names ellipsize to the card width. */}
            <div style="background:#fff;border:1px solid #e2e3e8;">
              <div style={`padding:12px 16px;border-bottom:1px solid #eceded;font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;`}>
                PUBLIC PAGES
              </div>
              {[
                ...(props.publicForms ?? []).map((f) => ({ name: f.name, href: `/${event.slug}/${f.slug}` })),
                { name: 'Agenda', href: `/${event.slug}/agenda` },
                { name: 'Sessions', href: `/${event.slug}/sessions` },
                { name: 'Speakers', href: `/${event.slug}/speakers` },
              ].map((p) => (
                <a
                  href={p.href}
                  target="_blank"
                  rel="noreferrer"
                  class="dash-pub"
                  style="display:flex;align-items:center;gap:8px;border-bottom:1px solid #f2f3f5;color:#16171d;font-size:12.5px;text-decoration:none;"
                >
                  <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{p.name}</span>
                  <span style="margin-left:auto;flex:none;color:#9a9da6;font-size:11px;">↗</span>
                </a>
              ))}
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:12px;">
            <div style="background:#fff;border:1px solid #e2e3e8;padding:14px 16px;">
              <div style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;margin-bottom:8px;`}>
                REVIEW PROGRESS
              </div>
              <div style="display:flex;align-items:baseline;gap:8px;">
                <div style={`font-size:26px;font-weight:700;font-family:${MONO};`}>{`${review.pct}%`}</div>
                <div style="font-size:11.5px;color:#686b74;">{`${review.done} of ${review.total} reviews submitted`}</div>
              </div>
              <div style="height:6px;background:#f0f1f4;margin-top:9px;">
                <div style={`height:100%;width:${review.pct}%;background:#4c5fd5;`}></div>
              </div>
              <div style="font-size:11.5px;margin-top:9px;">
                <a href="/app/evaluation">Open evaluation →</a>
              </div>
            </div>

            {myQueue ? (
              <div style="background:#fff;border:1px solid #e2e3e8;padding:14px 16px;">
                <div style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;margin-bottom:8px;`}>
                  MY REVIEWS
                </div>
                <div style="display:flex;align-items:baseline;gap:8px;">
                  <div style={`font-size:26px;font-weight:700;font-family:${MONO};`}>{myQueue.remaining}</div>
                  <div style="font-size:11.5px;color:#686b74;">{`${myQueue.done} in · ${myQueue.remaining} to go`}</div>
                </div>
                <div style="font-size:11.5px;margin-top:9px;">
                  <a href="/app/evaluation?tab=mine">Open my queue →</a>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
});

function fmtMin(m: number): string {
  const h = Math.floor((480 + m) / 60);
  const mm = (480 + m) % 60;
  return `${h}:${String(mm).padStart(2, '0')}`;
}

export default app;
