/**
 * `/app/agenda` — full port of `Agenda Builder.dc.html`.
 *
 * The shell (header, unscheduled rail, legend, dialogs) is server-rendered; the
 * grids, drag-and-drop, conflict panel and selection cards live in
 * `public/js/agenda-builder.js`, which mirrors the prototype's geometry
 * (K = 1.3 px/min, KB = 1.75, 15-minute snap) and its `conflicts()` rules.
 *
 * Placement is persisted immediately: every drop hits `/app/api/agenda/place`,
 * the UI is optimistic and reverts on error.
 *
 * OWNER: B4.
 */
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Ctx, Event } from '../types';
import { AdminLayout, MONO } from '../views/layout';
import { adminProps } from '../views/chrome';
import { batch, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { requireOrgRole } from '../lib/auth';
import { NewSessionDialog } from './admin-sessions';
import {
  conflictItem,
  conflictMessages,
  displayIds,
  eventDays,
  fmtTime,
  hasUnpublishedChanges,
  K,
  KB,
  loadAgenda,
  notifyScheduleChange,
  publishedRev,
  roomNamer,
  SNAP,
  speakerNamer,
  toViewSession,
  type SessionRow,
} from '../lib/agenda';
import { autoSchedule } from '../lib/auto-schedule';

const app = new Hono<Ctx>();

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`;

/* Dialog chrome — same values as `admin-sessions.tsx`. */
const DIALOG_WRAP = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;';
const DIALOG_CARD =
  'background:#fff;width:560px;max-width:calc(100vw - 48px);box-shadow:0 16px 48px rgba(22,23,29,0.25);max-height:calc(100vh - 60px);display:flex;flex-direction:column;';
const DIALOG_HEAD = 'padding:16px 20px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;';
const DIALOG_BODY = 'padding:18px 20px;display:grid;gap:14px;overflow-y:auto;';
const CODE_BLOCK = `display:block;font-family:${MONO};font-size:11px;line-height:1.55;background:#f4f5f9;border:1px solid #e2e3e8;padding:10px 12px;color:#16171d;word-break:break-all;white-space:pre-wrap;margin-bottom:6px;`;
const COPY_LINK = 'background:none;border:none;padding:0;font-size:12px;color:#4c5fd5;cursor:pointer;';

/**
 * Mobile port. The two-pane shell (264px rail + time grid) stacks below 768px:
 * the unscheduled bin becomes a horizontal tray above a grid that pans inside
 * its own scroll box, with the hour gutter / room labels pinned to the left.
 * `agenda-builder.js` carries the matching JS half (tap-to-place, bottom-sheet
 * cards, pointer-event dragging).
 *
 * Every value here is the byte-for-byte desktop value the inline style used to
 * carry — an inline style cannot be beaten by a media query, so anything that
 * has to change on a phone had to move out. The breakpoint is written as the
 * literal 768: importing MOBILE_MAX into a route module's top-level template
 * leaves it undefined at module-evaluation time and crashes the worker.
 */
const PAGE_CSS = `
  .ag-layout{display:grid;grid-template-columns:264px 1fr;gap:0;align-items:start;}
  .ag-rail{border-right:1px solid #e2e3e8;background:#fff;min-height:calc(100vh - 69px);padding:16px;position:sticky;top:0;min-width:0;}
  .ag-main{padding:18px 24px;overflow-x:auto;min-width:0;}
  .ag-bin{display:grid;gap:8px;min-height:200px;}
  .ag-add>button:first-child{margin-bottom:6px;}
  .ag-tab{padding:7px 13px;}
  .ag-hactions{gap:10px;}
  .ag-hbtn{padding:8px 14px;}
  .ag-hbtn-primary{padding:8px 16px;}
  /* The selection / service / schedule cards. agenda-builder.js sets the rest
     inline; touch-action lives here so the mobile sheet can scroll itself. */
  .ag-card{touch-action:none;}
  @media (max-width:768px){
    .ag-layout{grid-template-columns:1fr;}
    .ag-rail{border-right:none;border-bottom:1px solid #e2e3e8;min-height:0;position:static;padding:12px 14px;}
    .ag-main{padding:12px 12px 28px;overflow-x:visible;}
    /* The pan moves off .ag-main and onto the grid alone, so panning to the
       last room does not carry the day switcher and the filters off screen.
       The negative margin lets the board reach both edges while the daybar
       keeps its gutter — and leaves the sticky hour column flush at x=0, which
       a padding inside the scroll box would break. */
    #grid{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -12px;}
    /* The bin turns into a swipeable tray so the grid stays one screen away.
       Its empty state is a single full-width panel, not a 230px card. */
    .ag-bin{grid-auto-flow:column;grid-auto-columns:min(74vw,230px);min-height:0;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px;}
    .ag-bin.ag-bin-empty{grid-auto-flow:row;}
    .ag-add{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
    .ag-add>button:first-child{margin-bottom:0;}
    .ag-tab{padding:11px 12px;}
    /* The shell gives headerActions a row of its own; this inner row has to
       wrap inside it or the four view tabs push publish off the screen. */
    .ag-hactions{gap:8px;flex-wrap:wrap;justify-content:flex-end;}
    .ag-hbtn,.ag-hbtn-primary{padding:10px 12px;}
    #daybar{flex-wrap:wrap;}
    .ag-dialog-card{max-width:calc(100vw - 24px);}
    .ag-dialog-close{width:40px;height:40px;margin:-10px -10px -10px auto;}
    .ag-card{touch-action:auto;}
  }
`;

function tabBtn(on: boolean): string {
  return `border:none;font-size:12.5px;cursor:pointer;font-weight:600;background:${
    on ? '#16171d' : '#fff'
  };color:${on ? '#fff' : '#686b74'};white-space:nowrap;`;
}

function jsonBlock(id: string, value: unknown) {
  return (
    <script type="application/json" id={id}>
      {raw(JSON.stringify(value).replace(/</g, '\\u003c'))}
    </script>
  );
}

/* ---------------------------------------------------------- embed dialog */

/**
 * Copy-paste `<iframe>` snippets for `/{event}/embed/agenda` and
 * `/{event}/embed/speakers`. The transparent-background checkbox is wired in
 * `agenda-builder.js` (it rewrites the snippets and their copy buttons).
 */
const EmbedDialog: FC<{ event: Event; origin: string }> = ({ event, origin }) => {
  const snippet = (kind: 'agenda' | 'speakers') =>
    `<iframe src="${origin}/${event.slug}/embed/${kind}" style="width:100%;height:800px;border:0;" title="${event.name} ${kind}"></iframe>`;
  return (
    <div
      id="embed-dialog"
      data-dialog
      hidden
      style={DIALOG_WRAP}
      data-embed-base={`${origin}/${event.slug}/embed`}
      data-event-name={event.name}
    >
      <div class="ag-dialog-card" style={DIALOG_CARD}>
        <div style={DIALOG_HEAD}>
          <div style="font-size:15px;font-weight:700;">Embed on your website</div>
          <button
            type="button"
            class="ag-dialog-close"
            data-dialog-close="#embed-dialog"
            style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
          >
            ×
          </button>
        </div>
        <div style={DIALOG_BODY}>
          <div style="font-size:12.5px;color:#686b74;line-height:1.55;">
            Paste a snippet into any page on your site. Embeds show the published agenda and update live whenever you
            re-publish. For all five widget types, more output formats (JSON, XML, iCal) and branding options, head to{' '}
            <a href="/app/embeds">Embeds</a>.
          </div>
          <label style="display:flex;align-items:center;gap:9px;font-size:13px;cursor:pointer;">
            <input id="embed-transparent" type="checkbox" style="width:15px;height:15px;accent-color:#4c5fd5;" />
            Transparent background (sits on your site’s own background)
          </label>
          <div>
            <div style={`${MICRO}margin-bottom:6px;`}>AGENDA</div>
            <code id="embed-agenda-code" style={CODE_BLOCK}>
              {snippet('agenda')}
            </code>
            <button
              type="button"
              id="embed-agenda-copy"
              data-copy={snippet('agenda')}
              data-copy-msg="Agenda embed snippet copied"
              style={COPY_LINK}
            >
              Copy snippet
            </button>
          </div>
          <div>
            <div style={`${MICRO}margin-bottom:6px;`}>SPEAKERS</div>
            <code id="embed-speakers-code" style={CODE_BLOCK}>
              {snippet('speakers')}
            </code>
            <button
              type="button"
              id="embed-speakers-copy"
              data-copy={snippet('speakers')}
              data-copy-msg="Speakers embed snippet copied"
              style={COPY_LINK}
            >
              Copy snippet
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ page */

app.get('/app/agenda', async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');

  const [props, bundle, unpublished] = await Promise.all([
    adminProps(c, 'Agenda builder', { headerTitle: 'Agenda builder' }),
    loadAgenda(c.env.DB, event.id),
    hasUnpublishedChanges(c.env.DB, event),
  ]);
  const ids = displayIds(bundle.sessions);
  const days = eventDays(event);

  const payload = {
    eventId: event.id,
    slug: event.slug,
    days,
    dayStart: event.day_start_min,
    dayEnd: event.day_end_min,
    K,
    KB,
    snap: SNAP,
    rooms: bundle.rooms.map((r) => ({ id: r.id, name: r.name })),
    tracks: bundle.tracks.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    sessions: bundle.sessions.map((s) => toViewSession(s, bundle, ids)),
    published: !!event.published,
    publishedRev: publishedRev(event),
    unpublished,
  };

  const views: [string, string][] = [
    ['list', 'List'],
    ['day', 'Day'],
    ['week', 'Week'],
    ['rooms', 'Rooms'],
  ];

  const headerActions = (
    <div class="ag-hactions" style="display:flex;align-items:center;">
      <div style="display:flex;border:1px solid #e2e3e8;">
        {views.map(([id, label]) => (
          <button type="button" class="ag-tab" data-view={id} style={tabBtn(id === 'rooms')}>
            {label}
          </button>
        ))}
      </div>
      <div
        id="unpublished-dot"
        hidden={!unpublished}
        title="Sessions changed since the last publish"
        style="display:flex;align-items:center;gap:7px;"
      >
        <span style="width:7px;height:7px;border-radius:50%;background:#e6a817;"></span>
        {/* The dot alone carries the state on a phone; the words need a row of
            their own that the header cannot spare. The title attribute stays. */}
        <span class="us-desktop-only" style={`font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#686b74;`}>
          UNPUBLISHED CHANGES
        </span>
      </div>
      <button
        type="button"
        class="ag-hbtn"
        data-dialog-open="#embed-dialog"
        style="background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;"
      >
        Embed
      </button>
      <button
        type="button"
        id="publish-btn"
        class="ag-hbtn-primary"
        style="background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
      >
        Publish changes
      </button>
    </div>
  );

  return c.html(
    <AdminLayout {...props} headerActions={headerActions} scripts={['/js/agenda-builder.js']}>
      <style>{raw(PAGE_CSS)}</style>
      {jsonBlock('data-agenda', payload)}
      <div class="ag-layout">
        <aside class="ag-rail">
          <div style="display:flex;align-items:baseline;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:700;">Unscheduled</div>
            <div id="bin-count" style={`margin-left:auto;font-family:${MONO};font-size:11px;color:#9a9da6;`}></div>
          </div>
          <button
            type="button"
            id="auto-schedule"
            title="Place everything in the bin into the first conflict-free slot"
            style="width:100%;padding:9px 0;background:#fff;border:1px solid #4c5fd5;color:#4c5fd5;font-size:12.5px;font-weight:600;cursor:pointer;margin-bottom:12px;"
          >
            Auto-schedule the bin
          </button>
          <div id="bin" class="ag-bin" data-drop="bin"></div>
          <div style="margin-top:18px;border-top:1px solid #eceded;padding-top:12px;">
            <div style={`${MICRO}margin-bottom:8px;`}>ADD DIRECTLY</div>
            <div class="ag-add">
              <button
                type="button"
                id="add-service"
                style="width:100%;padding:8px 0;background:#fff;border:1px solid #e2e3e8;font-size:12.5px;cursor:pointer;"
              >
                + Service block (break, lunch…)
              </button>
              <button
                type="button"
                data-dialog-open="#new-session"
                style="width:100%;padding:8px 0;background:#fff;border:1px solid #e2e3e8;font-size:12.5px;cursor:pointer;"
              >
                + Sponsor session
              </button>
            </div>
          </div>
          <div
            class="us-desktop-only"
            style="margin-top:18px;border-top:1px solid #eceded;padding-top:12px;font-size:12px;color:#686b74;line-height:1.5;"
          >
            <div style={`${MICRO}margin-bottom:6px;`}>LEGEND</div>
            <span style="display:inline-block;width:8px;height:8px;background:#2b8a3e;"></span> confirmed &nbsp;
            <span style="display:inline-block;width:8px;height:8px;background:#e6a817;"></span> pending speaker
            <br />
            <span style="display:inline-block;width:8px;height:8px;background:#adb5bd;"></span> service ·{' '}
            <span style={`font-family:${MONO};font-size:10px;`}>SP</span> sponsor
          </div>
        </aside>
        <div class="ag-main">
          <div id="daybar" style="display:flex;align-items:center;gap:10px;margin-bottom:14px;"></div>
          <div id="grid"></div>
        </div>
      </div>
      <div id="cards"></div>
      <NewSessionDialog tracks={bundle.tracks} formats={bundle.formats} />
      <EmbedDialog event={event} origin={c.env.APP_ORIGIN} />
    </AdminLayout>
  );
});

/* ------------------------------------------------------------------- api */

type PlaceBody = {
  id: string;
  day: number;
  startMin: number;
  endMin?: number | null;
  roomId?: string | null;
  allRooms?: boolean;
};

async function conflictsForSession(env: Ctx['Bindings'], event: Event, sessionId: string): Promise<string[]> {
  const bundle = await loadAgenda(env.DB, event.id);
  const target = bundle.sessions.find((s) => s.id === sessionId);
  if (!target) return [];
  const placed = bundle.sessions.filter((s) => s.day !== null && s.start_min !== null).map((s) => conflictItem(s, bundle));
  return conflictMessages(conflictItem(target, bundle), placed, {
    dayEnd: event.day_end_min,
    roomName: roomNamer(bundle),
    speakerName: speakerNamer(bundle),
  });
}

app.post('/app/api/agenda/place', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<PlaceBody>();
  const cur = await one<SessionRow>(c.env.DB, `SELECT * FROM sessions WHERE id = ? AND event_id = ?`, body?.id, event.id);
  if (!cur) return c.json({ ok: false, error: 'Session not found.' }, 400);

  const days = eventDays(event);
  const day = Math.max(0, Math.min(days.length - 1, Math.round(Number(body.day ?? 0))));
  let start = Math.round(Number(body.startMin));
  if (!Number.isFinite(start)) return c.json({ ok: false, error: 'Missing start time.' }, 400);
  start = Math.max(0, Math.round(start / SNAP) * SNAP);

  let allRooms = cur.all_rooms === 1;
  let roomId = cur.room_id;
  if (body.allRooms !== undefined || body.roomId !== undefined) {
    allRooms = body.allRooms === true || body.roomId === 'ALL';
    roomId = allRooms ? null : body.roomId || null;
    if (roomId) {
      const room = await one<{ id: string }>(c.env.DB, `SELECT id FROM rooms WHERE id = ? AND event_id = ?`, roomId, event.id);
      if (!room) return c.json({ ok: false, error: 'That room does not belong to this event.' }, 400);
    }
  }
  // Service blocks always span the whole venue unless explicitly given a room.
  if (cur.type === 'service' && body.allRooms === undefined && body.roomId === undefined) allRooms = cur.all_rooms === 1;

  let duration = cur.duration_min;
  if (body.endMin !== undefined && body.endMin !== null && Number.isFinite(Number(body.endMin))) {
    duration = Math.max(SNAP, Math.round(Number(body.endMin)) - start);
  }
  const end = start + duration;

  const moved = cur.day !== day || cur.start_min !== start || cur.end_min !== end || (cur.room_id ?? null) !== (roomId ?? null) || (cur.all_rooms === 1) !== allRooms;
  const wasUnscheduled = cur.day === null || cur.start_min === null;

  await run(
    c.env.DB,
    `UPDATE sessions SET day = ?, start_min = ?, end_min = ?, duration_min = ?, room_id = ?, all_rooms = ?,
       ics_sequence = ics_sequence + ?, updated_at = ? WHERE id = ?`,
    day,
    start,
    end,
    duration,
    roomId,
    allRooms ? 1 : 0,
    moved ? 1 : 0,
    now(),
    cur.id
  );

  const actor = c.var.user?.name || c.var.user?.email || 'System';
  if (moved) {
    const roomLabel = allRooms
      ? 'all rooms'
      : roomId
        ? (await one<{ name: string }>(c.env.DB, `SELECT name FROM rooms WHERE id = ?`, roomId))?.name ?? 'unassigned'
        : 'unassigned';
    await logActivity(c.env.DB, {
      eventId: event.id,
      subjectType: 'session',
      subjectId: cur.id,
      actor,
      action: wasUnscheduled ? 'Scheduled' : 'Moved on the agenda',
      detail: `${days[day]?.label ?? `Day ${day + 1}`} · ${fmtTime(start)}–${fmtTime(end)} · ${roomLabel}`,
    });
    c.executionCtx.waitUntil(notifyScheduleChange(c.env, event, cur.id, actor));
  }

  const bundle = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(bundle.sessions);
  const fresh = bundle.sessions.find((s) => s.id === cur.id)!;
  const placed = bundle.sessions.filter((s) => s.day !== null && s.start_min !== null).map((s) => conflictItem(s, bundle));
  const conflicts = conflictMessages(conflictItem(fresh, bundle), placed, {
    dayEnd: event.day_end_min,
    roomName: roomNamer(bundle),
    speakerName: speakerNamer(bundle),
  });
  return c.json({ ok: true, session: toViewSession(fresh, bundle, ids), conflicts });
});

app.post('/app/api/agenda/unschedule', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<{ id: string }>();
  const cur = await one<SessionRow>(c.env.DB, `SELECT * FROM sessions WHERE id = ? AND event_id = ?`, body?.id, event.id);
  if (!cur) return c.json({ ok: false, error: 'Session not found.' }, 400);
  await run(
    c.env.DB,
    `UPDATE sessions SET day = NULL, start_min = NULL, end_min = NULL, ics_sequence = ics_sequence + 1, updated_at = ? WHERE id = ?`,
    now(),
    cur.id
  );
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: cur.id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Unscheduled',
    detail: cur.title,
  });
  const bundle = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(bundle.sessions);
  const fresh = bundle.sessions.find((s) => s.id === cur.id)!;
  return c.json({ ok: true, session: toViewSession(fresh, bundle, ids) });
});

/**
 * Fill the unscheduled bin in one action (the builder's "Auto-schedule").
 *
 * Only ever adds — sessions already on the grid keep their slots. Unlike
 * `/place` this does NOT fire `notifyScheduleChange`: auto-scheduling produces a
 * reviewable draft the organizer can undo in one click, and a bulk placement
 * that mails every confirmed speaker before the organizer has looked at it is
 * worse than no mail at all. Moving a session by hand afterwards notifies as usual.
 */
app.post('/app/api/agenda/autoschedule', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);

  const bundle = await loadAgenda(c.env.DB, event.id);
  const days = eventDays(event);
  const { placements, skipped } = autoSchedule(bundle, {
    days: days.length,
    dayStart: event.day_start_min,
    dayEnd: event.day_end_min,
  });

  if (placements.length) {
    const stamp = now();
    await batch(
      c.env.DB,
      placements.map((p) => [
        `UPDATE sessions SET day = ?, start_min = ?, end_min = ?, duration_min = ?, room_id = ?, all_rooms = 0,
           ics_sequence = ics_sequence + 1, updated_at = ? WHERE id = ? AND event_id = ?`,
        [p.day, p.start, p.end, p.end - p.start, p.roomId, stamp, p.id, event.id],
      ])
    );
    await logActivity(c.env.DB, {
      eventId: event.id,
      subjectType: 'event',
      subjectId: event.id,
      actor: c.var.user?.name || c.var.user?.email || 'System',
      action: 'Auto-scheduled the bin',
      detail: placements
        .map((p) => `${p.title} → ${days[p.day]?.label ?? `Day ${p.day + 1}`} ${fmtTime(p.start)} · ${p.roomName}`)
        .join('; '),
    });
  }

  const fresh = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(fresh.sessions);
  const sessions = placements
    .map((p) => fresh.sessions.find((s) => s.id === p.id))
    .filter((s): s is SessionRow => !!s)
    .map((s) => toViewSession(s, fresh, ids));

  // Sessions the second pass had to run across a soft band (lunch) — surfaced so
  // the organizer sees the trade instead of finding it on the published agenda.
  const over = placements
    .filter((p) => p.over)
    .map((p) => ({ id: p.id, title: p.title, band: p.over as string }));

  return c.json({ ok: true, sessions, skipped, over });
});

/** Undo an auto-schedule run: send exactly those sessions back to the bin. */
app.post('/app/api/agenda/autoschedule/undo', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<{ ids: string[] }>();
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
  if (!ids.length) return c.json({ ok: false, error: 'Nothing to undo.' }, 400);

  const stamp = now();
  await batch(
    c.env.DB,
    ids.map((id) => [
      `UPDATE sessions SET day = NULL, start_min = NULL, end_min = NULL,
         ics_sequence = ics_sequence + 1, updated_at = ? WHERE id = ? AND event_id = ?`,
      [stamp, id, event.id],
    ])
  );
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Undid auto-schedule',
    detail: `${ids.length} session${ids.length === 1 ? '' : 's'} returned to the bin`,
  });

  const fresh = await loadAgenda(c.env.DB, event.id);
  const fids = displayIds(fresh.sessions);
  const sessions = fresh.sessions.filter((s) => ids.includes(s.id)).map((s) => toViewSession(s, fresh, fids));
  return c.json({ ok: true, sessions });
});

/** Copy a service block to another day (the prototype's "Copy to Day 2"). */
app.post('/app/api/agenda/duplicate', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<{ id: string; day: number }>();
  const cur = await one<SessionRow>(c.env.DB, `SELECT * FROM sessions WHERE id = ? AND event_id = ?`, body?.id, event.id);
  if (!cur) return c.json({ ok: false, error: 'Session not found.' }, 400);
  if (cur.type === 'talk') return c.json({ ok: false, error: 'Talks come from submissions — copy is for service and sponsor blocks.' }, 400);
  const days = eventDays(event);
  const day = Math.max(0, Math.min(days.length - 1, Math.round(Number(body.day ?? 0))));
  const id = newId('ses');
  const stamp = now();
  await run(
    c.env.DB,
    `INSERT INTO sessions (id, event_id, submission_id, type, title, abstract, track_option_id, format_option_id,
       level, duration_min, room_id, all_rooms, day, start_min, end_min, status, published, sponsor_name,
       sponsor_badge, stream_url, visibility_json, ics_sequence, created_at, updated_at)
     VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,?,?)`,
    id,
    event.id,
    cur.type,
    cur.title,
    cur.abstract,
    cur.track_option_id,
    cur.format_option_id,
    cur.level,
    cur.duration_min,
    cur.room_id,
    cur.all_rooms,
    day,
    cur.start_min,
    cur.end_min,
    cur.status,
    cur.published,
    cur.sponsor_name,
    cur.sponsor_badge,
    stamp,
    stamp
  );
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Copied to another day',
    detail: `${cur.title} → ${days[day]?.label ?? `Day ${day + 1}`}`,
  });
  const bundle = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(bundle.sessions);
  const fresh = bundle.sessions.find((s) => s.id === id)!;
  return c.json({ ok: true, session: toViewSession(fresh, bundle, ids) });
});

app.post('/app/api/agenda/delete', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<{ id: string }>();
  const cur = await one<SessionRow>(c.env.DB, `SELECT * FROM sessions WHERE id = ? AND event_id = ?`, body?.id, event.id);
  if (!cur) return c.json({ ok: false, error: 'Session not found.' }, 400);
  if (cur.type === 'talk') {
    return c.json({ ok: false, error: 'Talks come from submissions — send it back to the bin instead of deleting.' }, 400);
  }
  await run(c.env.DB, `DELETE FROM session_speakers WHERE session_id = ?`, cur.id);
  await run(c.env.DB, `DELETE FROM sessions WHERE id = ?`, cur.id);
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: cur.id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Deleted',
    detail: cur.title,
  });
  return c.json({ ok: true, id: cur.id });
});

app.post('/app/api/agenda/publish', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const stamp = now();
  await run(
    c.env.DB,
    `UPDATE events SET published = 1, published_rev = published_rev + 1, published_at = ? WHERE id = ?`,
    stamp,
    event.id
  );
  const fresh = await one<{ published_rev: number }>(c.env.DB, `SELECT published_rev FROM events WHERE id = ?`, event.id);
  const rev = fresh?.published_rev ?? 0;
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Published agenda',
    detail: `Revision ${rev}`,
  });
  // Best-effort purge of the previous revision's cached responses.
  try {
    const cache = (caches as unknown as { default?: Cache }).default;
    if (cache) {
      const base = `${c.env.APP_ORIGIN}/${event.slug}/agenda`;
      c.executionCtx.waitUntil(
        Promise.all([
          cache.delete(`${base}?__rev=${rev - 1}`),
          cache.delete(`${base}.json?__rev=${rev - 1}`),
        ]).then(() => undefined)
      );
    }
  } catch {
    /* Cache API unavailable (some local modes) — the rev key already isolates us. */
  }
  return c.json({ ok: true, publishedRev: rev, publishedAt: stamp });
});

/** Conflict messages for one session — used by the builder after an external edit. */
app.get('/app/api/agenda/conflicts/:id', async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const msgs = await conflictsForSession(c.env, event, c.req.param('id'));
  return c.json({ ok: true, conflicts: msgs });
});

export default app;
