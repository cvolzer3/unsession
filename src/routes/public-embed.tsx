/**
 * Embeddable public surfaces — `/{event}/embed/agenda` and `/{event}/embed/speakers`.
 *
 * Chrome-stripped documents meant to live inside an `<iframe>` on someone
 * else's website (spec §4.11, DECISIONS review-round B10). Both share the
 * public agenda's publish gating and its 60-second, `published_rev`-keyed
 * Cache API pattern (`withCache` from `public-agenda.tsx`), so a re-publish
 * refreshes every embed within a minute. `?transparent=1` drops the themed
 * page background so the embed sits visually on the host site.
 *
 * Responses are explicitly frameable: no X-Frame-Options is ever emitted and
 * `Content-Security-Policy: frame-ancestors *` is set on every response.
 *
 * OWNER: B4.
 */
import { Hono } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Ctx, Event, Theme } from '../types';
import { pairingFor, themeStyleVars } from '../lib/theme';
import { loadPublicEvent } from '../lib/public';
import {
  eventDays,
  fmtSpan,
  loadAgenda,
  publishedRev,
  roomNamer,
  type SessionRow,
  type SpeakerLite,
} from '../lib/agenda';
import { publicSessions, withCache } from './public-agenda';

const app = new Hono<Ctx>();

/** Mirrors `publishable()` in `public-speaker.tsx` — a speaker is embeddable iff their profile page is public. */
function publishable(event: Event, s: SessionRow): boolean {
  return s.published === 1 && (!event.hide_unconfirmed || s.status === 'confirmed' || s.type !== 'talk');
}

function initialsOfName(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function embedHeaders(res: Response): Response {
  res.headers.set('content-security-policy', 'frame-ancestors *');
  return res;
}

/* ----------------------------------------------------------------- shell */

/** Minimal themed document — no site header, footer, toast or shared islands. */
const EmbedShell: FC<
  PropsWithChildren<{ title: string; event: { name: string }; theme: Theme; transparent: boolean }>
> = (props) => {
  const pair = pairingFor(props.theme.font);
  const vars = themeStyleVars(props.theme);
  const fontsHref = `https://fonts.googleapis.com/css2?${pair.google}&display=swap`;
  const css = `
  html,body{margin:0;padding:0;background:${props.transparent ? 'transparent' : 'var(--bg)'};color:var(--text);font-family:var(--font-ui);}
  a{color:var(--primary);text-decoration:none;} a:hover{color:var(--primary-hover);text-decoration:underline;}
  *{box-sizing:border-box;} input,select,button{font-family:inherit;}
  [hidden]{display:none !important;}
`;
  return (
    <html style={vars}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{`${props.event.name} — ${props.title}`}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={fontsHref} rel="stylesheet" />
        <style>{raw(css)}</style>
      </head>
      <body>{props.children}</body>
    </html>
  );
};

/** Same gating message as `agenda.json`'s 404, in embeddable form. */
function notReady(kind: 'AGENDA' | 'SPEAKERS', event: { name: string }, theme: Theme, transparent: boolean) {
  return (
    <EmbedShell title={kind === 'AGENDA' ? 'Agenda' : 'Speakers'} event={event} theme={theme} transparent={transparent}>
      <div style="padding:40px 16px;text-align:center;">
        <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.14em;color:var(--muted);margin-bottom:8px;">
          {kind}
        </div>
        <div style="font-size:17px;font-weight:700;letter-spacing:-0.01em;">Not published yet</div>
        <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin-top:6px;">
          The programme is still being put together — check back soon.
        </div>
      </div>
    </EmbedShell>
  );
}

const SELECT =
  'padding:5px 8px;border:1px solid var(--border-strong);background:var(--card);font-size:11.5px;color:var(--text);max-width:46%;';
const FULL_LINK =
  'margin-left:auto;font-family:var(--font-mono);font-size:10px;letter-spacing:0.08em;white-space:nowrap;';

/** Day + track filtering for the agenda embed — static, no shared islands inside the iframe. */
const FILTER_SCRIPT = `<script>(function(){
  var day = document.getElementById('f-day');
  var track = document.getElementById('f-track');
  if (!day && !track) return;
  var rows = [].slice.call(document.querySelectorAll('[data-day]'));
  var empty = document.getElementById('f-empty');
  function apply() {
    var d = day ? day.value : '';
    var t = track ? track.value : '';
    var shown = 0;
    rows.forEach(function (r) {
      var ok = (!d || r.getAttribute('data-day') === d) &&
        (!t || r.hasAttribute('data-service') || r.getAttribute('data-track') === t);
      r.hidden = !ok;
      if (ok) shown++;
    });
    if (empty) empty.hidden = shown > 0;
  }
  if (day) day.addEventListener('change', apply);
  if (track) track.addEventListener('change', apply);
})();</script>`;

/* ---------------------------------------------------------------- agenda */

app.get('/:event/embed/agenda', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const { event, theme } = found;
  const transparent = c.req.query('transparent') === '1';
  if (!event.published) {
    return embedHeaders(await c.html(notReady('AGENDA', event, theme, transparent), 404));
  }

  return withCache(c, `${event.slug}/${publishedRev(event)}/embed/agenda${transparent ? '?transparent=1' : ''}`, async () => {
    const bundle = await loadAgenda(c.env.DB, event.id);
    const rows = publicSessions(event, bundle).sort(
      (a, b) => a.day! - b.day! || a.start_min! - b.start_min! || (a.all_rooms ? -1 : 1)
    );
    const days = eventDays(event);
    const roomName = roomNamer(bundle);
    const trackById = new Map(bundle.tracks.map((t) => [t.id, t]));
    const agendaUrl = `/${event.slug}/agenda`;

    const listRow = (s: SessionRow) => {
      const svc = !!s.all_rooms;
      const end = s.end_min ?? s.start_min! + s.duration_min;
      const tr = s.track_option_id ? trackById.get(s.track_option_id) : null;
      const names = (bundle.speakers.get(s.id) ?? []).map((p) => p.name).join(', ');
      const rowStyle = `display:flex;gap:12px;padding:10px 12px;border-bottom:1px solid var(--border);align-items:flex-start;text-decoration:none;color:var(--text);${
        svc ? 'background:var(--bg);' : ''
      }`;
      const inner = (
        <>
          <span style="flex:none;width:84px;font-family:var(--font-mono);">
            <span style="display:block;font-size:11px;font-weight:600;">{fmtSpan(s.start_min!, end)}</span>
            <span style="display:block;font-size:9.5px;color:var(--muted);margin-top:2px;">{days[s.day!]?.short ?? ''}</span>
          </span>
          <span style="min-width:0;flex:1;">
            {svc ? (
              <span style="font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.08em;color:var(--muted);">
                {s.title.toUpperCase()}
              </span>
            ) : (
              <>
                <span style="display:block;font-size:13px;font-weight:700;letter-spacing:-0.01em;line-height:1.35;">
                  {s.title}
                  {s.type === 'sponsor' && s.sponsor_badge ? (
                    <span style="font-family:var(--font-mono);font-size:8.5px;background:var(--chip);color:var(--muted);padding:2px 6px;letter-spacing:0.08em;margin-left:8px;">
                      SPONSORED
                    </span>
                  ) : null}
                </span>
                {names ? <span style="display:block;font-size:11.5px;color:var(--muted);margin-top:2px;">{names}</span> : null}
                <span style="display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--text-secondary);margin-top:4px;flex-wrap:wrap;">
                  <span
                    style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:${tr?.color ?? '#adb5bd'};flex:none;`}
                  ></span>
                  {tr?.name ?? '—'}
                  <span style="color:var(--faint);">·</span>
                  <span style="font-family:var(--font-mono);font-size:9.5px;">{roomName(s.room_id)}</span>
                </span>
              </>
            )}
          </span>
        </>
      );
      return svc ? (
        <div data-day={String(s.day)} data-track="" data-service style={rowStyle}>
          {inner}
        </div>
      ) : (
        <a
          href={agendaUrl}
          target="_blank"
          rel="noreferrer"
          data-day={String(s.day)}
          data-track={s.track_option_id ?? ''}
          style={rowStyle}
        >
          {inner}
        </a>
      );
    };

    const html = (
      <EmbedShell title="Agenda" event={event} theme={theme} transparent={transparent}>
        <div style="padding:12px;">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
            {days.length > 1 ? (
              <select id="f-day" style={SELECT}>
                <option value="">All days</option>
                {days.map((d) => (
                  <option value={String(d.index)}>{d.label}</option>
                ))}
              </select>
            ) : null}
            {bundle.tracks.length ? (
              <select id="f-track" style={SELECT}>
                <option value="">All tracks</option>
                {bundle.tracks.map((t) => (
                  <option value={t.id}>{t.name}</option>
                ))}
              </select>
            ) : null}
            <a href={agendaUrl} target="_blank" rel="noreferrer" style={FULL_LINK}>
              FULL AGENDA ↗
            </a>
          </div>
          <div style="background:var(--card);border:1px solid var(--border);">
            {rows.map(listRow)}
            {rows.length === 0 ? (
              <div style="padding:24px 12px;text-align:center;font-size:12px;color:var(--muted);">
                No sessions on the agenda yet.
              </div>
            ) : null}
            <div id="f-empty" hidden style="padding:24px 12px;text-align:center;font-size:12px;color:var(--muted);">
              No sessions match those filters.
            </div>
          </div>
        </div>
        {raw(FILTER_SCRIPT)}
      </EmbedShell>
    );

    const res = await c.html(html);
    res.headers.set('cache-control', 'public, max-age=60');
    return embedHeaders(res);
  });
});

/* -------------------------------------------------------------- speakers */

app.get('/:event/embed/speakers', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const { event, theme } = found;
  const transparent = c.req.query('transparent') === '1';
  if (!event.published) {
    return embedHeaders(await c.html(notReady('SPEAKERS', event, theme, transparent), 404));
  }

  return withCache(c, `${event.slug}/${publishedRev(event)}/embed/speakers${transparent ? '?transparent=1' : ''}`, async () => {
    const bundle = await loadAgenda(c.env.DB, event.id);
    const byId = new Map<string, { profile: SpeakerLite; titles: string[] }>();
    for (const s of bundle.sessions) {
      if (!publishable(event, s)) continue;
      for (const p of bundle.speakers.get(s.id) ?? []) {
        const cur = byId.get(p.id) ?? { profile: p, titles: [] };
        cur.titles.push(s.title);
        byId.set(p.id, cur);
      }
    }
    const list = [...byId.values()].sort((a, b) => a.profile.name.localeCompare(b.profile.name));

    const cell = ({ profile: p, titles }: { profile: SpeakerLite; titles: string[] }) => (
      <a
        href={`/${event.slug}/speakers/${p.slug}`}
        target="_blank"
        rel="noreferrer"
        style="display:block;background:var(--card);border:1px solid var(--border);padding:10px;text-decoration:none;color:var(--text);"
      >
        {p.headshot_file_id ? (
          <img
            src={`/files/${p.headshot_file_id}`}
            alt={p.name}
            loading="lazy"
            style="width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:var(--chip);"
          />
        ) : (
          <div style="width:100%;aspect-ratio:1/1;background:var(--chip);color:var(--primary);display:grid;place-items:center;font-size:34px;font-weight:700;letter-spacing:-0.02em;">
            {initialsOfName(p.name)}
          </div>
        )}
        <div style="font-size:13px;font-weight:700;letter-spacing:-0.01em;margin-top:9px;line-height:1.3;">{p.name}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px;line-height:1.45;">{titles.join(' · ')}</div>
      </a>
    );

    const html = (
      <EmbedShell title="Speakers" event={event} theme={theme} transparent={transparent}>
        <div style="padding:12px;">
          <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px;">
            <span style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.14em;color:var(--muted);">
              {`SPEAKERS · ${list.length}`}
            </span>
            <a href={`/${event.slug}/agenda`} target="_blank" rel="noreferrer" style={FULL_LINK}>
              FULL AGENDA ↗
            </a>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;">
            {list.map(cell)}
          </div>
          {list.length === 0 ? (
            <div style="padding:24px 12px;text-align:center;font-size:12px;color:var(--muted);">
              No speakers announced yet.
            </div>
          ) : null}
        </div>
      </EmbedShell>
    );

    const res = await c.html(html);
    res.headers.set('cache-control', 'public, max-age=60');
    return embedHeaders(res);
  });
});

export default app;
