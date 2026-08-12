/**
 * `/app` — port of `Dashboard.dc.html` with every number computed from D1 for
 * the session's active event.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, MONO, fmtDate, firstName } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, one } from '../lib/db';

const app = new Hono<Ctx>();

const PIPELINE_ORDER = ['submitted', 'in_review', 'accepted', 'confirmed', 'waitlisted', 'declined'] as const;
const PIPELINE_META: Record<string, { label: string; fg: string }> = {
  submitted: { label: 'Submitted', fg: '#1c7ed6' },
  in_review: { label: 'In Review', fg: '#b08800' },
  accepted: { label: 'Accepted', fg: '#2b8a3e' },
  confirmed: { label: 'Confirmed', fg: '#087f5b' },
  waitlisted: { label: 'Waitlisted', fg: '#9c36b5' },
  declined: { label: 'Declined', fg: '#c92a2a' },
};

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
 * Outstanding reviews per plan. Scope honours the plan's `form`, `status` and
 * `track` rules; `format`/`level` are not yet applied (no seeded plan uses
 * them) — the evaluation track (B3) owns the full rule engine.
 */
async function reviewProgress(db: D1Database, eventId: string) {
  const done =
    (
      await one<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM evaluations e
           JOIN eval_plans p ON p.id = e.plan_id WHERE p.event_id = ?`,
        eventId
      )
    )?.n ?? 0;

  const plans = await all<{ id: string; reviews_per: number; rules_json: string }>(
    db,
    `SELECT id, reviews_per, rules_json FROM eval_plans WHERE event_id = ?`,
    eventId
  );
  if (!plans.length) return { done, total: done, pct: done ? 100 : 0 };

  const options = await all<{ id: string; name: string }>(
    db,
    `SELECT o.id, o.name FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id WHERE t.event_id = ?`,
    eventId
  );
  const optName = new Map(options.map((o) => [o.id, o.name]));

  let outstanding = 0;
  for (const plan of plans) {
    let rules: { form?: string; status?: string; track?: string } = {};
    try {
      rules = JSON.parse(plan.rules_json);
    } catch {
      rules = {};
    }
    const where: string[] = ['s.event_id = ?'];
    const params: unknown[] = [eventId];
    if (rules.form && rules.form !== 'all') {
      where.push('s.form_id = ?');
      params.push(rules.form);
    }
    if (!rules.status || rules.status === 'active') where.push("s.status IN ('submitted','in_review')");
    else if (rules.status !== 'all') {
      where.push('s.status = ?');
      params.push(rules.status);
    } else where.push("s.status <> 'draft'");
    if (rules.track && rules.track !== 'all') {
      where.push(`json_extract(s.answers_json, '$.f_track') = ?`);
      params.push(optName.get(rules.track) ?? '');
    }
    const clause = where.join(' AND ');
    // `evals` must only count reviews on the plan's in-scope submissions,
    // otherwise reviews on out-of-scope submissions cancel real outstanding work.
    const row = await one<{ subs: number; evals: number }>(
      db,
      `SELECT (SELECT COUNT(*) FROM submissions s WHERE ${clause}) AS subs,
              (SELECT COUNT(*) FROM evaluations ev JOIN submissions s ON s.id = ev.submission_id
                WHERE ev.plan_id = ? AND ${clause}) AS evals`,
      ...params,
      plan.id,
      ...params
    );
    const expected = (row?.subs ?? 0) * plan.reviews_per;
    outstanding += Math.max(0, expected - (row?.evals ?? 0));
  }

  const total = done + outstanding;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

app.get('/app', async (c) => {
  const event = c.var.event;
  const props = await adminProps(c, 'Dashboard');

  if (!event) {
    return c.html(
      <AdminLayout {...props}>
        <div style="padding:24px 28px;max-width:1160px;">
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
  const statusRows = await all<{ status: string; n: number }>(
    db,
    `SELECT status, COUNT(*) AS n FROM submissions WHERE event_id = ? GROUP BY status`,
    event.id
  );
  const cnt = (s: string) => statusRows.find((r) => r.status === s)?.n ?? 0;
  const totalSubs = statusRows.filter((r) => r.status !== 'draft').reduce((a, r) => a + r.n, 0);

  const unscheduled =
    (
      await one<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM sessions WHERE event_id = ? AND day IS NULL AND type <> 'service'`,
        event.id
      )
    )?.n ?? 0;

  const unreviewed =
    (
      await one<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM submissions s
          WHERE s.event_id = ? AND s.status IN ('submitted','in_review')
            AND NOT EXISTS (SELECT 1 FROM evaluations e WHERE e.submission_id = s.id)`,
        event.id
      )
    )?.n ?? 0;

  const today = new Date().toISOString().slice(0, 10);
  const overdue = await one<{ n: number; speakers: number }>(
    db,
    `SELECT COUNT(*) AS n, COUNT(DISTINCT speaker_profile_id) AS speakers
       FROM tasks WHERE event_id = ? AND status <> 'done' AND due_date IS NOT NULL AND due_date < ?`,
    event.id,
    today
  );

  const conflict = await one<{ name: string; day: number; start_min: number; rooms: string }>(
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
      LIMIT 1`,
    event.id
  );

  const review = await reviewProgress(db, event.id);

  const forms = await all<{ name: string; closes_at: string | null; status: string }>(
    db,
    `SELECT name, closes_at, status FROM forms WHERE event_id = ? AND closes_at IS NOT NULL AND status <> 'draft'`,
    event.id
  );
  const plans = await all<{ name: string; deadline: string | null }>(
    db,
    `SELECT name, deadline FROM eval_plans WHERE event_id = ? AND deadline IS NOT NULL`,
    event.id
  );

  const deadlines = [
    ...plans.map((p) => ({ date: p.deadline!, what: `${p.name} deadline` })),
    ...forms.map((f) => ({ date: f.closes_at!, what: `${f.name} closes` })),
    { date: event.start_date, what: `${event.name} · Day 1` },
  ]
    .filter((d) => !!d.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  const pipeline = PIPELINE_ORDER.map((k) => ({
    key: k,
    label: PIPELINE_META[k].label,
    fg: PIPELINE_META[k].fg,
    n: cnt(k),
  }));

  const kpis = [
    { label: 'SUBMISSIONS', val: totalSubs, sub: `${cnt('submitted')} new, unassigned`, href: '/app/submissions' },
    { label: 'IN REVIEW', val: cnt('in_review'), sub: `${review.done} of ${review.total} reviews in`, href: '/app/evaluation' },
    {
      label: 'ACCEPTED',
      val: cnt('accepted') + cnt('confirmed'),
      sub: `${cnt('confirmed')} confirmed by speaker`,
      href: '/app/sessions',
    },
    { label: 'UNSCHEDULED', val: unscheduled, sub: 'ready for the agenda', href: '/app/agenda' },
  ];

  const attention: { title: string; sub: string; cta: string; href: string; dot: string }[] = [];
  if (conflict) {
    attention.push({
      title: `${conflict.name} is double-booked`,
      sub: `Day ${conflict.day + 1}, ${fmtMin(conflict.start_min)} — ${conflict.rooms} at once`,
      cta: 'AGENDA',
      href: '/app/agenda',
      dot: '#e03131',
    });
  }
  if ((overdue?.n ?? 0) > 0) {
    attention.push({
      title: `${overdue!.n} speaker task${overdue!.n === 1 ? '' : 's'} overdue`,
      sub: `${overdue!.speakers} speaker${overdue!.speakers === 1 ? '' : 's'} behind on onboarding`,
      cta: 'SPEAKERS',
      href: '/app/speakers',
      dot: '#e03131',
    });
  }
  if (unreviewed > 0) {
    attention.push({
      title: `${unreviewed} submission${unreviewed === 1 ? '' : 's'} have no reviews yet`,
      sub: deadlines.length ? `Assign them before ${fmtDate(deadlines[0].date)}` : 'Assign them to an evaluation plan',
      cta: 'EVALUATION',
      href: '/app/evaluation',
      dot: '#b08800',
    });
  }
  if (unscheduled > 0) {
    attention.push({
      title: `${unscheduled} accepted session${unscheduled === 1 ? '' : 's'} not on the agenda`,
      sub: 'Drag them onto a day in the agenda builder',
      cta: 'AGENDA',
      href: '/app/agenda',
      dot: '#b08800',
    });
  }

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:22px 28px;max-width:1160px;">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:18px;">
          <h1 style="margin:0;font-size:21px;letter-spacing:-0.02em;">
            {`${greeting(event.timezone)}, ${firstName(c.var.user)}`}
          </h1>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px;">
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

        <div style="background:#fff;border:1px solid #e2e3e8;padding:14px 16px;margin-bottom:14px;">
          <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px;">
            <div style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;`}>
              SUBMISSION PIPELINE
            </div>
            <div style="margin-left:auto;font-size:11.5px;">
              <a href="/app/submissions">Open submissions →</a>
            </div>
          </div>
          <div style="display:flex;height:14px;overflow:hidden;">
            {pipeline.map((p) => (
              <div style={`flex:${Math.max(p.n, 0.001)};background:${p.fg};`} title={`${p.label}: ${p.n}`}></div>
            ))}
          </div>
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:9px;">
            {pipeline.map((p) => (
              <div style="display:flex;align-items:center;gap:5px;font-size:11.5px;color:#686b74;">
                <span style={`width:9px;height:9px;background:${p.fg};flex:none;`}></span>
                {p.label}{' '}
                <span style={`font-family:${MONO};font-weight:600;color:#16171d;`}>{p.n}</span>
              </div>
            ))}
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr;gap:12px;align-items:start;max-width:520px;">
          <div style="display:flex;flex-direction:column;gap:12px;">
            {attention.length ? (
              <div style="background:#fff;border:1px solid #e2e3e8;">
                <div style={`padding:12px 16px;border-bottom:1px solid #eceded;font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;`}>
                  NEEDS ATTENTION
                </div>
                {attention.map((a) => (
                  <a
                    href={a.href}
                    style="display:flex;align-items:baseline;gap:10px;padding:10px 16px;border-bottom:1px solid #f2f3f5;color:#16171d;text-decoration:none;"
                  >
                    <span style={`width:9px;height:9px;background:${a.dot};flex:none;position:relative;top:1px;`}></span>
                    <span style="min-width:0;">
                      <span style="display:block;font-size:13px;font-weight:500;">{a.title}</span>
                      <span style="display:block;font-size:11.5px;color:#686b74;margin-top:1px;">{a.sub}</span>
                    </span>
                    <span style={`margin-left:auto;font-family:${MONO};font-size:10px;color:#9a9da6;white-space:nowrap;`}>
                      {a.cta} →
                    </span>
                  </a>
                ))}
              </div>
            ) : null}

            <div style="background:#fff;border:1px solid #e2e3e8;">
              <div style={`padding:12px 16px;border-bottom:1px solid #eceded;font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;`}>
                UPCOMING DEADLINES
              </div>
              {deadlines.length ? (
                deadlines.map((d) => {
                  const left = daysLeft(d.date);
                  return (
                    <div style="display:flex;align-items:baseline;gap:10px;padding:10px 16px;border-bottom:1px solid #f2f3f5;">
                      <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;white-space:nowrap;`}>
                        {fmtDate(d.date)}
                      </div>
                      <div style="font-size:13px;font-weight:500;">{d.what}</div>
                      <div
                        style={`margin-left:auto;font-family:${MONO};font-size:10px;color:${
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
