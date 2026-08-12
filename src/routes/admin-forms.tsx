/**
 * `/app/forms` — full port of `prototype/design_handoff_program/design/Forms.dc.html`.
 *
 * Server renders the picker bar, the setup step, the settings drawer and the
 * initial field list; `public/js/form-builder.js` takes over drag-and-drop,
 * the right-hand field rail and the live preview (which reuses the *public*
 * renderer from `public/js/public-form.js`).
 *
 * OWNER: B1.
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { AdminLayout, MONO } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { slugify } from '../lib/slugify';
import { logActivity } from '../lib/activity';
import { requireOrgRole } from '../lib/auth';
import { parseTheme, themeStyleVars } from '../lib/theme';
import { looksRich, markdownToRich, sanitizeRich } from '../lib/rich';
import {
  PALETTE,
  PRESET_NAMES,
  currentVersion,
  hydrateSchema,
  listForms,
  listNotifyMembers,
  loadForm,
  loadFormRow,
  loadTaxonomies,
  monthDay,
  normalizeField,
  parsePreset,
  parseSchema,
  parseSettings,
  presetFields,
  presetSettings,
  randomSecret,
  saveSchema,
  sanitizeConditions,
  shareUrl,
  submissionCounts,
  validateSchema,
  type FormField,
  type FormPreset,
  type FormRow,
  type FormSettings,
  type NotifyMember,
} from '../lib/forms';

const app = new Hono<Ctx>();

/* ------------------------------------------------------------------ styles */

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const FIELD_LABEL = 'font-size:12px;color:#686b74;margin-bottom:5px;';
const SETUP_INPUT = 'width:100%;padding:10px 12px;border:1px solid #d8d9de;font-size:14px;';
const DRAWER_INPUT = 'width:100%;padding:8px 10px;border:1px solid #d8d9de;font-size:13px;';
const TYPE_CHIP = `font-family:${MONO};font-size:9.5px;background:#eef0fb;color:#4c5fd5;padding:3px 6px;font-weight:600;min-width:34px;text-align:center;line-height:1.4;flex:none;`;

const PAGE_CSS = `
  /* Build mode is a full-height shell: the layout's <main> already stretches to
     at least the viewport, so making it a column lets the builder grid claim
     whatever is left under the app header and the picker bar. Without this the
     field rail stops short of the bottom on short forms and on scroll. */
  main{display:flex;flex-direction:column;}
  .us-seg input{position:absolute;opacity:0;width:0;height:0;}
  .us-seg span{display:block;padding:7px 14px;font-size:12.5px;cursor:pointer;font-weight:600;background:#fff;color:#686b74;}
  .us-seg input:checked + span{background:#16171d;color:#fff;}
  .us-toggle{display:flex;align-items:flex-start;gap:12px;}
  .us-toggle input{position:absolute;opacity:0;width:0;height:0;}
  .us-toggle .tk{flex:none;width:36px;height:20px;border-radius:10px;padding:2px;display:flex;transition:background 0.15s;background:#d8d9de;justify-content:flex-start;cursor:pointer;}
  .us-toggle input:checked + .tk{background:#4c5fd5;justify-content:flex-end;}
  .us-toggle .kn{width:16px;height:16px;border-radius:50%;background:#fff;display:block;}
  @keyframes drawerin{from{transform:translateX(32px);opacity:0}to{transform:none;opacity:1}}
  /* Width sits midway between the old fixed 420px and half the viewport, so it
     tracks the window instead of feeling cramped on wide screens. */
  .us-drawer{--band-x:22px;position:absolute;top:0;right:0;bottom:0;width:clamp(360px,calc(210px + 25vw),720px);max-width:100vw;background:#fff;border-left:1px solid #e2e3e8;box-shadow:-12px 0 32px rgba(22,23,29,0.10);display:flex;flex-direction:column;animation:drawerin 0.18s ease;transition:width 0.16s ease;}
  /* Full screen widens the shell, not the fields: the bands grow their side
     padding so the content stays a readable column while the header and
     footer rules still run edge to edge. */
  .us-drawer[data-expanded]{width:100vw;--band-x:max(22px,calc((100vw - 880px) / 2));}
  .us-icon-btn{background:none;border:none;color:#9a9da6;cursor:pointer;padding:4px;display:flex;align-items:center;line-height:0;}
  .us-icon-btn:hover{color:#16171d;}
  .us-drawer .ic-min{display:none;}
  .us-drawer[data-expanded] .ic-max{display:none;}
  .us-drawer[data-expanded] .ic-min{display:block;}
`;

function statusBadge(status: string): string {
  const tone =
    status === 'open'
      ? 'color:#2b8a3e;background:#e6f4ea;'
      : status === 'draft'
        ? 'color:#686b74;background:#f1f3f5;'
        : 'color:#c92a2a;background:#fbe9e9;';
  return `font-family:${MONO};font-size:9px;letter-spacing:0.08em;padding:2px 6px;font-weight:600;${tone}`;
}

function closesLabel(form: FormRow): string {
  return form.closes_at ? `closes ${monthDay(form.closes_at)}` : 'not scheduled';
}

function linkLabel(form: FormRow, origin: string, eventSlug: string): string {
  if (form.status === 'draft') return 'not published';
  return shareUrl(origin, eventSlug, form.slug).replace(/^https?:\/\//, '');
}

/* ------------------------------------------------------------------ field row (mirrored in form-builder.js) */

function condChip(f: FormField, fields: FormField[]): string | null {
  if (!f.cond) return null;
  const src = fields.find((x) => x.id === f.cond!.src);
  if (!src) return 'IF (ARCHIVED FIELD)';
  return `IF ${src.label.toUpperCase()} ${f.cond.op.toUpperCase()} ${String(f.cond.val).split(' (')[0].toUpperCase()}`;
}

function tagLine(f: FormField): string {
  return [f.required ? 'required' : null, f.flags.public ? 'public' : null, !f.flags.evaluatorVisible ? 'hidden from evaluators' : null]
    .filter(Boolean)
    .join(' · ');
}

function FieldRow({ f, fields }: { f: FormField; fields: FormField[] }) {
  const chip = condChip(f, fields);
  const tags = tagLine(f);
  return (
    <div
      data-field={f.id}
      draggable={true}
      style="display:flex;align-items:flex-start;gap:10px;background:#fff;border:1px solid #e2e3e8;padding:11px 14px;margin-bottom:6px;cursor:grab;"
    >
      <span style="color:#c9cbd3;cursor:grab;font-size:14px;line-height:1;flex:none;">⠿</span>
      <span style={TYPE_CHIP}>{f.type}</span>
      <div style="display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:13.5px;font-weight:600;line-height:1.3;">{f.label}</span>
          {f.core ? (
            <span
              style={`font-family:${MONO};font-size:9px;letter-spacing:0.08em;color:#4c5fd5;border:1px solid #d5daf4;padding:2px 5px;line-height:1.4;flex:none;white-space:nowrap;`}
            >
              CORE
            </span>
          ) : null}
          {chip ? (
            <span
              style={`font-family:${MONO};font-size:10px;color:#b08800;background:#fdf5dc;padding:2px 6px;line-height:1.4;flex:none;white-space:nowrap;`}
            >
              {chip}
            </span>
          ) : null}
        </div>
        {tags ? <span style="font-size:11px;color:#9a9da6;line-height:1.3;">{tags}</span> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ settings fields (setup step + drawer) */

const TOGGLES: { key: string; label: string; hint: string }[] = [
  { key: 'allowDrafts', label: 'Allow saving drafts', hint: 'Submitters can save and return before the deadline' },
  { key: 'lateLink', label: 'Secret late-submission link', hint: 'Private URL that accepts entries after close' },
  { key: 'welcome', label: 'Welcome page', hint: 'Formatted intro shown before the first question' },
  {
    key: 'sessionIntake',
    label: 'Submissions become sessions',
    hint: 'Session intake: every submission is auto-accepted and lands as a sponsor session — no evaluation, no decision email',
  },
];

function SettingsFields({
  form,
  settings,
  inputStyle,
  lateLink,
  gap,
  defaultHeading,
  members,
}: {
  form: FormRow;
  settings: FormSettings;
  inputStyle: string;
  lateLink: string;
  gap: string;
  defaultHeading: string;
  members: NotifyMember[];
}) {
  const notified = new Set(settings.notifyMemberIds);
  const on: Record<string, boolean> = {
    allowDrafts: settings.allowDrafts,
    lateLink: !!settings.lateLinkSecret,
    welcome: settings.welcomeEnabled,
    sessionIntake: settings.submitsAs === 'session',
  };
  return (
    <>
      <div>
        <div style={FIELD_LABEL}>Internal name</div>
        <input name="name" value={form.name} style={inputStyle} />
        <div style="font-size:11px;color:#9a9da6;margin-top:3px;">Admin-only — lists, picker, activity log</div>
      </div>
      <div style={`display:grid;grid-template-columns:1fr 1fr;gap:${gap};`}>
        <div>
          <div style={FIELD_LABEL}>Public name</div>
          <input name="externalName" value={settings.externalName} placeholder={form.name} style={inputStyle} />
          <div style="font-size:11px;color:#9a9da6;margin-top:3px;">Shown to submitters · empty = internal name</div>
        </div>
        <div>
          <div style={FIELD_LABEL}>Page heading</div>
          <input name="pageHeading" value={settings.pageHeading} placeholder={defaultHeading} style={inputStyle} />
          <div style="font-size:11px;color:#9a9da6;margin-top:3px;">The public page’s H1 · empty = default</div>
        </div>
      </div>
      <div>
        <div style={FIELD_LABEL}>Status</div>
        <div style="display:flex;border:1px solid #e2e3e8;width:fit-content;">
          {['draft', 'open', 'closed'].map((s) => (
            <label class="us-seg">
              <input type="radio" name="status" value={s} checked={form.status === s} />
              <span>{s.charAt(0).toUpperCase() + s.slice(1)}</span>
            </label>
          ))}
        </div>
      </div>
      <div style={`display:grid;grid-template-columns:1fr 1fr;gap:${gap};`}>
        <div>
          <div style={FIELD_LABEL}>Opens</div>
          <input type="date" name="opens_at" value={form.opens_at?.slice(0, 10) ?? ''} style={inputStyle} />
        </div>
        <div>
          <div style={FIELD_LABEL}>Closes</div>
          <input type="date" name="closes_at" value={form.closes_at?.slice(0, 10) ?? ''} style={inputStyle} />
        </div>
      </div>
      <div style={`border-top:1px solid #eceded;padding-top:${gap};display:grid;gap:${gap};`}>
        {TOGGLES.map((t) => (
          <label class="us-toggle" data-toggle-key={t.key}>
            <input type="checkbox" name={t.key} value="1" checked={on[t.key]} />
            <span class="tk">
              <span class="kn"></span>
            </span>
            <span>
              <span style="font-size:13px;font-weight:600;display:block;">{t.label}</span>
              <span style="font-size:11.5px;color:#9a9da6;display:block;">{t.hint}</span>
            </span>
          </label>
        ))}
        <div
          data-late-link
          hidden={!on.lateLink}
          style={`font-family:${MONO};font-size:11px;color:#4c5fd5;background:#eef0fb;padding:8px 10px;margin-left:48px;word-break:break-all;`}
        >
          {lateLink}
        </div>
        {/* The welcome COPY is edited in the builder's PAGE 1 card only — a second
            textarea here used to clobber builder edits on drawer save. */}
        <div data-welcome-block hidden={!on.welcome} style="margin-left:48px;">
          <div style="font-size:11.5px;color:#686b74;background:#f8f8fa;border:1px solid #eceded;padding:8px 10px;">
            Write the welcome copy in Build, on the PAGE 1 · WELCOME card
          </div>
        </div>
      </div>
      <div style={`border-top:1px solid #eceded;padding-top:${gap};`}>
        <div style={FIELD_LABEL}>Co-speaker cap</div>
        <input
          type="number"
          name="coSpeakerCap"
          value={String(settings.coSpeakerCap)}
          min="0"
          max="5"
          style={`width:80px;${inputStyle.replace('width:100%;', '')}`}
        />
        <span style="font-size:11.5px;color:#9a9da6;margin-left:8px;">additional speakers per submission</span>
      </div>
      <div>
        <div style={FIELD_LABEL}>Post-submit message</div>
        {/* Upgraded to the rich-text island (rich-editor.js) on load; the
            textarea stays the form-post carrier if JS never runs. */}
        <textarea
          name="postSubmitMsg"
          data-rich-editor="1"
          data-rich-min="90px"
          rows={3}
          style={`${inputStyle}resize:vertical;`}
        >
          {settings.postSubmitMsg}
        </textarea>
      </div>
      <div style={`border-top:1px solid #eceded;padding-top:${gap};display:grid;gap:${gap};`}>
        <div>
          <div style={FIELD_LABEL}>Notify on every new submission</div>
          {members.length ? (
            /* `notify-chips.js` hides the select and drives it with @-chips;
               without JavaScript the multi-select is the picker. */
            <div data-notify-members>
              <select
                name="notifyMembers[]"
                multiple={true}
                size={Math.min(4, members.length)}
                style={`${inputStyle}padding:4px;`}
              >
                {members.map((m) => (
                  <option value={m.id} selected={notified.has(m.id)} data-name={m.name ?? ''} data-email={m.email}>
                    {m.name ? `${m.name} — ${m.email}` : m.email}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div style="font-size:11.5px;color:#686b74;background:#f8f8fa;border:1px solid #eceded;padding:8px 10px;">
              No teammates yet —{' '}
              <a href="/app/team" style="color:#4c5fd5;font-weight:600;">
                invite one on Team
              </a>
            </div>
          )}
        </div>
        <div>
          <div style={FIELD_LABEL}>Also notify these addresses</div>
          <input
            name="notifyEmails"
            value={settings.notifyEmails.join(', ')}
            placeholder="program@example.org, chair@example.org"
            style={inputStyle}
          />
          <div style="font-size:11px;color:#9a9da6;margin-top:3px;">
            Comma separated · for people who aren’t on the team
          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ new-form chooser (B4 presets) */

const PRESET_OPTIONS: { preset: FormPreset; desc: string }[] = [
  { preset: 'cfp', desc: 'Title, abstract, format and speakers — the standard call for proposals.' },
  { preset: 'contact', desc: 'Name, email and a message — collect people’s info, no session fields.' },
  {
    preset: 'session',
    desc: 'For sponsors: submissions are auto-accepted and land as sponsor sessions — no evaluation.',
  },
];

function NewFormChooser() {
  return (
    <div
      id="new-form-chooser"
      data-dialog
      hidden
      style="position:fixed;inset:0;background:rgba(22,23,29,0.28);z-index:70;display:flex;align-items:center;justify-content:center;padding:20px;"
    >
      <div style="width:100%;max-width:440px;background:#fff;border:1px solid #e2e3e8;box-shadow:0 12px 32px rgba(22,23,29,0.14);">
        <div style="display:flex;align-items:center;padding:16px 20px;border-bottom:1px solid #eceded;">
          <div>
            <div style="font-weight:700;font-size:15px;">New form</div>
            <div style={`${MICRO}margin-top:3px;`}>CHOOSE A STARTING POINT</div>
          </div>
          <button
            type="button"
            data-dialog-close="#new-form-chooser"
            style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:4px;"
          >
            ×
          </button>
        </div>
        <div style="padding:14px 20px 18px;display:grid;gap:8px;">
          {PRESET_OPTIONS.map((o) => (
            <form method="post" action="/app/forms/new" style="margin:0;">
              <input type="hidden" name="preset" value={o.preset} />
              <button
                type="submit"
                style="width:100%;text-align:left;background:#fff;border:1px solid #e2e3e8;padding:12px 14px;cursor:pointer;display:flex;flex-direction:column;gap:3px;"
              >
                <span style="font-size:13.5px;font-weight:600;color:#16171d;">{PRESET_NAMES[o.preset]}</span>
                <span style="font-size:11.5px;color:#686b74;line-height:1.4;">{o.desc}</span>
              </button>
            </form>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

app.get('/app/forms', async (c) => {
  const event = c.var.event;
  const props = await adminProps(c, 'Forms', { headerTitle: 'Forms' });
  if (!event) return c.redirect('/app/events/new');
  const db = c.env.DB;
  const origin = c.env.APP_ORIGIN;

  const forms = await listForms(db, event.id);
  const counts = await submissionCounts(db, event.id);

  if (!forms.length) {
    return c.html(
      <AdminLayout {...props}>
        {raw(`<style>${PAGE_CSS}</style>`)}
        <div style="padding:48px 28px;display:flex;justify-content:center;">
          <div style="width:100%;max-width:520px;background:#fff;border:1px solid #e2e3e8;padding:34px 28px;text-align:center;">
            <div style={`${MICRO}margin-bottom:8px;`}>NO FORMS YET</div>
            <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:6px;">
              Every submission starts with a form
            </div>
            <div style="font-size:13px;color:#686b74;margin-bottom:20px;">
              Start from a preset — a call for proposals, a contact form, or sponsor session intake.
            </div>
            <button
              type="button"
              data-dialog-open="#new-form-chooser"
              style="padding:10px 20px;background:#4c5fd5;border:1px solid #4c5fd5;color:#fff;font-size:13px;font-weight:600;cursor:pointer;"
            >
              ＋ New form
            </button>
          </div>
        </div>
        <NewFormChooser />
      </AdminLayout>
    );
  }

  const wanted = c.req.query('form');
  const active = forms.find((f) => f.id === wanted || f.slug === wanted) ?? forms[0];
  const loaded = await loadFormRow(db, active);
  const taxonomies = await loadTaxonomies(db, event.id);
  const members = await listNotifyMembers(db, event.org_id);
  const schema = hydrateSchema(loaded.schema, taxonomies);
  const settings = loaded.settings;

  const modeParam = c.req.query('mode');
  const mode: 'setup' | 'build' | 'preview' =
    modeParam === 'setup' || modeParam === 'preview' || modeParam === 'build' ? modeParam : 'build';

  const share = shareUrl(origin, event.slug, active.slug);
  const lateLink = settings.lateLinkSecret
    ? `${share}?key=${settings.lateLinkSecret}`
    : 'link generated when you turn this on';

  const data = {
    formId: active.id,
    formName: active.name,
    formSlug: active.slug,
    status: active.status,
    eventSlug: event.slug,
    eventName: event.name,
    mode,
    version: loaded.version.version,
    versionCount: loaded.versionCount,
    schema,
    settings,
    taxonomies,
    palette: PALETTE,
    shareUrl: share,
    submissions: counts.get(active.id) ?? 0,
    filesEnabled: !!c.env.FILES,
    themeVars: themeStyleVars(parseTheme(event.theme_json)),
  };

  const segButton = (label: string, m: string) => (
    <a
      href={`/app/forms?form=${active.id}&mode=${m}`}
      style={`padding:7px 14px;border:none;font-size:12.5px;cursor:pointer;font-weight:600;text-decoration:none;${
        mode === m ? 'background:#16171d;color:#fff;' : 'background:#fff;color:#686b74;'
      }`}
    >
      {label}
    </a>
  );

  const headerActions =
    mode === 'setup' ? null : (
      <div style="display:flex;border:1px solid #e2e3e8;">
        {segButton('Build', 'build')}
        {segButton('Preview', 'preview')}
      </div>
    );

  return c.html(
    <AdminLayout {...props} headerActions={headerActions} scripts={['/js/form-builder.js', '/js/notify-chips.js']}>
      {raw(`<style>${PAGE_CSS}</style>`)}
      {raw(
        `<script type="application/json" id="fb-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
      )}

      {/* ------------------------------------------------------ picker bar */}
      <div style="background:#fff;border-bottom:1px solid #e2e3e8;padding:16px 28px 14px;display:flex;align-items:flex-start;gap:16px;">
        <div style="position:relative;min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;">
            <button
              type="button"
              data-toggle="#form-picker"
              title="Switch form"
              style="display:flex;align-items:center;gap:10px;background:#f4f5f9;border:1px solid #d8d9de;padding:0 12px;height:38px;box-sizing:border-box;cursor:pointer;max-width:540px;"
            >
              <span style="font-weight:700;font-size:16px;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                {active.name}
              </span>
              <span style={statusBadge(active.status)}>{active.status.toUpperCase()}</span>
              <span style="color:#686b74;font-size:11px;border-left:1px solid #d8d9de;padding-left:10px;">▾</span>
            </button>
            <button
              type="button"
              data-dialog-open="#new-form-chooser"
              style="flex:none;display:flex;align-items:center;gap:7px;background:#fff;border:1px solid #d8d9de;padding:0 12px;height:38px;box-sizing:border-box;font-size:13px;font-weight:600;color:#4c5fd5;cursor:pointer;"
            >
              ＋ New form
            </button>
          </div>
          <div style="display:flex;align-items:center;gap:12px;margin-top:7px;flex-wrap:wrap;">
            <span style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
              {`${settings.audience} · ${linkLabel(active, origin, event.slug)} · ${closesLabel(active)}`}
            </span>
            <button
              type="button"
              id="fb-copy-link"
              data-share={share}
              data-draft={active.status === 'draft' ? '1' : '0'}
              style="background:none;border:none;padding:0;font-size:12px;color:#4c5fd5;cursor:pointer;"
            >
              Copy share link
            </button>
            <button
              type="button"
              data-dialog-open="#form-settings"
              style="background:none;border:none;padding:0;font-size:12px;color:#4c5fd5;cursor:pointer;"
            >
              Form settings
            </button>
            {active.status === 'open' ? (
              <a href={`/${event.slug}/${active.slug}`} target="_blank" rel="noreferrer" style="font-size:12px;">
                Open public form ↗
              </a>
            ) : null}
          </div>
          <div
            id="form-picker"
            hidden
            style="position:absolute;top:calc(100% + 8px);left:0;width:360px;background:#fff;border:1px solid #e2e3e8;box-shadow:0 8px 24px rgba(22,23,29,0.12);z-index:50;"
          >
            {forms.map((f) => {
              const n = counts.get(f.id) ?? 0;
              const s = parseSettings(f.settings_json);
              return (
                <a
                  href={`/app/forms?form=${f.id}`}
                  style={`display:flex;flex-direction:column;gap:3px;align-items:flex-start;text-align:left;width:100%;padding:11px 14px;cursor:pointer;background:${
                    f.id === active.id ? '#eef0fb' : '#fff'
                  };border-bottom:1px solid #eceded;text-decoration:none;color:#16171d;`}
                >
                  <span style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:13px;font-weight:600;">{f.name}</span>
                    <span style={statusBadge(f.status)}>{f.status.toUpperCase()}</span>
                  </span>
                  <span style="font-size:11px;color:#9a9da6;">
                    {`${s.audience} · ${n} submission${n === 1 ? '' : 's'} · ${closesLabel(f)}`}
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ setup step */}
      {mode === 'setup' ? (
        <div style="padding:36px 28px;display:flex;justify-content:center;">
          <div style="width:100%;max-width:640px;">
            <div style={`${MICRO}margin-bottom:6px;`}>NEW FORM · STEP 1 OF 2 · SETTINGS</div>
            <div style="font-weight:700;font-size:22px;letter-spacing:-0.01em;margin-bottom:4px;">Set up your form</div>
            <div style="font-size:13px;color:#686b74;margin-bottom:26px;">
              Core fields are already copied in — you’ll arrange fields in the next step.
            </div>
            <form method="post" action={`/app/forms/${active.id}/settings`} style="display:grid;gap:20px;">
              <input type="hidden" name="next" value="build" />
              <SettingsFields
                form={active}
                settings={settings}
                inputStyle={SETUP_INPUT}
                lateLink={lateLink}
                gap="14px"
                defaultHeading={`Speak at ${event.name}`}
                members={members}
              />
              <div style="display:flex;align-items:center;gap:12px;border-top:1px solid #eceded;padding-top:20px;">
                <button
                  type="submit"
                  form={`cancel-${active.id}`}
                  style="padding:10px 18px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;color:#686b74;"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style="margin-left:auto;padding:10px 20px;background:#4c5fd5;border:1px solid #4c5fd5;color:#fff;font-size:13px;font-weight:600;cursor:pointer;"
                >
                  Continue to fields →
                </button>
              </div>
            </form>
            <form id={`cancel-${active.id}`} method="post" action={`/app/forms/${active.id}/delete`} hidden></form>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------------ build mode */}
      {mode === 'build' ? (
        <div style="display:grid;grid-template-columns:1fr 360px;gap:0;flex:1 0 auto;">
          <div style="padding:22px 28px;max-width:760px;">
            <div style="display:flex;align-items:center;margin-bottom:10px;min-height:14px;">
              <span id="fb-save-state" style={`margin-left:auto;font-family:${MONO};font-size:10px;letter-spacing:0.06em;color:#c9cbd3;`}></span>
            </div>
            {/* PAGE 1 · WELCOME — both states render so the settings toggle can flip
                them live (form-builder.js), and the mental model stays stable. */}
            <div
              id="fb-welcome-card"
              hidden={!settings.welcomeEnabled}
              style="border:1px solid #e2e3e8;background:#fff;margin-bottom:18px;"
            >
              <div style="display:flex;align-items:baseline;gap:10px;padding:10px 14px;border-bottom:1px solid #eceded;background:#fafafb;">
                <span style={MICRO}>PAGE 1 · WELCOME</span>
                <span style="font-size:11px;color:#9a9da6;">Shown before the first question · autosaves</span>
              </div>
              {/* Value carrier for the rich editor form-builder.js mounts in its
                  place — legacy Markdown copy is upgraded to rich-lite here so
                  the editor never shows raw `##`/`**` syntax. */}
              <textarea id="fb-welcome" hidden>
                {looksRich(settings.welcomeMd) ? settings.welcomeMd : markdownToRich(settings.welcomeMd)}
              </textarea>
            </div>
            <div
              id="fb-welcome-off"
              hidden={settings.welcomeEnabled}
              style="border:1px dashed #d8d9de;padding:10px 14px;margin-bottom:18px;display:flex;align-items:baseline;gap:10px;"
            >
              <span style={MICRO}>PAGE 1 · WELCOME — OFF</span>
              <span style="font-size:11px;color:#b4b6be;">Turn it on under Form settings</span>
            </div>
            {/* PAGE 2 · FORM — the field list */}
            <div style="border:1px solid #e2e3e8;background:#fff;">
              <div style="display:flex;align-items:baseline;gap:10px;padding:10px 14px;border-bottom:1px solid #eceded;background:#fafafb;">
                <span style={MICRO}>PAGE 2 · FORM</span>
                <span style="font-size:11px;color:#9a9da6;">Drag to reorder · click a field to configure</span>
              </div>
              <div style="padding:14px;background:#fafafb;">
                <div id="fb-list">
                  {schema.fields.map((f) => (
                    <FieldRow f={f} fields={schema.fields} />
                  ))}
                </div>
                <div
                  id="fb-endzone"
                  style={`border:1px dashed #d8d9de;background:transparent;color:#b4b6be;padding:12px;text-align:center;font-family:${MONO};font-size:11px;letter-spacing:0.04em;`}
                >
                  drop zone
                </div>
              </div>
            </div>
            <div style={`${MICRO}margin:20px 0 8px;`}>FIELD TYPES · DRAG ONTO THE FORM, OR CLICK TO ADD AT THE END</div>
            <div id="fb-palette" style="display:flex;gap:6px;flex-wrap:wrap;">
              {PALETTE.map((p) => (
                <button
                  type="button"
                  draggable={true}
                  data-palette={p.label}
                  style="padding:6px 11px;background:#fff;border:1px dashed #c9cbd3;font-size:12px;color:#686b74;cursor:grab;"
                >
                  {`+ ${p.label}`}
                </button>
              ))}
            </div>
          </div>
          {/* The aside is the white column — it stretches to the grid row, which
              fills the viewport (see the `main` rule in PAGE_CSS), so the rail
              reaches the bottom of the page at any scroll position. The inner
              #fb-rail is what sticks, and what form-builder.js re-renders. */}
          <aside style="border-left:1px solid #e2e3e8;background:#fff;">
            <div
              id="fb-rail"
              style="position:sticky;top:0;max-height:100vh;overflow-y:auto;padding:20px;box-sizing:border-box;"
            >
              <div style="color:#9a9da6;font-size:13px;padding-top:30px;text-align:center;">
                Select a field to configure it, or drag a field type onto the form.
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {/* ------------------------------------------------------ preview mode */}
      {mode === 'preview' ? (
        <div style="padding:24px 28px;display:grid;grid-template-columns:minmax(0,640px);gap:24px;justify-content:center;align-items:start;">
          <div id="fb-preview" style={`background:#fff;border:1px solid #e2e3e8;padding:30px 34px;${data.themeVars}`}>
            <div style="color:#9a9da6;font-size:13px;">Loading preview…</div>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------------ settings drawer */}
      <div id="form-settings" data-dialog hidden style="position:fixed;inset:0;background:rgba(22,23,29,0.28);z-index:60;">
        <aside class="us-drawer" data-drawer>
          <form
            method="post"
            action={`/app/forms/${active.id}/settings`}
            style="display:flex;flex-direction:column;height:100%;min-height:0;"
          >
            <input type="hidden" name="next" value={mode} />
            <div style="display:flex;align-items:center;gap:10px;padding:18px var(--band-x);border-bottom:1px solid #eceded;">
              <div style="min-width:0;">
                <div style="font-weight:700;font-size:15px;">Form settings</div>
                <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                  {active.name}
                </div>
              </div>
              <div style="margin-left:auto;display:flex;align-items:center;gap:4px;">
                {/* Maximize / minimize (the corner-arrows "full screen" icon). */}
                <button
                  type="button"
                  class="us-icon-btn"
                  data-drawer-expand
                  aria-label="Expand to full screen"
                  title="Expand to full screen"
                >
                  <svg class="ic-max" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
                    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
                    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                  </svg>
                  <svg class="ic-min" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                    <path d="M16 3v3a2 2 0 0 0 2 2h3" />
                    <path d="M8 21v-3a2 2 0 0 0-2-2H3" />
                    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="us-icon-btn"
                  data-dialog-close="#form-settings"
                  aria-label="Close"
                  style="font-size:18px;line-height:1;"
                >
                  ×
                </button>
              </div>
            </div>
            <div style="flex:1;overflow-y:auto;padding:20px var(--band-x);display:grid;gap:18px;align-content:start;">
              <SettingsFields
                form={active}
                settings={settings}
                inputStyle={DRAWER_INPUT}
                lateLink={lateLink}
                gap="12px"
                defaultHeading={`Speak at ${event.name}`}
                members={members}
              />
            </div>
            <div style="padding:14px var(--band-x);border-top:1px solid #eceded;display:flex;justify-content:flex-end;gap:8px;">
              {(counts.get(active.id) ?? 0) === 0 ? (
                <button
                  type="submit"
                  form={`delete-${active.id}`}
                  style="margin-right:auto;padding:9px 14px;background:#fff;border:1px solid #ecc5c5;color:#c92a2a;font-size:12.5px;cursor:pointer;"
                >
                  Delete form
                </button>
              ) : null}
              <button
                type="submit"
                style="padding:9px 18px;background:#4c5fd5;border:1px solid #4c5fd5;color:#fff;font-size:13px;font-weight:600;cursor:pointer;"
              >
                Done
              </button>
            </div>
          </form>
        </aside>
      </div>
      <form id={`delete-${active.id}`} method="post" action={`/app/forms/${active.id}/delete`} hidden></form>
      <NewFormChooser />
    </AdminLayout>
  );
});

/* ------------------------------------------------------------------ writes */

const guard = requireOrgRole('admin');

async function uniqueFormSlug(db: D1Database, eventId: string, base: string, exceptId?: string): Promise<string> {
  const root = slugify(base, 'form');
  let slug = root;
  let n = 2;
  for (;;) {
    const row = await one<{ id: string }>(
      db,
      `SELECT id FROM forms WHERE event_id = ? AND slug = ?`,
      eventId,
      slug
    );
    if (!row || row.id === exceptId) return slug;
    slug = `${root}-${n++}`;
  }
}

app.post('/app/forms/new', guard, async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  const db = c.env.DB;
  const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const preset = parsePreset(body.preset);
  const settings = presetSettings(preset);
  const name = PRESET_NAMES[preset];

  // CFP only: core fields are copied from the event's first form, exactly like
  // the prototype. The other presets always start from their own field set.
  let fields: FormField[] = [];
  if (preset === 'cfp') {
    const existing = await listForms(db, event.id);
    if (existing.length) {
      const first = await loadFormRow(db, existing[0]);
      fields = first.schema.fields.filter((f) => f.core);
    }
  }
  if (!fields.length) {
    const formatTax = await one<{ id: string }>(
      db,
      `SELECT id FROM taxonomies WHERE event_id = ? AND name = 'Format' LIMIT 1`,
      event.id
    );
    fields = presetFields(preset, settings.coSpeakerCap, formatTax?.id ?? null);
  }

  const id = newId('frm');
  const slug = await uniqueFormSlug(db, event.id, name);
  await run(
    db,
    `INSERT INTO forms (id, event_id, name, slug, status, opens_at, closes_at, settings_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    event.id,
    name,
    slug,
    'draft',
    null,
    null,
    JSON.stringify(settings),
    now()
  );
  await run(
    db,
    `INSERT INTO form_versions (id, form_id, version, schema_json, created_at) VALUES (?,?,1,?,?)`,
    newId('fvr'),
    id,
    JSON.stringify({ fields }),
    now()
  );
  await logActivity(db, {
    eventId: event.id,
    subjectType: 'form',
    subjectId: id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Form created',
    detail: `${name} preset`,
  });
  return c.redirect(`/app/forms?form=${id}&mode=setup`);
});

/** Formatted-message fields (welcome, post-submit): gate rich bodies through
 *  the server-side whitelist; legacy Markdown/plain strings pass unchanged. */
function richField(v: unknown, prev: string): string {
  if (typeof v !== 'string') return prev;
  return looksRich(v) ? sanitizeRich(v) : v;
}

function settingsFromBody(
  body: Record<string, unknown>,
  prev: FormSettings,
  memberIds: Set<string>
): FormSettings {
  const lateOn = !!body.lateLink;
  // Checkboxes only report what's ticked, so the posted list *is* the new set.
  // Ids are filtered against the org so a stale form can't notify a stranger.
  const checked = body['notifyMembers[]'];
  const notifyMemberIds = (Array.isArray(checked) ? checked : checked === undefined ? [] : [checked])
    .map((id) => String(id))
    .filter((id) => memberIds.has(id));
  const welcomeOn = !!body.welcome;
  const cap = Number.parseInt(String(body.coSpeakerCap ?? ''), 10);
  return {
    allowDrafts: !!body.allowDrafts,
    lateLinkSecret: lateOn ? prev.lateLinkSecret || randomSecret() : null,
    welcomeEnabled: welcomeOn,
    // The drawer has no welcomeMd field — the copy is edited in the builder's
    // PAGE 1 card only, so a drawer save must never clobber it.
    welcomeMd: richField(body.welcomeMd, prev.welcomeMd),
    coSpeakerCap: Number.isFinite(cap) ? Math.max(0, Math.min(5, cap)) : prev.coSpeakerCap,
    postSubmitMsg: richField(body.postSubmitMsg, prev.postSubmitMsg),
    notifyEmails: String(body.notifyEmails ?? '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.includes('@')),
    notifyMemberIds,
    audience: prev.audience,
    externalName: typeof body.externalName === 'string' ? body.externalName.trim() : prev.externalName,
    pageHeading: typeof body.pageHeading === 'string' ? body.pageHeading.trim() : prev.pageHeading,
    submitsAs: body.sessionIntake ? 'session' : 'submission',
  };
}

app.post('/app/forms/:id/settings', guard, async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  const db = c.env.DB;
  const loaded = await loadForm(db, event.id, c.req.param('id'));
  if (!loaded) return c.notFound();
  const body = (await c.req.parseBody()) as Record<string, unknown>;

  const name = String(body.name ?? '').trim() || loaded.form.name;
  const statusRaw = String(body.status ?? loaded.form.status);
  const status = ['draft', 'open', 'closed'].includes(statusRaw) ? statusRaw : loaded.form.status;
  const opensAt = String(body.opens_at ?? '').slice(0, 10) || null;
  let closesAt = String(body.closes_at ?? '').slice(0, 10) || null;
  if (opensAt && closesAt && closesAt < opensAt) closesAt = opensAt;
  const memberIds = new Set((await listNotifyMembers(db, event.org_id)).map((m) => m.id));
  const settings = settingsFromBody(body, loaded.settings, memberIds);
  const slug = name === loaded.form.name ? loaded.form.slug : await uniqueFormSlug(db, event.id, name, loaded.form.id);

  await run(
    db,
    `UPDATE forms SET name = ?, slug = ?, status = ?, opens_at = ?, closes_at = ?, settings_json = ? WHERE id = ?`,
    name,
    slug,
    status,
    opensAt,
    closesAt,
    JSON.stringify(settings),
    loaded.form.id
  );

  const actor = c.var.user?.name || c.var.user?.email || 'System';
  if (status !== loaded.form.status) {
    await logActivity(db, {
      eventId: event.id,
      subjectType: 'form',
      subjectId: loaded.form.id,
      actor,
      action: status === 'open' ? 'Form opened' : status === 'closed' ? 'Form closed' : 'Form unpublished',
      detail: name,
    });
  } else {
    await logActivity(db, {
      eventId: event.id,
      subjectType: 'form',
      subjectId: loaded.form.id,
      actor,
      action: 'Form settings updated',
      detail: name,
    });
  }

  const next = String(body.next ?? 'build');
  const presetNames = new Set<string>(['Untitled form', ...Object.values(PRESET_NAMES)]);
  const isNew = next === 'build' && presetNames.has(loaded.form.name);
  const message = isNew
    ? 'Form created — core fields copied in. Drag field types to add more'
    : 'Form settings saved';
  return c.redirect(
    `/app/forms?form=${loaded.form.id}&mode=${next === 'preview' ? 'preview' : 'build'}&ok=${encodeURIComponent(message)}`
  );
});

app.post('/app/forms/:id/delete', guard, async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  const db = c.env.DB;
  const form = await one<FormRow>(
    db,
    `SELECT * FROM forms WHERE event_id = ? AND id = ?`,
    event.id,
    c.req.param('id')
  );
  if (!form) return c.notFound();
  const used = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM submissions WHERE form_id = ?`, form.id);
  if ((used?.n ?? 0) > 0) {
    return c.redirect(
      `/app/forms?form=${form.id}&ok=${encodeURIComponent('This form has submissions — close it instead of deleting')}`
    );
  }
  await run(db, `DELETE FROM form_versions WHERE form_id = ?`, form.id);
  await run(db, `DELETE FROM forms WHERE id = ?`, form.id);
  await logActivity(db, {
    eventId: event.id,
    subjectType: 'form',
    subjectId: form.id,
    actor: c.var.user?.name || c.var.user?.email || 'System',
    action: 'Form deleted',
    detail: form.name,
  });
  return c.redirect(`/app/forms?ok=${encodeURIComponent(`“${form.name}” deleted`)}`);
});

/* ------------------------------------------------------------------ JSON API */

app.post('/app/api/forms/:id/schema', guard, async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const db = c.env.DB;
  const form = await one<FormRow>(
    db,
    `SELECT * FROM forms WHERE event_id = ? AND id = ?`,
    event.id,
    c.req.param('id')
  );
  if (!form) return c.json({ ok: false, error: 'Form not found.' }, 404);

  const body = await c.req.json<{ fields?: unknown[] }>().catch(() => null);
  if (!body || !Array.isArray(body.fields)) return c.json({ ok: false, error: 'Expected a fields array.' }, 400);

  const fields = body.fields
    .map((f, i) => normalizeField(f, i))
    .filter((f): f is FormField => !!f);
  const { fields: clean, dropped } = sanitizeConditions(fields);
  const problem = validateSchema(clean);
  if (problem) return c.json({ ok: false, error: problem }, 400);

  const before = await currentVersion(db, form.id);
  const result = await saveSchema(db, form.id, { fields: clean });
  if (result.bumped) {
    await logActivity(db, {
      eventId: event.id,
      subjectType: 'form',
      subjectId: form.id,
      actor: c.var.user?.name || c.var.user?.email || 'System',
      action: 'Form version created',
      detail: `v${result.version.version} — v${before?.version ?? 1} keeps its submissions’ answers`,
    });
  }
  return c.json({
    ok: true,
    version: result.version.version,
    bumped: result.bumped,
    // A condition whose source ended up later in the form is cleared, not rejected —
    // same rule the builder applies on drop (Forms.dc.html `sanitize`).
    sanitized: dropped,
    fields: clean,
  });
});

app.post('/app/api/forms/:id/settings', guard, async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const db = c.env.DB;
  const loaded = await loadForm(db, event.id, c.req.param('id'));
  if (!loaded) return c.json({ ok: false, error: 'Form not found.' }, 404);

  const body = await c.req.json<Partial<FormSettings>>().catch(() => null);
  if (!body) return c.json({ ok: false, error: 'Expected a settings object.' }, 400);
  const memberIds = new Set((await listNotifyMembers(db, event.org_id)).map((m) => m.id));
  const next: FormSettings = {
    ...loaded.settings,
    ...body,
    notifyEmails: Array.isArray(body.notifyEmails) ? body.notifyEmails.map(String) : loaded.settings.notifyEmails,
    notifyMemberIds: Array.isArray(body.notifyMemberIds)
      ? body.notifyMemberIds.map(String).filter((id) => memberIds.has(id))
      : loaded.settings.notifyMemberIds,
  };
  if (next.lateLinkSecret === null && loaded.settings.lateLinkSecret) next.lateLinkSecret = null;
  next.welcomeMd = richField(next.welcomeMd, loaded.settings.welcomeMd);
  next.postSubmitMsg = richField(next.postSubmitMsg, loaded.settings.postSubmitMsg);
  await run(db, `UPDATE forms SET settings_json = ? WHERE id = ?`, JSON.stringify(next), loaded.form.id);
  return c.json({ ok: true, settings: next });
});

/** Read-only helper used by the builder after a save, and handy for curl tests. */
app.get('/app/api/forms/:id', async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const loaded = await loadForm(c.env.DB, event.id, c.req.param('id'));
  if (!loaded) return c.json({ ok: false, error: 'Form not found.' }, 404);
  const taxonomies = await loadTaxonomies(c.env.DB, event.id);
  return c.json({
    ok: true,
    form: {
      id: loaded.form.id,
      name: loaded.form.name,
      slug: loaded.form.slug,
      status: loaded.form.status,
      opensAt: loaded.form.opens_at,
      closesAt: loaded.form.closes_at,
    },
    version: loaded.version.version,
    versionCount: loaded.versionCount,
    settings: loaded.settings,
    schema: hydrateSchema(loaded.schema, taxonomies),
  });
});

app.get('/app/api/forms', async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event.' }, 400);
  const forms = await listForms(c.env.DB, event.id);
  const counts = await submissionCounts(c.env.DB, event.id);
  const versions = await all<{ form_id: string; v: number }>(
    c.env.DB,
    `SELECT form_id, MAX(version) AS v FROM form_versions GROUP BY form_id`
  );
  const vmap = new Map(versions.map((v) => [v.form_id, v.v]));
  return c.json({
    ok: true,
    forms: forms.map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      status: f.status,
      opensAt: f.opens_at,
      closesAt: f.closes_at,
      submissions: counts.get(f.id) ?? 0,
      version: vmap.get(f.id) ?? 1,
      settings: parseSettings(f.settings_json),
      publicUrl: shareUrl(c.env.APP_ORIGIN, event.slug, f.slug),
    })),
  });
});

/** Schema fetch used by the public form island + curl tests. */
export async function schemaOf(db: D1Database, eventId: string, formSlug: string) {
  const loaded = await loadForm(db, eventId, formSlug);
  if (!loaded) return null;
  const taxonomies = await loadTaxonomies(db, eventId);
  return hydrateSchema(parseSchema(loaded.version.schema_json), taxonomies);
}

export default app;
