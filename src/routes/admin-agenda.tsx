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
import { raw } from 'hono/html';
import type { Ctx, Event } from '../types';
import { AdminLayout, MONO } from '../views/layout';
import { adminProps } from '../views/chrome';
import { now, one, run } from '../lib/db';
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

const app = new Hono<Ctx>();

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`;

function tabBtn(on: boolean): string {
  return `padding:7px 13px;border:none;font-size:12.5px;cursor:pointer;font-weight:600;background:${
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

/* ------------------------------------------------------------------ page */

app.get('/app/agenda', async (c) => {
  const props = await adminProps(c, 'Agenda builder', { headerTitle: 'Agenda builder' });
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');

  const bundle = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(bundle.sessions);
  const days = eventDays(event);
  const unpublished = await hasUnpublishedChanges(c.env.DB, event);

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
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="display:flex;border:1px solid #e2e3e8;">
        {views.map(([id, label]) => (
          <button type="button" data-view={id} style={tabBtn(id === 'rooms')}>
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
        <span style={`font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#686b74;`}>UNPUBLISHED CHANGES</span>
      </div>
      <button
        type="button"
        id="publish-btn"
        style="padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
      >
        Publish changes
      </button>
    </div>
  );

  return c.html(
    <AdminLayout {...props} headerActions={headerActions} scripts={['/js/agenda-builder.js']}>
      {jsonBlock('data-agenda', payload)}
      <div style="display:grid;grid-template-columns:264px 1fr;gap:0;align-items:start;">
        <aside style="border-right:1px solid #e2e3e8;background:#fff;min-height:calc(100vh - 69px);padding:16px;position:sticky;top:0;">
          <div style="display:flex;align-items:baseline;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:700;">Unscheduled</div>
            <div id="bin-count" style={`margin-left:auto;font-family:${MONO};font-size:11px;color:#9a9da6;`}></div>
          </div>
          <div id="bin" data-drop="bin" style="display:grid;gap:8px;min-height:200px;"></div>
          <div style="margin-top:18px;border-top:1px solid #eceded;padding-top:12px;">
            <div style={`${MICRO}margin-bottom:8px;`}>ADD DIRECTLY</div>
            <button
              type="button"
              id="add-service"
              style="width:100%;padding:8px 0;background:#fff;border:1px solid #e2e3e8;font-size:12.5px;cursor:pointer;margin-bottom:6px;"
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
          <div style="margin-top:18px;border-top:1px solid #eceded;padding-top:12px;font-size:12px;color:#686b74;line-height:1.5;">
            <div style={`${MICRO}margin-bottom:6px;`}>LEGEND</div>
            <span style="display:inline-block;width:8px;height:8px;background:#2b8a3e;"></span> confirmed &nbsp;
            <span style="display:inline-block;width:8px;height:8px;background:#e6a817;"></span> pending speaker
            <br />
            <span style="display:inline-block;width:8px;height:8px;background:#adb5bd;"></span> service ·{' '}
            <span style={`font-family:${MONO};font-size:10px;`}>SP</span> sponsor
          </div>
        </aside>
        <div style="padding:18px 24px;overflow-x:auto;">
          <div id="daybar" style="display:flex;align-items:center;gap:10px;margin-bottom:14px;"></div>
          <div id="grid"></div>
        </div>
      </div>
      <div id="cards"></div>
      <NewSessionDialog tracks={bundle.tracks} formats={bundle.formats} />
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
       stream_url, visibility_json, ics_sequence, created_at, updated_at)
     VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,?,?)`,
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
