/**
 * Public widget surfaces — the attendee-facing pages
 *
 *   /{event}/sessions    session catalog: search, Format/Track/Location facets,
 *                        result count, expandable descriptions
 *   /{event}/speakers    speaker directory: surname order, name search, each
 *                        speaker's sessions inline
 *   /{event}/gallery     speaker photo grid: name search, detail overlay
 *   /{event}/itinerary   day-tabbed chronological schedule with a browser-local
 *                        personal schedule (star → My schedule → .ics export)
 *
 * their embeddable variants (`/{event}/embed/<widget>` — same content inside
 * `EmbedShell`, plus `?basic=1` for a style-free HTML fragment), and the
 * machine-readable feeds
 *
 *   /{event}/agenda.ics   whole-agenda calendar (METHOD:PUBLISH); `?ids=` picks
 *                         specific sessions (the itinerary's export)
 *   /{event}/agenda.xml   sessions feed
 *   /{event}/speakers.json /{event}/speakers.xml   speaker feeds
 *
 * All surfaces are anonymous, share the public agenda's publish gating and its
 * 60-second `published_rev`-keyed cache, and honour a saved embed's config via
 * `?eid=` (see /app/embeds). Speaker emails never appear in any feed.
 *
 * OWNER: B4.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Ctx, Event, Theme } from '../types';
import { PublicLayout, publicNav, PUBLIC_PAGE_MAX } from '../views/layout';
import { loadPublicEvent } from '../lib/public';
import {
  eventDays,
  fmtSpan,
  fmtTime,
  loadAgenda,
  publishedRev,
  roomNamer,
  speakerAffiliation,
  type AgendaBundle,
  type EventDay,
  type OptRow,
  type SessionRow,
  type SpeakerLite,
} from '../lib/agenda';
import { agendaIcs } from '../lib/ics';
import { publicSessions, withCache } from './public-agenda';
import {
  EmbedShell,
  draftConfig,
  embedCacheControl,
  embedHeaders,
  hides,
  loadEmbedConfig,
  notReady,
  trackFiltered,
  withEmbedCache,
  type EmbedConfig,
} from './public-embed';

const app = new Hono<Ctx>();

const MONO = 'var(--font-mono)';
const PAGE_MAX = PUBLIC_PAGE_MAX;

/* ------------------------------------------------------------ shared ctx */

function initialsOfName(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Mirrors `publishable()` in `public-speaker.tsx`. */
function publishable(event: Event, s: SessionRow): boolean {
  return s.published === 1 && (!event.hide_unconfirmed || s.status === 'confirmed' || s.type !== 'talk');
}

function surnameKey(name: string): string {
  const parts = (name || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return parts.length ? `${parts[parts.length - 1]} ${parts.join(' ')}` : '~';
}

type WidgetCtx = {
  event: Event;
  theme: Theme;
  bundle: AgendaBundle;
  days: EventDay[];
  roomName: (id: string | null) => string;
  trackById: Map<string, OptRow>;
  formatById: Map<string, OptRow>;
  /** Scheduled, publishable, config-track-filtered, chronological. */
  scheduled: SessionRow[];
  config: EmbedConfig;
  hide: Set<string>;
};

async function widgetCtx(c: Context<Ctx>, event: Event, theme: Theme, config: EmbedConfig): Promise<WidgetCtx> {
  const bundle = await loadAgenda(c.env.DB, event.id);
  const scheduled = trackFiltered(publicSessions(event, bundle), config).sort(
    (a, b) => a.day! - b.day! || a.start_min! - b.start_min! || (a.all_rooms ? -1 : 1)
  );
  return {
    event,
    theme,
    bundle,
    days: eventDays(event),
    roomName: roomNamer(bundle),
    trackById: new Map(bundle.tracks.map((t) => [t.id, t])),
    formatById: new Map(bundle.formats.map((f) => [f.id, f])),
    scheduled,
    config,
    hide: hides(config),
  };
}

function fmtLabel(x: WidgetCtx, s: SessionRow): string {
  const f = s.format_option_id ? x.formatById.get(s.format_option_id) : null;
  if (!f) return '';
  return f.duration_min ? `${f.name} (${f.duration_min} min)` : f.name;
}

/** "Day 1 · Wed, May 12 · 14:00–14:30" */
function whenLabel(x: WidgetCtx, s: SessionRow): string {
  if (s.day === null || s.start_min === null) return 'To be announced';
  const d = x.days[s.day];
  const end = s.end_min ?? s.start_min + s.duration_min;
  return `${d?.label ?? `Day ${s.day + 1}`} · ${fmtSpan(s.start_min, end)}`;
}

function roomLabel(x: WidgetCtx, s: SessionRow): string {
  if (s.day === null || s.start_min === null) return '';
  return s.all_rooms ? 'All rooms' : x.roomName(s.room_id);
}

type SpeakerEntry = { profile: SpeakerLite; sessions: SessionRow[] };

/** Speakers with ≥1 publishable session (scheduled or TBA), surname-ordered. */
function speakerEntries(x: WidgetCtx): SpeakerEntry[] {
  const byId = new Map<string, SpeakerEntry>();
  const rows = trackFiltered(
    x.bundle.sessions.filter((s) => publishable(x.event, s)),
    x.config
  );
  for (const s of rows) {
    for (const p of x.bundle.speakers.get(s.id) ?? []) {
      const cur = byId.get(p.id) ?? { profile: p, sessions: [] };
      cur.sessions.push(s);
      byId.set(p.id, cur);
    }
  }
  const chrono = (s: SessionRow) => (s.day === null || s.start_min === null ? 999999 : s.day * 10000 + s.start_min);
  for (const e of byId.values()) e.sessions.sort((a, b) => chrono(a) - chrono(b));
  return [...byId.values()].sort((a, b) => surnameKey(a.profile.name).localeCompare(surnameKey(b.profile.name)));
}

/* ------------------------------------------------------------ fragments */

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.14em;color:var(--muted);`;
const CHIP = `display:inline-flex;align-items:center;gap:6px;font-family:${MONO};font-size:9.5px;letter-spacing:0.06em;background:var(--chip);color:var(--text-secondary);padding:3px 8px;`;
const CLAMP = 'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;';
const MORE_BTN =
  'background:none;border:none;padding:0;margin-top:4px;font-size:12px;color:var(--primary);cursor:pointer;text-decoration:underline;';
const SEARCH_INPUT =
  'width:260px;max-width:100%;padding:7px 10px;border:1px solid var(--border-strong);font-size:12.5px;background:var(--card);';

function Headshot(props: { p: SpeakerLite; size: number; round?: boolean }) {
  const { p, size } = props;
  const radius = props.round ? 'border-radius:50%;' : '';
  return p.headshot_file_id ? (
    <img
      src={`/files/${p.headshot_file_id}`}
      alt={p.name}
      loading="lazy"
      style={`width:${size}px;height:${size}px;object-fit:cover;display:block;background:var(--chip);${radius}flex:none;`}
    />
  ) : (
    <div
      style={`width:${size}px;height:${size}px;background:var(--chip);color:var(--primary);display:grid;place-items:center;font-weight:700;font-size:${Math.round(
        size * 0.34
      )}px;letter-spacing:-0.02em;${radius}flex:none;`}
    >
      {initialsOfName(p.name)}
    </div>
  );
}

function Abstract(props: { text: string; hidden: boolean }) {
  if (props.hidden || !props.text) return null;
  return (
    <div>
      <div data-abstract style={`font-size:13px;color:var(--text-secondary);line-height:1.55;margin-top:7px;${CLAMP}`}>
        {props.text}
      </div>
      <button type="button" data-more style={MORE_BTN}>
        Show more
      </button>
    </div>
  );
}

function TrackChip(props: { x: WidgetCtx; s: SessionRow }) {
  const tr = props.s.track_option_id ? props.x.trackById.get(props.s.track_option_id) : null;
  if (!tr) return null;
  return (
    <span style={CHIP}>
      <span style={`width:7px;height:7px;border-radius:50%;background:${tr.color ?? '#adb5bd'};flex:none;`}></span>
      {`TRACK: ${tr.name.toUpperCase()}`}
    </span>
  );
}

function SpeakersBlock(props: { x: WidgetCtx; s: SessionRow; slug: string; blank: boolean }) {
  const people = props.x.bundle.speakers.get(props.s.id) ?? [];
  if (!people.length) return null;
  return (
    <div style="display:flex;flex-direction:column;gap:6px;margin-top:9px;">
      {people.map((p) => (
        <div style="display:flex;gap:9px;align-items:center;">
          <Headshot p={p} size={28} round />
          <div style="min-width:0;">
            <a
              href={`/${props.slug}/speakers/${encodeURIComponent(p.slug)}`}
              target={props.blank ? '_blank' : undefined}
              rel={props.blank ? 'noreferrer' : undefined}
              style="font-size:12.5px;font-weight:600;color:var(--text);"
            >
              {p.name}
            </a>
            {speakerAffiliation(p) ? (
              <div style="font-size:11px;color:var(--muted);margin-top:1px;">{speakerAffiliation(p)}</div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ==================================================== sessions list widget */

function SessionCard(props: { x: WidgetCtx; s: SessionRow; blank: boolean }) {
  const { x, s } = props;
  const search = `${s.title} ${(x.bundle.speakers.get(s.id) ?? []).map((p) => p.name).join(' ')}`.toLowerCase();
  const fmt = fmtLabel(x, s);
  return (
    <div
      data-w-card
      data-search={search}
      data-track={s.track_option_id ?? ''}
      data-format={s.format_option_id ?? ''}
      data-room={s.all_rooms ? 'all' : s.room_id ?? ''}
      style="background:var(--card);border:1px solid var(--border);padding:16px 18px;"
    >
      <div style="font-size:15.5px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;">
        {s.title}
        {s.type === 'sponsor' && s.sponsor_badge ? (
          <span style={`font-family:${MONO};font-size:8.5px;background:var(--chip);color:var(--muted);padding:2px 6px;letter-spacing:0.08em;margin-left:8px;`}>
            SPONSORED
          </span>
        ) : null}
      </div>
      <div style={`display:flex;gap:10px;flex-wrap:wrap;font-family:${MONO};font-size:10.5px;color:var(--muted);margin-top:6px;`}>
        <span style="color:var(--text);font-weight:600;">{whenLabel(x, s)}</span>
        {!x.hide.has('room') && roomLabel(x, s) ? <span>{roomLabel(x, s)}</span> : null}
      </div>
      <Abstract text={s.abstract} hidden={x.hide.has('description')} />
      {x.hide.has('speakers') ? null : <SpeakersBlock x={x} s={s} slug={x.event.slug} blank={props.blank} />}
      <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;">
        {!x.hide.has('format') && fmt ? <span style={CHIP}>{`FORMAT: ${fmt.toUpperCase()}`}</span> : null}
        {x.hide.has('track') ? null : <TrackChip x={x} s={s} />}
      </div>
    </div>
  );
}

function FacetGroup(props: { label: string; facet: string; options: { value: string; name: string }[] }) {
  if (!props.options.length) return null;
  return (
    <div>
      <div style={`${MICRO}margin-bottom:7px;`}>{props.label}</div>
      <div style="display:grid;gap:5px;">
        {props.options.map((o) => (
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;">
            <input type="checkbox" data-facet={props.facet} value={o.value} style="width:14px;height:14px;accent-color:var(--primary);" />
            {o.name}
          </label>
        ))}
      </div>
    </div>
  );
}

function sessionsContent(x: WidgetCtx, opts: { embed: boolean }) {
  const rows = x.scheduled.filter((s) => s.type !== 'service');
  const shownTracks = x.config.tracks?.length ? x.bundle.tracks.filter((t) => x.config.tracks!.includes(t.id)) : x.bundle.tracks;
  return (
    <div data-widget="sessions" data-slug={x.event.slug} style={opts.embed ? 'padding:14px;' : ''}>
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
        <h1 style={`margin:0;font-size:${opts.embed ? 19 : 26}px;letter-spacing:-0.02em;`}>Sessions</h1>
        <span data-w-count style={`font-family:${MONO};font-size:11px;color:var(--muted);`}>
          {rows.length ? `1–${rows.length} of ${rows.length}` : 'None yet'}
        </span>
        {opts.embed ? (
          <a href={`/${x.event.slug}/sessions`} target="_blank" rel="noreferrer" style={`margin-left:auto;${MICRO}`}>
            FULL SITE ↗
          </a>
        ) : null}
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px;">
        {x.hide.has('search') ? null : (
          <input data-w-search placeholder="Search by session title or speaker…" style={SEARCH_INPUT} />
        )}
        <button
          type="button"
          data-facets-toggle
          style="padding:7px 14px;border:1px solid var(--border-strong);background:var(--card);font-size:12.5px;cursor:pointer;"
        >
          Filters
        </button>
        <button
          type="button"
          data-w-clear
          hidden
          style="background:none;border:none;padding:0;color:var(--primary);font-size:12px;cursor:pointer;text-decoration:underline;"
        >
          Clear filters
        </button>
      </div>
      <div
        data-facets
        hidden
        style="background:var(--card);border:1px solid var(--border);padding:16px 18px;margin-top:10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:18px;position:relative;"
      >
        <button
          type="button"
          data-facets-toggle
          aria-label="Close filters"
          style="position:absolute;top:8px;right:10px;background:none;border:none;font-size:15px;color:var(--muted);cursor:pointer;"
        >
          ✕
        </button>
        <FacetGroup label="FORMAT" facet="format" options={x.bundle.formats.map((f) => ({ value: f.id, name: f.name }))} />
        <FacetGroup label="TRACK" facet="track" options={shownTracks.map((t) => ({ value: t.id, name: t.name }))} />
        <FacetGroup
          label="LOCATION"
          facet="room"
          options={x.bundle.rooms.map((r) => ({ value: r.id, name: r.name }))}
        />
      </div>
      <div style="display:grid;gap:12px;margin-top:16px;">
        {rows.map((s) => (
          <SessionCard x={x} s={s} blank={opts.embed} />
        ))}
        {rows.length === 0 ? (
          <div style="padding:32px 16px;text-align:center;font-size:13px;color:var(--muted);background:var(--card);border:1px solid var(--border);">
            No sessions on the programme yet.
          </div>
        ) : null}
        <div data-w-empty hidden style="padding:32px 16px;text-align:center;font-size:13px;color:var(--muted);background:var(--card);border:1px solid var(--border);">
          No sessions match — try clearing the search or filters.
        </div>
      </div>
    </div>
  );
}

/* ================================================= speakers list (directory) */

function speakersContent(x: WidgetCtx, opts: { embed: boolean }) {
  const entries = speakerEntries(x);
  const blank = opts.embed;
  return (
    <div data-widget="speakers" data-slug={x.event.slug} style={opts.embed ? 'padding:14px;' : ''}>
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
        <h1 style={`margin:0;font-size:${opts.embed ? 19 : 26}px;letter-spacing:-0.02em;`}>Speakers</h1>
        <span data-w-count style={`font-family:${MONO};font-size:11px;color:var(--muted);`}>
          {entries.length ? `1–${entries.length} of ${entries.length}` : 'None yet'}
        </span>
        {opts.embed ? (
          <a href={`/${x.event.slug}/speakers`} target="_blank" rel="noreferrer" style={`margin-left:auto;${MICRO}`}>
            FULL SITE ↗
          </a>
        ) : null}
      </div>
      {x.hide.has('search') ? null : (
        <div style="margin-top:14px;">
          <input data-w-search placeholder="Search speakers by name…" style={SEARCH_INPUT} />
        </div>
      )}
      <div style="display:grid;gap:12px;margin-top:16px;">
        {entries.map((e) => (
          <div
            data-w-card
            data-search={e.profile.name.toLowerCase()}
            style="background:var(--card);border:1px solid var(--border);padding:16px 18px;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;"
          >
            <Headshot p={e.profile} size={64} round />
            <div style="flex:1;min-width:240px;">
              <a
                href={`/${x.event.slug}/speakers/${encodeURIComponent(e.profile.slug)}`}
                target={blank ? '_blank' : undefined}
                rel={blank ? 'noreferrer' : undefined}
                style="font-size:15.5px;font-weight:700;letter-spacing:-0.01em;color:var(--text);"
              >
                {e.profile.name}
              </a>
              {!x.hide.has('tagline') && speakerAffiliation(e.profile) ? (
                <div style="font-size:12.5px;color:var(--muted);margin-top:2px;">{speakerAffiliation(e.profile)}</div>
              ) : null}
              {x.hide.has('bio') ? null : <Abstract text={e.profile.bio} hidden={false} />}
              {x.hide.has('sessions') ? null : (
                <div style="margin-top:10px;border-top:1px solid var(--chip);padding-top:9px;display:grid;gap:7px;">
                  {e.sessions.map((s) => (
                    <div style="font-size:12.5px;">
                      <a
                        href={`/${x.event.slug}/speakers/${encodeURIComponent(e.profile.slug)}`}
                        target={blank ? '_blank' : undefined}
                        rel={blank ? 'noreferrer' : undefined}
                        style="font-weight:600;color:var(--text);"
                      >
                        {s.title}
                      </a>
                      <span style={`font-family:${MONO};font-size:10px;color:var(--muted);margin-left:8px;`}>
                        {whenLabel(x, s)}
                        {roomLabel(x, s) ? ` · ${roomLabel(x, s)}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {entries.length === 0 ? (
          <div style="padding:32px 16px;text-align:center;font-size:13px;color:var(--muted);background:var(--card);border:1px solid var(--border);">
            No speakers announced yet.
          </div>
        ) : null}
        <div data-w-empty hidden style="padding:32px 16px;text-align:center;font-size:13px;color:var(--muted);background:var(--card);border:1px solid var(--border);">
          No speakers match that name.
        </div>
      </div>
    </div>
  );
}

/* ======================================================== speaker gallery */

function galleryContent(x: WidgetCtx, opts: { embed: boolean }) {
  const entries = speakerEntries(x);
  const blank = opts.embed;
  return (
    <div data-widget="gallery" data-slug={x.event.slug} style={opts.embed ? 'padding:14px;' : ''}>
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
        <h1 style={`margin:0;font-size:${opts.embed ? 19 : 26}px;letter-spacing:-0.02em;`}>Speakers</h1>
        <span data-w-count style={`font-family:${MONO};font-size:11px;color:var(--muted);`}>
          {entries.length ? `${entries.length}` : 'None yet'}
        </span>
        {opts.embed ? (
          <a href={`/${x.event.slug}/gallery`} target="_blank" rel="noreferrer" style={`margin-left:auto;${MICRO}`}>
            FULL SITE ↗
          </a>
        ) : null}
      </div>
      {x.hide.has('search') ? null : (
        <div style="margin-top:14px;">
          <input data-w-search placeholder="Search speaker by name…" style={SEARCH_INPUT} />
        </div>
      )}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-top:16px;">
        {entries.map((e) => (
          <button
            type="button"
            data-w-card
            data-g-card={e.profile.id}
            data-search={e.profile.name.toLowerCase()}
            style="display:block;background:var(--card);border:1px solid var(--border);padding:10px;text-align:left;cursor:pointer;color:var(--text);font-family:inherit;"
          >
            <Headshot p={e.profile} size={140} />
            <div style="font-size:13px;font-weight:700;letter-spacing:-0.01em;margin-top:9px;line-height:1.3;">
              {e.profile.name}
            </div>
            {!x.hide.has('tagline') && speakerAffiliation(e.profile) ? (
              <div style="font-size:11px;color:var(--muted);margin-top:3px;line-height:1.45;">
                {speakerAffiliation(e.profile)}
              </div>
            ) : null}
          </button>
        ))}
      </div>
      {entries.length === 0 ? (
        <div style="padding:32px 16px;text-align:center;font-size:13px;color:var(--muted);background:var(--card);border:1px solid var(--border);margin-top:16px;">
          No speakers announced yet.
        </div>
      ) : null}
      <div data-w-empty hidden style="padding:32px 16px;text-align:center;font-size:13px;color:var(--muted);background:var(--card);border:1px solid var(--border);margin-top:16px;">
        No speakers match that name.
      </div>
      {/* Detail overlays — server-rendered, toggled by the island. */}
      {entries.map((e) => (
        <div
          data-g-detail={e.profile.id}
          hidden
          style="position:fixed;inset:0;background:rgba(22,23,29,0.5);z-index:60;overflow-y:auto;padding:32px 16px;"
        >
          <div style="max-width:620px;margin:0 auto;background:var(--card);border:1px solid var(--border);padding:22px 24px;">
            <button
              type="button"
              data-g-close
              style="background:none;border:none;padding:0;font-size:13px;color:var(--primary);cursor:pointer;text-decoration:underline;"
            >
              ← Back
            </button>
            <div style="display:flex;gap:18px;align-items:flex-start;margin-top:14px;flex-wrap:wrap;">
              <Headshot p={e.profile} size={110} />
              <div style="flex:1;min-width:220px;">
                <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;">{e.profile.name}</div>
                {speakerAffiliation(e.profile) ? (
                  <div style="font-size:13px;color:var(--muted);margin-top:3px;">{speakerAffiliation(e.profile)}</div>
                ) : null}
                <Abstract text={e.profile.bio} hidden={false} />
                <div style="margin-top:12px;">
                  <a
                    href={`/${x.event.slug}/speakers/${encodeURIComponent(e.profile.slug)}`}
                    target={blank ? '_blank' : undefined}
                    rel={blank ? 'noreferrer' : undefined}
                    style="font-size:12.5px;"
                  >
                    Full profile ↗
                  </a>
                </div>
              </div>
            </div>
            <div style="margin-top:18px;">
              <div style={`${MICRO}border-bottom:1px solid var(--border);padding-bottom:8px;`}>
                {`SESSIONS (${e.sessions.length})`}
              </div>
              <div style="display:grid;gap:9px;margin-top:10px;">
                {e.sessions.map((s) => (
                  <div>
                    <div style="font-size:13.5px;font-weight:600;line-height:1.3;">{s.title}</div>
                    <div style={`font-family:${MONO};font-size:10px;color:var(--muted);margin-top:2px;`}>
                      {whenLabel(x, s)}
                      {roomLabel(x, s) ? ` · ${roomLabel(x, s)}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ====================================================== schedule itinerary */

function ItineraryCard(props: { x: WidgetCtx; s: SessionRow; blank: boolean }) {
  const { x, s } = props;
  const svc = !!s.all_rooms && s.type === 'service';
  if (svc) {
    return (
      <div
        data-i-card
        data-search={s.title.toLowerCase()}
        data-track=""
        data-service
        style="background:var(--bg);border:1px solid var(--border);padding:10px 16px;display:flex;gap:12px;align-items:center;"
      >
        <span style={`font-family:${MONO};font-size:10.5px;font-weight:600;`}>
          {fmtSpan(s.start_min!, s.end_min ?? s.start_min! + s.duration_min)}
        </span>
        <span style={`font-family:${MONO};font-size:10.5px;letter-spacing:0.08em;color:var(--muted);`}>
          {s.title.toUpperCase()}
        </span>
      </div>
    );
  }
  const tr = s.track_option_id ? x.trackById.get(s.track_option_id) : null;
  const fmt = fmtLabel(x, s);
  const search = `${s.title} ${(x.bundle.speakers.get(s.id) ?? []).map((p) => p.name).join(' ')}`.toLowerCase();
  return (
    <div
      data-i-card
      data-sid={s.id}
      data-search={search}
      data-track={s.track_option_id ?? ''}
      style="background:var(--card);border:1px solid var(--border);padding:16px 18px;"
    >
      <div style="display:flex;gap:10px;align-items:flex-start;">
        <div style="min-width:0;flex:1;">
          {tr ? (
            <span style={`font-size:9.5px;font-family:${MONO};color:#fff;background:${tr.color ?? '#adb5bd'};padding:2px 7px;letter-spacing:0.06em;`}>
              {tr.name.toUpperCase()}
            </span>
          ) : null}
          <div style="font-size:15.5px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;margin-top:6px;">
            {s.title}
            {s.type === 'sponsor' && s.sponsor_badge ? (
              <span style={`font-family:${MONO};font-size:8.5px;background:var(--chip);color:var(--muted);padding:2px 6px;letter-spacing:0.08em;margin-left:8px;`}>
                SPONSORED
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          data-star={s.id}
          title="Add to my schedule"
          style="background:none;border:1px solid var(--border-strong);padding:5px 10px;font-size:12px;cursor:pointer;color:var(--text-secondary);white-space:nowrap;flex:none;"
        >
          ☆ Add
        </button>
      </div>
      <Abstract text={s.abstract} hidden={x.hide.has('description')} />
      <div style={`display:flex;gap:10px;flex-wrap:wrap;font-family:${MONO};font-size:10.5px;color:var(--muted);margin-top:8px;`}>
        <span style="color:var(--text);font-weight:600;">{whenLabel(x, s)}</span>
        {!x.hide.has('room') && roomLabel(x, s) ? <span>{`📍 ${roomLabel(x, s)}`}</span> : null}
      </div>
      {x.hide.has('speakers') ? null : <SpeakersBlock x={x} s={s} slug={x.event.slug} blank={props.blank} />}
      <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;">
        {!x.hide.has('format') && fmt ? <span style={CHIP}>{`FORMAT: ${fmt.toUpperCase()}`}</span> : null}
        {x.hide.has('track') ? null : <TrackChip x={x} s={s} />}
      </div>
    </div>
  );
}

function itineraryContent(x: WidgetCtx, opts: { embed: boolean }) {
  const shownTracks = x.config.tracks?.length ? x.bundle.tracks.filter((t) => x.config.tracks!.includes(t.id)) : x.bundle.tracks;
  const byDay = x.days.map((d) => x.scheduled.filter((s) => s.day === d.index));
  const dayBtn = (on: boolean) =>
    `padding:7px 14px;border:1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'};background:${
      on ? 'var(--accent)' : 'var(--card)'
    };color:${on ? '#fff' : 'var(--text-secondary)'};font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;`;
  return (
    <div data-widget="itinerary" data-slug={x.event.slug} style={opts.embed ? 'padding:14px;' : ''}>
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
        <h1 style={`margin:0;font-size:${opts.embed ? 19 : 26}px;letter-spacing:-0.02em;`}>Itinerary</h1>
        {opts.embed ? (
          <a href={`/${x.event.slug}/itinerary`} target="_blank" rel="noreferrer" style={`margin-left:auto;${MICRO}`}>
            FULL SITE ↗
          </a>
        ) : null}
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px;">
        {x.hide.has('search') ? null : <input data-w-search placeholder="Search by session title or speaker…" style={SEARCH_INPUT} />}
        {shownTracks.length ? (
          <select data-i-track style="padding:7px 8px;border:1px solid var(--border-strong);background:var(--card);font-size:12px;">
            <option value="">All tracks</option>
            {shownTracks.map((t) => (
              <option value={t.id}>{t.name}</option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          data-mine-toggle
          style="padding:7px 14px;border:1px solid var(--border-strong);background:var(--card);font-size:12.5px;cursor:pointer;white-space:nowrap;"
        >
          ★ My schedule (<span data-mine-count>0</span>)
        </button>
        <a
          data-ics-link
          href={`/${x.event.slug}/agenda.ics`}
          data-ics-base={`/${x.event.slug}/agenda.ics`}
          style="font-size:12.5px;white-space:nowrap;"
        >
          ＋ Add to calendar (.ics)
        </a>
      </div>
      {x.days.length > 1 ? (
        <div data-i-days style="display:flex;gap:6px;flex-wrap:wrap;margin-top:14px;">
          {x.days.map((d) => (
            <button type="button" data-day-tab={String(d.index)} style={dayBtn(d.index === 0)}>
              {d.label.split(' · ')[1] ?? d.label}
            </button>
          ))}
        </div>
      ) : null}
      {x.days.map((d, di) => (
        <section data-day-section={String(d.index)} hidden={x.days.length > 1 && di !== 0} style="margin-top:16px;">
          <div style={`${MICRO}border-bottom:1px solid var(--border);padding-bottom:8px;`}>{d.label.toUpperCase()}</div>
          {(() => {
            const groups: { at: number; items: SessionRow[] }[] = [];
            for (const s of byDay[di]) {
              const hour = Math.floor(s.start_min! / 60) * 60;
              const g = groups.find((x2) => x2.at === hour);
              if (g) g.items.push(s);
              else groups.push({ at: hour, items: [s] });
            }
            return groups.map((g) => (
              <div data-i-group style="margin-top:14px;">
                <div style={`font-family:${MONO};font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;`}>
                  {fmtTime(g.at)}
                </div>
                <div style="display:grid;gap:10px;">
                  {g.items.map((s) => (
                    <ItineraryCard x={x} s={s} blank={opts.embed} />
                  ))}
                </div>
              </div>
            ));
          })()}
          {byDay[di].length === 0 ? (
            <div style="padding:24px 12px;text-align:center;font-size:12.5px;color:var(--muted);">Nothing scheduled this day yet.</div>
          ) : null}
        </section>
      ))}
      <div data-w-empty hidden style="padding:32px 16px;text-align:center;font-size:13px;color:var(--muted);background:var(--card);border:1px solid var(--border);margin-top:16px;">
        No sessions match — clear the search, track filter or My schedule toggle.
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- basic HTML */

function escXml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Style-free markup for server-side inclusion (`?basic=1`). */
function basicHtml(x: WidgetCtx, widget: string, origin: string): string {
  const lines: string[] = [];
  if (widget === 'speakers' || widget === 'gallery') {
    lines.push(`<div class="unsession-speakers"><h2>${escXml(x.event.name)} — Speakers</h2><ul>`);
    for (const e of speakerEntries(x)) {
      const sess = e.sessions
        .map((s) => `<li>${escXml(s.title)} — ${escXml(whenLabel(x, s))}${roomLabel(x, s) ? ` — ${escXml(roomLabel(x, s))}` : ''}</li>`)
        .join('');
      lines.push(
        `<li><strong>${escXml(e.profile.name)}</strong>${
          speakerAffiliation(e.profile) ? ` — ${escXml(speakerAffiliation(e.profile))}` : ''
        }` +
          `${e.profile.bio ? `<p>${escXml(e.profile.bio)}</p>` : ''}<ul>${sess}</ul>` +
          `<p><a href="${origin}/${x.event.slug}/speakers/${encodeURIComponent(e.profile.slug)}">Profile</a></p></li>`
      );
    }
    lines.push('</ul></div>');
    return lines.join('\n');
  }
  lines.push(`<div class="unsession-sessions"><h2>${escXml(x.event.name)} — Sessions</h2><ul>`);
  for (const s of x.scheduled.filter((s2) => s2.type !== 'service')) {
    const tr = s.track_option_id ? x.trackById.get(s.track_option_id)?.name : null;
    const speakers = (x.bundle.speakers.get(s.id) ?? [])
      .map((p) => `${p.name}${speakerAffiliation(p) ? ` (${speakerAffiliation(p)})` : ''}`)
      .join(', ');
    lines.push(
      `<li><strong>${escXml(s.title)}</strong><br>${escXml(whenLabel(x, s))}${
        roomLabel(x, s) ? ` — ${escXml(roomLabel(x, s))}` : ''
      }${tr ? ` — ${escXml(tr)}` : ''}${fmtLabel(x, s) ? ` — ${escXml(fmtLabel(x, s))}` : ''}` +
        `${speakers ? `<br>${escXml(speakers)}` : ''}${s.abstract ? `<p>${escXml(s.abstract)}</p>` : ''}</li>`
    );
  }
  lines.push('</ul></div>');
  lines.push(`<p><a href="${origin}/${x.event.slug}/agenda">Full agenda</a></p>`);
  return lines.join('\n');
}

/* ------------------------------------------------------- pages + embeds */

const WIDGETS: Record<
  string,
  { title: string; nav: string; render: (x: WidgetCtx, o: { embed: boolean }) => ReturnType<typeof sessionsContent> }
> = {
  sessions: { title: 'Sessions', nav: 'sessions', render: sessionsContent },
  speakers: { title: 'Speakers', nav: 'speakers', render: speakersContent },
  gallery: { title: 'Speaker Gallery', nav: 'gallery', render: galleryContent },
  itinerary: { title: 'Itinerary', nav: 'itinerary', render: itineraryContent },
};

function notPublishedPage(event: Event, theme: Theme, title: string, nav: string) {
  return (
    <PublicLayout title={title} event={event} theme={theme} maxWidth={PAGE_MAX} nav={publicNav(event.slug, nav)}>
      <div style="max-width:680px;margin:0 auto;padding:64px 20px 100px;text-align:center;">
        <div style={`${MICRO}margin-bottom:10px;`}>{title.toUpperCase()}</div>
        <div style="font-size:24px;font-weight:700;letter-spacing:-0.02em;margin-bottom:8px;">Not published yet</div>
        <div style="font-size:14px;color:var(--text-secondary);line-height:1.6;">
          The programme is still being put together. Check back soon.
        </div>
      </div>
    </PublicLayout>
  );
}

for (const [key, w] of Object.entries(WIDGETS)) {
  // Attendee-facing page.
  app.get(`/:event/${key}`, async (c) => {
    const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
    if (!found) return c.notFound();
    const { event, theme } = found;
    if (!event.published) return c.html(notPublishedPage(event, theme, w.title, w.nav), 200);
    return withCache(c, `${event.slug}/${publishedRev(event)}/page/${key}`, async () => {
      const x = await widgetCtx(c, event, theme, {});
      const res = await c.html(
        <PublicLayout
          title={w.title}
          event={event}
          theme={theme}
          maxWidth={PAGE_MAX}
          nav={publicNav(event.slug, w.nav)}
          scripts={['/js/public-widgets.js']}
        >
          <div style={`max-width:${PAGE_MAX}px;margin:0 auto;padding:24px 28px 72px;`}>{w.render(x, { embed: false })}</div>
        </PublicLayout>
      );
      res.headers.set('cache-control', 'public, max-age=60');
      return res;
    });
  });

  // Embeddable variant (`?basic=1` returns a style-free fragment).
  app.get(`/:event/embed/${key}`, async (c) => {
    const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
    if (!found) return c.notFound();
    const { event, theme } = found;
    const eid = c.req.query('eid');
    const { config, disabled, cacheSuffix, noStore } = await loadEmbedConfig(c.env.DB, event.id, eid, c.req.query('cfg'));
    if (disabled) return embedHeaders(await c.html(notReady(w.title.toUpperCase(), event, theme, false), 404));
    const transparent = c.req.query('transparent') === '1' || !!config.transparent;
    const basic = c.req.query('basic') === '1';
    if (!event.published) {
      return embedHeaders(await c.html(notReady(w.title.toUpperCase(), event, theme, transparent), 404));
    }
    const cacheKey = `${event.slug}/${publishedRev(event)}/embed/${key}${transparent ? '~t' : ''}${basic ? '~b' : ''}${cacheSuffix}`;
    return withEmbedCache(c, noStore, cacheKey, async () => {
      const x = await widgetCtx(c, event, theme, config);
      if (basic) {
        const res = new Response(basicHtml(x, key, c.env.APP_ORIGIN), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': embedCacheControl(noStore) },
        });
        return embedHeaders(res);
      }
      const res = await c.html(
        <EmbedShell
          title={w.title}
          event={event}
          theme={theme}
          transparent={transparent}
          accent={config.accent}
          scripts={['/js/public-widgets.js']}
        >
          {w.render(x, { embed: true })}
        </EmbedShell>
      );
      res.headers.set('cache-control', embedCacheControl(noStore));
      return embedHeaders(res);
    });
  });
}

/* ------------------------------------------------------------------ feeds */

/**
 * Draft-preview shim in front of `/{event}/agenda.json`, which is built in
 * public-agenda.tsx. It runs first only because this file is mounted before
 * that one; it lets the real handler produce the body, then applies the draft
 * track filter and drops the response out of every cache. Saved embeds (`eid`)
 * and plain reads fall straight through, so the feed body stays in one place.
 */
app.get('/:event/agenda.json', async (c, next) => {
  const draft = draftConfig(c.req.query('cfg'));
  if (!draft || c.req.query('eid')) return next();
  await next();
  const upstream = c.res;
  if (upstream.status !== 200) return;
  const body = (await upstream.json()) as { sessions?: { id: string }[] };
  const tracks = draft.tracks?.filter(Boolean) ?? [];
  if (tracks.length && body.sessions) {
    // Track ids only exist in the database, so resolve which sessions survive
    // the filter here rather than matching on the feed's track names.
    const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
    if (found) {
      const bundle = await loadAgenda(c.env.DB, found.event.id);
      const keep = new Set(trackFiltered(publicSessions(found.event, bundle), draft).map((s) => s.id));
      body.sessions = body.sessions.filter((s) => keep.has(s.id));
    }
  }
  // A handler that already ran `next()` replaces the response through `c.res`;
  // Hono merges the upstream headers into it, so `no-store` is set afterwards.
  c.res = new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  c.res.headers.set('cache-control', 'no-store');
});

/** Whole-agenda (or `?ids=`-selected) calendar feed — anonymous, no emails. */
app.get('/:event/agenda.ics', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const { event } = found;
  if (!event.published) return c.text('Agenda not published yet', 404);
  const { config, disabled, cacheSuffix, noStore } = await loadEmbedConfig(
    c.env.DB,
    event.id,
    c.req.query('eid'),
    c.req.query('cfg')
  );
  if (disabled) return c.text('This embed is disabled', 404);
  const idsParam = (c.req.query('ids') ?? '').trim();
  const ids = idsParam ? new Set(idsParam.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const build = async () => {
    const x = await widgetCtx(c, event, found.theme, config);
    const rows = x.scheduled.filter((s) => (ids ? ids.has(s.id) : true));
    const body = agendaIcs(
      event,
      rows.map((s) => ({
        session: s,
        // Names only — a public feed must never carry speaker emails.
        speakers: (x.bundle.speakers.get(s.id) ?? []).map((p) => ({ name: p.name })),
        roomName: roomLabel(x, s) || null,
        url: `${c.env.APP_ORIGIN}/${event.slug}/agenda`,
      })),
      { from: c.env.EMAIL_FROM }
    );
    return new Response(body, {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': `attachment; filename="${event.slug}${ids ? '-my-schedule' : '-agenda'}.ics"`,
        'cache-control': ids ? 'no-store' : embedCacheControl(noStore),
      },
    });
  };
  // Personal selections vary per visitor — never cache those.
  if (ids) return build();
  return withEmbedCache(c, noStore, `${event.slug}/${publishedRev(event)}/agenda.ics${cacheSuffix}`, build);
});

app.get('/:event/agenda.xml', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const { event } = found;
  if (!event.published) return c.text('Agenda not published yet', 404);
  const { config, disabled, cacheSuffix, noStore } = await loadEmbedConfig(
    c.env.DB,
    event.id,
    c.req.query('eid'),
    c.req.query('cfg')
  );
  if (disabled) return c.text('This embed is disabled', 404);
  return withEmbedCache(c, noStore, `${event.slug}/${publishedRev(event)}/agenda.xml${cacheSuffix}`, async () => {
    const x = await widgetCtx(c, event, found.theme, config);
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<agenda>',
      `  <event><name>${escXml(event.name)}</name><slug>${escXml(event.slug)}</slug>` +
        `<start_date>${escXml(event.start_date)}</start_date><end_date>${escXml(event.end_date)}</end_date>` +
        `<timezone>${escXml(event.timezone)}</timezone><venue>${escXml(event.venue ?? '')}</venue></event>`,
      '  <sessions>',
    ];
    for (const s of x.scheduled) {
      const end = s.end_min ?? s.start_min! + s.duration_min;
      const tr = s.track_option_id ? x.trackById.get(s.track_option_id)?.name : null;
      const speakers = (x.bundle.speakers.get(s.id) ?? [])
        .map(
          (p) =>
            `<speaker slug="${escXml(p.slug)}"><name>${escXml(p.name)}</name>` +
            `${speakerAffiliation(p) ? `<tagline>${escXml(speakerAffiliation(p))}</tagline>` : ''}` +
            `<url>${escXml(`${c.env.APP_ORIGIN}/${event.slug}/speakers/${p.slug}`)}</url></speaker>`
        )
        .join('');
      lines.push(
        `    <session id="${escXml(s.id)}"><title>${escXml(s.title)}</title>` +
          `<abstract>${escXml(s.abstract)}</abstract><type>${escXml(s.type)}</type>` +
          `<date>${escXml(x.days[s.day!]?.date ?? '')}</date><day>${s.day}</day>` +
          `<start>${escXml(fmtTime(s.start_min!))}</start><end>${escXml(fmtTime(end))}</end>` +
          `<room>${escXml(roomLabel(x, s))}</room><track>${escXml(tr ?? '')}</track>` +
          `<format>${escXml(fmtLabel(x, s))}</format><level>${escXml(s.level ?? '')}</level>` +
          `<speakers>${speakers}</speakers></session>`
      );
    }
    lines.push('  </sessions>', '</agenda>');
    return new Response(lines.join('\n'), {
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': embedCacheControl(noStore) },
    });
  });
});

app.get('/:event/speakers.json', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.json({ ok: false, error: 'Event not found' }, 404);
  const { event } = found;
  if (!event.published) return c.json({ ok: false, error: 'Not published yet' }, 404);
  const { config, disabled, cacheSuffix, noStore } = await loadEmbedConfig(
    c.env.DB,
    event.id,
    c.req.query('eid'),
    c.req.query('cfg')
  );
  if (disabled) return c.json({ ok: false, error: 'This embed is disabled' }, 404);
  return withEmbedCache(c, noStore, `${event.slug}/${publishedRev(event)}/speakers.json${cacheSuffix}`, async () => {
    const x = await widgetCtx(c, event, found.theme, config);
    const body = {
      event: { name: event.name, slug: event.slug, start_date: event.start_date, end_date: event.end_date },
      speakers: speakerEntries(x).map((e) => ({
        name: e.profile.name,
        slug: e.profile.slug,
        job_title: e.profile.job_title,
        company: e.profile.company,
        tagline: speakerAffiliation(e.profile) || null,
        bio: e.profile.bio,
        headshot_url: e.profile.headshot_file_id ? `${c.env.APP_ORIGIN}/files/${e.profile.headshot_file_id}` : null,
        url: `${c.env.APP_ORIGIN}/${event.slug}/speakers/${e.profile.slug}`,
        sessions: e.sessions.map((s) => ({
          id: s.id,
          title: s.title,
          date: s.day !== null ? x.days[s.day]?.date ?? null : null,
          start: s.start_min !== null ? fmtTime(s.start_min) : null,
          end: s.start_min !== null ? fmtTime(s.end_min ?? s.start_min + s.duration_min) : null,
          room: roomLabel(x, s) || null,
          track: s.track_option_id ? x.trackById.get(s.track_option_id)?.name ?? null : null,
          format: fmtLabel(x, s) || null,
        })),
      })),
    };
    return new Response(JSON.stringify(body, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': embedCacheControl(noStore) },
    });
  });
});

app.get('/:event/speakers.xml', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const { event } = found;
  if (!event.published) return c.text('Not published yet', 404);
  const { config, disabled, cacheSuffix, noStore } = await loadEmbedConfig(
    c.env.DB,
    event.id,
    c.req.query('eid'),
    c.req.query('cfg')
  );
  if (disabled) return c.text('This embed is disabled', 404);
  return withEmbedCache(c, noStore, `${event.slug}/${publishedRev(event)}/speakers.xml${cacheSuffix}`, async () => {
    const x = await widgetCtx(c, event, found.theme, config);
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<speakers event="${escXml(event.name)}" slug="${escXml(event.slug)}">`,
    ];
    for (const e of speakerEntries(x)) {
      const sessions = e.sessions
        .map(
          (s) =>
            `<session id="${escXml(s.id)}"><title>${escXml(s.title)}</title>` +
            `<when>${escXml(whenLabel(x, s))}</when><room>${escXml(roomLabel(x, s))}</room></session>`
        )
        .join('');
      lines.push(
        `  <speaker slug="${escXml(e.profile.slug)}"><name>${escXml(e.profile.name)}</name>` +
          `${speakerAffiliation(e.profile) ? `<tagline>${escXml(speakerAffiliation(e.profile))}</tagline>` : ''}` +
          `<bio>${escXml(e.profile.bio)}</bio>` +
          `<url>${escXml(`${c.env.APP_ORIGIN}/${event.slug}/speakers/${e.profile.slug}`)}</url>` +
          `<sessions>${sessions}</sessions></speaker>`
      );
    }
    lines.push('</speakers>');
    return new Response(lines.join('\n'), {
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': embedCacheControl(noStore) },
    });
  });
});

export default app;
