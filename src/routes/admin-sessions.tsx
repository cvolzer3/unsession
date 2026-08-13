/**
 * `/app/sessions` — full port of `Sessions.dc.html`.
 *
 * The table is server-rendered (so it reads without JavaScript); the chips,
 * track filter, search box, inline selects and the edit drawer are wired by
 * `public/js/sessions.js`. Sponsor and service sessions are created here — talk
 * sessions only ever arrive by accepting a submission (`sessions-core`).
 *
 * OWNER: B4.
 */
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Ctx, Event } from '../types';
import { AdminLayout, DrawerExpandButton, MONO } from '../views/layout';
import { adminProps } from '../views/chrome';
import { now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { logActivity } from '../lib/activity';
import {
  listContentVersions,
  recordContentVersion,
  restoreSummary,
  sessionSnapshotOf,
  snapshotOf,
  type SessionSnapshot,
  type VersionRow,
} from '../lib/content-versions';
import { requireOrgRole } from '../lib/auth';
import { ensureSpeakerProfiles } from '../lib/sessions-core';
import {
  bumpIcsSequence,
  conflictIds,
  displayIds,
  eventDays,
  fmtTime,
  loadAgenda,
  notifyScheduleChange,
  roomNamer,
  toCsv,
  toViewSession,
  type OptRow,
  type SessionRow,
} from '../lib/agenda';

const app = new Hono<Ctx>();

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const ROW_COLS = '70px minmax(240px,1fr) 130px 170px 92px 150px 160px';
const CELL_SELECT = 'width:100%;padding:5px 6px;border:1px solid #e2e3e8;background:#fff;font-size:12px;color:#16171d;';
const DRAWER_LABEL = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:6px;`;
/**
 * Panel width lives here, not inline, so the shared full-screen rule can
 * override it — and on a class, not `#drawer`, since an id would outrank it.
 */
const DRAWER_CSS =
  '.drawer-session{position:fixed;top:0;right:0;bottom:0;width:460px;max-width:92vw;background:#fff;z-index:50;' +
  'box-shadow:-12px 0 40px rgba(0,0,0,0.14);animation:slidein 0.18s ease;display:flex;flex-direction:column;}';
const DRAWER_SELECT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;background:#fff;font-size:13px;';
const DIALOG_WRAP = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;';
const DIALOG_CARD = 'background:#fff;width:520px;max-width:calc(100vw - 48px);box-shadow:0 16px 48px rgba(22,23,29,0.25);max-height:calc(100vh - 60px);display:flex;flex-direction:column;';
const DIALOG_HEAD = 'padding:16px 20px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;';
const DIALOG_BODY = 'padding:18px 20px;display:grid;gap:12px;overflow-y:auto;';
const DIALOG_FOOT = 'padding:14px 20px;border-top:1px solid #f2f3f5;display:flex;gap:8px;align-items:center;';
const FIELD_LABEL = 'font-size:12px;color:#686b74;margin-bottom:4px;';
const INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;outline-color:#4c5fd5;';
const CANCEL_BTN = 'padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const CREATE_BTN = 'padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;';

const DURATIONS = [10, 15, 30, 45, 60, 90, 120];
export const SERVICE_PRESETS = ['Registration & Coffee', 'Coffee Break', 'Lunch', 'Afternoon Break', 'Closing Drinks'];

function formatLabel(o: OptRow): string {
  return o.duration_min ? `${o.name} (${o.duration_min} min)` : o.name;
}

function jsonBlock(id: string, value: unknown) {
  return (
    <script type="application/json" id={id}>
      {raw(JSON.stringify(value).replace(/</g, '\\u003c'))}
    </script>
  );
}

/* ------------------------------------------------------------ new session */

/**
 * "＋ New session" dialog — sponsor or service only. Also mounted on the agenda
 * builder (its "＋ Sponsor session" button opens this with sponsor preselected).
 */
export const NewSessionDialog: FC<{ tracks: OptRow[]; formats: OptRow[] }> = ({ tracks, formats }) => (
  <div id="new-session" data-dialog hidden style={DIALOG_WRAP}>
    <div style={DIALOG_CARD}>
      <div style={DIALOG_HEAD}>
        <div style="font-size:15px;font-weight:700;">New session</div>
        <button
          type="button"
          data-dialog-close="#new-session"
          style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
        >
          ×
        </button>
      </div>
      <div style={DIALOG_BODY}>
        <div>
          <div style={FIELD_LABEL}>Type</div>
          <select id="ns-kind" style={DRAWER_SELECT}>
            <option value="sponsor">Sponsor session</option>
            <option value="service">Service block (break, lunch…)</option>
          </select>
        </div>

        {/* ------------------------------------------------------- sponsor */}
        <div id="ns-sponsor" style="display:grid;gap:12px;">
          <div>
            <div style={FIELD_LABEL}>Session title</div>
            <input id="ns-title" placeholder="Observability on Autopilot" style={INPUT} />
          </div>
          <div>
            <div style={FIELD_LABEL}>Sponsor company</div>
            <input id="ns-sponsor-name" placeholder="Datastack" style={INPUT} />
          </div>
          <div>
            <div style={FIELD_LABEL}>Abstract</div>
            <textarea
              id="ns-abstract"
              rows={3}
              placeholder="What will attendees learn? No pure product pitches."
              style="width:100%;padding:9px 11px;border:1px solid #e2e3e8;font-size:13px;line-height:1.5;resize:vertical;outline-color:#4c5fd5;"
            ></textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div>
              <div style={FIELD_LABEL}>Track</div>
              <select id="ns-track" style={DRAWER_SELECT}>
                <option value="">— None</option>
                {tracks.map((t) => (
                  <option value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <div style={FIELD_LABEL}>Format</div>
              <select id="ns-format" style={DRAWER_SELECT}>
                {formats.map((f) => (
                  <option value={f.id} data-dur={String(f.duration_min ?? 30)}>
                    {formatLabel(f)}
                  </option>
                ))}
                <option value="">— Custom duration</option>
              </select>
            </div>
          </div>
          <div style="border:1px solid #eceded;padding:12px;display:grid;gap:10px;">
            <div style={MICRO}>SPEAKER (OPTIONAL)</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <input id="ns-sp-name" placeholder="Name" style={INPUT} />
              <input id="ns-sp-email" placeholder="name@company.com" style={INPUT} />
            </div>
            <input id="ns-sp-bio" placeholder="One-line bio for the agenda page" style={INPUT} />
          </div>
          <label style="display:flex;align-items:center;gap:10px;background:#fff4e6;border:1px solid #f0c078;padding:10px 12px;cursor:pointer;">
            <input id="ns-badge" type="checkbox" checked style="width:15px;height:15px;accent-color:#4c5fd5;flex:none;" />
            <span
              id="ns-badge-preview"
              style={`font-family:${MONO};font-size:9px;letter-spacing:0.08em;background:#f0ece4;color:#8b857a;padding:2px 6px;flex:none;`}
            >
              SPONSORED
            </span>
            <span style="font-size:12px;color:#686b74;">
              Carry this badge on the public agenda and embeds. Sponsor sessions are tinted on the builder grid either way.
            </span>
          </label>
        </div>

        {/* ------------------------------------------------------- service */}
        <div id="ns-service" hidden style="display:grid;gap:12px;">
          <div>
            <div style={FIELD_LABEL}>Title</div>
            <select id="ns-preset" style={`${DRAWER_SELECT}margin-bottom:8px;`}>
              {SERVICE_PRESETS.map((p) => (
                <option value={p}>{p}</option>
              ))}
              <option value="">Custom…</option>
            </select>
            <input id="ns-svc-title" value={SERVICE_PRESETS[0]} style={INPUT} />
          </div>
          <div>
            <div style={FIELD_LABEL}>Duration</div>
            <select id="ns-svc-dur" style={DRAWER_SELECT}>
              {DURATIONS.map((d) => (
                <option value={String(d)} selected={d === 60}>
                  {d} min
                </option>
              ))}
            </select>
          </div>
          <label style="display:flex;align-items:center;gap:9px;font-size:13px;cursor:pointer;">
            <input id="ns-svc-all" type="checkbox" checked style="width:15px;height:15px;accent-color:#4c5fd5;" />
            Spans all rooms
          </label>
        </div>
      </div>
      <div style={DIALOG_FOOT}>
        <div style="font-size:11.5px;color:#9a9da6;line-height:1.4;flex:1;">
          Talk sessions can’t be created here. Accept a Submission to create a session from a talk.
        </div>
        <button type="button" data-dialog-close="#new-session" style={CANCEL_BTN}>
          Cancel
        </button>
        <button type="button" id="ns-create" style={CREATE_BTN}>
          Create session
        </button>
      </div>
    </div>
  </div>
);

/* ------------------------------------------------------------------ page */

app.get('/app/sessions', async (c) => {
  const props = await adminProps(c, 'Sessions');
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');

  const bundle = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(bundle.sessions);
  const days = eventDays(event);
  const trackById = new Map(bundle.tracks.map((t) => [t.id, t]));

  const statusOf = (s: SessionRow) => (s.day !== null && s.start_min !== null ? 'scheduled' : s.room_id || s.all_rooms ? 'ready' : 'needs');
  const counts = { all: bundle.sessions.length, needs: 0, ready: 0, scheduled: 0 } as Record<string, number>;
  bundle.sessions.forEach((s) => {
    counts[statusOf(s)] = (counts[statusOf(s)] ?? 0) + 1;
  });

  const chips: [string, string][] = [
    ['all', 'All'],
    ['needs', 'Needs room'],
    ['ready', 'Ready'],
    ['scheduled', 'Scheduled'],
  ];

  const payload = {
    sessions: bundle.sessions.map((s) => toViewSession(s, bundle, ids)),
    rooms: bundle.rooms,
    tracks: bundle.tracks.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    formats: bundle.formats.map((f) => ({ id: f.id, name: f.name, dur: f.duration_min ?? 30, label: formatLabel(f) })),
    levels: bundle.levels.map((l) => l.name),
    days,
    durations: DURATIONS,
  };

  return c.html(
    <AdminLayout {...props} scripts={['/js/sessions.js']}>
      {jsonBlock('data-sessions', payload)}
      <style>{raw(DRAWER_CSS)}</style>
      <div style="padding:22px 28px;">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px;">
          <h1 style="margin:0;font-size:21px;letter-spacing:-0.02em;">Sessions</h1>
          <div style={`font-family:${MONO};font-size:12px;color:#686b74;`} id="session-count">
            {bundle.sessions.length ? `${counts.all} sessions · ${counts.needs} need a room` : ''}
          </div>
          <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <a
              href="/app/embeds"
              title="Embed the sessions list on your website"
              style="display:inline-block;padding:7px 12px;background:#fff;border:1px solid #e2e3e8;color:#16171d;font-size:13px;text-decoration:none;"
            >
              Embed
            </a>
            <a
              href="/app/api/sessions/export.csv"
              style="display:inline-block;padding:7px 12px;background:#fff;border:1px solid #e2e3e8;color:#16171d;font-size:13px;text-decoration:none;"
            >
              Export CSV
            </a>
            <button type="button" data-dialog-open="#new-session" style={CREATE_BTN}>
              ＋ New session
            </button>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">
          {chips.map(([id, label]) => (
            <button
              type="button"
              data-chip={id}
              style={`padding:6px 12px;font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border:1px solid ${
                id === 'all' ? '#4c5fd5' : '#e2e3e8'
              };background:${id === 'all' ? '#eef0fb' : '#fff'};color:${id === 'all' ? '#4c5fd5' : '#16171d'};font-weight:${
                id === 'all' ? '600' : '400'
              };`}
            >
              {label}
              <span style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;`} data-chip-count={id}>
                {String(counts[id] ?? 0)}
              </span>
            </button>
          ))}
          <div style="flex:1;"></div>
          <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#686b74;cursor:pointer;">
            <input id="show-abstract" type="checkbox" style="width:14px;height:14px;accent-color:#4c5fd5;" />
            Abstracts
          </label>
          <select id="track-filter" style="padding:7px 10px;border:1px solid #e2e3e8;background:#fff;font-size:13px;color:#16171d;">
            <option value="all">All tracks</option>
            {bundle.tracks.map((t) => (
              <option value={t.id}>{t.name}</option>
            ))}
          </select>
          <input
            id="session-search"
            placeholder="Search title or speaker…"
            style="padding:7px 12px;border:1px solid #e2e3e8;background:#fff;font-size:13px;width:220px;outline-color:#4c5fd5;"
          />
        </div>
        <div style="background:#fff;border:1px solid #e2e3e8;overflow-x:auto;">
          <div
            style={`display:grid;grid-template-columns:${ROW_COLS};gap:0;padding:9px 12px;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;color:#9a9da6;align-items:center;min-width:1020px;`}
          >
            <div>ID</div>
            <div>SESSION</div>
            <div>TRACK</div>
            <div>TYPE</div>
            <div>SLOT</div>
            <div>ROOM</div>
            <div>STATUS</div>
          </div>
          {bundle.sessions.map((s) => {
            const st = statusOf(s);
            const tr = s.track_option_id ? trackById.get(s.track_option_id) : null;
            const speakers = (bundle.speakers.get(s.id) ?? []).map((p) => p.name);
            const badge =
              st === 'scheduled'
                ? {
                    t: `Day ${(s.day ?? 0) + 1} · ${fmtTime(s.start_min ?? 0)} · scheduled`,
                    fg: '#1c7ed6',
                    bg: '#e7f1fb',
                  }
                : st === 'ready'
                  ? { t: 'Ready for agenda', fg: '#2b8a3e', bg: '#e6f4ea' }
                  : { t: 'Needs room', fg: '#b08800', bg: '#fdf5dc' };
            const durOpts = DURATIONS.includes(s.duration_min) ? DURATIONS : [...DURATIONS, s.duration_min].sort((a, b) => a - b);
            return (
              <div
                data-row
                data-id={s.id}
                data-state={st}
                data-track={s.track_option_id ?? ''}
                data-search={`${s.title} ${speakers.join(' ')} ${s.sponsor_name ?? ''}`.toLowerCase()}
                style={`display:grid;grid-template-columns:${ROW_COLS};gap:0;padding:11px 12px;border-bottom:1px solid #f0f0f3;align-items:center;cursor:pointer;min-width:1020px;`}
              >
                <div style={`font-family:${MONO};font-size:11.5px;color:#9a9da6;`}>{ids.get(s.id)}</div>
                <div style="min-width:0;padding-right:14px;">
                  <div style="font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    {s.type === 'sponsor' ? `SP · ${s.title}` : s.title}
                  </div>
                  <div style="font-size:12px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    {speakers.join(', ') || (s.type === 'service' ? 'Service block · all rooms' : s.sponsor_name || '—')}
                  </div>
                  <div
                    data-abstract
                    hidden
                    style="font-size:12px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;"
                  >
                    {s.abstract}
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;">
                  <span
                    style={`width:8px;height:8px;border-radius:50%;background:${tr?.color ?? '#adb5bd'};flex:none;`}
                  ></span>
                  {tr?.name ?? '—'}
                </div>
                <div style="padding-right:10px;">
                  <select data-field="format" data-id={s.id} style={CELL_SELECT}>
                    <option value="" selected={!s.format_option_id}>
                      — Format
                    </option>
                    {bundle.formats.map((f) => (
                      <option value={f.id} selected={f.id === s.format_option_id} data-dur={String(f.duration_min ?? 30)}>
                        {formatLabel(f)}
                      </option>
                    ))}
                  </select>
                </div>
                <div style="padding-right:10px;">
                  <select data-field="duration" data-id={s.id} style={CELL_SELECT}>
                    {durOpts.map((d) => (
                      <option value={String(d)} selected={d === s.duration_min}>
                        {d} min
                      </option>
                    ))}
                  </select>
                </div>
                <div style="padding-right:10px;">
                  <select
                    data-field="room"
                    data-id={s.id}
                    style={`width:100%;padding:5px 6px;font-size:12px;background:#fff;color:#16171d;border:1px solid ${
                      s.room_id || s.all_rooms ? '#e2e3e8' : '#e8c76a'
                    };`}
                  >
                    <option value="" selected={!s.room_id && !s.all_rooms}>
                      — Assign
                    </option>
                    {s.type === 'service' ? (
                      <option value="ALL" selected={!!s.all_rooms}>
                        All rooms
                      </option>
                    ) : null}
                    {bundle.rooms.map((r) => (
                      <option value={r.id} selected={r.id === s.room_id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span
                    data-badge
                    style={`font-family:${MONO};font-size:11px;padding:3px 8px;color:${badge.fg};background:${badge.bg};white-space:nowrap;`}
                  >
                    {badge.t}
                  </span>
                </div>
              </div>
            );
          })}
          <div id="no-rows" hidden style="padding:36px;text-align:center;font-size:13.5px;color:#686b74;">
            No sessions match this filter.
          </div>
          {bundle.sessions.length === 0 ? (
            <div style="padding:36px;text-align:center;font-size:13.5px;color:#686b74;">
              No sessions yet — accept a submission or create a sponsor/service session.
            </div>
          ) : null}
        </div>
      </div>

      {/* ------------------------------------------------------------ drawer */}
      <div id="drawer-scrim" hidden style="position:fixed;inset:0;background:rgba(22,23,29,0.28);z-index:40;"></div>
      <div id="drawer" class="us-drawer-panel drawer-session" data-drawer hidden>
        <div style="padding:16px var(--band-x);border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;">
          <div id="d-num" style={`font-family:${MONO};font-size:12px;color:#9a9da6;`}></div>
          <div style="margin-left:auto;display:flex;align-items:center;gap:4px;">
            <DrawerExpandButton />
            <button type="button" data-drawer-close class="us-icon-btn" aria-label="Close" style="font-size:18px;line-height:1;">
              ×
            </button>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:20px var(--band-x);display:flex;flex-direction:column;gap:16px;">
          <div id="d-sched" hidden style="background:#e7f1fb;border:1px solid #bcd8f0;padding:11px 12px 12px;display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;align-items:baseline;gap:12px;">
              <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#1c7ed6;`}>ON AGENDA</div>
              <a href="/app/agenda" style="margin-left:auto;font-size:12px;white-space:nowrap;">
                View Agenda ↗
              </a>
            </div>
            <div style="display:flex;flex-direction:column;gap:3px;">
              <div id="d-sched-date" style="font-size:13px;font-weight:600;"></div>
              <div id="d-sched-time" style="font-size:12.5px;color:#5c5f68;"></div>
            </div>
          </div>
          <div>
            <div style={DRAWER_LABEL}>TITLE</div>
            <input id="d-title" style="width:100%;padding:9px 11px;border:1px solid #e2e3e8;font-size:14px;font-weight:600;outline-color:#4c5fd5;" />
          </div>
          <div>
            <div style={DRAWER_LABEL}>ABSTRACT</div>
            <textarea
              id="d-abstract"
              rows={4}
              style="width:100%;padding:9px 11px;border:1px solid #e2e3e8;font-size:13px;line-height:1.5;resize:vertical;outline-color:#4c5fd5;"
            ></textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div>
              <div style={DRAWER_LABEL}>TRACK</div>
              <select id="d-track" style={DRAWER_SELECT}>
                <option value="">— None</option>
                {bundle.tracks.map((t) => (
                  <option value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <div style={DRAWER_LABEL}>LEVEL</div>
              <select id="d-level" style={DRAWER_SELECT}>
                <option value="">— None</option>
                {bundle.levels.map((l) => (
                  <option value={l.name}>{l.name}</option>
                ))}
              </select>
            </div>
            <div>
              <div style={DRAWER_LABEL}>TYPE</div>
              <select id="d-format" style={DRAWER_SELECT}>
                <option value="">— Format</option>
                {bundle.formats.map((f) => (
                  <option value={f.id} data-dur={String(f.duration_min ?? 30)}>
                    {formatLabel(f)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={DRAWER_LABEL}>SLOT DURATION</div>
              <select id="d-duration" style={DRAWER_SELECT}>
                {DURATIONS.map((d) => (
                  <option value={String(d)}>{d} min</option>
                ))}
              </select>
            </div>
            <div style="grid-column:1/-1;">
              <div style={DRAWER_LABEL}>ROOM</div>
              <select id="d-room" style={DRAWER_SELECT}>
                <option value="">— Unassigned</option>
                <option value="ALL">All rooms</option>
                {bundle.rooms.map((r) => (
                  <option value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div id="d-badge-row" hidden>
            <div style={`${DRAWER_LABEL}margin-bottom:8px;`}>SPONSORED BADGE</div>
            <label style="display:flex;align-items:center;gap:10px;border:1px solid #eceded;padding:10px 12px;cursor:pointer;">
              <input id="d-badge" type="checkbox" style="width:15px;height:15px;accent-color:#4c5fd5;flex:none;" />
              <span style={`font-family:${MONO};font-size:9px;letter-spacing:0.08em;background:#f0ece4;color:#8b857a;padding:2px 6px;flex:none;`}>
                SPONSORED
              </span>
              <span style="font-size:12px;color:#686b74;">Shown on the public agenda and embeds.</span>
            </label>
          </div>
          <div>
            <div style={`${DRAWER_LABEL}margin-bottom:8px;`}>SPEAKERS</div>
            <div id="d-speakers" style="display:flex;flex-direction:column;gap:10px;"></div>
          </div>
          <div>
            <div style={`${DRAWER_LABEL}margin-bottom:8px;`}>VERSION HISTORY</div>
            <div id="d-history" style="display:flex;flex-direction:column;"></div>
          </div>
        </div>
        <div style="padding:14px var(--band-x);border-top:1px solid #e2e3e8;display:flex;align-items:center;gap:8px;">
          <button
            type="button"
            id="d-save"
            style="padding:9px 18px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
          >
            Save changes
          </button>
          <button type="button" data-drawer-close style="padding:9px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;">
            Cancel
          </button>
        </div>
      </div>

      <NewSessionDialog tracks={bundle.tracks} formats={bundle.formats} />
    </AdminLayout>
  );
});

/* ------------------------------------------------------------------- api */

type PatchBody = {
  id: string;
  patch: Partial<{
    title: string;
    abstract: string;
    trackId: string | null;
    level: string | null;
    formatId: string | null;
    duration: number;
    roomId: string | null;
    allRooms: boolean;
    published: boolean;
    sponsorBadge: boolean;
  }>;
};

/** Apply an edit to one session; returns a toast line and whether the slot moved. */
async function patchSession(
  c: { env: Ctx['Bindings']; var: { user: { name: string | null; email: string } | null } },
  event: Event,
  body: PatchBody
): Promise<{ ok: false; error: string } | { ok: true; session: SessionRow; before: SessionRow; scheduleChanged: boolean }> {
  const cur = await one<SessionRow>(c.env.DB, `SELECT * FROM sessions WHERE id = ? AND event_id = ?`, body.id, event.id);
  if (!cur) return { ok: false, error: 'Session not found.' };
  const p = body.patch ?? {};
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    params.push(value);
  };

  if (typeof p.title === 'string') push('title', p.title.trim() || cur.title);
  if (typeof p.abstract === 'string') push('abstract', p.abstract);
  if (p.trackId !== undefined) push('track_option_id', p.trackId || null);
  if (p.level !== undefined) push('level', p.level || null);
  if (p.formatId !== undefined) push('format_option_id', p.formatId || null);
  if (p.published !== undefined) push('published', p.published ? 1 : 0);
  if (p.sponsorBadge !== undefined) push('sponsor_badge', p.sponsorBadge ? 1 : 0);

  let duration = cur.duration_min;
  if (p.duration !== undefined && Number.isFinite(p.duration)) {
    duration = Math.max(5, Math.min(600, Math.round(Number(p.duration))));
    push('duration_min', duration);
  }

  let roomId = cur.room_id;
  let allRooms = !!cur.all_rooms;
  if (p.roomId !== undefined || p.allRooms !== undefined) {
    if (p.allRooms === true || p.roomId === 'ALL') {
      allRooms = true;
      roomId = null;
    } else {
      allRooms = false;
      roomId = p.roomId || null;
      if (roomId) {
        const room = await one<{ id: string }>(c.env.DB, `SELECT id FROM rooms WHERE id = ? AND event_id = ?`, roomId, event.id);
        if (!room) return { ok: false, error: 'That room does not belong to this event.' };
      }
    }
    push('room_id', roomId);
    push('all_rooms', allRooms ? 1 : 0);
  }

  // A duration change on a scheduled session moves its end; nothing else shifts.
  let endMin = cur.end_min;
  if (cur.start_min !== null && duration !== cur.duration_min) {
    endMin = cur.start_min + duration;
    push('end_min', endMin);
  }

  const scheduleChanged =
    cur.day !== null &&
    cur.start_min !== null &&
    ((roomId ?? null) !== (cur.room_id ?? null) || allRooms !== !!cur.all_rooms || endMin !== cur.end_min);

  if (!sets.length) return { ok: true, session: cur, before: cur, scheduleChanged: false };
  push('updated_at', now());
  params.push(body.id);
  await run(c.env.DB, `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...params);
  const session = (await one<SessionRow>(c.env.DB, `SELECT * FROM sessions WHERE id = ?`, body.id))!;
  return { ok: true, session, before: cur, scheduleChanged };
}

app.post('/app/api/sessions/update', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<PatchBody>();
  if (!body?.id) return c.json({ ok: false, error: 'Missing session id.' }, 400);
  const res = await patchSession(c, event, body);
  if (!res.ok) return c.json(res, 400);

  const actor = c.var.user?.name || c.var.user?.email || 'System';
  await recordContentVersion(c.env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: res.session.id,
    editor: actor,
    before: sessionSnapshotOf(res.before),
    after: sessionSnapshotOf(res.session),
    subjectCreatedAt: res.before.created_at,
  });
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: res.session.id,
    actor,
    action: 'Session edited',
    detail: res.session.title,
  });
  if (res.scheduleChanged) {
    await bumpIcsSequence(c.env.DB, res.session.id);
    c.executionCtx.waitUntil(notifyScheduleChange(c.env, event, res.session.id, actor));
  }

  const bundle = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(bundle.sessions);
  const fresh = bundle.sessions.find((s) => s.id === res.session.id)!;
  return c.json({ ok: true, session: toViewSession(fresh, bundle, ids), scheduleChanged: res.scheduleChanged });
});

/* -------------------------------------------------- version history + restore */

/** Rows for the drawer's VERSION HISTORY panel; `current` = matches the live content. */
function versionPayload(versions: VersionRow[], live: SessionSnapshot) {
  return versions.map((v) => {
    const snap = snapshotOf<SessionSnapshot>(v, { title: '', abstract: '' });
    return {
      id: v.id,
      editor: v.editor,
      summary: v.summary,
      at: v.created_at,
      title: snap.title,
      current: snap.title === live.title && snap.abstract === live.abstract,
    };
  });
}

app.get('/app/api/sessions/history', async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const id = c.req.query('id') ?? '';
  const session = await one<SessionRow>(c.env.DB, `SELECT * FROM sessions WHERE id = ? AND event_id = ?`, id, event.id);
  if (!session) return c.json({ ok: false, error: 'Session not found.' }, 404);
  const versions = await listContentVersions(c.env.DB, 'session', session.id);
  return c.json({ ok: true, versions: versionPayload(versions, sessionSnapshotOf(session)) });
});

app.post('/app/api/sessions/restore', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<{ id?: string; versionId?: string }>();
  if (!body?.id || !body?.versionId) return c.json({ ok: false, error: 'Missing session or version id.' }, 400);
  const cur = await one<SessionRow>(c.env.DB, `SELECT * FROM sessions WHERE id = ? AND event_id = ?`, body.id, event.id);
  if (!cur) return c.json({ ok: false, error: 'Session not found.' }, 404);
  const version = await one<VersionRow>(
    c.env.DB,
    `SELECT id, event_id, editor, summary, snapshot_json, created_at FROM content_versions
      WHERE id = ? AND subject_type = 'session' AND subject_id = ?`,
    body.versionId,
    body.id
  );
  if (!version) return c.json({ ok: false, error: 'Version not found.' }, 404);

  const snap = snapshotOf<SessionSnapshot>(version, sessionSnapshotOf(cur));
  const title = (snap.title ?? '').trim() || cur.title;
  const abstract = String(snap.abstract ?? '');
  await run(c.env.DB, `UPDATE sessions SET title = ?, abstract = ?, updated_at = ? WHERE id = ?`, title, abstract, now(), cur.id);

  const actor = c.var.user?.name || c.var.user?.email || 'System';
  await recordContentVersion(c.env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: cur.id,
    editor: actor,
    before: sessionSnapshotOf(cur),
    after: { title, abstract },
    subjectCreatedAt: cur.created_at,
    summary: restoreSummary(version),
  });
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: cur.id,
    actor,
    action: 'Version restored',
    detail: title,
  });

  const bundle = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(bundle.sessions);
  const fresh = bundle.sessions.find((s) => s.id === cur.id)!;
  const versions = await listContentVersions(c.env.DB, 'session', cur.id);
  return c.json({
    ok: true,
    session: toViewSession(fresh, bundle, ids),
    versions: versionPayload(versions, sessionSnapshotOf(fresh)),
  });
});

type CreateBody = {
  kind: 'sponsor' | 'service';
  title?: string;
  sponsorName?: string;
  /** Sponsor sessions: show the SPONSORED badge publicly (default on). */
  sponsorBadge?: boolean;
  abstract?: string;
  trackId?: string | null;
  formatId?: string | null;
  duration?: number;
  allRooms?: boolean;
  day?: number | null;
  startMin?: number | null;
  speaker?: { name?: string; email?: string; bio?: string } | null;
};

app.post('/app/api/sessions/create', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<CreateBody>();
  const kind = body?.kind === 'service' ? 'service' : 'sponsor';
  const title = (body.title || '').trim() || (kind === 'service' ? 'New break' : '');
  if (!title) return c.json({ ok: false, error: 'Give the session a title.' }, 400);

  let duration = Number(body.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = kind === 'service' ? 60 : 30;
  duration = Math.max(5, Math.min(600, Math.round(duration)));

  const formatId = kind === 'sponsor' ? body.formatId || null : null;
  const trackId = kind === 'sponsor' ? body.trackId || null : null;
  const allRooms = kind === 'service' ? body.allRooms !== false : false;
  const day = body.day ?? null;
  const start = day !== null && body.startMin !== null && body.startMin !== undefined ? Number(body.startMin) : null;
  const end = start === null ? null : start + duration;

  const id = newId('ses');
  const stamp = now();
  await run(
    c.env.DB,
    `INSERT INTO sessions (id, event_id, submission_id, type, title, abstract, track_option_id, format_option_id,
       level, duration_min, room_id, all_rooms, day, start_min, end_min, status, published, sponsor_name,
       sponsor_badge, stream_url, visibility_json, ics_sequence, created_at, updated_at)
     VALUES (?,?,NULL,?,?,?,?,?,NULL,?,NULL,?,?,?,?, 'confirmed', 1, ?, ?, NULL, NULL, 0, ?, ?)`,
    id,
    event.id,
    kind,
    title,
    (body.abstract || '').trim(),
    trackId,
    formatId,
    duration,
    allRooms ? 1 : 0,
    day,
    start,
    end,
    kind === 'sponsor' ? (body.sponsorName || '').trim() || null : null,
    kind === 'sponsor' && body.sponsorBadge === false ? 0 : 1,
    stamp,
    stamp
  );

  if (kind === 'sponsor' && body.speaker?.email && body.speaker?.name) {
    const profiles = await ensureSpeakerProfiles(c.env, event.id, [
      {
        id: '',
        name: body.speaker.name.trim(),
        email: body.speaker.email.trim(),
        bio: (body.speaker.bio || '').trim(),
        tagline: '',
        links_json: null,
        headshot_file_id: null,
        user_id: null,
        position: 0,
      },
    ]);
    for (let i = 0; i < profiles.length; i++) {
      await run(c.env.DB, `INSERT OR IGNORE INTO session_speakers (session_id, speaker_profile_id, position) VALUES (?,?,?)`, id, profiles[i], i);
    }
  }

  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'session',
    subjectId: id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: kind === 'sponsor' ? 'Sponsor session created' : 'Service block created',
    detail: title,
  });

  const bundle = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(bundle.sessions);
  const fresh = bundle.sessions.find((s) => s.id === id)!;
  return c.json({ ok: true, session: toViewSession(fresh, bundle, ids) });
});

app.get('/app/api/sessions/export.csv', async (c) => {
  const event = c.var.event;
  if (!event) return c.text('No active event', 400);
  const bundle = await loadAgenda(c.env.DB, event.id);
  const ids = displayIds(bundle.sessions);
  const roomName = roomNamer(bundle);
  const trackById = new Map(bundle.tracks.map((t) => [t.id, t.name]));
  const formatById = new Map(bundle.formats.map((f) => [f.id, f.name]));
  const days = eventDays(event);
  const conflicted = conflictIds(bundle, event.day_end_min);

  const rows = bundle.sessions.map((s) => [
    ids.get(s.id) ?? s.id,
    s.title,
    s.type,
    s.track_option_id ? trackById.get(s.track_option_id) ?? '' : '',
    s.format_option_id ? formatById.get(s.format_option_id) ?? '' : '',
    s.level ?? '',
    s.duration_min,
    s.all_rooms ? 'All rooms' : s.room_id ? roomName(s.room_id) : '',
    s.day === null ? '' : days[s.day]?.date ?? `Day ${s.day + 1}`,
    s.start_min === null ? '' : fmtTime(s.start_min),
    s.end_min === null ? '' : fmtTime(s.end_min),
    s.status,
    s.published ? 'yes' : 'no',
    (bundle.speakers.get(s.id) ?? []).map((p) => p.name).join('; '),
    conflicted.has(s.id) ? 'yes' : '',
  ]);

  const csv = toCsv(
    ['ID', 'Title', 'Type', 'Track', 'Format', 'Level', 'Duration (min)', 'Room', 'Date', 'Start', 'End', 'Status', 'Published', 'Speakers', 'Conflict'],
    rows
  );
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${event.slug}-sessions.csv"`,
    },
  });
});

export default app;
