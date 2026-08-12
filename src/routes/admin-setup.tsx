/**
 * `/app/setup` — full port of `Event Setup.dc.html`.
 * Dialogs are server-rendered overlays toggled by `public/js/ui.js`; the
 * derived swatches and live preview repaint client-side via `public/js/setup.js`.
 */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, MONO } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { FONT_PAIRINGS, initialsOf, normalizeHex, paletteFor, parseTheme, tint } from '../lib/theme';
import { EVENT_MODES, GITHUB_URL, TIMEZONES } from '../lib/defaults';
import { slugTaken } from '../lib/events';
import { slugify } from '../lib/slugify';
import { logActivity } from '../lib/activity';
import { requireOrgRole } from '../lib/auth';

const app = new Hono<Ctx>();

const FIELD_LABEL = 'font-size:12px;color:#686b74;margin-bottom:4px;';
const INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;outline-color:#4c5fd5;';
const SELECT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;background:#fff;';
const CARD = 'background:#fff;border:1px solid #e2e3e8;padding:18px 20px;';
const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const DASHED_BTN = 'padding:7px 12px;background:#fff;border:1px dashed #c9cbd3;font-size:12.5px;color:#686b74;cursor:pointer;';
const DIALOG_WRAP =
  'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;';
const DIALOG_CARD = 'background:#fff;width:400px;max-width:calc(100vw - 48px);box-shadow:0 16px 48px rgba(22,23,29,0.25);';
const DIALOG_HEAD = 'padding:16px 20px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;';
const DIALOG_BODY = 'padding:18px 20px;display:grid;gap:12px;';
const DIALOG_FOOT = 'padding:14px 20px;border-top:1px solid #f2f3f5;display:flex;gap:8px;justify-content:flex-end;';
const CANCEL_BTN = 'padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const CREATE_BTN = 'padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;';

type TaxRow = { id: string; name: string; has_color: number; has_duration: number; position: number };
type OptRow = { id: string; taxonomy_id: string; name: string; color: string | null; duration_min: number | null };

app.get('/app/setup', async (c) => {
  const event = c.var.event;
  const props = await adminProps(c, 'Event setup', { headerTitle: 'Event setup' });
  if (!event) return c.redirect('/app/events/new');

  const db = c.env.DB;
  const rooms = await all<{ id: string; name: string; capacity: number | null; priority: number }>(
    db,
    `SELECT * FROM rooms WHERE event_id = ? ORDER BY priority, name`,
    event.id
  );
  const taxonomies = await all<TaxRow>(
    db,
    `SELECT * FROM taxonomies WHERE event_id = ? ORDER BY position, name`,
    event.id
  );
  const options = await all<OptRow>(
    db,
    `SELECT o.* FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
      WHERE t.event_id = ? ORDER BY o.position, o.name`,
    event.id
  );
  const theme = parseTheme(event.theme_json);
  const d = paletteFor(theme);
  const hasOverride = Boolean(theme.hover || theme.border || theme.tint);
  const host = c.env.APP_ORIGIN.replace(/^https?:\/\//, '') + '/';

  const saveButton = (
    <button
      type="submit"
      form="setup-form"
      style="padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
    >
      Save changes
    </button>
  );

  return c.html(
    <AdminLayout {...props} headerActions={saveButton} scripts={['/js/setup.js']}>
      <form id="setup-form" method="post" action="/app/setup">
        <div style="padding:24px 28px;display:grid;grid-template-columns:minmax(0,560px) minmax(320px,420px);gap:24px;align-items:start;">
          <div style="display:grid;gap:18px;">
            {/* ---------------------------------------------------------- basics */}
            <div style={CARD}>
              <div style={`${MICRO}margin-bottom:12px;`}>BASICS</div>
              <div style="display:grid;gap:12px;">
                <div>
                  <div style={FIELD_LABEL}>Event name</div>
                  <input id="event-name" name="name" value={event.name} style={INPUT} />
                </div>
                <div>
                  <div style={`${FIELD_LABEL}display:flex;align-items:center;gap:6px;`}>
                    <span>Slug</span>
                    {/* position:relative on the wrapper, not the field row — the popover anchors to the icon */}
                    <span style="position:relative;display:inline-flex;">
                      <button
                        type="button"
                        data-toggle="#slug-info"
                        aria-label="About the slug"
                        style={`width:15px;height:15px;padding:0;background:#eef0fb;border:none;border-radius:50%;color:#4c5fd5;font-family:${MONO};font-size:9px;font-weight:700;line-height:1;display:grid;place-items:center;cursor:pointer;`}
                      >
                        i
                      </button>
                      <div
                        id="slug-info"
                        hidden
                        style="position:absolute;top:calc(100% + 6px);left:-8px;width:270px;background:#fff;border:1px solid #e2e3e8;box-shadow:0 8px 24px rgba(22,23,29,0.12);padding:12px 14px;z-index:60;font-size:12px;line-height:1.55;color:#686b74;font-weight:400;"
                      >
                        Unsession is open source. Self-host it and your event links live on your own domain instead of
                        this one.
                        <a
                          href={GITHUB_URL}
                          target="_blank"
                          rel="noreferrer"
                          style="display:block;margin-top:8px;color:#4c5fd5;font-size:12px;"
                        >
                          View on GitHub ↗
                        </a>
                      </div>
                    </span>
                  </div>
                  <div style="display:flex;border:1px solid #e2e3e8;">
                    <span style={`padding:8px 0 8px 10px;font-family:${MONO};font-size:12px;color:#9a9da6;`}>{host}</span>
                    <input
                      id="event-slug"
                      name="slug"
                      data-autoslug="0"
                      value={event.slug}
                      style={`flex:1;min-width:0;padding:8px 10px 8px 2px;border:none;font-family:${MONO};font-size:12px;outline:none;`}
                    />
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                  <div>
                    <div style={FIELD_LABEL}>Starts</div>
                    <input
                      type="date"
                      name="start_date"
                      value={event.start_date.slice(0, 10)}
                      style="width:100%;padding:7px 10px;border:1px solid #e2e3e8;font-size:13.5px;background:#fff;color:#16171d;"
                    />
                  </div>
                  <div>
                    <div style={FIELD_LABEL}>Ends</div>
                    <input
                      type="date"
                      name="end_date"
                      value={event.end_date.slice(0, 10)}
                      style="width:100%;padding:7px 10px;border:1px solid #e2e3e8;font-size:13.5px;background:#fff;color:#16171d;"
                    />
                  </div>
                </div>
                <div>
                  <div style={FIELD_LABEL}>Timezone *</div>
                  <select name="timezone" style={SELECT}>
                    {TIMEZONES.map((tz) => (
                      <option value={tz} selected={tz === event.timezone}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div style={FIELD_LABEL}>Location</div>
                  <input name="venue" value={event.venue ?? ''} style={INPUT} />
                </div>
                <div>
                  <div style={FIELD_LABEL}>Mode</div>
                  <select name="mode" style={SELECT}>
                    {EVENT_MODES.map((m) => (
                      <option value={m.value} selected={m.value === event.mode}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* ----------------------------------------------------------- rooms */}
            <div style={CARD}>
              <div style={`${MICRO}margin-bottom:12px;`}>ROOMS</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                {rooms.map((r) => (
                  <span style="display:inline-flex;align-items:center;background:#f4f5f9;border:1px solid #e2e3e8;font-size:13px;">
                    <button
                      type="button"
                      data-dialog-open={`#room-edit-${r.id}`}
                      title="Edit room"
                      style="display:inline-flex;align-items:center;gap:8px;background:none;border:none;padding:7px 4px 7px 12px;font-size:13px;color:#16171d;font-family:inherit;cursor:pointer;"
                    >
                      {r.name}
                      <span style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
                        {r.capacity ? `· ${r.capacity}` : ''}
                      </span>
                    </button>
                    <button
                      type="submit"
                      form={`rm-${r.id}`}
                      title="Remove room"
                      style="background:none;border:none;color:#9a9da6;cursor:pointer;font-size:13px;padding:7px 8px 7px 4px;"
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <button type="button" data-dialog-open="#room-dialog" style={DASHED_BTN}>
                  + Add room
                </button>
              </div>
            </div>

            {/* ------------------------------------------------------ taxonomies */}
            <div style={CARD}>
              <div style={`${MICRO}margin-bottom:4px;`}>CATEGORY TAXONOMIES</div>
              {taxonomies.map((tx) => (
                <div style="border-top:1px solid #f2f3f5;padding:10px 0;">
                  <div style="font-size:13px;font-weight:700;margin-bottom:6px;">{tx.name}</div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    {options
                      .filter((o) => o.taxonomy_id === tx.id)
                      .map((o) => (
                        <button
                          type="button"
                          data-dialog-open={`#opt-edit-${o.id}`}
                          title="Edit option"
                          style={`display:inline-flex;align-items:center;gap:6px;border:1px solid #e2e3e8;padding:4px 10px;font-size:12px;color:#16171d;font-family:inherit;cursor:pointer;background:${
                            o.color ? tint(o.color, 0.9) : '#f4f5f9'
                          };`}
                        >
                          <span
                            style={
                              o.color
                                ? `display:inline-block;width:8px;height:8px;background:${o.color};`
                                : 'display:none;'
                            }
                          ></span>
                          {o.duration_min ? `${o.name} (${o.duration_min} min)` : o.name}
                        </button>
                      ))}
                    <button
                      type="button"
                      data-dialog-open={`#opt-dialog-${tx.id}`}
                      style="padding:4px 9px;background:#fff;border:1px dashed #c9cbd3;font-size:11.5px;color:#686b74;cursor:pointer;"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
              <button type="button" data-dialog-open="#tax-dialog" style={`margin-top:6px;${DASHED_BTN}`}>
                + Custom taxonomy (e.g. Audience, Region)
              </button>
            </div>
          </div>

          {/* ------------------------------------------------------------ theme */}
          <div style="display:grid;gap:18px;position:sticky;top:20px;">
            <div style={CARD}>
              <div style={`${MICRO}margin-bottom:14px;`}>THEME</div>
              <div style="display:grid;gap:12px;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <div style="font-size:13px;width:110px;">Primary color</div>
                  <input
                    id="theme-primary"
                    type="color"
                    name="primary"
                    value={theme.primary}
                    style="width:44px;height:32px;border:1px solid #e2e3e8;padding:2px;background:#fff;cursor:pointer;"
                  />
                  <span id="theme-primary-hex" style={`font-family:${MONO};font-size:12px;color:#686b74;`}>
                    {theme.primary}
                  </span>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <div style="font-size:13px;width:110px;">Font pairing</div>
                  <select
                    id="theme-font"
                    name="font"
                    style="flex:1;padding:7px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;"
                  >
                    {FONT_PAIRINGS.map((p) => (
                      <option value={p.ui} selected={p.ui === theme.font}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <div style="font-size:13px;width:110px;">Logo</div>
                  <span title="File storage not yet enabled">
                    <button
                      id="logo-upload"
                      type="button"
                      disabled
                      title="File storage not yet enabled"
                      style="padding:7px 14px;background:#f7f7f9;border:1px dashed #c9cbd3;font-size:12.5px;color:#b9bcc4;cursor:not-allowed;"
                    >
                      Upload SVG/PNG
                    </button>
                  </span>
                </div>
                <div style="border-top:1px solid #f2f3f5;padding-top:12px;">
                  <div style="display:flex;align-items:center;margin-bottom:12px;">
                    <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`}>
                      DERIVED AUTOMATICALLY · CLICK TO OVERRIDE
                    </div>
                    <button
                      id="derived-reset"
                      type="button"
                      hidden={!hasOverride}
                      title="Discard overrides and re-derive from the primary color"
                      style="margin-left:auto;background:none;border:none;padding:0;font-size:11px;color:#4c5fd5;cursor:pointer;font-family:inherit;"
                    >
                      Reset
                    </button>
                  </div>
                  <input type="hidden" id="hover-set" name="hover_set" value={theme.hover ? '1' : '0'} />
                  <input type="hidden" id="border-set" name="border_set" value={theme.border ? '1' : '0'} />
                  <input type="hidden" id="tint-set" name="tint_set" value={theme.tint ? '1' : '0'} />
                  <div style="display:flex;gap:8px;">
                    <div style="flex:1;text-align:center;">
                      <div id="sw-primary" style={`height:30px;background:${d.primary};border:1px solid #e2e3e8;`}></div>
                      <div style="font-size:10.5px;color:#9a9da6;margin-top:4px;">primary</div>
                    </div>
                    <div style="flex:1;text-align:center;">
                      <input
                        id="sw-hover"
                        type="color"
                        name="hover"
                        value={d.hover}
                        class="sw-input"
                      />
                      <div style="font-size:10.5px;color:#9a9da6;margin-top:4px;">hover</div>
                    </div>
                    <div style="flex:1;text-align:center;">
                      <input
                        id="sw-border"
                        type="color"
                        name="border"
                        value={d.border}
                        class="sw-input"
                      />
                      <div style="font-size:10.5px;color:#9a9da6;margin-top:4px;">border</div>
                    </div>
                    <div style="flex:1;text-align:center;">
                      <input
                        id="sw-tint"
                        type="color"
                        name="tint"
                        value={d.tint}
                        class="sw-input"
                      />
                      <div style="font-size:10.5px;color:#9a9da6;margin-top:4px;">tint</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ---------------------------------------------------- live preview */}
            <div style="border:1px solid #e2e3e8;">
              <div style={`padding:8px 14px;background:#fff;border-bottom:1px solid #e2e3e8;font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`}>
                LIVE PREVIEW · PUBLIC FORM HEADER
              </div>
              <div id="pv-bg" style={`background:${theme.bg};padding:20px;font-family:'${theme.font}',sans-serif;`}>
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
                  <div
                    id="pv-logo"
                    style={`width:28px;height:28px;background:${d.primary};color:${d.textOn};display:grid;place-items:center;font-family:${MONO};font-size:12px;font-weight:700;`}
                  >
                    {initialsOf(event.name)}
                  </div>
                  <div style="font-weight:700;font-size:15px;">{event.name}</div>
                </div>
                <div style="font-size:18px;font-weight:700;margin-bottom:4px;">Call for Speakers</div>
                <div style="font-size:12.5px;color:#555a63;margin-bottom:14px;">
                  {event.venue ? `${event.venue}` : 'Your venue appears here'}
                </div>
                <div
                  id="pv-field"
                  style={`border:1px solid ${d.border};background:#fff;padding:9px 12px;font-size:13px;color:#9a9da6;margin-bottom:10px;`}
                >
                  Session title
                </div>
                <button
                  id="pv-btn"
                  type="button"
                  style={`padding:9px 16px;background:${d.primary};color:${d.textOn};border:none;font-size:13px;font-weight:600;cursor:pointer;`}
                >
                  Start your submission →
                </button>
              </div>
            </div>
          </div>
        </div>
      </form>

      {/* ------------------------------------------------- out-of-form actions */}
      {rooms.map((r) => (
        <form id={`rm-${r.id}`} method="post" action="/app/setup/rooms/delete" hidden>
          <input type="hidden" name="room_id" value={r.id} />
        </form>
      ))}

      <div id="room-dialog" data-dialog hidden style={DIALOG_WRAP}>
        <div style={DIALOG_CARD}>
          <form method="post" action="/app/setup/rooms">
            <div style={DIALOG_HEAD}>
              <div style="font-weight:700;font-size:15px;">New room</div>
              <button
                type="button"
                data-dialog-close="#room-dialog"
                style="margin-left:auto;background:none;border:none;color:#9a9da6;cursor:pointer;font-size:15px;padding:0;"
              >
                ✕
              </button>
            </div>
            <div style={DIALOG_BODY}>
              <div>
                <div style={FIELD_LABEL}>Room name *</div>
                <input name="name" required placeholder="e.g. Workshop Lab B" style={INPUT} />
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div>
                  <div style={FIELD_LABEL}>Capacity</div>
                  <input type="number" min="1" name="capacity" placeholder="e.g. 120" style={INPUT} />
                </div>
                <div>
                  <div style={FIELD_LABEL}>Priority order</div>
                  <input type="number" min="1" name="priority" value={String(rooms.length + 1)} style={INPUT} />
                </div>
              </div>
              <div style="font-size:11.5px;color:#9a9da6;">
                Priority sets column order in the agenda grid — 1 is leftmost.
              </div>
            </div>
            <div style={DIALOG_FOOT}>
              <button type="button" data-dialog-close="#room-dialog" style={CANCEL_BTN}>
                Cancel
              </button>
              <button type="submit" style={CREATE_BTN}>
                Add room
              </button>
            </div>
          </form>
        </div>
      </div>

      {rooms.map((r) => (
        <div id={`room-edit-${r.id}`} data-dialog hidden style={DIALOG_WRAP}>
          <div style={DIALOG_CARD}>
            <form method="post" action="/app/setup/rooms/update">
              <input type="hidden" name="room_id" value={r.id} />
              <div style={DIALOG_HEAD}>
                <div style="font-weight:700;font-size:15px;">Edit room</div>
                <button
                  type="button"
                  data-dialog-close={`#room-edit-${r.id}`}
                  style="margin-left:auto;background:none;border:none;color:#9a9da6;cursor:pointer;font-size:15px;padding:0;"
                >
                  ✕
                </button>
              </div>
              <div style={DIALOG_BODY}>
                <div>
                  <div style={FIELD_LABEL}>Room name *</div>
                  <input name="name" required value={r.name} style={INPUT} />
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                  <div>
                    <div style={FIELD_LABEL}>Capacity</div>
                    <input
                      type="number"
                      min="1"
                      name="capacity"
                      placeholder="e.g. 120"
                      value={r.capacity ? String(r.capacity) : ''}
                      style={INPUT}
                    />
                  </div>
                  <div>
                    <div style={FIELD_LABEL}>Priority order</div>
                    <input type="number" min="1" name="priority" value={String(r.priority)} style={INPUT} />
                  </div>
                </div>
                <div style="font-size:11.5px;color:#9a9da6;">
                  Priority sets column order in the agenda grid — 1 is leftmost.
                </div>
              </div>
              <div style={DIALOG_FOOT}>
                <button type="button" data-dialog-close={`#room-edit-${r.id}`} style={CANCEL_BTN}>
                  Cancel
                </button>
                <button type="submit" style={CREATE_BTN}>
                  Save room
                </button>
              </div>
            </form>
          </div>
        </div>
      ))}

      {taxonomies.map((tx) => (
        <div id={`opt-dialog-${tx.id}`} data-dialog hidden style={DIALOG_WRAP}>
          <div style={DIALOG_CARD}>
            <form method="post" action="/app/setup/options">
              <input type="hidden" name="taxonomy_id" value={tx.id} />
              <div style={DIALOG_HEAD}>
                <div style="font-weight:700;font-size:15px;">{`New option · ${tx.name}`}</div>
                <button
                  type="button"
                  data-dialog-close={`#opt-dialog-${tx.id}`}
                  style="margin-left:auto;background:none;border:none;color:#9a9da6;cursor:pointer;font-size:15px;padding:0;"
                >
                  ✕
                </button>
              </div>
              <div style={DIALOG_BODY}>
                <div>
                  <div style={FIELD_LABEL}>Name *</div>
                  <input
                    name="name"
                    required
                    placeholder={
                      { Track: 'e.g. Data Engineering', Format: 'e.g. Fireside Chat', Level: 'e.g. Expert' }[tx.name] ??
                      'Option name'
                    }
                    style={INPUT}
                  />
                </div>
                {tx.has_color ? (
                  <div style="display:flex;align-items:center;gap:10px;">
                    <div style="font-size:12px;color:#686b74;width:110px;">Color</div>
                    <input
                      type="color"
                      name="color"
                      value="#7048e8"
                      style="width:44px;height:32px;border:1px solid #e2e3e8;padding:2px;background:#fff;cursor:pointer;"
                    />
                  </div>
                ) : null}
                {tx.has_duration ? (
                  <div>
                    <div style={FIELD_LABEL}>Duration (minutes)</div>
                    <input
                      type="number"
                      min="5"
                      step="5"
                      name="duration"
                      value="30"
                      style="width:120px;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;outline-color:#4c5fd5;"
                    />
                  </div>
                ) : null}
              </div>
              <div style={DIALOG_FOOT}>
                <button type="button" data-dialog-close={`#opt-dialog-${tx.id}`} style={CANCEL_BTN}>
                  Cancel
                </button>
                <button type="submit" style={CREATE_BTN}>
                  Add option
                </button>
              </div>
            </form>
          </div>
        </div>
      ))}

      {options.map((o) => {
        const tx = taxonomies.find((t) => t.id === o.taxonomy_id);
        if (!tx) return null;
        return (
          <div id={`opt-edit-${o.id}`} data-dialog hidden style={DIALOG_WRAP}>
            <div style={DIALOG_CARD}>
              <form method="post" action="/app/setup/options/update">
                <input type="hidden" name="option_id" value={o.id} />
                <div style={DIALOG_HEAD}>
                  <div style="font-weight:700;font-size:15px;">{`Edit option · ${tx.name}`}</div>
                  <button
                    type="button"
                    data-dialog-close={`#opt-edit-${o.id}`}
                    style="margin-left:auto;background:none;border:none;color:#9a9da6;cursor:pointer;font-size:15px;padding:0;"
                  >
                    ✕
                  </button>
                </div>
                <div style={DIALOG_BODY}>
                  <div>
                    <div style={FIELD_LABEL}>Name *</div>
                    <input name="name" required value={o.name} style={INPUT} />
                  </div>
                  {tx.has_color ? (
                    <div style="display:flex;align-items:center;gap:10px;">
                      <div style="font-size:12px;color:#686b74;width:110px;">Color</div>
                      <input
                        type="color"
                        name="color"
                        value={o.color ?? '#7048e8'}
                        style="width:44px;height:32px;border:1px solid #e2e3e8;padding:2px;background:#fff;cursor:pointer;"
                      />
                    </div>
                  ) : null}
                  {tx.has_duration ? (
                    <div>
                      <div style={FIELD_LABEL}>Duration (minutes)</div>
                      <input
                        type="number"
                        min="5"
                        step="5"
                        name="duration"
                        value={String(o.duration_min ?? 30)}
                        style="width:120px;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;outline-color:#4c5fd5;"
                      />
                    </div>
                  ) : null}
                </div>
                <div style={DIALOG_FOOT}>
                  <button
                    type="submit"
                    formaction="/app/setup/options/delete"
                    formnovalidate
                    data-confirm={`Delete “${o.name}”? Sessions tagged with it lose the tag, and evaluation rules pinned to it stop matching. Submitted answers keep their text.`}
                    style="margin-right:auto;padding:8px 0;background:none;border:none;color:#c92a2a;font-size:12.5px;cursor:pointer;"
                  >
                    ✕ Delete option
                  </button>
                  <button type="button" data-dialog-close={`#opt-edit-${o.id}`} style={CANCEL_BTN}>
                    Cancel
                  </button>
                  <button type="submit" style={CREATE_BTN}>
                    Save option
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })}

      <div id="tax-dialog" data-dialog hidden style={DIALOG_WRAP}>
        <div style={DIALOG_CARD}>
          <form method="post" action="/app/setup/taxonomies">
            <div style={DIALOG_HEAD}>
              <div style="font-weight:700;font-size:15px;">New taxonomy</div>
              <button
                type="button"
                data-dialog-close="#tax-dialog"
                style="margin-left:auto;background:none;border:none;color:#9a9da6;cursor:pointer;font-size:15px;padding:0;"
              >
                ✕
              </button>
            </div>
            <div style={DIALOG_BODY}>
              <div>
                <div style={FIELD_LABEL}>Category title *</div>
                <input name="name" required placeholder="e.g. Audience, Region" style={INPUT} />
              </div>
              <div>
                <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;margin-bottom:8px;`}>
                  VALUE FIELDS ON EACH OPTION
                </div>
                <div style="display:grid;gap:8px;">
                  <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                    <input type="checkbox" name="has_color" value="1" style="accent-color:#4c5fd5;" />
                    Color
                  </label>
                  <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                    <input type="checkbox" name="has_duration" value="1" style="accent-color:#4c5fd5;" />
                    Duration (minutes)
                  </label>
                </div>
              </div>
            </div>
            <div style={DIALOG_FOOT}>
              <button type="button" data-dialog-close="#tax-dialog" style={CANCEL_BTN}>
                Cancel
              </button>
              <button type="submit" style={CREATE_BTN}>
                Create taxonomy
              </button>
            </div>
          </form>
        </div>
      </div>
    </AdminLayout>
  );
});

/* ------------------------------------------------------------------ writes */

const guard = requireOrgRole('admin');

app.post('/app/setup', guard, async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  const body = await c.req.parseBody();

  const name = String(body.name ?? '').trim() || event.name;
  let slug = slugify(String(body.slug ?? '') || name);
  if (slug !== event.slug && (await slugTaken(c.env.DB, slug, event.id))) slug = event.slug;

  const startDate = String(body.start_date ?? event.start_date).slice(0, 10);
  let endDate = String(body.end_date ?? event.end_date).slice(0, 10);
  if (endDate < startDate) endDate = startDate;

  const theme = parseTheme(event.theme_json);
  theme.primary = normalizeHex(String(body.primary ?? theme.primary));
  const font = String(body.font ?? theme.font);
  theme.font = FONT_PAIRINGS.some((p) => p.ui === font) ? font : theme.font;
  // Palette slots are stored only when explicitly overridden (the `*_set` flag);
  // otherwise they keep deriving from primary.
  for (const key of ['hover', 'border', 'tint'] as const) {
    if (String(body[`${key}_set`] ?? '') === '1' && body[key]) theme[key] = normalizeHex(String(body[key]));
    else delete theme[key];
  }

  await run(
    c.env.DB,
    `UPDATE events SET name=?, slug=?, start_date=?, end_date=?, timezone=?, venue=?, mode=?, theme_json=? WHERE id=?`,
    name,
    slug,
    startDate,
    endDate,
    String(body.timezone ?? event.timezone),
    String(body.venue ?? '').trim() || null,
    String(body.mode ?? event.mode),
    JSON.stringify(theme),
    event.id
  );
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Event settings updated',
  });

  return c.redirect(
    '/app/setup?ok=' + encodeURIComponent('Saved — public surfaces revalidate on next request')
  );
});

app.post('/app/setup/rooms', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const name = String(body.name ?? '').trim();
  if (!name) return c.redirect('/app/setup');
  const capacity = Number.parseInt(String(body.capacity ?? ''), 10);
  const priority = Number.parseInt(String(body.priority ?? ''), 10);
  await run(
    c.env.DB,
    `INSERT INTO rooms (id, event_id, name, capacity, priority) VALUES (?,?,?,?,?)`,
    newId('rom'),
    event.id,
    name,
    Number.isFinite(capacity) ? capacity : null,
    Number.isFinite(priority) ? priority : 1
  );
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: c.var.user?.name || 'System',
    action: 'Room added',
    detail: name,
  });
  return c.redirect('/app/setup?ok=' + encodeURIComponent(`“${name}” added — agenda grid gains a column`));
});

app.post('/app/setup/rooms/update', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const roomId = String(body.room_id ?? '');
  const room = await one<{ id: string; name: string; capacity: number | null; priority: number }>(
    c.env.DB,
    `SELECT * FROM rooms WHERE id = ? AND event_id = ?`,
    roomId,
    event.id
  );
  if (!room) return c.redirect('/app/setup');
  const name = String(body.name ?? '').trim() || room.name;
  const capacity = Number.parseInt(String(body.capacity ?? ''), 10);
  const priority = Number.parseInt(String(body.priority ?? ''), 10);
  await run(
    c.env.DB,
    `UPDATE rooms SET name=?, capacity=?, priority=? WHERE id=? AND event_id=?`,
    name,
    Number.isFinite(capacity) ? capacity : null,
    Number.isFinite(priority) ? priority : room.priority,
    roomId,
    event.id
  );
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: c.var.user?.name || 'System',
    action: 'Room updated',
    detail: name,
  });
  return c.redirect('/app/setup?ok=' + encodeURIComponent(`“${name}” updated — agenda grid follows`));
});

app.post('/app/setup/rooms/delete', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const roomId = String(body.room_id ?? '');
  const room = await one<{ name: string }>(
    c.env.DB,
    `SELECT name FROM rooms WHERE id = ? AND event_id = ?`,
    roomId,
    event.id
  );
  if (!room) return c.redirect('/app/setup');
  await run(c.env.DB, `UPDATE sessions SET room_id = NULL WHERE room_id = ?`, roomId);
  await run(c.env.DB, `DELETE FROM rooms WHERE id = ? AND event_id = ?`, roomId, event.id);
  return c.redirect('/app/setup?ok=' + encodeURIComponent(`“${room.name}” removed — agenda grid updates`));
});

app.post('/app/setup/taxonomies', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const name = String(body.name ?? '').trim();
  if (!name) return c.redirect('/app/setup');
  const count = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM taxonomies WHERE event_id = ?`,
    event.id
  );
  await run(
    c.env.DB,
    `INSERT INTO taxonomies (id, event_id, name, has_color, has_duration, position) VALUES (?,?,?,?,?,?)`,
    newId('tax'),
    event.id,
    name,
    body.has_color ? 1 : 0,
    body.has_duration ? 1 : 0,
    count?.n ?? 0
  );
  return c.redirect(
    '/app/setup?ok=' + encodeURIComponent(`“${name}” created — available to forms, routing, filters`)
  );
});

app.post('/app/setup/options', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const taxonomyId = String(body.taxonomy_id ?? '');
  const name = String(body.name ?? '').trim();
  const tax = await one<TaxRow>(
    c.env.DB,
    `SELECT * FROM taxonomies WHERE id = ? AND event_id = ?`,
    taxonomyId,
    event.id
  );
  if (!tax || !name) return c.redirect('/app/setup');
  const count = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM taxonomy_options WHERE taxonomy_id = ?`,
    taxonomyId
  );
  const duration = Number.parseInt(String(body.duration ?? ''), 10);
  await run(
    c.env.DB,
    `INSERT INTO taxonomy_options (id, taxonomy_id, name, color, duration_min, position) VALUES (?,?,?,?,?,?)`,
    newId('tpo'),
    taxonomyId,
    name,
    tax.has_color ? normalizeHex(String(body.color ?? '#7048e8')) : null,
    tax.has_duration && Number.isFinite(duration) ? duration : null,
    count?.n ?? 0
  );
  return c.redirect('/app/setup?ok=' + encodeURIComponent(`“${name}” added to ${tax.name}`));
});

app.post('/app/setup/options/update', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const optionId = String(body.option_id ?? '');
  const row = await one<OptRow & { has_color: number; has_duration: number; taxonomy: string }>(
    c.env.DB,
    `SELECT o.*, t.has_color, t.has_duration, t.name AS taxonomy
       FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
      WHERE o.id = ? AND t.event_id = ?`,
    optionId,
    event.id
  );
  if (!row) return c.redirect('/app/setup');
  const name = String(body.name ?? '').trim() || row.name;
  const duration = Number.parseInt(String(body.duration ?? ''), 10);
  await run(
    c.env.DB,
    `UPDATE taxonomy_options SET name=?, color=?, duration_min=? WHERE id=?`,
    name,
    row.has_color ? normalizeHex(String(body.color ?? row.color ?? '#7048e8')) : row.color,
    row.has_duration && Number.isFinite(duration) ? duration : row.has_duration ? row.duration_min : null,
    optionId
  );
  return c.redirect(
    '/app/setup?ok=' + encodeURIComponent(`“${name}” updated — forms, routing, filters follow`)
  );
});

app.post('/app/setup/options/delete', guard, async (c) => {
  const event = c.var.event!;
  const body = await c.req.parseBody();
  const optionId = String(body.option_id ?? '');
  const row = await one<{ id: string; name: string; taxonomy: string }>(
    c.env.DB,
    `SELECT o.id, o.name, t.name AS taxonomy
       FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
      WHERE o.id = ? AND t.event_id = ?`,
    optionId,
    event.id
  );
  if (!row) return c.redirect('/app/setup');
  // Sessions hold FK references — untag them before deleting, mirroring rooms/delete.
  await run(c.env.DB, `UPDATE sessions SET track_option_id = NULL WHERE track_option_id = ?`, optionId);
  await run(c.env.DB, `UPDATE sessions SET format_option_id = NULL WHERE format_option_id = ?`, optionId);
  await run(c.env.DB, `DELETE FROM taxonomy_options WHERE id = ?`, optionId);
  return c.redirect(
    '/app/setup?ok=' + encodeURIComponent(`“${row.name}” removed from ${row.taxonomy} — tagged sessions are now untagged`)
  );
});

export default app;
