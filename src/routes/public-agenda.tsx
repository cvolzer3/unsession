/**
 * Public agenda — `/{event}` (redirect), `/{event}/agenda`, `/{event}/agenda.json`
 * and the speaker-only ICS feed `/{event}/portal/session/<id>.ics`.
 *
 * Ported from `Agenda.dc.html`. The LIST view is server-rendered so the page
 * reads without JavaScript; `public/js/public-agenda.js` swaps views, filters,
 * sorts, opens the detail popover and re-labels times for the viewer's timezone.
 *
 * Responses are cached for 60s in the Cache API under a key that includes
 * `events.published_rev`, so publishing invalidates every cached view at once.
 *
 * OWNER: B4.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import type { Ctx, Event, Theme } from '../types';
import { PublicLayout, MONO, fmtDateRange } from '../views/layout';
import { loadPublicEvent } from '../lib/public';
import { all, one } from '../lib/db';
import {
  displayIds,
  eventDays,
  fmtSpan,
  fmtTime,
  loadAgenda,
  publishedRev,
  roomNamer,
  type AgendaBundle,
  type SessionRow,
} from '../lib/agenda';
import { icsFilename, sessionIcs } from '../lib/ics';

const app = new Hono<Ctx>();

const PAGE_MAX = 1240;

function jsonBlock(id: string, value: unknown) {
  return (
    <script type="application/json" id={id}>
      {raw(JSON.stringify(value).replace(/</g, '\\u003c'))}
    </script>
  );
}

/** Sessions that belong on the public agenda (spec B4 §3.2). */
export function publicSessions(event: Event, bundle: AgendaBundle): SessionRow[] {
  return bundle.sessions.filter(
    (s) =>
      s.day !== null &&
      s.start_min !== null &&
      s.published === 1 &&
      (!event.hide_unconfirmed || s.status === 'confirmed' || s.type !== 'talk')
  );
}

/* ---------------------------------------------------------------- cache */

type CacheLike = { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> };

function edgeCache(): CacheLike | null {
  try {
    const c = (caches as unknown as { default?: CacheLike }).default;
    return c ?? null;
  } catch {
    return null;
  }
}

/** Cache a 200 response for ~60s under a `published_rev`-scoped key (also used by the `/embed/*` routes). */
export async function withCache(c: Context<Ctx>, key: string, build: () => Promise<Response>): Promise<Response> {
  const cache = edgeCache();
  const cacheKey = new Request(new URL(`/__agenda/${key}`, new URL(c.req.url).origin).toString());
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      /* cache unavailable in some local modes */
    }
  }
  const res = await build();
  if (cache && res.status === 200) {
    try {
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    } catch {
      /* streaming bodies can't be cached — skip */
    }
  }
  return res;
}

/* ------------------------------------------------------------- not ready */

function notPublished(event: { name: string; slug: string }, theme: Theme) {
  return (
    <PublicLayout title="Agenda" event={event} theme={theme} maxWidth={680}>
      <div style="max-width:680px;margin:0 auto;padding:64px 20px 100px;text-align:center;">
        <div style="font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.14em;color:var(--muted);margin-bottom:10px;">
          AGENDA
        </div>
        <div style="font-size:24px;font-weight:700;letter-spacing:-0.02em;margin-bottom:8px;">Not published yet</div>
        <div style="font-size:14px;color:var(--text-secondary);line-height:1.6;">
          The programme is still being put together. Check back soon — every session lands here the moment the schedule
          is final.
        </div>
      </div>
    </PublicLayout>
  );
}

/* ------------------------------------------------------------------ page */

app.get('/:event', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  return c.redirect(`/${found.event.slug}/agenda`, 302);
});

app.get('/:event/agenda', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const { event, theme } = found;
  if (!event.published) return c.html(notPublished(event, theme), 200);

  return withCache(c, `${event.slug}/${publishedRev(event)}/agenda`, async () => {
    const bundle = await loadAgenda(c.env.DB, event.id);
    const ids = displayIds(bundle.sessions);
    const rows = publicSessions(event, bundle);
    const days = eventDays(event);
    const roomName = roomNamer(bundle);
    const trackById = new Map(bundle.tracks.map((t) => [t.id, t]));

    const view = rows
      .map((s) => ({
        id: s.id,
        displayId: ids.get(s.id) ?? s.id,
        title: s.title,
        abstract: s.abstract,
        type: s.type,
        day: s.day!,
        start: s.start_min!,
        end: s.end_min ?? s.start_min! + s.duration_min,
        room: s.all_rooms ? null : roomName(s.room_id),
        allRooms: !!s.all_rooms,
        trackId: s.track_option_id,
        sponsorName: s.sponsor_name,
        sponsorBadge: s.type === 'sponsor' && !!s.sponsor_badge,
        speakers: (bundle.speakers.get(s.id) ?? []).map((p) => ({ name: p.name, slug: p.slug, bio: p.bio })),
      }))
      .sort((a, b) => a.day - b.day || a.start - b.start || (a.allRooms ? -1 : 1));

    const payload = {
      slug: event.slug,
      timezone: event.timezone,
      days,
      dayStart: event.day_start_min,
      dayEnd: event.day_end_min,
      rooms: bundle.rooms.map((r) => r.name),
      tracks: bundle.tracks.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      sessions: view,
    };

    const subtitle = [fmtDateRange(event.start_date, event.end_date), event.venue || null]
      .filter(Boolean)
      .join(' · ') + (event.mode === 'hybrid' ? ' + online' : event.mode === 'online' ? ' · online' : '');

    const listRow = (s: (typeof view)[number]) => {
      const tr = s.trackId ? trackById.get(s.trackId) : null;
      const svc = s.allRooms;
      return (
        <div
          data-sid={svc ? undefined : s.id}
          data-day={String(s.day)}
          data-track={s.trackId ?? ''}
          data-search={`${s.title} ${s.speakers.map((p) => p.name).join(' ')}`.toLowerCase()}
          style={`display:grid;grid-template-columns:96px 100px 1fr 160px 120px;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);align-items:start;${
            svc ? 'background:var(--bg);' : 'cursor:pointer;'
          }`}
        >
          <span style="font-family:var(--font-mono);font-size:10.5px;color:var(--muted);" data-cell="day">
            {days[s.day]?.short ?? ''}
          </span>
          <span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text);font-weight:600;" data-cell="time">
            {fmtSpan(s.start, s.end)}
          </span>
          <span>
            <span
              style={
                svc
                  ? 'font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.08em;color:var(--muted);'
                  : 'font-size:13.5px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;'
              }
            >
              {svc ? s.title.toUpperCase() : s.title}
            </span>
            {s.sponsorBadge ? (
              <span style="font-family:var(--font-mono);font-size:8.5px;background:var(--chip);color:var(--muted);padding:2px 6px;letter-spacing:0.08em;margin-left:8px;">
                SPONSORED
              </span>
            ) : null}
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px;">{svc ? '' : s.speakers.map((p) => p.name).join(', ')}</div>
          </span>
          <span style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--text-secondary);">
            {svc ? null : (
              <>
                <span style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${tr?.color ?? '#adb5bd'};flex-shrink:0;`}></span>
                {tr?.name ?? '—'}
              </>
            )}
          </span>
          <span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);">{svc ? 'ALL ROOMS' : s.room ?? ''}</span>
        </div>
      );
    };

    const viewBtn = (on: boolean) =>
      `padding:7px 14px;border:1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'};background:${
        on ? 'var(--accent)' : 'var(--card)'
      };color:${on ? '#fff' : 'var(--text-secondary)'};font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.1em;cursor:pointer;white-space:nowrap;flex-shrink:0;`;

    const VIEWS: [string, string][] = [['list', 'LIST'], ['day', 'DAY']];
    if (days.length > 1) VIEWS.push(['week', 'WEEK']);
    VIEWS.push(['track', 'TRACK'], ['rooms', 'ROOMS']);

    const chipStyle = (on: boolean, color: string | null) =>
      `display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid ${on ? color || 'var(--accent)' : 'var(--border-strong)'};background:${
        on ? color || 'var(--accent)' : 'var(--card)'
      };color:${on ? '#fff' : 'var(--text-secondary)'};font-size:11.5px;cursor:pointer;white-space:nowrap;flex-shrink:0;`;

    const html = (
      <PublicLayout title="Agenda" event={event} theme={theme} maxWidth={PAGE_MAX} scripts={['/js/public-agenda.js']}>
        {jsonBlock('data-public-agenda', payload)}
        <div style={`max-width:${PAGE_MAX}px;margin:0 auto;padding:24px 28px 60px;`}>
          <div style="display:flex;align-items:flex-end;gap:12px;">
            <div>
              <h1 style="margin:12px 0 2px;font-size:28px;letter-spacing:-0.02em;">Agenda</h1>
              <div style="font-size:13px;color:var(--muted);">{subtitle}</div>
            </div>
            <button
              type="button"
              id="tz-toggle"
              style="margin-left:auto;padding:6px 10px;background:var(--card);border:1px solid var(--border-strong);font-family:var(--font-mono);font-size:10px;cursor:pointer;color:var(--text-secondary);white-space:nowrap;"
            >
              EVENT TIME
            </button>
          </div>
          <div
            style="position:sticky;top:51px;background:var(--bg);padding:10px 0 12px;z-index:5;border-bottom:1px solid var(--border);margin:16px 0 18px;display:grid;gap:9px;"
          >
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              {VIEWS.map(([id, label]) => (
                <button type="button" data-view={id} style={viewBtn(id === 'list')}>
                  {label}
                </button>
              ))}
            </div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;">
              <div id="day-tabs" hidden style="display:flex;gap:5px;"></div>
              <div id="track-chips" style="display:flex;gap:5px;flex-wrap:wrap;">
                <button type="button" data-track="all" style={chipStyle(true, null)}>
                  All tracks
                </button>
                {bundle.tracks.map((t) => (
                  <button type="button" data-track={t.id} style={chipStyle(false, t.color)}>
                    <span
                      data-dot
                      style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:${t.color ?? '#adb5bd'};flex-shrink:0;`}
                    ></span>
                    {t.name}
                  </button>
                ))}
              </div>
              <input
                id="agenda-search"
                placeholder="Search title or speaker…"
                style="margin-left:auto;width:220px;padding:6px 10px;border:1px solid var(--border-strong);font-size:12px;background:var(--card);"
              />
              <button
                type="button"
                id="clear-filters"
                hidden
                style="padding:6px 4px;background:none;border:none;color:var(--primary);font-size:11.5px;cursor:pointer;text-decoration:underline;"
              >
                Clear filters
              </button>
            </div>
          </div>
          <div id="agenda-body">
            <div style="background:var(--card);border:1px solid var(--border);">
              <div style="display:grid;grid-template-columns:96px 100px 1fr 160px 120px;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);">
                {[
                  ['day', 'DAY'],
                  ['time', 'TIME'],
                  ['title', 'SESSION'],
                  ['track', 'TRACK'],
                  ['room', 'ROOM'],
                ].map(([k, label]) => (
                  <button
                    type="button"
                    data-sort={k}
                    style={`background:none;border:none;padding:0;text-align:left;cursor:pointer;font-family:var(--font-mono);font-size:9.5px;letter-spacing:0.12em;color:${
                      k === 'time' ? 'var(--primary)' : 'var(--muted)'
                    };`}
                  >
                    {k === 'time' ? `${label} ▲` : label}
                  </button>
                ))}
              </div>
              {view.map(listRow)}
              {view.length === 0 ? (
                <div style="padding:28px 16px;text-align:center;font-size:12.5px;color:var(--muted);">
                  No sessions on the agenda yet.
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div id="agenda-detail"></div>
      </PublicLayout>
    );

    const res = await c.html(html);
    res.headers.set('cache-control', 'public, max-age=60');
    return res;
  });
});

/* ------------------------------------------------------------------ json */

app.get('/:event/agenda.json', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.json({ ok: false, error: 'Event not found' }, 404);
  const { event } = found;
  if (!event.published) return c.json({ ok: false, error: 'Agenda not published yet' }, 404);

  return withCache(c, `${event.slug}/${publishedRev(event)}/agenda.json`, async () => {
    const bundle = await loadAgenda(c.env.DB, event.id);
    const roomName = roomNamer(bundle);
    const trackById = new Map(bundle.tracks.map((t) => [t.id, t]));
    const days = eventDays(event);
    const body = {
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
        sponsor_badge: s.type === 'sponsor' && !!s.sponsor_badge,
        date: days[s.day!]?.date ?? null,
        day: s.day,
        start: fmtTime(s.start_min!),
        end: fmtTime(s.end_min ?? s.start_min! + s.duration_min),
        start_min: s.start_min,
        end_min: s.end_min,
        room: s.all_rooms ? null : roomName(s.room_id),
        all_rooms: !!s.all_rooms,
        track: s.track_option_id ? trackById.get(s.track_option_id)?.name ?? null : null,
        level: s.level,
        speakers: (bundle.speakers.get(s.id) ?? []).map((p) => ({
          name: p.name,
          slug: p.slug,
          url: `${c.env.APP_ORIGIN}/${event.slug}/speakers/${p.slug}`,
        })),
      })),
    };
    return new Response(JSON.stringify(body, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
    });
  });
});

/* ------------------------------------------------------------------- ics */

/** Speakers of the session (or any organizer of the event) may pull the file. */
async function mayDownload(c: Context<Ctx>, event: Event, sessionId: string): Promise<boolean> {
  const user = c.var.user;
  if (!user) return false;
  const speaker = await one(
    c.env.DB,
    `SELECT 1 FROM session_speakers ss JOIN speaker_profiles sp ON sp.id = ss.speaker_profile_id
      WHERE ss.session_id = ? AND (sp.user_id = ? OR sp.email = ?)`,
    sessionId,
    user.id,
    user.email
  );
  if (speaker) return true;
  const member = await one(c.env.DB, `SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?`, event.org_id, user.id);
  return !!member;
}

app.get('/:event/portal/session/:file', async (c) => {
  const file = c.req.param('file');
  if (!file.endsWith('.ics')) return c.notFound();
  const sessionId = file.slice(0, -4);
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const { event } = found;

  const session = await one<SessionRow>(c.env.DB, `SELECT * FROM sessions WHERE id = ? AND event_id = ?`, sessionId, event.id);
  if (!session) return c.notFound();
  if (!(await mayDownload(c, event, sessionId))) {
    return c.text('Sign in as a speaker of this session to download its calendar file.', 403);
  }
  if (session.day === null || session.start_min === null) {
    return c.text('This session is not scheduled yet — the calendar file appears once it has a slot.', 409);
  }

  const speakers = await all<{ name: string; email: string }>(
    c.env.DB,
    `SELECT sp.name, sp.email FROM session_speakers ss JOIN speaker_profiles sp ON sp.id = ss.speaker_profile_id
      WHERE ss.session_id = ? ORDER BY ss.position`,
    sessionId
  );
  const room = session.all_rooms
    ? 'All rooms'
    : session.room_id
      ? (await one<{ name: string }>(c.env.DB, `SELECT name FROM rooms WHERE id = ?`, session.room_id))?.name ?? ''
      : '';

  const body = sessionIcs(event, session, speakers, {
    roomName: room,
    from: c.env.EMAIL_FROM,
    url: `${c.env.APP_ORIGIN}/${event.slug}/agenda`,
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8; method=REQUEST',
      'content-disposition': `attachment; filename="${icsFilename(session.title)}"`,
      'cache-control': 'no-store',
    },
  });
});

export default app;
