/**
 * Embeddable public surfaces — the agenda embed (`/{event}/embed/agenda`) and
 * the shared embed chrome (`EmbedShell`, `embedHeaders`, `loadEmbedConfig`)
 * used by every widget embed in `public-widgets.tsx`.
 *
 * Chrome-stripped documents meant to live inside an `<iframe>` on someone
 * else's website (spec §4.11, DECISIONS review-round B10). All embeds share the
 * public agenda's publish gating and its 60-second, `published_rev`-keyed
 * Cache API pattern (`withCache` from `public-agenda.tsx`), so a re-publish
 * refreshes every embed within a minute. `?transparent=1` drops the themed
 * page background; `?eid=<embed id>` applies a saved embed's config from
 * `/app/embeds` (track filter, hidden fields, accent, transparent) and 404s
 * when that embed is disabled. `?cfg=<url-encoded JSON>` carries the same
 * config inline for the live preview on `/app/embeds/new`, before a row exists.
 *
 * Responses are explicitly frameable: no X-Frame-Options is ever emitted and
 * `Content-Security-Policy: frame-ancestors *` is set on every response.
 *
 * OWNER: B4.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Ctx, Event, Theme } from '../types';
import { pairingFor, themeStyleVars } from '../lib/theme';
import { loadPublicEvent } from '../lib/public';
import { one, jsonParse } from '../lib/db';
import {
  eventDays,
  fmtSpan,
  loadAgenda,
  publishedRev,
  roomNamer,
  type SessionRow,
} from '../lib/agenda';
import { publicSessions, withCache } from './public-agenda';

const app = new Hono<Ctx>();

export function embedHeaders(res: Response): Response {
  res.headers.set('content-security-policy', 'frame-ancestors *');
  return res;
}

/* ---------------------------------------------------------- saved embeds */

export type EmbedConfig = {
  transparent?: boolean;
  /** Hex accent override — replaces the theme primary inside the embed. */
  accent?: string | null;
  /** Track option ids to keep; empty/missing = all tracks. */
  tracks?: string[];
  /** Card field keys to hide (see FIELD_KEYS in admin-embeds.tsx). */
  hide?: string[];
};

export type EmbedRow = {
  id: string;
  event_id: string;
  name: string;
  widget: string;
  format: string;
  config_json: string | null;
  enabled: number;
  updated_at: string;
};

/**
 * Parse `?cfg=` — a draft config the embed generator's live preview passes
 * inline, before an embed row exists. Display-only fields (track filter, hidden
 * card fields, colours), so an unauthenticated caller may set them, but the
 * shape is validated and capped exactly like `/app/api/embeds/create` and
 * unknown keys are dropped. Malformed JSON degrades to an empty config rather
 * than an error; `null` means no draft was passed at all.
 */
export function draftConfig(raw: string | undefined): EmbedConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const cfg = parsed as EmbedConfig;
  return {
    transparent: !!cfg.transparent,
    accent: typeof cfg.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(cfg.accent) ? cfg.accent : null,
    tracks: Array.isArray(cfg.tracks) ? cfg.tracks.filter((t) => typeof t === 'string').slice(0, 50) : [],
    hide: Array.isArray(cfg.hide) ? cfg.hide.filter((h) => typeof h === 'string').slice(0, 50) : [],
  };
}

export type EmbedResolution = {
  config: EmbedConfig;
  disabled: boolean;
  cacheSuffix: string;
  /** A draft preview is per-keystroke — it must never reach a cache. */
  noStore: boolean;
};

/**
 * Resolve `?eid=` to a saved embed's config, or `?cfg=` to a draft one. Returns
 * `disabled: true` when the embed exists but is switched off (callers must
 * 404), and an empty config when neither param was passed.
 */
export async function loadEmbedConfig(
  db: D1Database,
  eventId: string,
  eid: string | undefined,
  cfg?: string
): Promise<EmbedResolution> {
  if (!eid) {
    const draft = draftConfig(cfg);
    return { config: draft ?? {}, disabled: false, cacheSuffix: '', noStore: !!draft };
  }
  const row = await one<EmbedRow>(db, `SELECT * FROM embeds WHERE id = ? AND event_id = ?`, eid, eventId);
  if (!row) return { config: {}, disabled: false, cacheSuffix: '', noStore: false };
  if (!row.enabled) return { config: {}, disabled: true, cacheSuffix: '', noStore: false };
  return {
    config: jsonParse<EmbedConfig>(row.config_json, {}),
    disabled: false,
    cacheSuffix: `~${row.id}@${row.updated_at}`,
    noStore: false,
  };
}

/** `cache-control` for an embed response — draft previews opt out entirely. */
export const embedCacheControl = (noStore: boolean) => (noStore ? 'no-store' : 'public, max-age=60');

/** `withCache`, skipped for draft previews so no cache entry is ever written. */
export function withEmbedCache(
  c: Context<Ctx>,
  noStore: boolean,
  key: string,
  build: () => Promise<Response>
): Promise<Response> {
  return noStore ? build() : withCache(c, key, build);
}

/** Keep only sessions whose track survives the saved embed's track filter. */
export function trackFiltered(rows: SessionRow[], config: EmbedConfig): SessionRow[] {
  const tracks = config.tracks?.filter(Boolean) ?? [];
  if (!tracks.length) return rows;
  return rows.filter((s) => s.all_rooms || (s.track_option_id && tracks.includes(s.track_option_id)));
}

export function hides(config: EmbedConfig): Set<string> {
  return new Set(config.hide ?? []);
}

/* ----------------------------------------------------------------- shell */

/** Minimal themed document — no site header, footer, toast or shared islands. */
export const EmbedShell: FC<
  PropsWithChildren<{
    title: string;
    event: { name: string };
    theme: Theme;
    transparent: boolean;
    accent?: string | null;
    scripts?: string[];
  }>
> = (props) => {
  const theme = props.accent ? { ...props.theme, primary: props.accent, accent: props.accent } : props.theme;
  const pair = pairingFor(theme.font);
  const vars = themeStyleVars(theme);
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
      <body>
        {props.children}
        {(props.scripts ?? []).map((s) => (
          <script type="module" src={s}></script>
        ))}
      </body>
    </html>
  );
};

/** Same gating message as `agenda.json`'s 404, in embeddable form. */
export function notReady(kind: string, event: { name: string }, theme: Theme, transparent: boolean) {
  return (
    <EmbedShell title="Not published" event={event} theme={theme} transparent={transparent}>
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
export const FULL_LINK =
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
  const eid = c.req.query('eid');
  const { config, disabled, cacheSuffix, noStore } = await loadEmbedConfig(c.env.DB, event.id, eid, c.req.query('cfg'));
  if (disabled) return embedHeaders(await c.html(notReady('AGENDA', event, theme, false), 404));
  const transparent = c.req.query('transparent') === '1' || !!config.transparent;
  if (!event.published) {
    return embedHeaders(await c.html(notReady('AGENDA', event, theme, transparent), 404));
  }

  return withEmbedCache(
    c,
    noStore,
    `${event.slug}/${publishedRev(event)}/embed/agenda${transparent ? '?transparent=1' : ''}${cacheSuffix}`,
    async () => {
      const bundle = await loadAgenda(c.env.DB, event.id);
      const rows = trackFiltered(publicSessions(event, bundle), config).sort(
        (a, b) => a.day! - b.day! || a.start_min! - b.start_min! || (a.all_rooms ? -1 : 1)
      );
      const days = eventDays(event);
      const roomName = roomNamer(bundle);
      const trackById = new Map(bundle.tracks.map((t) => [t.id, t]));
      const shownTracks = config.tracks?.length ? bundle.tracks.filter((t) => config.tracks!.includes(t.id)) : bundle.tracks;
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
        <EmbedShell title="Agenda" event={event} theme={theme} transparent={transparent} accent={config.accent}>
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
              {shownTracks.length ? (
                <select id="f-track" style={SELECT}>
                  <option value="">All tracks</option>
                  {shownTracks.map((t) => (
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
      res.headers.set('cache-control', embedCacheControl(noStore));
      return embedHeaders(res);
    }
  );
});

export default app;
