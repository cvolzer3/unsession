/**
 * `/app/embeds` — the organizer embed generator.
 *
 * "Export a feed of your agenda, sessions, or speakers to place in your app
 * or website." Five widget types (sessions list, speakers list, agenda,
 * schedule itinerary, speaker gallery) × five output formats (styled HTML
 * script tag, basic HTML, JSON, XML, iCal). Each saved embed is a row in
 * `embeds` (migration 0020) with a name, an enable/disable state and display
 * config — track filter, field selection, transparent background, accent
 * colour. "Get Code" hands over the copy-paste snippet; the public renderers
 * pick the config up via `?eid=<id>`.
 *
 * `/app/embeds/new` is the full-screen create page: the same controls with a
 * live preview beside them, which renders the unsaved draft by passing the
 * config inline as `?cfg=` (see `draftConfig` in public-embed.tsx).
 *
 * Islands: public/js/embeds.js (list: toggle, delete, auto-open Get Code),
 * public/js/embed-new.js (create page: live preview + create).
 */
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { Ctx, Event } from '../types';
import { AdminLayout, MONO } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, jsonCol, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { requireOrgRole } from '../lib/auth';
import { loadAgenda } from '../lib/agenda';
import type { EmbedConfig, EmbedRow } from './public-embed';

const app = new Hono<Ctx>();

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;`;
const DIALOG_WRAP = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;overflow-y:auto;padding:30px 0;';
const DIALOG_CARD =
  'background:#fff;width:600px;max-width:calc(100vw - 48px);box-shadow:0 16px 48px rgba(22,23,29,0.25);max-height:calc(100vh - 60px);display:flex;flex-direction:column;';
const DIALOG_HEAD = 'padding:16px 20px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;';
const DIALOG_BODY = 'padding:18px 20px;display:grid;gap:16px;overflow-y:auto;';
const CODE_BLOCK = `display:block;font-family:${MONO};font-size:11px;line-height:1.55;background:#f4f5f9;border:1px solid #e2e3e8;padding:10px 12px;color:#16171d;word-break:break-all;white-space:pre-wrap;margin-bottom:6px;`;
const COPY_LINK = 'background:none;border:none;padding:0;font-size:12px;color:#4c5fd5;cursor:pointer;';
const INPUT = 'width:100%;padding:8px 10px;border:1px solid #d8d9de;font-size:13px;';
const FIELD_LABEL = 'font-size:12px;font-weight:600;color:#16171d;margin-bottom:5px;';
/** The preview's resolved URL — long, so it wraps rather than pushing the column wide. */
const URL_LINE = `font-family:${MONO};font-size:10.5px;color:#686b74;word-break:break-all;line-height:1.5;margin-bottom:8px;`;
const PRE_BLOCK = `margin:0;font-family:${MONO};font-size:11px;line-height:1.55;background:#f4f5f9;color:#16171d;padding:10px 12px;max-height:640px;overflow:auto;white-space:pre-wrap;word-break:break-all;`;

export const WIDGET_TYPES = [
  { key: 'sessions', label: 'List of Sessions', blurb: 'Searchable, filterable session catalog with expandable descriptions.' },
  { key: 'speakers', label: 'List of Speakers', blurb: 'Speaker directory pairing each person with their sessions.' },
  { key: 'agenda', label: 'Agenda', blurb: 'Room-by-time schedule grid, one day at a time.' },
  { key: 'itinerary', label: 'Schedule Itinerary', blurb: 'Day-tabbed chronological list with personal-schedule building.' },
  { key: 'gallery', label: 'Speaker Gallery', blurb: 'Visual photo grid of speakers with a detail view.' },
] as const;

export const FORMATS = [
  { key: 'styled', label: 'Styled HTML (script tag)', blurb: 'One-line script that renders the themed widget.' },
  { key: 'basic', label: 'Basic HTML', blurb: 'Style-free markup for server-side inclusion.' },
  { key: 'json', label: 'JSON feed', blurb: 'Machine-readable data for your own frontend.' },
  { key: 'xml', label: 'XML feed', blurb: 'The same data as XML.' },
  { key: 'ical', label: 'iCal calendar', blurb: 'Subscribe-able .ics of every published session.' },
] as const;

/** Card fields the organizer can untick per widget — title and date/time are always shown. */
const FIELD_KEYS: Record<string, { key: string; label: string }[]> = {
  sessions: [
    { key: 'description', label: 'Description' },
    { key: 'speakers', label: 'Speakers' },
    { key: 'room', label: 'Room / location' },
    { key: 'track', label: 'Track tag' },
    { key: 'format', label: 'Format tag' },
    { key: 'search', label: 'Search box' },
  ],
  itinerary: [
    { key: 'description', label: 'Description' },
    { key: 'speakers', label: 'Speakers' },
    { key: 'room', label: 'Room / location' },
    { key: 'track', label: 'Track tag' },
    { key: 'format', label: 'Format tag' },
    { key: 'search', label: 'Search box' },
  ],
  agenda: [],
  speakers: [
    { key: 'tagline', label: 'Job title & company' },
    { key: 'bio', label: 'Bio' },
    { key: 'sessions', label: 'Sessions per speaker' },
    { key: 'search', label: 'Search box' },
  ],
  gallery: [
    { key: 'tagline', label: 'Job title & company' },
    { key: 'search', label: 'Search box' },
  ],
};

const widgetLabel = (key: string) => WIDGET_TYPES.find((w) => w.key === key)?.label ?? key;
const formatLabel = (key: string) => FORMATS.find((f) => f.key === key)?.label ?? key;

/* --------------------------------------------------------------- snippets */

/** Where a widget × format is served from, `q` being the caller's query string. */
function embedPath(origin: string, event: Event, widget: string, format: string, q: string): string {
  const base = `${origin}/${event.slug}`;
  switch (format) {
    case 'json':
      return widget === 'speakers' || widget === 'gallery' ? `${base}/speakers.json?${q}` : `${base}/agenda.json?${q}`;
    case 'xml':
      return widget === 'speakers' || widget === 'gallery' ? `${base}/speakers.xml?${q}` : `${base}/agenda.xml?${q}`;
    case 'ical':
      return `${base}/agenda.ics?${q}`;
    case 'basic':
      // The agenda grid has no basic variant — its chronological fragment serves the same data.
      return widget === 'agenda' ? `${base}/embed/itinerary?${q}&basic=1` : `${base}/embed/${widget}?${q}&basic=1`;
    default:
      return `${base}/embed/${widget}?${q}`;
  }
}

/** The URL the embed's format is served from (also the Preview target). */
export function embedUrl(origin: string, event: Event, widget: string, format: string, eid: string): string {
  return embedPath(origin, event, widget, format, `eid=${eid}`);
}

/**
 * Preview targets for every widget × format, keyed `widget:format`. The island
 * swaps `__CFG__` for the encoded draft config, so the format → URL mapping
 * above stays the only copy of that logic.
 */
function previewUrls(event: Event): Record<string, string> {
  const map: Record<string, string> = {};
  for (const w of WIDGET_TYPES) {
    for (const f of FORMATS) map[`${w.key}:${f.key}`] = embedPath('', event, w.key, f.key, 'cfg=__CFG__');
  }
  return map;
}

export function snippetFor(origin: string, event: Event, row: { id: string; widget: string; format: string }): string {
  const url = embedUrl(origin, event, row.widget, row.format, row.id);
  if (row.format === 'styled') {
    return `<script src="${origin}/embed.js" data-unsession="${url}" data-height="800"></script>`;
  }
  if (row.format === 'basic') {
    return url;
  }
  return url;
}

/* ------------------------------------------------------------------ page */

const CodeDialog: FC<{ row: EmbedRow; event: Event; origin: string }> = ({ row, event, origin }) => {
  const snippet = snippetFor(origin, event, row);
  const url = embedUrl(origin, event, row.widget, row.format, row.id);
  const iframeAlt =
    row.format === 'styled'
      ? `<iframe src="${url}" style="width:100%;height:800px;border:0;" title="${event.name} ${widgetLabel(row.widget)}"></iframe>`
      : null;
  return (
    <div id={`code-${row.id}`} data-dialog hidden style={DIALOG_WRAP}>
      <div style={DIALOG_CARD}>
        <div style={DIALOG_HEAD}>
          <div style="font-size:15px;font-weight:700;">{`Get code — ${row.name}`}</div>
          <button
            type="button"
            data-dialog-close={`#code-${row.id}`}
            style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
          >
            ×
          </button>
        </div>
        <div style={DIALOG_BODY}>
          <div style="font-size:12.5px;color:#686b74;line-height:1.55;">
            {row.format === 'styled'
              ? 'Paste this one-line snippet into any page on your site. The widget pulls live data and updates whenever you re-publish.'
              : row.format === 'basic'
                ? 'Fetch this URL from your site or CMS — it returns plain HTML you can drop into any template.'
                : 'Point your integration at this feed URL.'}
          </div>
          <div>
            <div style={`${MICRO}margin-bottom:6px;`}>{formatLabel(row.format).toUpperCase()}</div>
            <code style={CODE_BLOCK}>{snippet}</code>
            <button type="button" data-copy={snippet} data-copy-msg="Embed snippet copied" style={COPY_LINK}>
              Copy snippet
            </button>
          </div>
          {iframeAlt ? (
            <div>
              <div style={`${MICRO}margin-bottom:6px;`}>PREFER AN IFRAME?</div>
              <code style={CODE_BLOCK}>{iframeAlt}</code>
              <button type="button" data-copy={iframeAlt} data-copy-msg="Iframe snippet copied" style={COPY_LINK}>
                Copy snippet
              </button>
            </div>
          ) : null}
          <div style="font-size:12.5px;">
            <a href={url} target="_blank" rel="noreferrer">
              Preview in a new window ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

app.get('/app/embeds', async (c) => {
  const props = await adminProps(c, 'Embeds', { headerTitle: 'Embeds' });
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');

  const rows = await all<EmbedRow>(c.env.DB, `SELECT * FROM embeds WHERE event_id = ? ORDER BY created_at DESC`, event.id);
  const origin = c.env.APP_ORIGIN;

  const headerActions = (
    <a
      href="/app/embeds/new"
      style="padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;"
    >
      ＋ Add embed
    </a>
  );

  return c.html(
    <AdminLayout {...props} headerActions={headerActions} scripts={['/js/embeds.js']}>
      <div style="padding:24px 28px;">
        <div style="font-size:13px;color:#686b74;line-height:1.6;">
          <div>Embed your agenda, sessions, or speakers on your website or in your app.</div>
          <div>Each embed reads from the published program and updates automatically when you publish changes.</div>
        </div>
        {!event.published ? (
          <div style="margin-top:14px;background:#fdf5dc;border:1px solid #f3e3ab;padding:11px 14px;font-size:12.5px;color:#8a6d1a;">
            The agenda isn’t published yet — embeds render a “Not published yet” notice until you hit Publish changes on
            the <a href="/app/agenda">Agenda builder</a>.
          </div>
        ) : null}

        <div style="margin-top:20px;background:#fff;border:1px solid #e2e3e8;">
          <div style={`display:grid;grid-template-columns:1fr 170px 170px 90px 210px;gap:12px;padding:10px 16px;border-bottom:1px solid #e2e3e8;${MICRO}`}>
            <span>NAME</span>
            <span>WIDGET</span>
            <span>FORMAT</span>
            <span>ENABLED</span>
            <span></span>
          </div>
          {rows.map((r) => (
            <div
              data-embed-row={r.id}
              style="display:grid;grid-template-columns:1fr 170px 170px 90px 210px;gap:12px;padding:12px 16px;border-bottom:1px solid #eceded;align-items:center;"
            >
              <span style="font-size:13.5px;font-weight:600;">{r.name}</span>
              <span style="font-size:12.5px;color:#686b74;">{widgetLabel(r.widget)}</span>
              <span style="font-size:12.5px;color:#686b74;">{formatLabel(r.format)}</span>
              <label style="display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;">
                <input
                  type="checkbox"
                  data-embed-toggle={r.id}
                  checked={!!r.enabled}
                  style="width:15px;height:15px;accent-color:#4c5fd5;"
                />
                <span data-embed-state style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.08em;color:${r.enabled ? '#2b8a3e' : '#9a9da6'};`}>
                  {r.enabled ? 'ON' : 'OFF'}
                </span>
              </label>
              <span style="display:flex;gap:12px;align-items:center;justify-content:flex-end;">
                <button type="button" data-dialog-open={`#code-${r.id}`} style={COPY_LINK}>
                  Get code
                </button>
                <a href={embedUrl(origin, event, r.widget, r.format, r.id)} target="_blank" rel="noreferrer" style="font-size:12px;">
                  Preview ↗
                </a>
                <button
                  type="button"
                  data-embed-delete={r.id}
                  data-confirm="Delete this embed? Any pages already using its snippet will stop rendering."
                  style="background:none;border:none;padding:0;font-size:12px;color:#c92a2a;cursor:pointer;"
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
          {rows.length === 0 ? (
            <div style="padding:36px 16px;text-align:center;">
              <div style="font-size:14px;font-weight:600;">No embeds yet</div>
              <div style="font-size:12.5px;color:#686b74;margin-top:4px;">
                Add one to get a copy-paste snippet for your website.
              </div>
            </div>
          ) : null}
        </div>

        <div style="margin-top:16px;font-size:12px;color:#9a9da6;line-height:1.6;">
          Quick links without saving an embed:{' '}
          <a href={`/${event.slug}/agenda.json`} target="_blank" rel="noreferrer">
            agenda.json
          </a>
          {' · '}
          <a href={`/${event.slug}/agenda.xml`} target="_blank" rel="noreferrer">
            agenda.xml
          </a>
          {' · '}
          <a href={`/${event.slug}/agenda.ics`} target="_blank" rel="noreferrer">
            agenda.ics
          </a>
          {' · '}
          <a href={`/${event.slug}/speakers.json`} target="_blank" rel="noreferrer">
            speakers.json
          </a>
        </div>
      </div>

      {rows.map((r) => (
        <CodeDialog row={r} event={event} origin={origin} />
      ))}
    </AdminLayout>
  );
});

/* -------------------------------------------------------------- new embed */

app.get('/app/embeds/new', async (c) => {
  const props = await adminProps(c, 'New embed', { headerTitle: 'New embed' });
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');

  const bundle = await loadAgenda(c.env.DB, event.id);
  const origin = c.env.APP_ORIGIN;
  const urls = previewUrls(event);
  // Without JavaScript the preview still shows the defaults the form starts on.
  const defaultUrl = urls['sessions:styled'].replace('__CFG__', '');

  return c.html(
    <AdminLayout {...props} scripts={['/js/embed-new.js']}>
      <div style="padding:24px 28px;">
        <div style="display:grid;grid-template-columns:minmax(0,480px) minmax(0,1fr);gap:24px;align-items:start;">
          {/* ------------------------------------------------------- form */}
          <div style="background:#fff;border:1px solid #e2e3e8;padding:18px 20px;display:grid;gap:16px;">
            <div>
              <div style={FIELD_LABEL}>Name</div>
              <input id="ne-name" placeholder="e.g. Website sessions list" style={INPUT} />
            </div>
            <div>
              <div style={FIELD_LABEL}>Widget</div>
              <div style="display:grid;gap:6px;">
                {WIDGET_TYPES.map((w, i) => (
                  <label style="display:flex;gap:9px;align-items:flex-start;font-size:13px;cursor:pointer;border:1px solid #e2e3e8;padding:9px 12px;">
                    <input
                      type="radio"
                      name="ne-widget"
                      value={w.key}
                      checked={i === 0}
                      style="margin-top:2px;accent-color:#4c5fd5;"
                    />
                    <span>
                      <span style="font-weight:600;">{w.label}</span>
                      <span style="display:block;font-size:11.5px;color:#686b74;margin-top:1px;">{w.blurb}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div style={FIELD_LABEL}>Output format</div>
              <select id="ne-format" style={INPUT}>
                {FORMATS.map((f) => (
                  <option value={f.key}>{`${f.label} — ${f.blurb}`}</option>
                ))}
              </select>
            </div>
            {bundle.tracks.length ? (
              <div>
                <div style={FIELD_LABEL}>Content filter — tracks</div>
                <div style="font-size:11.5px;color:#9a9da6;margin-bottom:6px;">Leave everything unticked to include all tracks.</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:5px;">
                  {bundle.tracks.map((t) => (
                    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;">
                      <input type="checkbox" data-ne-track value={t.id} style="width:14px;height:14px;accent-color:#4c5fd5;" />
                      <span
                        style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${t.color ?? '#adb5bd'};flex:none;`}
                      ></span>
                      {t.name}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            <div data-ne-fields>
              <div style={FIELD_LABEL}>Card fields</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:5px;">
                {['Title', 'Date & time'].map((label) => (
                  <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:#9a9da6;">
                    <input type="checkbox" checked disabled style="width:14px;height:14px;" />
                    {`${label} (always shown)`}
                  </label>
                ))}
                {Object.entries(FIELD_KEYS).flatMap(([widget, fields]) =>
                  fields.map((f) => (
                    <label
                      data-ne-field-for={widget}
                      style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;"
                    >
                      <input type="checkbox" data-ne-field value={f.key} checked style="width:14px;height:14px;accent-color:#4c5fd5;" />
                      {f.label}
                    </label>
                  ))
                )}
              </div>
            </div>
            <div style="display:grid;gap:8px;">
              <div style={FIELD_LABEL}>Appearance</div>
              <label style="display:flex;align-items:center;gap:9px;font-size:13px;cursor:pointer;">
                <input id="ne-transparent" type="checkbox" style="width:15px;height:15px;accent-color:#4c5fd5;" />
                Transparent background (sits on your site’s own background)
              </label>
              <label style="display:flex;align-items:center;gap:9px;font-size:13px;cursor:pointer;">
                <input id="ne-accent-on" type="checkbox" style="width:15px;height:15px;accent-color:#4c5fd5;" />
                Override accent colour
                <input id="ne-accent" type="color" value="#4c5fd5" style="width:44px;height:26px;border:1px solid #d8d9de;padding:0;background:none;cursor:pointer;" />
              </label>
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #eceded;padding-top:14px;">
              <a
                href="/app/embeds"
                style="padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;color:#16171d;text-decoration:none;"
              >
                Cancel
              </a>
              <button
                type="button"
                id="ne-create"
                style="padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
              >
                Create embed
              </button>
            </div>
          </div>

          {/* ---------------------------------------------------- preview */}
          <div id="ne-preview" data-preview-urls={JSON.stringify(urls)} style="position:sticky;top:24px;">
            <div style={`${MICRO}margin-bottom:6px;`}>LIVE PREVIEW</div>
            <div id="ne-url" style={URL_LINE}>{`${origin}${defaultUrl}`}</div>
            <div style="background:#fff;border:1px solid #e2e3e8;">
              <iframe
                id="ne-frame"
                src={defaultUrl}
                title="Embed preview"
                style="width:100%;height:640px;border:0;display:block;background:#fff;"
              ></iframe>
              <pre id="ne-data" hidden style={PRE_BLOCK}></pre>
            </div>
            <div style="font-size:11.5px;color:#9a9da6;line-height:1.6;margin-top:8px;">
              The preview renders the draft settings above. Nothing is saved until you hit Create embed.
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
});

/* ------------------------------------------------------------------- api */

const WIDGET_KEYS = new Set(WIDGET_TYPES.map((w) => w.key as string));
const FORMAT_KEYS = new Set(FORMATS.map((f) => f.key as string));

type CreateBody = {
  name?: string;
  widget?: string;
  format?: string;
  config?: EmbedConfig;
};

app.post('/app/api/embeds/create', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<CreateBody>();
  const widget = String(body?.widget ?? '');
  const format = String(body?.format ?? '');
  if (!WIDGET_KEYS.has(widget)) return c.json({ ok: false, error: 'Pick a widget type.' }, 400);
  if (!FORMAT_KEYS.has(format)) return c.json({ ok: false, error: 'Pick an output format.' }, 400);

  const cfg = body.config ?? {};
  const allowedFields = new Set((FIELD_KEYS[widget] ?? []).map((f) => f.key));
  const config: EmbedConfig = {
    transparent: !!cfg.transparent,
    accent: typeof cfg.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(cfg.accent) ? cfg.accent : null,
    tracks: Array.isArray(cfg.tracks) ? cfg.tracks.filter((t) => typeof t === 'string').slice(0, 50) : [],
    hide: Array.isArray(cfg.hide) ? cfg.hide.filter((h) => allowedFields.has(String(h))) : [],
  };

  const name = String(body?.name ?? '').trim() || `${widgetLabel(widget)} — ${formatLabel(format)}`;
  const id = newId('emb');
  const stamp = now();
  await run(
    c.env.DB,
    `INSERT INTO embeds (id, event_id, name, widget, format, config_json, enabled, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,1,?,?,?)`,
    id,
    event.id,
    name,
    widget,
    format,
    jsonCol(config),
    c.var.user?.id ?? 'system',
    stamp,
    stamp
  );
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Embed created',
    detail: `${name} · ${widgetLabel(widget)} · ${formatLabel(format)}`,
  });
  return c.json({ ok: true, id, snippet: snippetFor(c.env.APP_ORIGIN, event, { id, widget, format }) });
});

app.post('/app/api/embeds/toggle', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<{ id?: string; enabled?: boolean }>();
  const row = await one<EmbedRow>(c.env.DB, `SELECT * FROM embeds WHERE id = ? AND event_id = ?`, body?.id, event.id);
  if (!row) return c.json({ ok: false, error: 'Embed not found.' }, 400);
  const enabled = body?.enabled ? 1 : 0;
  await run(c.env.DB, `UPDATE embeds SET enabled = ?, updated_at = ? WHERE id = ?`, enabled, now(), row.id);
  return c.json({ ok: true, id: row.id, enabled: !!enabled });
});

app.post('/app/api/embeds/delete', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const body = await c.req.json<{ id?: string }>();
  const row = await one<EmbedRow>(c.env.DB, `SELECT * FROM embeds WHERE id = ? AND event_id = ?`, body?.id, event.id);
  if (!row) return c.json({ ok: false, error: 'Embed not found.' }, 400);
  await run(c.env.DB, `DELETE FROM embeds WHERE id = ?`, row.id);
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'event',
    subjectId: event.id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Embed deleted',
    detail: row.name,
  });
  return c.json({ ok: true, id: row.id });
});

export default app;
