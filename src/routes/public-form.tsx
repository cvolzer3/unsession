/**
 * Public submission form — `/{event}/{form}`. Registered last: it is the catch-all.
 *
 * Port of `prototype/design_handoff_program/design/Submit.dc.html`, generalized
 * over the form schema. The whole form is server-rendered inside a real
 * `<form method="post">` (so it submits without JavaScript); `public/js/
 * public-form.js` layers on debounced autosave, conditional show/hide, word
 * counters, co-speaker cards, headshot uploads and the client-side error pass.
 *
 * OWNER: B1.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import { getCookie, setCookie } from 'hono/cookie';
import type { Ctx, Event, Theme, User } from '../types';
import { MOBILE_MAX, PublicLayout } from '../views/layout';
import { loadPublicEvent } from '../lib/public';
import { all, jsonParse, now, one, run } from '../lib/db';
import { newId, nextSeq } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { findOrCreateUserByEmail, requestMagicLink, requestPasswordReset } from '../lib/auth';
import { renderTemplate, sendEmail } from '../lib/email';
import { filesEnabled, saveUpload } from '../lib/files';
import { createSessionFromSubmission } from '../lib/sessions-core';
import {
  coreRoles,
  hydrateSchema,
  inlineLinks,
  loadForm,
  loadTaxonomies,
  monthDay,
  notifyRecipients,
  openState,
  speakerCap,
  wordCount,
  type FormField,
  type FormRow,
  type FormSettings,
  type FormSchema,
} from '../lib/forms';
import { richMessageHtml } from '../lib/rich';
import { linksJson, normalizeLinks, sanitizeLinks, type SpeakerLinks } from '../lib/speaker-links';
import { SPEAKER_ROLES, defaultRole, normalizeRole } from '../lib/speaker-roles';
import {
  normalizeUrl,
  requiredWhenVisible,
  stripHidden,
  validateSubmission,
  visibleIds,
  type Answers,
  type SpeakerInput,
} from '../lib/conditions';

const app = new Hono<Ctx>();

const DRAFT_COOKIE = 'us_draft';

/* ------------------------------------------------------------------ styles */

const MONO_VAR = 'var(--font-mono)';
const LABEL = 'font-size:14px;font-weight:600;margin-bottom:6px;';
const SECTION =
  'font-family:var(--font-mono);font-size:12px;font-weight:700;letter-spacing:0.14em;color:var(--text);border-bottom:2px solid var(--border-strong);padding-bottom:8px;margin-top:14px;';
const HINT = 'font-size:12px;color:var(--muted);margin-bottom:6px;';
/** Block styles for rich-lite message bodies (welcome page, post-submit message). */
const RICH_CSS =
  '<style>' +
  '.pf-rich p{margin:0 0 10px;}.pf-rich p:last-child{margin-bottom:0;}' +
  '.pf-rich h2{font-size:19px;font-weight:700;letter-spacing:-0.01em;margin:14px 0 6px;}.pf-rich h2:first-child{margin-top:0;}' +
  '.pf-rich h3{font-size:15.5px;font-weight:700;margin:12px 0 6px;}.pf-rich h3:first-child{margin-top:0;}' +
  '.pf-rich ul,.pf-rich ol{margin:8px 0;padding-left:22px;}.pf-rich li{margin-bottom:3px;}' +
  '.pf-rich a{color:var(--primary);}' +
  /* Lists inside the centered thank-you column read left-aligned. */
  '.pf-rich-center ul,.pf-rich-center ol{display:inline-block;text-align:left;}' +
  '</style>';

/**
 * Phone layout (SPECS/M-mobile.md). Only the properties that have to change
 * below 768px live here — everything else stays inline, the way the rest of
 * this page is written. Desktop values are byte-for-byte what was inline.
 */
const FORM_CSS =
  '<style>' +
  /* Paired fields in a speaker card. At 320px each column is ~119px, which
     truncates every placeholder ("Job title — e.g. C"), so they stack. */
  '.pf-2col{display:grid;grid-template-columns:1fr 1fr;gap:10px;}' +
  /* Error message + word counter share a row under a long answer. */
  '.pf-meta{display:flex;margin-top:4px;}' +
  '.pf-remove{background:none;border:none;color:var(--muted);font-size:12.5px;cursor:pointer;padding:0;}' +
  '.pf-back{display:inline-block;margin-bottom:18px;padding:0;}' +
  /* The header kicker is capped at 45vw on a phone, and its ellipsis cannot
     reach a flex child — so the save indicator truncates its own text. */
  '.pf-kick{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;}' +
  '.pf-kick #pf-save{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
  `@media (max-width:${MOBILE_MAX}px){` +
  '.pf-2col{grid-template-columns:1fr;}' +
  '.pf-meta{flex-wrap:wrap;gap:6px;}' +
  /* ~40px hit areas; negative margins keep the surrounding rhythm. */
  '.pf-remove{padding:11px 0 11px 14px;margin:-11px 0;}' +
  '.pf-back{padding:11px 0;margin:-11px 0 7px;}' +
  '}' +
  '</style>';

function inputStyle(bad?: boolean): string {
  return `width:100%;padding:11px 12px;border:1px solid ${
    bad ? '#e03131' : 'var(--border-strong)'
  };font-size:14px;background:var(--card);outline-color:var(--primary);font-family:inherit;resize:vertical;`;
}

/* ------------------------------------------------------------------ types */

type SubmissionRow = {
  id: string;
  event_id: string;
  form_id: string;
  form_version_id: string | null;
  seq: number;
  status: string;
  title: string;
  abstract: string;
  answers_json: string;
  owner_user_id: string | null;
  agent_mode: number;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

type SpeakerRow = {
  id: string;
  submission_id: string;
  position: number;
  name: string;
  email: string;
  bio: string;
  job_title: string;
  company: string;
  tagline: string;
  role: string;
  links_json: string | null;
  headshot_file_id: string | null;
};

type RenderState = {
  answers: Answers;
  speakers: SpeakerInput[];
  agentMode: boolean;
  errors: Record<string, string>;
  errorList: string[];
  tried: boolean;
  draftId: string | null;
  email: string;
  simulatedLink?: string | null;
};

/* ------------------------------------------------------------------ cookies */

/**
 * Draft access is capability-based: the random `sub_…` id is the secret, and
 * this cookie remembers which ids this browser created (D3 — anonymous drafts
 * work in-session, the emailed `draft_link` makes them portable).
 */
function draftIds(c: Context<Ctx>): string[] {
  const cookie = getCookie(c, DRAFT_COOKIE) ?? '';
  return cookie.split(',').map((s) => s.trim()).filter(Boolean);
}

function rememberDraft(c: Context<Ctx>, id: string, ids: string[]) {
  const next = [id, ...ids.filter((x) => x !== id)].slice(0, 10);
  setCookie(c, DRAFT_COOKIE, next.join(','), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 86_400,
  });
}

/* ------------------------------------------------------------------ organizer preview */

/**
 * `?preview=1` — the form builder's Preview tab frames this very page, so what
 * an organizer previews *is* the live page rather than a second renderer that
 * drifts. The flag only bypasses the open/draft window and the draft resume:
 * everything else renders exactly as a first-time visitor sees it (anonymous,
 * so the email block shows), and `public-form.js` blocks autosave, uploads and
 * the real POST. Anyone who isn't on the event's org gets the ordinary page —
 * the flag is ignored, never an error.
 */
async function previewingAs(c: Context<Ctx>, orgId: string): Promise<boolean> {
  if (c.req.query('preview') !== '1') return false;
  const user = c.var.user;
  if (!user) return false;
  const member = await one<{ role: string }>(
    c.env.DB,
    `SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`,
    orgId,
    user.id
  );
  return !!member;
}

/* ------------------------------------------------------------------ layout helpers */

type Item = { kind: 'section'; label: string; desc?: string } | { kind: 'field'; field: FormField };

/**
 * Sections come from HDR fields (label = section title, help = section
 * description — the B2 copy blocks). Schemas without any (the seeded sandbox,
 * the prototype's own CFP) get the prototype's rhythm generated for them:
 * 01 · YOUR SESSION → 02 · SPEAKERS → … → CONSENT.
 *
 * The builder's Preview tab frames this page, so this is the only
 * implementation — nothing to mirror client-side.
 */
export function layoutItems(fields: FormField[]): Item[] {
  const hasHdr = fields.some((f) => f.type === 'HDR');
  const items: Item[] = [];
  if (hasHdr) {
    for (const f of fields) {
      if (f.type === 'HDR') items.push({ kind: 'section', label: f.label.toUpperCase(), desc: (f.help ?? '').trim() || undefined });
      else items.push({ kind: 'field', field: f });
    }
  } else {
    let current = '';
    const open = (label: string) => {
      if (current === label) return;
      current = label;
      items.push({ kind: 'section', label });
    };
    for (const f of fields) {
      const consent = f.type === 'CHK' && !!f.validation.mustCheck;
      if (f.type === 'GRP') open('SPEAKERS');
      else if (consent) open('CONSENT');
      else if (current === '' ) open('YOUR SESSION');
      else if (current === 'SPEAKERS' || current === 'CONSENT') open('MORE DETAIL');
      items.push({ kind: 'field', field: f });
    }
  }
  let n = 0;
  return items.map((it) =>
    it.kind === 'section' ? { ...it, label: `${String(++n).padStart(2, '0')} · ${it.label}` } : it
  );
}

function condHint(f: FormField, fields: FormField[]): string {
  if (!f.cond) return '';
  const src = fields.find((x) => x.id === f.cond!.src);
  const what = String(f.cond.val || '').trim();
  const tail = f.cond.alsoReq ? ' — required while it shows.' : '.';
  if (f.cond.op === 'is' && what) return `Appeared because you chose ${what}${tail}`;
  if (!src) return `Appeared because of an earlier answer${tail}`;
  return `Appeared because ${src.label} ${f.cond.op} ${what ? `“${what}”` : 'answered'}${tail}`;
}

/* ------------------------------------------------------------------ field renderer */

function FieldBlock({
  f,
  fields,
  state,
  visible,
  filesOn,
  cap,
}: {
  f: FormField;
  fields: FormField[];
  state: RenderState;
  visible: boolean;
  filesOn: boolean;
  cap: number;
}) {
  if (f.type === 'GRP') return <SpeakerBlock f={f} state={state} visible={visible} filesOn={filesOn} cap={cap} />;

  const err = state.errors[f.id];
  const value = state.answers[f.id];
  const req = requiredWhenVisible(f);
  const name = `f_${f.id}`;
  const conditional = !!f.cond;

  const inner = (
    <>
      <div style={LABEL}>
        {f.label} {req ? <span style="color:#e03131;">*</span> : null}
      </div>
      {conditional ? <div style={HINT}>{condHint(f, fields)}</div> : null}
      {f.help && !conditional && f.type !== 'CHK' ? <div style={HINT}>{raw(inlineLinks(f.help))}</div> : null}
      {(() => {
        switch (f.type) {
          case 'LONG':
            return (
              <>
                <textarea
                  name={name}
                  rows={5}
                  placeholder={f.placeholder ?? ''}
                  data-words={f.validation.maxWords ? String(f.validation.maxWords) : undefined}
                  style={inputStyle(!!err)}
                >
                  {String(value ?? '')}
                </textarea>
                <div class="pf-meta">
                  {err ? <div style="font-size:12px;color:#c92a2a;" data-err={f.id}>{err}</div> : <div data-err={f.id}></div>}
                  {f.validation.maxWords ? (
                    <div
                      data-counter={f.id}
                      style={`margin-left:auto;font-family:${MONO_VAR};font-size:11px;color:var(--muted);`}
                    >
                      {`${wordCount(String(value ?? ''))} / ${f.validation.maxWords} words`}
                    </div>
                  ) : null}
                </div>
              </>
            );
          case 'SEL':
            return (
              <select name={name} style={inputStyle(!!err)}>
                <option value="">Choose…</option>
                {(f.opts ?? []).map((o) => (
                  <option value={o} selected={String(value ?? '') === o}>
                    {o}
                  </option>
                ))}
              </select>
            );
          case 'MULTI': {
            const chosen = new Set(Array.isArray(value) ? value.map(String) : value ? [String(value)] : []);
            return (
              <div style="display:grid;gap:7px;">
                {(f.opts ?? []).map((o) => (
                  <label style="display:flex;gap:9px;font-size:13.5px;align-items:flex-start;color:var(--text-secondary);">
                    <input
                      type="checkbox"
                      name={`${name}[]`}
                      value={o}
                      checked={chosen.has(o)}
                      style="accent-color:var(--primary);margin-top:2px;"
                    />
                    <span>{o}</span>
                  </label>
                ))}
              </div>
            );
          }
          case 'CHK': {
            const checked = value === true || value === 'true' || value === 'on';
            return (
              <label style="display:flex;gap:9px;font-size:13.5px;align-items:flex-start;">
                <input
                  type="checkbox"
                  name={name}
                  value="true"
                  checked={checked}
                  style="accent-color:var(--primary);margin-top:2px;"
                />
                <span>
                  {raw(inlineLinks(f.placeholder || f.help || f.label))}{' '}
                  {req ? <span style="color:#e03131;">*</span> : null}
                </span>
              </label>
            );
          }
          case 'FILE': {
            const ids = Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
            return (
              <div data-file={f.id} data-exts={f.validation.fileExts ?? ''} data-max-mb={String(f.validation.fileMaxMb ?? 25)}>
                <input type="hidden" name={name} value={ids.join(',')} />
                {filesOn ? (
                  <label class="file-btn" style="display:block;border:1px dashed var(--border-strong);padding:12px;text-align:center;font-size:12.5px;color:var(--muted);background:repeating-linear-gradient(45deg,#fdfcfa,#fdfcfa 8px,var(--bg) 8px,var(--bg) 16px);cursor:pointer;">
                    {/* Visually hidden, not display:none — the picker stays in
                        the accessibility tree and reachable by keyboard. */}
                    <input type="file" class="vh-file" data-file-input={f.id} />
                    <span data-file-label={f.id}>
                      {ids.length
                        ? `${ids.length} file${ids.length === 1 ? '' : 's'} attached — tap to replace`
                        : `Tap to upload${f.validation.fileExts ? ` · ${f.validation.fileExts}` : ''}${
                            f.validation.fileMaxMb ? ` · ${f.validation.fileMaxMb} MB` : ''
                          }`}
                    </span>
                  </label>
                ) : (
                  <div
                    title="File storage not yet enabled"
                    style="border:1px dashed var(--border-strong);padding:12px;text-align:center;font-size:12.5px;color:var(--faint);background:repeating-linear-gradient(45deg,#fdfcfa,#fdfcfa 8px,var(--bg) 8px,var(--bg) 16px);cursor:not-allowed;"
                  >
                    File storage not yet enabled
                  </div>
                )}
              </div>
            );
          }
          case 'NUM':
            return (
              <input
                type="number"
                name={name}
                inputmode={f.validation.numKind === 'decimal' ? 'decimal' : 'numeric'}
                step={f.validation.numKind === 'decimal' ? 'any' : '1'}
                min={f.validation.min !== undefined ? String(f.validation.min) : undefined}
                max={f.validation.max !== undefined ? String(f.validation.max) : undefined}
                value={String(value ?? '')}
                placeholder={f.placeholder ?? ''}
                style={inputStyle(!!err)}
              />
            );
          case 'DATE':
            return (
              <input
                type="date"
                name={name}
                min={f.validation.dateFrom || undefined}
                max={f.validation.dateTo || undefined}
                value={String(value ?? '')}
                style={inputStyle(!!err)}
              />
            );
          case 'EML':
            return (
              <input
                type="email"
                name={name}
                inputmode="email"
                autocomplete="email"
                value={String(value ?? '')}
                placeholder={f.placeholder ?? 'you@example.com'}
                style={inputStyle(!!err)}
              />
            );
          case 'URL':
            return (
              <input
                type="url"
                name={name}
                inputmode="url"
                data-url
                value={String(value ?? '')}
                placeholder={f.placeholder ?? 'https://…'}
                style={inputStyle(!!err)}
              />
            );
          case 'TEL':
            return (
              <input
                type="tel"
                name={name}
                inputmode="tel"
                value={String(value ?? '')}
                placeholder={f.placeholder ?? '+49 …'}
                style={inputStyle(!!err)}
              />
            );
          default:
            return (
              <input
                name={name}
                value={String(value ?? '')}
                placeholder={f.placeholder ?? ''}
                maxlength={f.validation.maxChars ? f.validation.maxChars : undefined}
                style={inputStyle(!!err)}
              />
            );
        }
      })()}
      {err && f.type !== 'LONG' ? (
        <div data-err={f.id} style="font-size:12px;color:#c92a2a;margin-top:4px;">
          {err}
        </div>
      ) : (
        <div data-err={f.id}></div>
      )}
    </>
  );

  return (
    <div
      data-fw={f.id}
      data-cond={f.cond ? JSON.stringify(f.cond) : undefined}
      data-req={f.required ? '1' : '0'}
      data-type={f.type}
      hidden={!visible}
      style={conditional ? 'border-left:3px solid var(--primary);padding-left:14px;' : undefined}
    >
      {inner}
    </div>
  );
}

function SpeakerCard({
  i,
  s,
  state,
  filesOn,
}: {
  i: number;
  s: SpeakerInput;
  state: RenderState;
  filesOn: boolean;
}) {
  const label =
    state.agentMode && i === 0
      ? 'SPEAKER 1 · THE ACTUAL SPEAKER'
      : `SPEAKER ${i + 1}${i === 0 && !state.agentMode ? ' · YOU' : ''}`;
  const nameErr = state.errors[`sp${i}.name`];
  const emailErr = state.errors[`sp${i}.email`];
  return (
    <div data-speaker={String(i)} style="border:1px solid var(--border-strong);background:var(--card);padding:16px;display:grid;gap:12px;">
      <div style="display:flex;align-items:center;">
        <div data-speaker-label style={`font-family:${MONO_VAR};font-size:10.5px;letter-spacing:0.1em;color:var(--muted);`}>
          {label}
        </div>
        {i > 0 ? (
          <button type="button" data-remove-speaker class="pf-remove" style="margin-left:auto;">
            Remove
          </button>
        ) : null}
      </div>
      <div class="pf-2col">
        <div>
          <input name="sp_name[]" value={s.name} placeholder="Full name *" style={inputStyle(!!nameErr)} />
        </div>
        <div>
          <input
            name="sp_email[]"
            type="email"
            inputmode="email"
            value={s.email}
            placeholder="Email *"
            style={inputStyle(!!emailErr)}
          />
        </div>
      </div>
      <select name="sp_role[]" aria-label="Role on this submission" style={inputStyle(false)}>
        {SPEAKER_ROLES.map(([value, label]) => (
          <option value={value} selected={(normalizeRole(s.role) || defaultRole(i)) === value}>
            {`Role — ${label}`}
          </option>
        ))}
      </select>
      <div class="pf-2col">
        <input
          name="sp_job_title[]"
          value={s.jobTitle ?? ''}
          maxlength={80}
          placeholder="Job title — e.g. CTO"
          style={inputStyle(false)}
        />
        <input
          name="sp_company[]"
          value={s.company ?? ''}
          maxlength={80}
          placeholder="Company — e.g. Acme"
          style={inputStyle(false)}
        />
      </div>
      <textarea
        name="sp_bio[]"
        rows={2}
        placeholder="Short bio (shown on the public agenda)"
        style="width:100%;padding:10px 12px;border:1px solid var(--border-strong);font-size:13.5px;resize:vertical;font-family:inherit;background:var(--card);"
      >
        {s.bio ?? ''}
      </textarea>
      <div class="pf-2col">
        <input
          name="sp_link_linkedin[]"
          inputmode="url"
          value={s.links?.linkedin ?? ''}
          placeholder="LinkedIn (optional)"
          style={inputStyle(!!state.errors[`sp${i}.link_linkedin`])}
        />
        <input
          name="sp_link_x[]"
          inputmode="url"
          value={s.links?.x ?? ''}
          placeholder="X (optional)"
          style={inputStyle(!!state.errors[`sp${i}.link_x`])}
        />
        <input
          name="sp_link_website[]"
          inputmode="url"
          value={s.links?.website ?? ''}
          placeholder="Website (optional)"
          style={inputStyle(!!state.errors[`sp${i}.link_website`])}
        />
        <input
          name="sp_link_other[]"
          inputmode="url"
          value={s.links?.other ?? ''}
          placeholder="Other link (optional)"
          style={inputStyle(!!state.errors[`sp${i}.link_other`])}
        />
      </div>
      <input type="hidden" name="sp_headshot[]" value={s.headshotFileId ?? ''} />
      {filesOn ? (
        <label class="file-btn" style="display:block;border:1px dashed var(--border-strong);padding:12px;text-align:center;font-size:12.5px;color:var(--muted);background:repeating-linear-gradient(45deg,#fdfcfa,#fdfcfa 8px,var(--bg) 8px,var(--bg) 16px);cursor:pointer;">
          <input type="file" accept="image/*" class="vh-file" data-headshot-input />
          <span data-headshot-label>
            {s.headshotFileId ? (
              'headshot attached — tap to replace'
            ) : (
              <>
                <span style={`font-family:${MONO_VAR};`}>headshot</span>
                {' — tap to upload from camera roll · JPG/PNG · 10 MB'}
              </>
            )}
          </span>
        </label>
      ) : (
        <div
          title="File storage not yet enabled"
          style="border:1px dashed var(--border-strong);padding:12px;text-align:center;font-size:12.5px;color:var(--faint);background:repeating-linear-gradient(45deg,#fdfcfa,#fdfcfa 8px,var(--bg) 8px,var(--bg) 16px);cursor:not-allowed;"
        >
          <span style={`font-family:${MONO_VAR};`}>headshot</span> — file storage not yet enabled
        </div>
      )}
    </div>
  );
}

function SpeakerBlock({
  f,
  state,
  visible,
  filesOn,
  cap,
}: {
  f: FormField;
  state: RenderState;
  visible: boolean;
  filesOn: boolean;
  cap: number;
}) {
  const speakers = state.speakers.length ? state.speakers : [{ name: '', email: '', bio: '' }];
  return (
    <div data-fw={f.id} data-type="GRP" data-cond={f.cond ? JSON.stringify(f.cond) : undefined} hidden={!visible}>
      <div style="display:grid;gap:12px;">
        <label style="display:flex;gap:9px;font-size:13.5px;align-items:flex-start;color:var(--text-secondary);">
          <input
            type="checkbox"
            name="agent_mode"
            value="1"
            checked={state.agentMode}
            data-agent
            style="accent-color:var(--primary);margin-top:2px;"
          />
          <span>
            I’m submitting on behalf of someone else.
          </span>
        </label>
        {state.errors.speakers ? (
          <div style="font-size:12px;color:#c92a2a;">{state.errors.speakers}</div>
        ) : null}
        <div id="pf-speakers" data-cap={String(cap)} style="display:grid;gap:12px;">
          {speakers.map((s, i) => (
            <SpeakerCard i={i} s={s} state={state} filesOn={filesOn} />
          ))}
        </div>
        {speakers.length < cap ? (
          <button
            type="button"
            id="pf-add-speaker"
            style="padding:11px 0;background:var(--card);border:1px dashed #c9c2b4;font-size:13.5px;color:var(--text-secondary);cursor:pointer;"
          >
            {`+ Add co-speaker (${speakers.length}/${cap})`}
          </button>
        ) : (
          <button
            type="button"
            id="pf-add-speaker"
            hidden
            style="padding:11px 0;background:var(--card);border:1px dashed #c9c2b4;font-size:13.5px;color:var(--text-secondary);cursor:pointer;"
          >
            {`+ Add co-speaker (${speakers.length}/${cap})`}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

function fmtEventLine(event: Event): string {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [sy, sm, sd] = event.start_date.slice(0, 10).split('-').map(Number);
  const [, em, ed] = (event.end_date || event.start_date).slice(0, 10).split('-').map(Number);
  const range =
    sm === em ? `${M[sm - 1]} ${sd}–${ed}, ${sy}` : `${M[sm - 1]} ${sd} – ${M[em - 1]} ${ed}, ${sy}`;
  const bits = [range];
  if (event.venue) bits.push(event.venue);
  if (event.mode === 'hybrid') bits.push('in person + online');
  else if (event.mode === 'online') bits.push('online');
  return bits.join(' · ');
}

function renderPage(opts: {
  event: Event;
  theme: Theme;
  form: FormRow;
  settings: FormSettings;
  schema: FormSchema;
  state: RenderState;
  filesOn: boolean;
  late: boolean;
  showWelcome: boolean;
  user: User | null;
  toast?: string | null;
  /** Organizer preview — same page, minus the parts that would write anything. */
  preview?: boolean;
  /** Editing an already-submitted proposal: same form, saves in place. */
  editing?: { seq: number } | null;
}) {
  const { event, form, settings, schema, state, filesOn, late } = opts;
  const preview = !!opts.preview;
  const editing = opts.editing ?? null;
  const self = `/${event.slug}/${form.slug}${preview ? '?preview=1' : ''}`;
  // The welcome block is always in the DOM when the form has one, just hidden —
  // that's what lets "Start →" / "← BACK TO INTRO" toggle without a round trip.
  const hasWelcome = !!(settings.welcomeEnabled && settings.welcomeMd);
  const fields = schema.fields;
  const vis = visibleIds(fields, state.answers);
  const cap = speakerCap(fields, settings);
  const items = layoutItems(fields);
  // B1: public name + page heading come from form settings, with the old
  // hardcoded values as fallbacks.
  const publicName = settings.externalName.trim() || form.name;
  const heading = settings.pageHeading.trim() || `Speak at ${event.name}`;

  const saveIndicator = (
    <span class="pf-kick">
      <span id="pf-dot" style="display:inline-block;width:7px;height:7px;background:#2b8a3e;flex:none;"></span>
      <span id="pf-save">{editing ? `EDITING SUB-${editing.seq}` : state.draftId ? 'DRAFT SAVED' : 'NOT SAVED YET'}</span>
    </span>
  ) as unknown as string;

  const kicker = `${publicName.toUpperCase()}${form.closes_at ? ` · CLOSES ${monthDay(form.closes_at).toUpperCase()}` : ''}`;

  return (
    <PublicLayout
      title={publicName}
      event={event}
      theme={opts.theme}
      maxWidth={620}
      kicker={saveIndicator}
      toast={opts.toast ?? null}
      scripts={['/js/public-form.js']}
    >
      {raw(
        `<script type="application/json" id="pf-data">${JSON.stringify({
          eventSlug: event.slug,
          formSlug: form.slug,
          formName: form.name,
          submissionId: state.draftId,
          fields,
          answers: state.answers,
          speakers: state.speakers,
          agentMode: state.agentMode,
          cap,
          allowDrafts: settings.allowDrafts,
          filesEnabled: filesOn,
          needEmail: !opts.user && !state.draftId,
          preview,
          editing: !!editing,
        }).replace(/</g, '\\u003c')}</script>`
      )}
      {raw(FORM_CSS)}
      {/* The sandbox role chip belongs to the surrounding app, not the form —
          inside the builder's preview frame it just doubles the admin one. */}
      {preview ? raw('<style>#sandbox-switcher{display:none !important;}</style>') : null}
      <div style="max-width:620px;margin:0 auto;padding:28px 20px 80px;">
        {late ? (
          <div
            style={`border:1px solid #f0c36d;background:#fdf5dc;color:#b08800;padding:11px 14px;margin-bottom:20px;font-size:13px;font-family:${MONO_VAR};letter-spacing:0.04em;`}
          >
            LATE SUBMISSION LINK · THIS CALL IS CLOSED TO THE PUBLIC
          </div>
        ) : null}
        <div style={`font-family:${MONO_VAR};font-size:10.5px;letter-spacing:0.14em;color:var(--primary);margin-bottom:8px;`}>
          {kicker}
        </div>
        <h1 style="margin:0 0 8px;font-size:27px;letter-spacing:-0.02em;line-height:1.15;">{heading}</h1>
        <p
          style={`margin:0 0 ${opts.user ? '6px' : '26px'};font-size:15px;color:var(--text-secondary);line-height:1.55;`}
        >
          {fmtEventLine(event)}
        </p>
        {opts.user ? (
          <p style="margin:0 0 26px;font-size:12.5px;color:var(--muted);">
            {'Signed in as '}
            <span style={`font-family:${MONO_VAR};`}>{opts.user.email}</span>
          </p>
        ) : null}

        {hasWelcome ? (
          <div
            id="pf-welcome"
            hidden={!opts.showWelcome}
            style="border:1px solid var(--border-strong);background:var(--card);padding:24px 26px;margin-bottom:26px;"
          >
            {raw(RICH_CSS)}
            <div class="pf-rich" style="font-size:14px;line-height:1.65;color:var(--text-secondary);">
              {raw(richMessageHtml(settings.welcomeMd))}
            </div>
            <a
              href={preview ? '?preview=1&start=1' : '?start=1'}
              id="pf-start"
              style="display:inline-block;margin-top:22px;padding:11px 26px;background:var(--primary);color:var(--on-primary);border:none;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;"
            >
              Start →
            </a>
          </div>
        ) : null}

        <div id="pf-body" hidden={opts.showWelcome}>
          {editing ? (
            <div
              style={`border:1px solid var(--border-strong);background:var(--card);padding:11px 14px;margin-bottom:20px;font-size:12.5px;font-family:${MONO_VAR};letter-spacing:0.05em;`}
            >
              {`EDITING SUB-${editing.seq} · SAVED CHANGES REPLACE WHAT THE PROGRAM TEAM SEES`}
            </div>
          ) : null}
          {hasWelcome ? (
            <a
              href={preview ? '?preview=1&welcome=1' : '?welcome=1'}
              id="pf-back"
              class="pf-back"
              style={`font-family:${MONO_VAR};font-size:10.5px;letter-spacing:0.14em;color:var(--muted);text-decoration:none;`}
            >
              ← BACK TO INTRO
            </a>
          ) : null}
          {state.errorList.length ? (
            <div id="pf-errors" style="border:1px solid #e03131;background:var(--card);padding:14px 16px;margin-bottom:20px;">
              <div style="font-weight:700;font-size:13.5px;color:#c92a2a;margin-bottom:6px;">
                {`Fix ${state.errorList.length} thing${state.errorList.length > 1 ? 's' : ''} before submitting:`}
              </div>
              {state.errorList.map((e) => (
                <div style="font-size:13px;color:#c92a2a;">{`· ${e}`}</div>
              ))}
            </div>
          ) : (
            <div id="pf-errors" hidden style="border:1px solid #e03131;background:var(--card);padding:14px 16px;margin-bottom:20px;"></div>
          )}

          <form id="pf-form" method="post" action={self} style="display:grid;gap:22px;">
            <input type="hidden" name="submission_id" id="pf-submission-id" value={state.draftId ?? ''} />
            {late ? <input type="hidden" name="key" value={settings.lateLinkSecret ?? ''} /> : null}

            {!opts.user ? (
              <div id="pf-email-block" style="border:1px solid var(--border-strong);background:var(--card);padding:16px;">
                <div style={LABEL}>Where should we send your draft link + confirmation? <span style="color:#e03131;">*</span></div>
                <input
                  type="email"
                  name="email"
                  id="pf-email"
                  inputmode="email"
                  autocomplete="email"
                  value={state.email}
                  placeholder="you@example.com"
                  style={inputStyle(!!opts.state.errors.email)}
                />
                {opts.state.errors.email ? (
                  <div style="font-size:12px;color:#c92a2a;margin-top:4px;">{opts.state.errors.email}</div>
                ) : null}
                {state.simulatedLink ? (
                  <div style={`margin-top:10px;font-family:${MONO_VAR};font-size:11px;background:var(--chip);padding:8px 10px;word-break:break-all;`}>
                    {'Email sending is simulated in this environment — your draft link: '}
                    <a href={state.simulatedLink}>{state.simulatedLink}</a>
                  </div>
                ) : null}
              </div>
            ) : null}

            {items.map((it) =>
              it.kind === 'section' ? (
                <div>
                  <div style={SECTION}>{it.label}</div>
                  {it.desc ? (
                    <div style="font-size:13px;color:var(--muted);line-height:1.5;margin-top:8px;">{it.desc}</div>
                  ) : null}
                </div>
              ) : (
                <FieldBlock
                  f={it.field}
                  fields={fields}
                  state={state}
                  visible={vis.has(it.field.id)}
                  filesOn={filesOn}
                  cap={cap}
                />
              )
            )}

            <button
              type="submit"
              id="pf-submit"
              data-busy={editing ? 'Saving…' : 'Submitting…'}
              style="padding:15px 0;background:var(--primary);color:var(--on-primary);border:none;font-size:15.5px;font-weight:700;cursor:pointer;letter-spacing:0.01em;"
            >
              {editing ? 'Save changes →' : 'Submit session →'}
            </button>
            {editing || settings.allowDrafts ? (
              <div style="font-size:12px;color:var(--muted);text-align:center;">
                You can edit until the call closes.
              </div>
            ) : null}
          </form>
        </div>
      </div>
    </PublicLayout>
  );
}

/**
 * The locked view of a submitted proposal: everything the speaker sent, no
 * inputs. Rendered when they open a submission that can't be edited any more
 * (call closed, withdrawn) — the message says which.
 */
function renderReadOnly(opts: {
  event: Event;
  theme: Theme;
  publicName: string;
  sub: SubmissionRow;
  schema: FormSchema;
  speakers: SpeakerInput[];
  answers: Answers;
  message: string;
}) {
  const { event, sub, schema, speakers, answers } = opts;
  const items = layoutItems(schema.fields);
  const vis = visibleIds(schema.fields, answers);
  const fmt = (f: FormField): string => {
    const v = answers[f.id];
    if (v === undefined || v === null || v === '') return '';
    if (Array.isArray(v)) return f.type === 'FILE' ? `${v.length} file${v.length === 1 ? '' : 's'} attached` : v.join(', ');
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return String(v);
  };
  return (
    <PublicLayout title={opts.publicName} event={event} theme={opts.theme} maxWidth={620} kicker="READ-ONLY">
      <div style="max-width:620px;margin:0 auto;padding:28px 20px 80px;">
        <div style={`font-family:${MONO_VAR};font-size:10.5px;letter-spacing:0.14em;color:var(--primary);margin-bottom:8px;`}>
          {`${opts.publicName.toUpperCase()} · SUB-${sub.seq}`}
        </div>
        <h1 style="margin:0 0 14px;font-size:27px;letter-spacing:-0.02em;line-height:1.15;">{sub.title || 'Your submission'}</h1>
        <div style="border:1px solid #f0c36d;background:#fdf5dc;color:#b08800;padding:11px 14px;margin-bottom:26px;font-size:13px;line-height:1.5;">
          {`${opts.message} Here’s a read-only copy of what you sent.`}
        </div>
        <div style="display:grid;gap:18px;">
          {items.map((it) =>
            it.kind === 'section' ? (
              <div style={SECTION}>{it.label}</div>
            ) : vis.has(it.field.id) && fmt(it.field) ? (
              <div>
                <div style={LABEL}>{it.field.label}</div>
                <div style="font-size:14.5px;line-height:1.6;white-space:pre-wrap;">{fmt(it.field)}</div>
              </div>
            ) : null
          )}
          {speakers.length ? (
            <div>
              <div style={LABEL}>Speakers</div>
              {speakers.map((s) => (
                <div style="font-size:14px;color:var(--text-secondary);margin-top:4px;">
                  {s.name}
                  {s.email ? ` · ${s.email}` : ''}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div style="margin-top:30px;">
          <a href={`/${event.slug}/portal`} style="font-size:13px;color:var(--text-secondary);">
            ← Back to your speaker portal
          </a>
        </div>
      </div>
    </PublicLayout>
  );
}

/* ------------------------------------------------------------------ loading */

async function speakersOf(db: D1Database, submissionId: string): Promise<SpeakerInput[]> {
  const rows = await all<SpeakerRow>(
    db,
    `SELECT * FROM submission_speakers WHERE submission_id = ? ORDER BY position`,
    submissionId
  );
  return rows.map((r) => ({
    name: r.name,
    email: r.email,
    bio: r.bio,
    jobTitle: r.job_title ?? '',
    company: r.company ?? '',
    tagline: r.tagline ?? '',
    role: r.role ?? '',
    links: jsonParse<SpeakerLinks>(r.links_json, {}),
    headshotFileId: r.headshot_file_id,
  }));
}

function canAccess(sub: SubmissionRow, user: User | null, cookieIds: string[]): boolean {
  if (user && sub.owner_user_id === user.id) return true;
  return cookieIds.includes(sub.id);
}

/** Statuses a speaker may still edit while the call is open. Withdrawn stays
 * frozen; a decision doesn't lock editing — only the close date does. */
const EDITABLE_STATUSES = new Set(['in_review', 'accepted', 'waitlisted']);

/** canAccess widened for submitted proposals: a signed-in co-speaker listed on
 * the submission gets the same edit rights the portal already gives them. */
async function canEditSubmission(
  db: D1Database,
  sub: SubmissionRow,
  user: User | null,
  cookieIds: string[]
): Promise<boolean> {
  if (canAccess(sub, user, cookieIds)) return true;
  if (!user?.email) return false;
  const row = await one<{ id: string }>(
    db,
    `SELECT id FROM submission_speakers WHERE submission_id = ? AND lower(email) = lower(?)`,
    sub.id,
    user.email
  );
  return !!row;
}

/* ------------------------------------------------------------------ JSON API (autosave + upload) */

app.post('/p/api/draft', async (c) => {
  const body = await c.req.json<{
    eventSlug?: string;
    formSlug?: string;
    submissionId?: string | null;
    email?: string;
    answers?: Answers;
    speakers?: SpeakerInput[];
    agentMode?: boolean;
  }>().catch(() => null);
  if (!body?.eventSlug || !body?.formSlug) return c.json({ ok: false, error: 'Missing form.' }, 400);

  const found = await loadPublicEvent(c.env.DB, body.eventSlug);
  if (!found) return c.json({ ok: false, error: 'Event not found.' }, 404);
  const loaded = await loadForm(c.env.DB, found.event.id, body.formSlug);
  if (!loaded) return c.json({ ok: false, error: 'Form not found.' }, 404);
  if (!loaded.settings.allowDrafts) return c.json({ ok: false, error: 'This form does not save drafts.' }, 400);

  const user = c.var.user;
  const cookies = draftIds(c);
  const answers = body.answers ?? {};
  const speakers = (body.speakers ?? []).map((s) => ({
    name: String(s.name ?? ''),
    email: String(s.email ?? ''),
    bio: String(s.bio ?? ''),
    jobTitle: String(s.jobTitle ?? ''),
    company: String(s.company ?? ''),
    tagline: String(s.tagline ?? ''),
    role: normalizeRole(s.role),
    links: sanitizeLinks(s.links),
    headshotFileId: s.headshotFileId ?? null,
  }));

  let sub: SubmissionRow | null = null;
  if (body.submissionId) {
    sub = await one<SubmissionRow>(c.env.DB, `SELECT * FROM submissions WHERE id = ?`, body.submissionId);
    if (!sub || sub.form_id !== loaded.form.id) return c.json({ ok: false, error: 'Draft not found.' }, 404);
    if (!canAccess(sub, user, cookies)) return c.json({ ok: false, error: 'That draft belongs to someone else.' }, 403);
    if (sub.status !== 'draft') return c.json({ ok: false, error: 'This submission is already in.' }, 400);
  }

  let simulatedLink: string | null = null;
  if (!sub) {
    const email = (body.email ?? '').trim();
    if (!user && !email) return c.json({ ok: true, needEmail: true });
    const owner = user ?? (await findOrCreateUserByEmail(c.env.DB, email));
    const id = newId('sub');
    const stamp = now();
    await run(
      c.env.DB,
      `INSERT INTO submissions (id, event_id, form_id, form_version_id, seq, status, title, abstract, answers_json,
         owner_user_id, agent_mode, withdraw_reason, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,0,'draft','','','{}',?,?,NULL,NULL,?,?)`,
      id,
      found.event.id,
      loaded.form.id,
      loaded.version.id,
      owner.id,
      body.agentMode ? 1 : 0,
      stamp,
      stamp
    );
    sub = await one<SubmissionRow>(c.env.DB, `SELECT * FROM submissions WHERE id = ?`, id);
    rememberDraft(c, id, cookies);
    await logActivity(c.env.DB, {
      eventId: found.event.id,
      subjectType: 'submission',
      subjectId: id,
      actor: owner.email,
      action: 'Draft started',
      detail: loaded.form.name,
    });
    if (!user) {
      const res = await requestMagicLink(
        c.env,
        owner.email,
        'draft_link',
        { submissionId: id, next: `/${found.event.slug}/${loaded.form.slug}?draft=${id}` },
        {
          eventId: found.event.id,
          subject: `Your ${found.event.name} draft`,
          text: `Here is the link back to your ${found.event.name} submission draft. It works once and expires in 30 minutes — your draft keeps autosaving in this browser either way.`,
        }
      );
      simulatedLink = res.simulatedLink ?? null;
    }
  }

  const roles = coreRoles(loaded.schema.fields);
  const title = roles.title ? String(answers[roles.title.id] ?? '') : '';
  const abstract = roles.abstract ? String(answers[roles.abstract.id] ?? '') : '';

  await run(
    c.env.DB,
    `UPDATE submissions SET answers_json = ?, title = ?, abstract = ?, agent_mode = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(answers),
    title,
    abstract,
    body.agentMode ? 1 : 0,
    now(),
    sub!.id
  );
  await writeSpeakers(c.env.DB, sub!.id, speakers);

  return c.json({ ok: true, submissionId: sub!.id, simulatedLink });
});

async function writeSpeakers(db: D1Database, submissionId: string, speakers: SpeakerInput[]) {
  await run(db, `DELETE FROM submission_speakers WHERE submission_id = ?`, submissionId);
  for (let i = 0; i < speakers.length; i++) {
    const s = speakers[i];
    const links = linksJson(s.links);
    if (
      !s.name?.trim() &&
      !s.email?.trim() &&
      !s.bio?.trim() &&
      !s.jobTitle?.trim() &&
      !s.company?.trim() &&
      !s.tagline?.trim() &&
      !links &&
      !s.headshotFileId
    )
      continue;
    await run(
      db,
      `INSERT INTO submission_speakers (id, submission_id, position, name, email, bio, job_title, company, tagline, role, links_json, headshot_file_id, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      newId('ssp'),
      submissionId,
      i,
      (s.name ?? '').trim(),
      (s.email ?? '').trim(),
      (s.bio ?? '').trim(),
      (s.jobTitle ?? '').trim(),
      (s.company ?? '').trim(),
      (s.tagline ?? '').trim(),
      normalizeRole(s.role),
      links,
      s.headshotFileId || null
    );
  }
}

app.post('/p/api/upload', async (c) => {
  if (!filesEnabled(c.env)) return c.json({ ok: false, error: 'File storage is not enabled yet.' }, 400);
  const form = await c.req.parseBody();
  const submissionId = String(form.submissionId ?? '');
  const kind = String(form.kind ?? 'upload') === 'headshot' ? 'headshot' : 'upload';
  const fieldId = String(form.fieldId ?? '');
  const file = form.file;
  if (!(file instanceof File)) return c.json({ ok: false, error: 'No file received.' }, 400);

  const sub = await one<SubmissionRow>(c.env.DB, `SELECT * FROM submissions WHERE id = ?`, submissionId);
  if (!sub) return c.json({ ok: false, error: 'Save your draft first.' }, 400);
  if (!canAccess(sub, c.var.user, draftIds(c))) return c.json({ ok: false, error: 'Not your submission.' }, 403);

  const formRow = await one<FormRow>(c.env.DB, `SELECT * FROM forms WHERE id = ?`, sub.form_id);
  const loaded = formRow ? await loadForm(c.env.DB, sub.event_id, formRow.id) : null;
  const field = loaded?.schema.fields.find((f) => f.id === fieldId) ?? null;

  const res = await saveUpload(c.env, {
    eventId: sub.event_id,
    kind,
    subjectType: kind === 'headshot' ? 'submission_speaker' : 'submission',
    subjectId: kind === 'headshot' ? `${sub.id}:${String(form.position ?? '0')}` : `${sub.id}:${fieldId}`,
    file,
    uploadedBy: c.var.user?.id ?? sub.owner_user_id,
    maxMb: kind === 'headshot' ? 10 : field?.validation.fileMaxMb ?? 25,
    allowedExts: kind === 'headshot' ? 'jpg, jpeg, png, webp' : field?.validation.fileExts ?? '',
  });
  if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
  return c.json({ ok: true, id: res.file.id, filename: res.file.filename, url: `/files/${res.file.id}` });
});

/* ------------------------------------------------------------------ GET the form */

app.get('/:event/:form', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const loaded = await loadForm(c.env.DB, found.event.id, c.req.param('form'));
  if (!loaded) return c.notFound();

  const taxonomies = await loadTaxonomies(c.env.DB, found.event.id);
  const schema = hydrateSchema(loaded.schema, taxonomies);
  const settings = loaded.settings;
  const publicName = settings.externalName.trim() || loaded.form.name;
  const user = c.var.user;
  const cookies = draftIds(c);
  const preview = await previewingAs(c, found.event.org_id);

  /* ------------------------------------------------------------ post-submit */
  const submittedId = c.req.query('submitted');
  if (submittedId) {
    const sub = await one<SubmissionRow>(c.env.DB, `SELECT * FROM submissions WHERE id = ?`, submittedId);
    if (sub && sub.form_id === loaded.form.id && canAccess(sub, user, cookies)) {
      const speakers = await speakersOf(c.env.DB, sub.id);
      return c.html(
        <PublicLayout title={publicName} event={found.event} theme={found.theme} maxWidth={620}>
          <div style="max-width:620px;margin:0 auto;padding:56px 20px;text-align:center;">
            <div style="width:56px;height:56px;background:var(--primary);color:var(--on-primary);display:grid;place-items:center;font-size:26px;margin:0 auto 18px;">
              ✓
            </div>
            <h1 style="margin:0 0 10px;font-size:26px;letter-spacing:-0.02em;">It’s in. Nice work.</h1>
            {raw(RICH_CSS)}
            <div class="pf-rich pf-rich-center" style="font-size:15px;color:var(--text-secondary);line-height:1.6;max-width:440px;margin:0 auto 26px;">
              <p>{`“${sub.title || 'Your session'}” is with the ${found.event.name} program team.`}</p>
              {raw(
                richMessageHtml(
                  settings.postSubmitMsg ||
                    'You’ll get a confirmation email now, and we’ll be in touch with a decision. Track it any time in your speaker portal.'
                )
              )}
            </div>
            <div style="border:1px solid var(--border-strong);background:var(--card);max-width:360px;margin:0 auto 20px;padding:22px;text-align:left;">
              <div style={`font-family:${MONO_VAR};font-size:10px;letter-spacing:0.14em;color:var(--primary);margin-bottom:8px;`}>
                I JUST SUBMITTED TO
              </div>
              <div style="font-size:19px;font-weight:700;letter-spacing:-0.01em;">{found.event.name}</div>
              <div style="font-size:12.5px;color:var(--muted);margin-top:4px;">{fmtEventLine(found.event)}</div>
              <div style={`font-family:${MONO_VAR};font-size:11px;color:var(--muted);margin-top:10px;`}>
                {`SUB-${sub.seq}`}
              </div>
            </div>
            <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
              <button
                type="button"
                data-copy={`I just submitted “${sub.title}” to ${found.event.name} — ${c.env.APP_ORIGIN}/${found.event.slug}/${loaded.form.slug}`}
                data-copy-msg="Share card copied — post it anywhere"
                style="padding:10px 18px;background:var(--accent);color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
              >
                Share the card
              </button>
              <a
                href={`/${found.event.slug}/portal`}
                style="padding:10px 18px;border:1px solid var(--border-strong);font-size:13px;font-weight:600;color:var(--text);text-decoration:none;"
              >
                Open speaker portal →
              </a>
            </div>
            {!user && speakers[0]?.email ? (
              <div style={`max-width:440px;margin:22px auto 0;font-size:12px;color:var(--muted);`}>
                {`We emailed ${speakers[0].email} — open that link to reach your speaker portal.`}
              </div>
            ) : null}
            <div style="margin-top:26px;">
              <a href={`/${found.event.slug}/${loaded.form.slug}`} style="color:var(--muted);font-size:12px;text-decoration:underline;">
                Submit another proposal
              </a>
            </div>
          </div>
        </PublicLayout>
      );
    }
  }

  /* ------------------------------------------------------------ open window */
  const state = openState(loaded.form, settings, found.event.timezone, c.req.query('key'));

  /* ------------------------------------------------------------ edit a submitted proposal */
  // The same form, pre-filled, saving in place — but only while the call is
  // open. Once it closes (or the speaker withdrew) the submission opens as a
  // read-only copy with the reason spelled out.
  const editId = preview ? null : c.req.query('edit');
  if (editId) {
    const sub = await one<SubmissionRow>(c.env.DB, `SELECT * FROM submissions WHERE id = ?`, editId);
    if (
      sub &&
      sub.form_id === loaded.form.id &&
      sub.status !== 'draft' &&
      (await canEditSubmission(c.env.DB, sub, user, cookies))
    ) {
      const subAnswers = jsonParse<Answers>(sub.answers_json, {});
      const subSpeakers = await speakersOf(c.env.DB, sub.id);
      if (!state.open || !EDITABLE_STATUSES.has(sub.status)) {
        const message = !state.open
          ? 'The call for proposals has closed, so this submission can no longer be edited.'
          : sub.status === 'withdrawn'
            ? 'You withdrew this submission, so it can no longer be edited.'
            : 'This submission can no longer be edited.';
        return c.html(
          renderReadOnly({
            event: found.event,
            theme: found.theme,
            publicName,
            sub,
            schema,
            speakers: subSpeakers,
            answers: subAnswers,
            message,
          })
        );
      }
      return c.html(
        renderPage({
          event: found.event,
          theme: found.theme,
          form: loaded.form,
          settings,
          schema,
          filesOn: filesEnabled(c.env),
          late: state.late,
          showWelcome: false,
          user,
          toast: c.req.query('ok') ?? null,
          editing: { seq: sub.seq },
          state: {
            answers: subAnswers,
            speakers: subSpeakers,
            agentMode: !!sub.agent_mode,
            errors: {},
            errorList: [],
            tried: false,
            draftId: sub.id,
            email: '',
          },
        })
      );
    }
  }

  if (!state.open && !preview) {
    return c.html(
      <PublicLayout title={publicName} event={found.event} theme={found.theme} maxWidth={620}>
        <div style="max-width:620px;margin:0 auto;padding:64px 20px;text-align:center;">
          <div style={`font-family:${MONO_VAR};font-size:10.5px;letter-spacing:0.14em;color:var(--muted);margin-bottom:10px;`}>
            {publicName.toUpperCase()}
          </div>
          <h1 style="margin:0 0 12px;font-size:26px;letter-spacing:-0.02em;">{state.message}</h1>
          <p style="font-size:14.5px;color:var(--text-secondary);line-height:1.6;max-width:420px;margin:0 auto 24px;">
            {state.reason === 'not_yet' && loaded.form.opens_at
              ? `Submissions open ${monthDay(loaded.form.opens_at)}. Check back then.`
              : state.reason === 'draft'
                ? 'The organizers haven’t published this form yet.'
                : 'Thanks for the interest — the program team is reviewing what came in.'}
          </p>
          <a
            href={`/${found.event.slug}/agenda`}
            style="display:inline-block;padding:11px 22px;background:var(--primary);color:var(--on-primary);font-size:13.5px;font-weight:600;text-decoration:none;"
          >
            See the programme →
          </a>
        </div>
      </PublicLayout>,
      state.reason === 'draft' ? 404 : 200
    );
  }

  /* ------------------------------------------------------------ draft resume */
  // A preview starts from a blank form every time — an organizer's own draft on
  // their own call would be a confusing thing to open inside the builder.
  let draft: SubmissionRow | null = null;
  const wanted = preview ? null : c.req.query('draft');
  if (wanted) {
    const sub = await one<SubmissionRow>(c.env.DB, `SELECT * FROM submissions WHERE id = ?`, wanted);
    if (sub && sub.form_id === loaded.form.id && sub.status === 'draft' && canAccess(sub, user, cookies)) {
      draft = sub;
      rememberDraft(c, sub.id, cookies);
    }
  }
  if (!preview && !draft && user) {
    draft = await one<SubmissionRow>(
      c.env.DB,
      `SELECT * FROM submissions WHERE form_id = ? AND owner_user_id = ? AND status = 'draft' ORDER BY updated_at DESC LIMIT 1`,
      loaded.form.id,
      user.id
    );
  }
  if (!preview && !draft && cookies.length) {
    draft = await one<SubmissionRow>(
      c.env.DB,
      `SELECT * FROM submissions WHERE form_id = ? AND status = 'draft' AND id IN (${cookies.map(() => '?').join(',')})
        ORDER BY updated_at DESC LIMIT 1`,
      loaded.form.id,
      ...cookies
    );
  }

  const answers = draft ? jsonParse<Answers>(draft.answers_json, {}) : {};
  const speakers = draft ? await speakersOf(c.env.DB, draft.id) : [];

  // `?welcome=1` is the back link's no-JS fallback — it wins over both the
  // `?start=1` and the resumed-draft suppressions.
  const showWelcome =
    settings.welcomeEnabled &&
    !!settings.welcomeMd &&
    (c.req.query('welcome') === '1' || (!c.req.query('start') && !draft));

  return c.html(
    renderPage({
      event: found.event,
      theme: found.theme,
      form: loaded.form,
      settings,
      schema,
      filesOn: filesEnabled(c.env),
      late: !preview && state.late,
      showWelcome,
      // Previewing renders the first-time visitor's view, not the organizer's:
      // the email block is part of what they're checking.
      user: preview ? null : user,
      preview,
      toast: c.req.query('ok') ?? null,
      state: {
        answers,
        speakers,
        agentMode: !!draft?.agent_mode,
        errors: {},
        errorList: [],
        tried: false,
        draftId: draft?.id ?? null,
        email: '',
      },
    })
  );
});

/* ------------------------------------------------------------------ POST submit */

function vals(body: Record<string, unknown>, key: string): string[] {
  const raw = body[key] !== undefined ? body[key] : body[`${key}[]`];
  if (raw === undefined || raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((v): v is string => typeof v === 'string');
}

function answersFromBody(fields: FormField[], body: Record<string, unknown>): Answers {
  const answers: Answers = {};
  for (const f of fields) {
    if (f.type === 'HDR' || f.type === 'GRP') continue;
    const got = vals(body, `f_${f.id}`);
    switch (f.type) {
      case 'MULTI':
        answers[f.id] = got;
        break;
      case 'CHK':
        answers[f.id] = got.length > 0;
        break;
      case 'FILE':
        answers[f.id] = (got[0] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'URL':
        answers[f.id] = got[0] ? normalizeUrl(got[0]) : '';
        break;
      default:
        answers[f.id] = got[0] ?? '';
    }
  }
  return answers;
}

function speakersFromBody(body: Record<string, unknown>): SpeakerInput[] {
  const names = vals(body, 'sp_name');
  const emails = vals(body, 'sp_email');
  const bios = vals(body, 'sp_bio');
  const jobTitles = vals(body, 'sp_job_title');
  const companies = vals(body, 'sp_company');
  const taglines = vals(body, 'sp_tagline');
  const roles = vals(body, 'sp_role');
  const heads = vals(body, 'sp_headshot');
  const linkCols = {
    linkedin: vals(body, 'sp_link_linkedin'),
    x: vals(body, 'sp_link_x'),
    website: vals(body, 'sp_link_website'),
    other: vals(body, 'sp_link_other'),
  };
  const n = Math.max(names.length, emails.length, bios.length, heads.length);
  const out: SpeakerInput[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      name: (names[i] ?? '').trim(),
      email: (emails[i] ?? '').trim(),
      bio: (bios[i] ?? '').trim(),
      jobTitle: (jobTitles[i] ?? '').trim(),
      company: (companies[i] ?? '').trim(),
      tagline: (taglines[i] ?? '').trim(),
      role: normalizeRole(roles[i]),
      links: sanitizeLinks({
        linkedin: linkCols.linkedin[i],
        x: linkCols.x[i],
        website: linkCols.website[i],
        other: linkCols.other[i],
      }),
      headshotFileId: heads[i] || null,
    });
  }
  // Trailing blank cards are ignored (the island can leave one behind).
  while (out.length > 1 && !out[out.length - 1].name && !out[out.length - 1].email) out.pop();
  return out;
}

app.post('/:event/:form', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const loaded = await loadForm(c.env.DB, found.event.id, c.req.param('form'));
  if (!loaded) return c.notFound();

  // A preview never writes. The island already blocks this; the redirect is the
  // no-JS path, and it lands back on the preview rather than the live form.
  if (c.req.query('preview') === '1') {
    const back = `/${found.event.slug}/${loaded.form.slug}?preview=1`;
    return c.redirect(
      (await previewingAs(c, found.event.org_id))
        ? `${back}&ok=${encodeURIComponent('Preview — nothing was submitted')}`
        : `/${found.event.slug}/${loaded.form.slug}`
    );
  }

  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const taxonomies = await loadTaxonomies(c.env.DB, found.event.id);
  const schema = hydrateSchema(loaded.schema, taxonomies);
  const settings = loaded.settings;
  const fields = schema.fields;

  const state = openState(loaded.form, settings, found.event.timezone, vals(body, 'key')[0] ?? c.req.query('key'));
  if (!state.open) {
    return c.redirect(`/${found.event.slug}/${loaded.form.slug}`);
  }

  const user = c.var.user;
  const cookies = draftIds(c);
  const answers = answersFromBody(fields, body);
  const speakers = speakersFromBody(body);
  const agentMode = vals(body, 'agent_mode').length > 0;
  const email = (vals(body, 'email')[0] ?? '').trim();
  const cap = speakerCap(fields, settings);

  const check = validateSubmission(fields, answers, speakers, { hard: true, speakerCap: cap });
  const errors = { ...check.errors };
  const errorList = [...check.list];
  if (!user && !email && !vals(body, 'submission_id')[0]) {
    errors.email = 'We need an email address to send your confirmation.';
    errorList.unshift('Email — required so we can confirm your submission');
  }

  let draft: SubmissionRow | null = null;
  const draftId = vals(body, 'submission_id')[0];
  if (draftId) {
    const sub = await one<SubmissionRow>(c.env.DB, `SELECT * FROM submissions WHERE id = ?`, draftId);
    if (sub && sub.form_id === loaded.form.id) {
      const ok =
        sub.status === 'draft' ? canAccess(sub, user, cookies) : await canEditSubmission(c.env.DB, sub, user, cookies);
      if (ok) draft = sub;
    }
  }
  // A submitted proposal saves in place; anything else (draft, withdrawn, no id)
  // goes through the submit path below.
  const isEdit = !!draft && EDITABLE_STATUSES.has(draft.status);

  if (errorList.length) {
    return c.html(
      renderPage({
        event: found.event,
        theme: found.theme,
        form: loaded.form,
        settings,
        schema,
        filesOn: filesEnabled(c.env),
        late: state.late,
        showWelcome: false,
        user,
        editing: isEdit && draft ? { seq: draft.seq } : null,
        state: {
          answers,
          speakers,
          agentMode,
          errors,
          errorList,
          tried: true,
          draftId: draft?.id ?? null,
          email,
        },
      }),
      422
    );
  }

  /* ------------------------------------------------------------ persist */
  const owner = user ?? (draft?.owner_user_id
    ? await one<User>(c.env.DB, `SELECT * FROM users WHERE id = ?`, draft.owner_user_id)
    : null) ?? (await findOrCreateUserByEmail(c.env.DB, email || speakers[0]?.email || '', speakers[0]?.name ?? null));

  const roles = coreRoles(fields);
  const cleaned = stripHidden(fields, answers);
  const title = roles.title ? String(cleaned[roles.title.id] ?? '') : speakers[0]?.name ?? '';
  const abstract = roles.abstract ? String(cleaned[roles.abstract.id] ?? '') : '';
  const stamp = now();

  let submissionId: string;
  let seq: number;
  if (isEdit && draft) {
    // Saving an edit rewrites the proposal in place: same SUB number, same
    // status — a decision already made stays made, and no confirmation emails
    // go out again. Only the close date locks editing (checked above).
    submissionId = draft.id;
    seq = draft.seq;
    await run(
      c.env.DB,
      `UPDATE submissions SET title = ?, abstract = ?, answers_json = ?, agent_mode = ?, form_version_id = ?, updated_at = ? WHERE id = ?`,
      title,
      abstract,
      JSON.stringify(cleaned),
      agentMode ? 1 : 0,
      loaded.version.id,
      stamp,
      submissionId
    );
  } else if (draft && draft.status === 'draft') {
    submissionId = draft.id;
    seq = await nextSeq(c.env.DB, found.event.id, 'submission');
    await run(
      c.env.DB,
      `UPDATE submissions SET seq = ?, status = 'in_review', title = ?, abstract = ?, answers_json = ?, owner_user_id = ?,
         agent_mode = ?, form_version_id = ?, submitted_at = ?, updated_at = ? WHERE id = ?`,
      seq,
      title,
      abstract,
      JSON.stringify(cleaned),
      owner.id,
      agentMode ? 1 : 0,
      loaded.version.id,
      stamp,
      stamp,
      submissionId
    );
  } else {
    submissionId = newId('sub');
    seq = await nextSeq(c.env.DB, found.event.id, 'submission');
    await run(
      c.env.DB,
      `INSERT INTO submissions (id, event_id, form_id, form_version_id, seq, status, title, abstract, answers_json,
         owner_user_id, agent_mode, withdraw_reason, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,'in_review',?,?,?,?,?,NULL,?,?,?)`,
      submissionId,
      found.event.id,
      loaded.form.id,
      loaded.version.id,
      seq,
      title,
      abstract,
      JSON.stringify(cleaned),
      owner.id,
      agentMode ? 1 : 0,
      stamp,
      stamp,
      stamp
    );
  }
  // Links validated above, so store them normalized (https:// prepended etc.).
  await writeSpeakers(
    c.env.DB,
    submissionId,
    speakers.map((s) => ({ ...s, links: normalizeLinks(s.links) }))
  );
  rememberDraft(c, submissionId, cookies);

  await logActivity(c.env.DB, {
    eventId: found.event.id,
    subjectType: 'submission',
    subjectId: submissionId,
    actor: owner.name || owner.email,
    action: isEdit ? 'Updated' : 'Submitted',
    detail: `SUB-${seq} · ${loaded.form.name}`,
  });

  if (isEdit) {
    // Everything below is first-submission ceremony (auto-accept, confirmation
    // and notify emails, portal onboarding) — an edit just lands back on the
    // form with the saved values.
    return c.redirect(
      `/${found.event.slug}/${loaded.form.slug}?edit=${submissionId}&ok=${encodeURIComponent('Changes saved')}`
    );
  }

  if (settings.submitsAs === 'session') {
    // B5 (DECISIONS R7): session-intake forms skip the pipeline. The submission
    // is auto-accepted (Session ≠ Submission stays intact, so the drawer and
    // history still work) and the sponsor session is created immediately.
    // No evaluation routing, no decision email — the confirmation email below
    // still goes out.
    await run(c.env.DB, `UPDATE submissions SET status = 'accepted', updated_at = ? WHERE id = ?`, now(), submissionId);
    await logActivity(c.env.DB, {
      eventId: found.event.id,
      subjectType: 'submission',
      subjectId: submissionId,
      actor: 'System',
      action: 'Auto-accepted',
      detail: 'session intake form',
    });
    const companyField = fields.find(
      (f) => f.type === 'TXT' && (f.id === 'f_company' || /company|organi[sz]ation/i.test(f.label))
    );
    const company = companyField ? String(cleaned[companyField.id] ?? '').trim() : '';
    try {
      await createSessionFromSubmission(c.env, submissionId, 'System', {
        type: 'sponsor',
        sponsorName: company || null,
        sessionStatus: 'confirmed',
      });
    } catch (err) {
      console.error('[submit] session-intake session create failed', err);
    }
  }
  // Category routing (spec §4.2) needs no hook since migration 0011: a fresh
  // submission lands in `in_review` already, and evaluation plan membership is
  // rule-derived (`evals.matchesRules`), recomputed on every read. Session-intake
  // forms are auto-accepted above, which is what keeps them out of review.

  /* ------------------------------------------------------------ emails */
  const tpl = await one<{ subject: string; body: string }>(
    c.env.DB,
    `SELECT subject, body FROM email_templates WHERE event_id = ? AND key = 'confirm_submission'`,
    found.event.id
  );
  const portalLink = `${c.env.APP_ORIGIN}/${found.event.slug}/portal`;
  const recipients = new Map<string, string>();
  speakers.forEach((s) => {
    if (s.email) recipients.set(s.email.toLowerCase(), s.name || s.email);
  });
  if (owner.email) recipients.set(owner.email.toLowerCase(), owner.name || owner.email);

  for (const [to, toName] of recipients) {
    const vars = {
      speaker_name: toName,
      session_title: title,
      event_name: found.event.name,
      portal_link: portalLink,
    };
    await sendEmail(c.env, {
      eventId: found.event.id,
      to,
      toName,
      templateKey: 'confirm_submission',
      subject: tpl ? renderTemplate(tpl.subject, vars) : `We’ve got your ${found.event.name} submission`,
      text: tpl
        ? renderTemplate(tpl.body, vars)
        : `Thanks for submitting “${title}” to ${found.event.name}.\n\n${portalLink}`,
      subjectType: 'submission',
      subjectId: submissionId,
    });
  }

  const notify = await notifyRecipients(c.env.DB, found.event.org_id, settings);
  for (const { email: to, name: toName } of notify) {
    await sendEmail(c.env, {
      eventId: found.event.id,
      to,
      toName,
      templateKey: 'submission_notify',
      subject: `New submission — ${title || 'untitled'} (SUB-${seq})`,
      text:
        `${loaded.form.name} received a new submission.\n\n` +
        `SUB-${seq} · ${title}\n${speakers.map((s) => `${s.name} <${s.email}>`).join('\n')}\n\n` +
        `${c.env.APP_ORIGIN}/app/submissions`,
      subjectType: 'submission',
      subjectId: submissionId,
    });
  }

  if (!user && owner.email) {
    if (!owner.password_hash) {
      await requestPasswordReset(c.env, owner.email, {
        eventId: found.event.id,
        next: `/${found.event.slug}/portal`,
        subject: `Your ${found.event.name} speaker portal`,
        text: `Set a password to track “${title}” in your speaker portal.`,
      });
    } else {
      await sendEmail(c.env, {
        eventId: found.event.id,
        to: owner.email,
        toName: owner.name,
        templateKey: 'portal_welcome',
        subject: `Your ${found.event.name} speaker portal`,
        text: `Open your speaker portal to track “${title}”.\n\n${c.env.APP_ORIGIN}/${found.event.slug}/portal`,
        subjectType: 'submission',
        subjectId: submissionId,
      });
    }
  }

  return c.redirect(`/${found.event.slug}/${loaded.form.slug}?submitted=${submissionId}`);
});

export default app;
