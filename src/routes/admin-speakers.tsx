/**
 * `/app/speakers` — Speaker onboarding: the speakers × task-templates grid,
 * the speaker drawer, task-template CRUD, bulk assignment, the file review
 * queue and the ZIP exports.
 *
 * Markup + inline styles ported from `prototype/design_handoff_program/design/Speakers.dc.html`;
 * behaviour from `specs/tasks-spec.md` §4.8.x. Task engine lives in `lib/tasks.ts`,
 * archives in `lib/zip.ts`.
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { FC } from 'hono/jsx';
import type { Ctx } from '../types';
import { AdminLayout, DrawerExpandButton, MONO, STATUS_COLORS } from '../views/layout';
import { adminProps, redirectWithToast } from '../views/chrome';
import { all, one, run, batch, now, jsonParse } from '../lib/db';
import { newId } from '../lib/ids';
import { slugify } from '../lib/slugify';
import { csvHeaders, parseCsvTable, toCsv } from '../lib/csv';
import { LINK_FIELDS, linksJson, normalizeLink, type LinkKey, type SpeakerLinks } from '../lib/speaker-links';
import { requireOrgRole } from '../lib/auth';
import { logActivity } from '../lib/activity';
import {
  listContentVersions,
  recordContentVersion,
  restoreSummary,
  snapshotOf,
  speakerSnapshotOf,
  type SpeakerSnapshot,
  type VersionRow,
} from '../lib/content-versions';
import { sendEmail, renderTemplate } from '../lib/email';
import { filesEnabled, saveUpload } from '../lib/files';
import { zipHeadshots, zipSlides } from '../lib/zip';
import { listReminderQueue, queueTaskReminder } from '../lib/reminder-queue';
import { OUTBOX_SEND_LIMIT } from '../lib/decision-queue';
import * as T from '../lib/tasks';
import { speakerAffiliation } from '../lib/agenda';
import { addContactToEvent, upsertOrgContact } from '../lib/org-contacts';

const app = new Hono<Ctx>();

/* --------------------------------------------------------------- styles */

const LABEL = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;';
const BTN = 'padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const PRIMARY = 'padding:9px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;';
const DIALOG = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;';

/**
 * Page CSS. Every desktop declaration below is byte-for-byte what used to sit
 * inline (or in the JS island's template strings); the `@media (max-width:768px)`
 * half is the phone shape. Classes prefixed `spk-` are page-scoped; the island
 * `public/js/speakers.js` renders the same class names into the speaker drawer,
 * the clause rows and the CSV mapper, so those restack here too.
 *
 * The speakers × task-templates grid is the criterion-7 decision
 * (SPECS/M-mobile.md). It is a matrix: 220px of speaker plus 92px per template
 * plus the done fraction, so six templates need ~950px. Scrolling it sideways
 * on a phone would push the speaker's name off-screen exactly when you are
 * reading their task states — the row header is not sticky — so below 768px a
 * row reflows into a card instead: the speaker on line one with the done
 * fraction beside it, then one labelled chip per task wrapping underneath.
 * Nothing is hidden and nothing scrolls sideways.
 *
 * Both drawers keep their widths here, not inline, so the shared full-screen
 * rule in ADMIN_BASE_CSS can override them.
 */
const PAGE_CSS = `
  .drawer-speaker,.drawer-template{position:fixed;top:0;right:0;bottom:0;max-width:92vw;background:#fff;z-index:70;box-shadow:-12px 0 40px rgba(0,0,0,0.14);display:flex;flex-direction:column;}
  /* The speaker panel re-renders while open, so speakers.js sets its own
     animation inline — only the sizing belongs here. */
  .drawer-speaker{width:440px;}
  .drawer-template{width:480px;animation:slidein 0.18s ease;}

  .spk-page{padding:22px 28px;}
  /* Queued task reminders */
  .spk-rembar{padding:10px 14px;display:flex;align-items:center;gap:12px;font-size:13px;color:#33343c;flex-wrap:wrap;}
  .spk-remsend{padding:8px 16px;}
  .spk-remgroup{display:flex;align-items:center;gap:10px;padding:8px 14px;background:#fafafb;}
  .spk-remrow{display:grid;grid-template-columns:minmax(0,1fr) 78px;gap:10px;padding:6px 14px 6px 28px;align-items:center;}
  .spk-remundo{padding:4px 10px;}
  /* Filter bar */
  .spk-filters{display:flex;gap:6px;margin-bottom:14px;align-items:center;flex-wrap:wrap;}
  .spk-filtersel{padding:6px 8px;}
  .spk-search{width:220px;padding:6px 10px;}
  .spk-chip{padding:6px 11px;}
  .spk-actions{margin-left:auto;display:flex;gap:6px;}
  .spk-action{padding:6px 11px;}
  .spk-action-primary{padding:7px 12px;}
  /* The grid. Column widths are dynamic (one per template) and live in the
     Grid component's own <style>; only the shape-independent parts sit here. */
  .spk-gridhead{display:grid;padding:10px 14px;border-bottom:1px solid #e2e3e8;align-items:end;}
  .spk-gridrow{display:grid;padding:9px 14px;border-bottom:1px solid #f2f3f5;align-items:center;}
  .spk-who{padding-right:10px;cursor:pointer;}
  /* display:contents keeps the cells as direct grid items on desktop, so the
     wrapper costs nothing there and can become the phone's chip row. */
  .spk-cells{display:contents;}
  .spk-cell{text-align:center;}
  .spk-celllbl{display:none;}
  .spk-pager{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid #e2e3e8;}
  .spk-pgbtn{padding:6px 12px;}
  .spk-legend{display:flex;gap:18px;padding:12px 2px;font-size:12px;color:#686b74;align-items:center;}
  /* Task templates */
  .spk-tplpanel{margin-top:16px;background:#fff;border:1px solid #e2e3e8;padding:16px 20px;}
  .spk-tplhead{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
  .spk-tplnew{margin-left:auto;padding:7px 13px;}
  .spk-tplrow{display:flex;gap:8px;align-items:center;}
  .spk-tplname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  /* Template editor drawer */
  .spk-typegrid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;}
  .spk-filegrid{display:grid;grid-template-columns:1.4fr 1fr 0.8fr;gap:8px;}
  .spk-triggrid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}
  .spk-duerow{display:flex;gap:8px;align-items:center;}
  .spk-duesel{flex:1;}
  .spk-duen{width:76px;}
  .spk-gracen{width:64px;}
  .spk-duedate{width:150px;}
  .spk-rembody{margin-left:30px;}
  .spk-remadd{width:220px;}
  .spk-edfoot{padding:14px var(--band-x);border-top:1px solid #e2e3e8;display:flex;gap:8px;align-items:center;}
  /* Dialogs */
  .spk-dialogscrim{padding:20px;}
  .spk-panel{max-width:calc(100vw - 40px);}
  .spk-dialogpad{padding:24px;}
  .spk-dialoghead{padding:18px 24px;}
  .spk-dialogbody{padding:20px 24px;grid-template-columns:minmax(0,1fr);}
  #import-file{max-width:100%;}
  .spk-dialogfootlink{margin-right:auto;}
  .spk-dialogfoot{padding:14px 24px;}
  .spk-emlpanel{width:620px;height:560px;}
  .spk-dirrow{display:grid;grid-template-columns:18px minmax(0,1fr) 140px;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid #f2f3f5;cursor:pointer;}
  /* Rendered by speakers.js */
  .spk-oneoffrow{display:flex;gap:6px;}
  .spk-oodue{width:150px;}
  .spk-clauserow{display:flex;gap:6px;align-items:center;}
  .spk-clausefield{width:126px;flex:none;}
  .spk-maprow{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center;}
  .spk-taskrow{display:flex;align-items:center;gap:8px;}
  .spk-taskshead{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
  .spk-taskname{font-size:13px;}
  .spk-taskacts{display:contents;}
  .spk-taskbtn{padding:4px 9px;}
  .spk-taskx{padding:4px 8px;}
  .spk-restorebtn{padding:4px 10px;}
  .spk-drawerbtn{padding:6px 12px;}
  .spk-assignbtn{padding:7px 13px;}
  .spk-stalebar{bottom:24px;left:24px;}
  .spk-focusbanner{display:flex;align-items:center;gap:10px;}

  @media (max-width:768px){
    .spk-page{padding:14px 14px 28px;}
    .spk-rembar{padding:10px 12px;gap:8px 10px;}
    .spk-remsend{padding:11px 16px;}
    .spk-remgroup{flex-wrap:wrap;gap:4px 10px;padding:10px 12px;}
    .spk-remrow{grid-template-columns:minmax(0,1fr) auto;padding:8px 12px 8px 18px;}
    .spk-remundo{padding:9px 12px;}
    /* Two selects share a row, the search takes its own, the buttons wrap
       under them — the whole bar stays one block instead of a sideways strip. */
    .spk-filters{gap:6px;}
    .spk-filtersel{flex:1 1 calc(50% - 3px);min-width:0;}
    .spk-search{flex:1 0 100%;width:auto;}
    .spk-chip{flex:1 0 100%;padding:10px 11px;}
    .spk-actions{margin-left:0;flex:1 0 100%;flex-wrap:wrap;gap:6px;}
    .spk-action,.spk-action-primary{flex:1 1 auto;padding:11px 10px;text-align:center;}
    .spk-gridhead{display:none;}
    .spk-gridrow{padding:12px 14px;gap:8px 10px;align-items:start;}
    .spk-who{grid-area:who;padding-right:0;padding-bottom:2px;}
    .spk-done{grid-area:done;}
    .spk-cells{grid-area:cells;display:flex;flex-wrap:wrap;gap:6px;}
    .spk-cell{display:inline-flex;align-items:center;gap:6px;text-align:left;border:1px solid #eceded;padding:3px 9px 3px 3px;min-height:34px;max-width:100%;}
    .spk-celllbl{display:block;font-family:${MONO};font-size:10px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .spk-pager{padding:10px 12px;}
    .spk-pgbtn{padding:10px 15px;}
    .spk-legend{flex-wrap:wrap;gap:6px 14px;padding:12px 2px 4px;}
    .spk-tplpanel{padding:14px;}
    .spk-tplhead{flex-wrap:wrap;gap:8px 10px;}
    .spk-tplnew{padding:11px 14px;}
    .spk-tplrow{flex-wrap:wrap;gap:5px 8px;}
    .spk-tplname{flex:1 1 auto;min-width:0;}
    .spk-typegrid{grid-template-columns:repeat(2,1fr);}
    .spk-filegrid{grid-template-columns:1fr;}
    .spk-triggrid{grid-template-columns:1fr;}
    .spk-duerow{flex-wrap:wrap;}
    .spk-duesel{flex:1 0 100%;}
    .spk-duen,.spk-gracen,.spk-duedate{width:auto;flex:1 1 auto;}
    .spk-rembody{margin-left:0;}
    .spk-remadd{width:100%;}
    .spk-edfoot{flex-wrap:wrap;}
    .drawer-speaker .us-icon-btn,.drawer-template .us-icon-btn{padding:11px;}
    .spk-dialogscrim{padding:10px;}
    .spk-panel{max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);overflow-y:auto;}
    .spk-dialogpad{padding:16px;}
    .spk-dialoghead{padding:14px 16px;}
    .spk-dialogbody{padding:16px;}
    .spk-dialogfoot{padding:12px 16px;flex-wrap:wrap;justify-content:flex-end;}
    .spk-dialogfootlink{flex:1 0 100%;margin-right:0;margin-bottom:4px;}
    .spk-emlpanel{width:100%;height:auto;}
    /* Company drops under the name instead of taking a third of a 320px row. */
    .spk-dirrow{grid-template-columns:22px minmax(0,1fr);grid-template-areas:"box who" ". company";gap:2px 10px;padding:10px 12px;}
    .spk-dirbox{grid-area:box;width:20px;height:20px;}
    .spk-dirwho{grid-area:who;}
    .spk-dircompany{grid-area:company;}
    .spk-oneoffrow{flex-wrap:wrap;}
    .spk-oodue{width:auto;flex:1 1 auto;}
    .spk-clauserow{flex-wrap:wrap;}
    .spk-clausefield{width:auto;flex:1 0 100%;}
    .spk-maprow{grid-template-columns:1fr;gap:4px;}
    .spk-taskrow{flex-wrap:wrap;gap:6px 8px;}
    .spk-taskname{flex:1 1 auto;min-width:0;}
    .spk-taskacts{display:flex;flex:1 0 100%;flex-wrap:wrap;justify-content:flex-end;gap:6px;}
    .spk-taskshead{flex-wrap:wrap;gap:6px 8px;}
    .spk-taskbtn,.spk-taskx,.spk-restorebtn{padding:9px 12px;min-height:40px;}
    .spk-taskx{min-width:40px;}
    .spk-drawerbtn{padding:10px 14px;min-height:40px;}
    .spk-assignbtn{padding:11px 14px;min-height:40px;}
    /* Keep the refresh bar clear of the sandbox chip pinned to the bottom. */
    .spk-stalebar{bottom:78px;left:14px;right:14px;}
    .spk-focusbanner{flex-wrap:wrap;gap:6px 10px;}
  }
`;

const CELL_STYLE: Record<string, string> = {
  c: 'background:#2b8a3e;color:#fff;',
  p: 'background:#e2e3e8;color:#9a9da6;',
  o: 'background:#c92a2a;color:#fff;',
  r: 'background:#fdf5dc;border:1px solid #e8d79a;color:#b08800;',
  '-': 'background:#fafafb;border:1px solid #eceded;color:#c9cbd2;',
};
const GLYPH: Record<string, string> = { c: '✓', p: '·', o: '!', r: '⋯', '-': '' };
const TIP: Record<string, string> = {
  c: 'Complete',
  p: 'To do',
  o: 'Overdue',
  r: 'Pending review',
  '-': 'Not assigned',
};

/* ----------------------------------------------------------- page data */

type ProfileRow = {
  id: string;
  name: string;
  email: string;
  bio: string;
  job_title: string | null;
  company: string | null;
  tagline: string | null;
  slug: string;
  headshot_file_id: string | null;
  /** Set by the CSV importer (migration 0019) — organizer-added, no CFP trail. */
  imported_at?: string | null;
};

/** The full row: everything the versioned content snapshot covers, plus drawer extras. */
type FullProfileRow = ProfileRow & {
  tagline: string | null;
  pronouns: string | null;
  links_json: string | null;
  travel_notes: string | null;
  created_at: string;
};

/** Rows for the drawer's VERSION HISTORY panel; `current` = matches the live profile. */
function speakerVersionPayload(versions: VersionRow[], live: FullProfileRow) {
  const liveSnap = speakerSnapshotOf(live);
  const keys = Object.keys(liveSnap) as (keyof SpeakerSnapshot)[];
  return versions.map((v) => {
    const snap = snapshotOf<SpeakerSnapshot>(v, liveSnap);
    return {
      id: v.id,
      editor: v.editor,
      summary: v.summary,
      at: v.created_at,
      name: snap.name,
      current: keys.every((k) => (snap[k] ?? null) === (liveSnap[k] ?? null)),
    };
  });
}

type GridRow = {
  id: string;
  name: string;
  email: string;
  /** "Job title · Company" line (tagline fallback) shown under the name. */
  affiliation: string;
  slug: string;
  session: string;
  status: string;
  /** Speaker confirmed their session — `status` alone can no longer tell you (migration 0011). */
  confirmed: boolean;
  cells: Record<string, string>;
  done: number;
  assigned: number;
};

type PageData = {
  templates: T.TaskTemplateRow[];
  active: T.TaskTemplateRow[];
  rows: GridRow[];
  pendingReview: number;
};

async function loadPage(env: Ctx['Bindings'], eventId: string): Promise<PageData> {
  // `confirmed` is the session's state (migration 0011), so rank it off the
  // session rather than the submission — an accepted-and-confirmed speaker
  // still outranks a merely-accepted one in the grid.
  const [templates, profiles, tasks, links, subs] = await Promise.all([
    all<T.TaskTemplateRow>(
      env.DB,
      `SELECT * FROM task_templates WHERE event_id = ? ORDER BY archived, created_at`,
      eventId
    ),
    all<ProfileRow>(
      env.DB,
      `SELECT id, name, email, bio, job_title, company, tagline, slug, headshot_file_id, imported_at
         FROM speaker_profiles WHERE event_id = ? ORDER BY name`,
      eventId
    ),
    all<T.TaskRow>(
      env.DB,
      `SELECT * FROM tasks WHERE event_id = ? AND status != 'cancelled'`,
      eventId
    ),
    all<{ speaker_profile_id: string; session_id: string; title: string }>(
      env.DB,
      `SELECT ss.speaker_profile_id, ss.session_id, s.title
         FROM session_speakers ss JOIN sessions s ON s.id = ss.session_id
        WHERE s.event_id = ? ORDER BY ss.position`,
      eventId
    ),
    all<{ email: string; status: string; title: string; confirmed: number }>(
      env.DB,
      `SELECT sp.email AS email, s.status AS status, s.title AS title,
              EXISTS (SELECT 1 FROM sessions se WHERE se.submission_id = s.id AND se.status = 'confirmed') AS confirmed
         FROM submission_speakers sp JOIN submissions s ON s.id = sp.submission_id
        WHERE s.event_id = ?`,
      eventId
    ),
  ]);
  const active = templates.filter((t) => !t.archived);

  const sessionsOf = new Map<string, { ids: Set<string>; title: string }>();
  for (const l of links) {
    const e = sessionsOf.get(l.speaker_profile_id) ?? { ids: new Set<string>(), title: '' };
    e.ids.add(l.session_id);
    if (!e.title) e.title = l.title;
    sessionsOf.set(l.speaker_profile_id, e);
  }
  const subOf = new Map<string, { status: string; title: string; confirmed: boolean }>();
  for (const s of subs) {
    const key = s.email.toLowerCase();
    const prev = subOf.get(key);
    const rank = (st: string, conf: boolean) => (conf ? 3 : st === 'accepted' ? 2 : 1);
    const confirmed = !!s.confirmed;
    if (!prev || rank(s.status, confirmed) > rank(prev.status, prev.confirmed)) {
      subOf.set(key, { status: s.status, title: s.title, confirmed });
    }
  }

  const today = T.todayISO();
  const pendingReview = T.dedupeTasks(tasks).filter((t) => t.status === 'pending_review').length;
  const rows: GridRow[] = [];
  for (const p of profiles) {
    const mySessions = sessionsOf.get(p.id);
    const mine = T.dedupeTasks(
      tasks.filter((t) => t.speaker_profile_id === p.id || (t.session_id && mySessions?.ids.has(t.session_id)))
    );
    const sub = subOf.get(p.email.toLowerCase());
    const onboarding = sub?.status === 'accepted';
    // CSV-imported speakers have no CFP trail and start with no tasks — list
    // them anyway, or the import would appear to have done nothing.
    if (!mine.length && !onboarding && !p.imported_at) continue;

    const cells: Record<string, string> = {};
    let done = 0;
    let assigned = 0;
    for (const tpl of active) {
      const task = mine.find((t) => t.template_id === tpl.id);
      const state = task ? T.cellState(task, today) : '-';
      cells[tpl.id] = state;
      if (state !== '-') assigned++;
      if (state === 'c') done++;
    }
    rows.push({
      id: p.id,
      name: p.name,
      email: p.email,
      affiliation: speakerAffiliation(p),
      slug: p.slug,
      session: mySessions?.title ?? sub?.title ?? '',
      status: sub?.status ?? '',
      confirmed: sub?.confirmed ?? false,
      cells,
      done,
      assigned,
    });
  }
  return { templates, active, rows, pendingReview };
}

/* ------------------------------------------------------------ fragments */

const Grid: FC<{ data: PageData }> = ({ data }) => {
  const n = data.active.length;
  const minW = 320 + 92 * n + 72;
  /**
   * The only column-shaped rules — one track per template, so they cannot live
   * in the static PAGE_CSS. The phone block turns the same two elements into
   * the card: the head disappears (each chip carries its own label) and the row
   * becomes a two-area block, speaker beside the fraction, chips underneath.
   */
  const gridCss = `
    .spk-gridhead,.spk-gridrow{grid-template-columns:220px repeat(${n},minmax(92px,1fr)) 72px;min-width:${minW}px;}
    @media (max-width:768px){
      .spk-gridrow{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"who done" "cells cells";min-width:0;}
    }
  `;
  const PAGE = 8;

  return (
    <div class="us-scroll-x" style="background:#fff;border:1px solid #e2e3e8;">
      <style>{raw(gridCss)}</style>
      <div class="spk-gridhead" style={`font-family:${MONO};font-size:10px;letter-spacing:0.06em;color:#9a9da6;`}>
        <div>SPEAKER</div>
        {data.active.map((t) => (
          <div data-tpl-head={t.id} title="Edit template" style="text-align:center;line-height:1.3;cursor:pointer;">
            <div>{t.name.toUpperCase()}</div>
            {t.target === 'session' ? <div style="color:#c9cbd2;font-size:9px;margin-top:1px;">SESSION</div> : null}
          </div>
        ))}
        <div style="text-align:right;">DONE</div>
      </div>
      <div id="grid-body">
        {data.rows.map((r, i) => (
          <div
            class="spk-gridrow"
            style={i >= PAGE ? 'display:none;' : ''}
            data-row
            data-id={r.id}
            data-name={r.name}
            data-session={r.session}
            data-status={r.status}
            data-confirmed={r.confirmed ? '1' : ''}
            data-cells={data.active.map((t) => `${t.id}:${r.cells[t.id]}`).join(',')}
          >
            <div data-open-speaker={r.id} class="spk-who" title="Open speaker profile">
              <div style="font-size:13px;font-weight:600;">{r.name}</div>
              {r.affiliation ? (
                <div style="font-size:11px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {r.affiliation}
                </div>
              ) : null}
              <div style="font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                {r.session}
              </div>
            </div>
            <div class="spk-cells">
              {data.active.map((t) => {
                const s = r.cells[t.id];
                return (
                  <div class="spk-cell" title={`${t.name}: ${TIP[s]}`}>
                    <span
                      style={`display:inline-grid;place-items:center;width:26px;height:26px;font-size:13px;flex:none;${CELL_STYLE[s]}font-family:${MONO};`}
                    >
                      {GLYPH[s]}
                    </span>
                    <span class="spk-celllbl">{t.name}</span>
                  </div>
                );
              })}
            </div>
            <div
              class="spk-done"
              style={`text-align:right;font-family:${MONO};font-size:12px;color:${
                r.assigned && r.done === r.assigned ? '#2b8a3e' : Object.values(r.cells).includes('o') ? '#c92a2a' : '#686b74'
              };font-weight:600;`}
            >
              {`${r.done}/${r.assigned}`}
            </div>
          </div>
        ))}
      </div>
      <div id="grid-empty" hidden style="padding:28px 14px;text-align:center;font-size:13px;color:#9a9da6;">
        No speakers match this view.
      </div>
      <div class="spk-pager">
        <div id="page-info" style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
          {`${data.rows.length ? 1 : 0}–${Math.min(PAGE, data.rows.length)} OF ${data.rows.length}`}
        </div>
        <div style="margin-left:auto;display:flex;gap:6px;">
          <button id="pg-prev" class="spk-pgbtn" style="font-size:12px;border:1px solid #e2e3e8;background:#fff;color:#c9cbd2;cursor:default;">
            ← Prev
          </button>
          <button
            id="pg-next"
            class="spk-pgbtn"
            style={`font-size:12px;border:1px solid #e2e3e8;background:#fff;${
              data.rows.length > PAGE ? 'color:#33343c;cursor:pointer;' : 'color:#c9cbd2;cursor:default;'
            }`}
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
};

const TemplateCards: FC<{ data: PageData }> = ({ data }) => {
  const archived = data.templates.length - data.active.length;
  const ordered = [...data.active, ...data.templates.filter((t) => t.archived)];
  return (
    <div class="spk-tplpanel">
      <div class="spk-tplhead">
        <div style={LABEL}>
          {`TASK TEMPLATES · ${data.active.length} ACTIVE${archived ? ` · ${archived} ARCHIVED` : ''}`}
        </div>
        <button
          id="new-tpl"
          class="spk-tplnew"
          style="background:#4c5fd5;color:#fff;border:none;font-size:12.5px;font-weight:600;cursor:pointer;"
        >
          ＋ New template
        </button>
      </div>
      <div style="display:grid;grid-template-columns:1fr;gap:8px;">
        {ordered.map((t) => (
          <div
            data-tpl-card={t.id}
            style={`border:1px solid #eceded;padding:10px 12px;cursor:pointer;${t.archived ? 'opacity:0.55;' : ''}`}
          >
            <div class="spk-tplrow">
              <span style={`font-family:${MONO};font-size:9px;background:#eef0fb;color:#4c5fd5;padding:2px 6px;font-weight:600;flex:none;`}>
                {T.TYPE_LABEL[t.type]}
              </span>
              <span class="spk-tplname" style="font-size:13px;font-weight:600;">
                {t.name}
              </span>
              {t.required ? (
                <span style={`font-family:${MONO};font-size:9px;color:#b08800;flex:none;`}>REQ</span>
              ) : null}
              <span style={`margin-left:auto;font-family:${MONO};font-size:9px;color:#9a9da6;flex:none;`}>
                {(t.target === 'session' ? 'SESSION' : 'SPEAKER') + (t.archived ? ' · ARCHIVED' : '')}
              </span>
            </div>
            <div style="font-size:11.5px;color:#9a9da6;margin-top:4px;">{T.dueDesc(t)}</div>
            <div style={`font-family:${MONO};font-size:10px;color:#4c5fd5;margin-top:3px;`}>{T.ruleDesc(t)}</div>
          </div>
        ))}
        {ordered.length ? null : (
          <div style="font-size:13px;color:#9a9da6;padding:6px 0;">
            No task templates yet — create one to start the onboarding checklist.
          </div>
        )}
      </div>
    </div>
  );
};

const Segmented: FC<{ name: string; options: [string, string][] }> = ({ name, options }) => (
  <>
    {options.map(([value, label]) => (
      <button type="button" data-seg={name} data-value={value} style="padding:8px 6px;font-size:12px;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#33343c;">
        {label}
      </button>
    ))}
  </>
);

/** The template editor drawer — one server-rendered shell, driven by speakers.js. */
const EditorDrawer: FC<{ files: boolean }> = ({ files }) => (
  <div id="editor" data-drawer hidden>
    <div data-close-editor style="position:fixed;inset:0;background:rgba(22,23,29,0.28);z-index:60;"></div>
    <div class="us-drawer-panel drawer-template">
      <div style="padding:16px var(--band-x);border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;">
        <div id="ed-title" style={LABEL}>
          NEW TASK TEMPLATE
        </div>
        <div style="margin-left:auto;display:flex;align-items:center;gap:4px;">
          <DrawerExpandButton />
          <button data-close-editor class="us-icon-btn" aria-label="Close" style="font-size:18px;line-height:1;">
            ×
          </button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:20px var(--band-x);display:flex;flex-direction:column;gap:28px;">
        <div style="display:grid;gap:12px;">
          <div>
            <div style={`${LABEL}margin-bottom:6px;`}>NAME</div>
            <input id="ed-name" placeholder="e.g. Extended bio" style={INPUT} />
          </div>
          <div>
            <div style={`${LABEL}margin-bottom:6px;`}>DESCRIPTION</div>
            <textarea id="ed-desc" rows={3} style={`${INPUT}resize:vertical;`}></textarea>
            <div style="font-size:11px;color:#9a9da6;margin-top:5px;line-height:1.45;">
              Personalize with {'{{speaker_name}}'}, {'{{session_title}}'}, {'{{session_slot}}'} or any form field by
              reference. Uses the same variables as email templates.
            </div>
          </div>
        </div>
        <div>
          <div style={`${LABEL}margin-bottom:6px;`}>TYPE</div>
          <div class="spk-typegrid">
            <Segmented
              name="type"
              options={[
                ['checkbox', 'Checkbox'],
                ['file', 'File request'],
                ['form', 'Form'],
                ['profile', 'Profile'],
              ]}
            />
          </div>
          <div id="ed-check" hidden style="margin-top:10px;">
            <div style={`${LABEL}margin-bottom:6px;`}>EXTERNAL LINK · OPTIONAL</div>
            <input
              id="ed-link"
              placeholder="https://av-portal.example.com/?talk={{session_id}}"
              style={`${INPUT}font-size:12px;font-family:${MONO};`}
            />
          </div>
          <div id="ed-file" hidden style="margin-top:10px;display:grid;gap:10px;">
            <div class="spk-filegrid">
              <div>
                <div style={`${LABEL}margin-bottom:6px;`}>ALLOWED TYPES</div>
                <input id="ed-ext" placeholder="pdf, key" style={INPUT} />
              </div>
              <div>
                <div style={`${LABEL}margin-bottom:6px;`}>SIZE CAP</div>
                <select id="ed-cap" style={INPUT}>
                  <option value="25">25 MB</option>
                  <option value="100">100 MB</option>
                  <option value="250">250 MB</option>
                </select>
              </div>
              <div>
                <div style={`${LABEL}margin-bottom:6px;`}>MAX FILES</div>
                <input id="ed-maxn" type="number" min="1" style={INPUT} />
              </div>
            </div>
            <div>
              <div style={`${LABEL}margin-bottom:6px;`}>SAMPLE / TEMPLATE FILE</div>
              <div id="ed-sample-on" hidden style="display:flex;align-items:center;gap:8px;border:1px solid #e2e3e8;padding:7px 10px;">
                <span id="ed-sample-name" style={`font-family:${MONO};font-size:11.5px;`}></span>
                <button id="ed-sample-rm" type="button" style="margin-left:auto;background:none;border:none;color:#9a9da6;cursor:pointer;font-size:14px;padding:0;">
                  ×
                </button>
              </div>
              <label
                id="ed-sample-off"
                title={files ? '' : 'File storage not yet enabled'}
                style={`display:inline-block;padding:7px 12px;background:#fff;border:1px dashed #c9cbd2;font-size:12px;color:#686b74;cursor:${
                  files ? 'pointer' : 'not-allowed'
                };`}
              >
                ＋ Attach a sample file (“use this slide template”)
                <input id="ed-sample-input" type="file" hidden disabled={!files} />
              </label>
            </div>
            <div id="ed-review-row" style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;">
              <span id="ed-review-box" data-box="review"></span>
              <div>
                <div style="font-size:13px;font-weight:600;">Requires review</div>
                <div style="font-size:11.5px;color:#9a9da6;line-height:1.45;">
                  Uploads are marked as pending review. Approvals or requests for changes will email the speaker.
                </div>
              </div>
            </div>
          </div>
          <div id="ed-form" hidden style="margin-top:10px;">
            <div style={`${LABEL}margin-bottom:6px;`}>MINI-FORM</div>
            <select id="ed-formspec" style={INPUT}>
              {T.MINI_FORM_NAMES.map((n) => (
                <option value={n}>{n}</option>
              ))}
              <option value="__new">＋ New mini-form…</option>
            </select>
            <div style="font-size:11px;color:#9a9da6;margin-top:4px;">
              Fields, validation, conditional logic.
            </div>
            <div id="ed-formbuilder" hidden style="margin-top:10px;border:1px solid #e2e3e8;padding:10px 12px;display:grid;gap:8px;">
              <div style={LABEL}>NEW MINI-FORM · UP TO 3 FIELDS</div>
              <input id="ed-formname" placeholder="Mini-form name" style={INPUT} />
              {[0, 1, 2].map((i) => (
                <div style="display:flex;gap:6px;">
                  <select data-mf-type={String(i)} style="width:96px;flex:none;padding:8px 6px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;">
                    <option value="TXT">Text</option>
                    <option value="LONG">Long</option>
                    <option value="SEL">Select</option>
                    <option value="CHK">Checkbox</option>
                  </select>
                  <input data-mf-label={String(i)} placeholder={i === 0 ? 'Field label' : 'Field label (optional)'} style={INPUT} />
                </div>
              ))}
              <div style="font-size:11px;color:#9a9da6;">
                Select fields take comma-separated options in the label after a colon — “T-shirt size: S, M, L”.
              </div>
            </div>
          </div>
          <div id="ed-profile" hidden style="margin-top:10px;background:#f4f4f6;padding:10px 12px;font-size:12px;color:#686b74;line-height:1.5;">
            Auto-completes when the required profile fields are filled.
          </div>
        </div>
        <div>
          <div style={`${LABEL}margin-bottom:6px;`}>TARGET</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <button type="button" data-seg="target" data-value="speaker" style="padding:9px 10px;text-align:left;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#16171d;">
              <div style="font-weight:600;font-size:12.5px;">Speaker</div>
              <div style="font-size:10.5px;color:#9a9da6;margin-top:2px;line-height:1.35;">
                One instance per speaker.
              </div>
            </button>
            <button type="button" data-seg="target" data-value="session" style="padding:9px 10px;text-align:left;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#16171d;">
              <div style="font-weight:600;font-size:12.5px;">Session</div>
              <div style="font-size:10.5px;color:#9a9da6;margin-top:2px;line-height:1.35;">
                One per session; any co-speaker completes it.
              </div>
            </button>
          </div>
        </div>
        <div style="display:grid;gap:4px;">
          <div data-flag-row="required" style="display:flex;gap:10px;align-items:center;cursor:pointer;padding:5px 0;">
            <span data-box="required"></span>
            <div>
              <div style="font-size:13px;font-weight:600;">Required</div>
            </div>
          </div>
          <div data-flag-row="lock" style="display:flex;gap:10px;align-items:center;cursor:pointer;padding:5px 0;">
            <span data-box="lock"></span>
            <div>
              <div style="font-size:13px;font-weight:600;">Lock on complete</div>
              <div style="font-size:11.5px;color:#9a9da6;line-height:1.45;">
                Once completed (or approved), the speaker can no longer change this field. Often used for legal docs or
                final print assets.
              </div>
            </div>
          </div>
        </div>
        <div>
          <div style={`${LABEL}margin-bottom:6px;`}>ASSIGNMENT</div>
          <div class="spk-triggrid">
            <Segmented
              name="trigger"
              options={[
                ['confirmation', 'On confirmation'],
                ['acceptance', 'On acceptance'],
                ['manual', 'Manual only'],
              ]}
            />
          </div>
          <div id="ed-clauses-wrap" style="margin-top:10px;display:grid;gap:6px;">
            <div style={LABEL}>ONLY WHEN · OPTIONAL</div>
            <div id="ed-clauses" style="display:grid;gap:6px;"></div>
            <button id="ed-add-clause" type="button" style="justify-self:start;padding:6px 11px;background:#fff;border:1px dashed #c9cbd2;font-size:12px;color:#686b74;cursor:pointer;">
              ＋ Add clause
            </button>
          </div>
          {/* Live rule-match count (speakers.js) — a clause typo shows up here, not weeks later. */}
          <div id="ed-match" hidden style={`font-family:${MONO};font-size:11px;color:#686b74;margin-top:8px;`}></div>
        </div>
        <div id="ed-due-wrap">
          <div style={`${LABEL}margin-bottom:6px;`}>DUE</div>
          <div class="spk-duerow">
            <select id="ed-duemode" class="spk-duesel" style={INPUT}>
              <option value="after">Days after assignment</option>
              <option value="before">Days before event start</option>
              <option value="abs">Absolute date</option>
            </select>
            <input id="ed-duen" type="number" min="0" class="spk-duen" style="padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;" />
            <input id="ed-duedate" type="date" hidden class="spk-duedate" style="padding:7px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;" />
          </div>
          <div class="spk-duerow" style="margin-top:8px;">
            <select id="ed-grace" class="spk-duesel" style={INPUT}>
              <option value="none">Past due: stays completable (default)</option>
              <option value="lock">Past due: lock after grace period</option>
            </select>
            <input id="ed-gracen" type="number" min="0" hidden class="spk-gracen" style="padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;" />
            <span id="ed-gracen-label" hidden style="font-size:12px;color:#9a9da6;">
              days
            </span>
          </div>
        </div>
        <div id="ed-rem-wrap">
          <div style={`${LABEL}margin-bottom:8px;`}>DEADLINE REMINDERS</div>
          <div id="ed-rem-row" style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;">
            <span data-box="remOn"></span>
            <div>
              <div style="font-size:13px;font-weight:600;">Email speakers before the due date</div>
              <div style="font-size:11.5px;color:#9a9da6;line-height:1.45;">
                Sends only while the task is open. Every send lands in the email log.
              </div>
            </div>
          </div>
          <div id="ed-rem-body" class="spk-rembody" style="margin-top:12px;display:grid;gap:14px;">
            <div>
              <div style={`${LABEL}margin-bottom:6px;`}>SCHEDULE</div>
              <select id="ed-rem-add" class="spk-remadd" style="padding:7px 8px;border:1px solid #e2e3e8;font-size:12px;background:#fff;color:#686b74;cursor:pointer;">
                <option value="">＋ Add reminder…</option>
              </select>
              <div id="ed-rem-days" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px;"></div>
              <div id="ed-rem-none" hidden style="font-size:11.5px;color:#b08800;margin-top:6px;">
                Add a reminder, or turn reminders off.
              </div>
            </div>
            <div>
              <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;">
                <div style={LABEL}>REMINDER EMAIL</div>
                <span id="ed-rem-custom" hidden style={`font-family:${MONO};font-size:9px;color:#4c5fd5;`}>
                  CUSTOMIZED
                </span>
                <button id="ed-rem-reset" hidden type="button" style="background:none;border:none;color:#4c5fd5;font-size:11.5px;cursor:pointer;text-decoration:underline;padding:0;">
                  Reset to default
                </button>
                <button id="eml-open" type="button" style="margin-left:auto;background:none;border:none;padding:0;color:#4c5fd5;font-size:11.5px;cursor:pointer;text-decoration:underline;">
                  Open editor ↗
                </button>
              </div>
              <input id="ed-rem-subj" title="Subject line" style={`${INPUT}border-bottom:none;font-size:12.5px;font-weight:600;`} />
              <textarea id="ed-rem-body-text" rows={9} style={`${INPUT}font-size:12.5px;resize:vertical;line-height:1.5;display:block;`}></textarea>
            </div>
          </div>
        </div>
      </div>
      <div class="spk-edfoot">
        <button id="ed-save" style={PRIMARY}>
          Create template
        </button>
        <button data-close-editor style={BTN}>
          Cancel
        </button>
        <button id="ed-archive" hidden style="margin-left:auto;background:none;border:none;color:#c92a2a;font-size:12.5px;cursor:pointer;text-decoration:underline;padding:0;">
          Archive template
        </button>
      </div>
    </div>
  </div>
);

/**
 * Speaker CSV import. Same three beats as the submissions importer — pick a
 * file, map the columns, review the count — driven by speakers.js against
 * `/app/api/speakers/import`.
 */
const ImportDialog: FC = () => (
  <div id="import-modal" data-dialog hidden class="spk-dialogscrim" style={DIALOG}>
    <div class="spk-panel" style="background:#fff;width:560px;max-height:88vh;display:flex;flex-direction:column;">
      <div class="spk-dialoghead" style="border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
        <div style="font-size:16px;font-weight:700;">Import speakers from CSV</div>
        <button
          type="button"
          data-dialog-close="#import-modal"
          style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
        >
          ×
        </button>
      </div>
      <div class="spk-dialogbody" style="display:grid;gap:16px;overflow-y:auto;">
        <div>
          <div style={`${LABEL}margin-bottom:6px;`}>CSV FILE</div>
          <input type="file" id="import-file" accept=".csv,text/csv" style="font-size:13px;" />
          <div style="font-size:12.5px;color:#686b74;margin-top:6px;line-height:1.5;">
            First row is the header. Speakers are matched by <strong>email</strong>, so a row that matches an existing
            speaker updates them instead of adding a duplicate.
          </div>
        </div>
        <div id="import-mapping-wrap" hidden>
          <div style={`${LABEL}margin-bottom:8px;`}>MAP COLUMNS</div>
          <div id="import-mapping" style="display:grid;gap:6px;"></div>
        </div>
        <div id="import-preview" hidden style="background:#f8f8fa;border:1px solid #e2e3e8;padding:10px 14px;font-size:12.5px;color:#686b74;line-height:1.5;"></div>
      </div>
      <div class="spk-dialogfoot" style="border-top:1px solid #e2e3e8;display:flex;gap:8px;align-items:center;">
        <a href="/app/speakers/import-template.csv" class="spk-dialogfootlink" style="font-size:12px;color:#4c5fd5;">
          Download a template CSV
        </a>
        <button type="button" data-dialog-close="#import-modal" style={BTN}>
          Cancel
        </button>
        <button type="button" id="import-run" disabled style={`${PRIMARY}background:#e2e3e8;color:#9a9da6;cursor:default;`}>
          Import
        </button>
      </div>
    </div>
  </div>
);

/* ------------------------------------------------- add from directory */

/** Rows listed in the picker. Longer directories are cut off with a note. */
const DIRECTORY_LIST_LIMIT = 200;
/** Contacts added per request, to stay inside the subrequest budget. */
const DIRECTORY_ADD_MAX = 100;

type DirectoryCandidate = { id: string; name: string; email: string; company: string };

/**
 * Org contacts who are not speakers in this event yet. Matched by email,
 * case-insensitive, the same natural key `speaker_profiles` uses.
 */
async function directoryCandidates(
  db: D1Database,
  orgId: string,
  eventId: string
): Promise<{ rows: DirectoryCandidate[]; more: boolean }> {
  const rows = await all<DirectoryCandidate>(
    db,
    `SELECT id, name, email, company FROM org_contacts
      WHERE org_id = ?
        AND lower(email) NOT IN (SELECT lower(email) FROM speaker_profiles WHERE event_id = ?)
      ORDER BY name COLLATE NOCASE
      LIMIT ?`,
    orgId,
    eventId,
    DIRECTORY_LIST_LIMIT + 1
  );
  return { rows: rows.slice(0, DIRECTORY_LIST_LIMIT), more: rows.length > DIRECTORY_LIST_LIMIT };
}

/**
 * Pick contacts from the org directory and add them to this event as speaker
 * profiles. A plain form POST, so it works without JavaScript; speakers.js only
 * adds the filter box.
 */
const DirectoryDialog: FC<{ rows: DirectoryCandidate[]; more: boolean }> = ({ rows, more }) => (
  <div id="dlg-directory" data-dialog hidden class="spk-dialogscrim" style={DIALOG}>
    <form
      method="post"
      action="/app/speakers/add-from-directory"
      class="spk-panel"
      style="background:#fff;width:560px;max-height:88vh;display:flex;flex-direction:column;"
    >
      <div class="spk-dialoghead" style="border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
        <div style="font-size:16px;font-weight:700;">Add from directory</div>
        <button
          type="button"
          data-dialog-close="#dlg-directory"
          style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
        >
          ×
        </button>
      </div>
      <div class="spk-dialogbody" style="display:grid;gap:12px;overflow-y:auto;">
        {rows.length ? (
          <>
            <div style="font-size:12.5px;color:#686b74;line-height:1.5;">
              Contacts in your organization who are not speakers in this event yet.
            </div>
            <input id="dir-q" type="search" placeholder="Filter by name, email or company…" style={INPUT} />
            <div style="border:1px solid #e2e3e8;max-height:300px;overflow-y:auto;">
              {rows.map((r) => (
                <label
                  data-dir-row
                  class="spk-dirrow"
                  data-search={`${r.name} ${r.email} ${r.company}`.toLowerCase()}
                >
                  <input type="checkbox" name="ids" value={r.id} class="spk-dirbox" style="cursor:pointer;" />
                  <div class="spk-dirwho" style="min-width:0;">
                    <div style="font-size:13px;color:#16171d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                      {r.name}
                    </div>
                    <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                      {r.email}
                    </div>
                  </div>
                  <div class="spk-dircompany" style="font-size:12px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    {r.company}
                  </div>
                </label>
              ))}
            </div>
            <div id="dir-empty" hidden style="font-size:12.5px;color:#9a9da6;">
              No contact matches that filter.
            </div>
            {more ? (
              <div style="font-size:11.5px;color:#9a9da6;line-height:1.45;">
                {`Showing the first ${DIRECTORY_LIST_LIMIT} contacts. Use the directory to add the rest.`}
              </div>
            ) : null}
            <div style="font-size:11.5px;color:#9a9da6;line-height:1.45;">
              {`Up to ${DIRECTORY_ADD_MAX} contacts per add.`}
            </div>
          </>
        ) : (
          <div style="font-size:12.5px;color:#686b74;line-height:1.5;">
            Every contact in the directory is already a speaker in this event.
          </div>
        )}
      </div>
      <div class="spk-dialogfoot" style="border-top:1px solid #e2e3e8;display:flex;gap:8px;align-items:center;">
        <a href="/app/org/contacts" class="spk-dialogfootlink" style="font-size:12px;color:#4c5fd5;">
          Open the directory
        </a>
        <button type="button" data-dialog-close="#dlg-directory" style={BTN}>
          Cancel
        </button>
        <button type="submit" disabled={!rows.length} style={PRIMARY}>
          Add selected
        </button>
      </div>
    </form>
  </div>
);

const Dialogs: FC<{ eventName: string; userEmail: string }> = ({ eventName, userEmail }) => (
  <>
    {/* apply-to-open-instances */}
    <div id="dlg-apply" data-dialog hidden class="spk-dialogscrim" style={DIALOG}>
      <div class="spk-dialogpad spk-panel" style="background:#fff;width:460px;">
        <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Apply changes to open instances?</div>
        <div id="apply-copy" style="font-size:13px;color:#686b74;line-height:1.55;margin-bottom:14px;"></div>
        <div style="display:grid;gap:8px;margin-bottom:16px;">
          <div data-apply="future" style="border:1px solid #4c5fd5;background:#eef0fb;padding:11px 13px;cursor:pointer;">
            <div style="font-size:13px;font-weight:600;">Future assignments only</div>
            <div id="apply-future-sub" style="font-size:11.5px;color:#9a9da6;margin-top:2px;line-height:1.4;"></div>
          </div>
          <div data-apply="open" style="border:1px solid #e2e3e8;background:#fff;padding:11px 13px;cursor:pointer;">
            <div id="apply-open-label" style="font-size:13px;font-weight:600;">Also update open instances</div>
            <div style="font-size:11.5px;color:#9a9da6;margin-top:2px;line-height:1.4;">
              Open instances get the new wording now. Completed instances never change.
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <div style={`margin-right:auto;font-family:${MONO};font-size:10px;color:#9a9da6;`}>LOGGED IN ACTIVITY</div>
          <button data-dialog-close="#dlg-apply" style={BTN}>
            Cancel
          </button>
          <button id="apply-go" style={PRIMARY}>
            Apply
          </button>
        </div>
      </div>
    </div>

    {/* post-create “assign now?” offer — N existing speakers match the new rule (speakers.js) */}
    <div id="dlg-bulk" data-dialog hidden class="spk-dialogscrim" style={DIALOG}>
      <div class="spk-dialogpad spk-panel" style="background:#fff;width:480px;">
        <div id="bulk-title" style="font-size:16px;font-weight:700;margin-bottom:4px;">
          Assign now?
        </div>
        <div id="bulk-view" style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-bottom:14px;`}></div>
        <select id="bulk-tpl" style={`${INPUT}margin-bottom:12px;`}></select>
        <div id="bulk-preview" style="background:#f4f4f6;padding:11px 13px;font-size:12.5px;color:#33343c;margin-bottom:16px;line-height:1.5;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button data-dialog-close="#dlg-bulk" style={BTN}>
            Cancel
          </button>
          <button id="bulk-go" style={PRIMARY}>
            Create tasks
          </button>
        </div>
      </div>
    </div>

    {/* assign task — pick a template, then reach speakers by rule or by hand */}
    <div id="dlg-assign" data-dialog hidden class="spk-dialogscrim" style={DIALOG}>
      <div class="spk-dialogpad spk-panel" style="background:#fff;width:520px;max-height:88vh;display:flex;flex-direction:column;">
        <div style="font-size:16px;font-weight:700;margin-bottom:14px;">Assign task</div>
        <div style={`${LABEL}margin-bottom:6px;`}>TEMPLATE</div>
        <select id="as-tpl" style={`${INPUT}margin-bottom:14px;`}></select>
        <div style={`${LABEL}margin-bottom:6px;`}>SPEAKERS</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;">
          <button type="button" data-as-mode="rule" style="padding:8px 6px;font-size:12px;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#33343c;">
            By rule
          </button>
          <button type="button" data-as-mode="pick" style="padding:8px 6px;font-size:12px;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#33343c;">
            Pick speakers
          </button>
        </div>
        <div style="flex:1;overflow-y:auto;min-height:0;">
          <div id="as-rule" style="display:grid;gap:6px;">
            <select id="as-group" style={INPUT}>
              <option value="acceptance">All accepted speakers</option>
              <option value="confirmation">Confirmed speakers only</option>
            </select>
            <div id="as-clauses" style="display:grid;gap:6px;"></div>
            <button id="as-add-clause" type="button" style="justify-self:start;padding:6px 11px;background:#fff;border:1px dashed #c9cbd2;font-size:12px;color:#686b74;cursor:pointer;">
              ＋ Add clause
            </button>
          </div>
          <div id="as-pick" hidden style="display:grid;gap:8px;">
            <input id="as-q" placeholder="Filter speakers…" style={INPUT} />
            <div id="as-list" style="border:1px solid #e2e3e8;max-height:240px;overflow-y:auto;"></div>
          </div>
        </div>
        <div id="as-preview" style="border-top:1px solid #eceded;padding-top:12px;margin:16px 0;min-height:20px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button data-dialog-close="#dlg-assign" style={BTN}>
            Cancel
          </button>
          <button id="as-go" style={PRIMARY}>
            Create tasks
          </button>
        </div>
      </div>
    </div>

    {/* reminder email editor */}
    <div id="dlg-eml" data-dialog hidden class="spk-dialogscrim" style={`${DIALOG}z-index:95;`}>
      <div class="spk-emlpanel spk-panel" style="background:#fff;max-height:88vh;display:flex;flex-direction:column;">
        <div style="padding:14px 20px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:14px;">
          <div id="eml-title" style={LABEL}>
            REMINDER EMAIL
          </div>
          <div style="margin-left:auto;display:flex;">
            <button id="eml-tab-edit" style="padding:6px 16px;font-size:12px;cursor:pointer;border:1px solid #4c5fd5;background:#eef0fb;color:#4c5fd5;font-weight:600;">
              Edit
            </button>
            <button id="eml-tab-prev" style="padding:6px 16px;font-size:12px;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#33343c;margin-left:-1px;">
              Preview
            </button>
          </div>
          <button data-dialog-close="#dlg-eml" style="background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;">
            ×
          </button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:18px 20px;">
          <div id="eml-edit" style="display:grid;gap:14px;">
            <div>
              <div style={`${LABEL}margin-bottom:6px;`}>SUBJECT</div>
              <input id="eml-subj" style={`${INPUT}font-size:12.5px;font-weight:600;`} />
            </div>
            <div>
              <div style={`${LABEL}margin-bottom:6px;`}>BODY</div>
              <textarea id="eml-body" rows={12} style={`${INPUT}font-size:12.5px;resize:vertical;line-height:1.5;display:block;`}></textarea>
              <div style="font-size:11px;color:#9a9da6;margin-top:5px;line-height:1.45;">
                Variables: {'{{speaker_name}}'}, {'{{task_name}}'}, {'{{event_name}}'}, {'{{due_date}}'},{' '}
                {'{{days_left}}'}, {'{{portal_link}}'}, {'{{session_title}}'}
              </div>
            </div>
          </div>
          <div id="eml-prev" hidden>
            <div style="border:1px solid #e2e3e8;">
              <div style="padding:10px 14px;border-bottom:1px solid #eceded;display:grid;gap:4px;font-size:12px;color:#686b74;">
                <div style="display:flex;gap:8px;">
                  <span style={`font-family:${MONO};font-size:9.5px;color:#9a9da6;width:44px;flex:none;padding-top:2px;`}>
                    FROM
                  </span>
                  {`${eventName} Program`}
                </div>
                <div style="display:flex;gap:8px;">
                  <span style={`font-family:${MONO};font-size:9.5px;color:#9a9da6;width:44px;flex:none;padding-top:2px;`}>
                    TO
                  </span>
                  <span id="eml-prev-to"></span>
                </div>
                <div style="display:flex;gap:8px;">
                  <span style={`font-family:${MONO};font-size:9.5px;color:#9a9da6;width:44px;flex:none;padding-top:2px;`}>
                    SUBJ
                  </span>
                  <span id="eml-prev-subj" style="font-weight:600;color:#16171d;"></span>
                </div>
              </div>
              <div id="eml-prev-body" style="padding:16px 14px;font-size:13px;line-height:1.6;white-space:pre-line;color:#16171d;"></div>
            </div>
            <div style={`font-family:${MONO};font-size:10px;color:#9a9da6;margin-top:8px;`}>
              VARIABLES FILLED WITH SAMPLE DATA FROM ONE REAL ASSIGNMENT
            </div>
          </div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid #e2e3e8;display:flex;gap:8px;align-items:center;">
          <button id="eml-test" style="padding:8px 14px;background:#fdf6e0;border:1px solid #e8d79a;color:#7a5c0a;font-size:12.5px;cursor:pointer;">
            Send test to me
          </button>
          <div style="margin-left:auto;display:flex;gap:8px;">
            <button data-dialog-close="#dlg-eml" style={BTN}>
              Cancel
            </button>
            <button id="eml-save" style={PRIMARY}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>

    {/* compose email to a speaker */}
    <div id="dlg-compose" data-dialog hidden class="spk-dialogscrim" style={DIALOG}>
      <div class="spk-dialogpad spk-panel" style="background:#fff;width:520px;">
        <div style="font-size:16px;font-weight:700;margin-bottom:4px;">Email speaker</div>
        <div id="compose-to" style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-bottom:14px;`}></div>
        <div style="display:grid;gap:10px;">
          <select id="compose-tpl" style={INPUT}>
            <option value="">Blank message</option>
          </select>
          <input id="compose-subj" placeholder="Subject" style={INPUT} />
          <textarea id="compose-body" rows={8} style={`${INPUT}resize:vertical;line-height:1.5;`}></textarea>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button data-dialog-close="#dlg-compose" style={BTN}>
            Cancel
          </button>
          <button id="compose-send" style={PRIMARY}>
            Send email
          </button>
        </div>
        <div style="font-size:11px;color:#9a9da6;margin-top:10px;">
          {`Sends as ${eventName} · logged in the email log · from ${userEmail}`}
        </div>
      </div>
    </div>

    {/* request changes */}
    <div id="dlg-changes" data-dialog hidden class="spk-dialogscrim" style={DIALOG}>
      <div class="spk-dialogpad spk-panel" style="background:#fff;width:460px;">
        <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Request changes</div>
        <div style="font-size:13px;color:#686b74;line-height:1.55;margin-bottom:12px;">
          The task goes back to open and the speaker is emailed with your message. The uploaded file is kept as a
          version.
        </div>
        <textarea id="changes-msg" rows={4} placeholder="e.g. The deck is landscape 4:3 — please re-export at 16:9." style={`${INPUT}resize:vertical;`}></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button data-dialog-close="#dlg-changes" style={BTN}>
            Cancel
          </button>
          <button id="changes-go" style={PRIMARY}>
            Send request
          </button>
        </div>
      </div>
    </div>
  </>
);

/* ------------------------------------------------------------- the page */

app.get('/app/speakers', async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  const files = filesEnabled(c.env);
  const canWrite = c.var.role === 'admin' || c.var.role === 'owner';
  // Same review-and-send panel as /app/submissions, but for queued task
  // reminders — the Remind button queues, this is where the queue shows.
  const [props, data, reminderQueue, directory, taxOpts, emailTemplates] = await Promise.all([
    adminProps(c, 'Speakers & Tasks', { headerTitle: 'Speaker onboarding' }),
    loadPage(c.env, event.id),
    listReminderQueue(c.env, event.id),
    canWrite
      ? directoryCandidates(c.env.DB, event.org_id, event.id)
      : Promise.resolve({ rows: [] as DirectoryCandidate[], more: false }),
    all<{ taxonomy: string; name: string }>(
      c.env.DB,
      `SELECT t.name AS taxonomy, o.name AS name FROM taxonomy_options o
         JOIN taxonomies t ON t.id = o.taxonomy_id WHERE t.event_id = ? ORDER BY t.position, o.position`,
      event.id
    ),
    all<{ key: string; name: string; subject: string; body: string }>(
      c.env.DB,
      `SELECT key, name, subject, body FROM email_templates WHERE event_id = ? ORDER BY key`,
      event.id
    ),
  ]);
  // Sending batches per speaker (one email each) — group the panel the same way.
  const reminderGroups: (typeof reminderQueue)[] = [];
  {
    const bySpeaker = new Map<string, typeof reminderQueue>();
    for (const q of reminderQueue) {
      const g = bySpeaker.get(q.speaker_profile_id);
      if (g) g.push(q);
      else {
        const fresh = [q];
        bySpeaker.set(q.speaker_profile_id, fresh);
        reminderGroups.push(fresh);
      }
    }
  }
  // Two header buttons only fit 320px with their long labels trimmed, so each
  // carries a phone-length label beside the desktop one.
  const zipBtn = (href: string, long: string, short: string) => {
    const label = (
      <>
        <span class="us-desktop-only">{long}</span>
        <span class="us-mobile-only">{short}</span>
      </>
    );
    return files ? (
      <a href={href} style={`${BTN}text-decoration:none;color:#16171d;display:inline-block;`}>
        {label}
      </a>
    ) : (
      <span title="File storage not yet enabled" style={`${BTN}color:#c9cbd2;cursor:not-allowed;display:inline-block;`}>
        {label}
      </span>
    );
  };

  const headerActions = (
    <div style="display:flex;gap:8px;">
      {zipBtn('/app/speakers/headshots.zip', '↓ All headshots (ZIP)', '↓ Headshots')}
      {zipBtn('/app/speakers/slides.zip', '↓ All slides (ZIP)', '↓ Slides')}
    </div>
  );

  const payload = {
    templates: data.templates.map((t) => ({
      id: t.id,
      name: t.name,
      desc: t.description,
      type: t.type,
      target: t.target,
      required: !!t.required,
      lock: !!t.lock_on_complete,
      trigger: t.trigger,
      archived: !!t.archived,
      settings: T.parseSettings(t),
      due: T.parseDue(t),
      grace: T.parseGrace(t),
      clauses: T.parseClauses(t),
      reminders: T.parseReminders(t),
      typeLabel: T.TYPE_LABEL[t.type],
      dueDesc: T.dueDesc(t),
    })),
    taxonomies: (() => {
      const map: Record<string, string[]> = { Track: [], Format: [], Level: [] };
      for (const o of taxOpts) (map[o.taxonomy] ??= []).push(o.name);
      return map;
    })(),
    miniForms: T.MINI_FORM_NAMES,
    emailTemplates,
    defaults: { subject: T.REM_SUBJ, body: T.REM_BODY },
    event: { name: event.name, slug: event.slug, start: event.start_date },
    me: c.var.user?.email ?? '',
    files,
    pendingReview: data.pendingReview,
  };

  return c.html(
    <AdminLayout {...props} headerActions={headerActions} scripts={['/js/speakers.js']}>
      <style>{raw(PAGE_CSS)}</style>
      <div class="spk-page">
        {reminderQueue.length > 0 ? (
          <div style="background:#fbf4e2;border:1px solid #e6d29a;margin-bottom:12px;">
            <div class="spk-rembar">
              <span>
                <strong>{`${reminderQueue.length} queued task reminder${reminderQueue.length === 1 ? '' : 's'}`}</strong>
                {` — sends as ${reminderGroups.length} email${
                  reminderGroups.length === 1 ? '' : 's'
                } (one per speaker); nothing has been sent to speakers yet.`}
              </span>
              {canWrite ? (
                <form method="post" action="/app/emails/outbox/send" style="margin-left:auto;">
                  <input type="hidden" name="back" value="/app/speakers" />
                  <input type="hidden" name="only" value="reminders" />
                  <button
                    type="submit"
                    class="spk-remsend"
                    style="background:#2b8a3e;color:#fff;border:none;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;"
                  >
                    {reminderQueue.length > OUTBOX_SEND_LIMIT
                      ? `Send ${OUTBOX_SEND_LIMIT} of ${reminderQueue.length} now`
                      : `Send all ${reminderQueue.length} now`}
                  </button>
                </form>
              ) : null}
            </div>
            <details>
              <summary
                style={`padding:8px 14px;border-top:1px solid #e6d29a;cursor:pointer;font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;color:#8a6d1a;`}
              >
                REVIEW THE QUEUE
              </summary>
              <div style="background:#fff;border-top:1px solid #e6d29a;max-height:320px;overflow-y:auto;">
                {reminderGroups.map((g) => (
                  <div style="border-bottom:1px solid #eceded;">
                    <div class="spk-remgroup">
                      <a
                        href={`/app/speakers?open=${g[0].speaker_profile_id}`}
                        style="font-size:13px;font-weight:600;color:#16171d;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                      >
                        {g[0].speaker_name || 'No speaker on file'}
                      </a>
                      <span style={`font-family:${MONO};font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                        {g[0].speaker_email || 'no email on file'}
                      </span>
                      <span
                        title={
                          g.length === 1
                            ? 'This speaker gets one reminder email'
                            : `These ${g.length} reminders are batched — this speaker gets ONE email listing all of them`
                        }
                        style={`margin-left:auto;padding:2px 7px;font-size:10px;font-weight:600;white-space:nowrap;color:#b08800;border:1px dashed #b08800;font-family:${MONO};letter-spacing:0.04em;flex:none;`}
                      >
                        {g.length === 1 ? '1 EMAIL' : `1 EMAIL · ${g.length} REMINDERS`}
                      </span>
                    </div>
                    {g.map((q) => (
                      <div class="spk-remrow" style="border-bottom:1px solid #f2f3f5;">
                        <div style="min-width:0;">
                          <div style="font-size:12.5px;color:#33343c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            {q.task_name}
                          </div>
                          <div style="font-size:11px;color:#9a9da6;">
                            {q.due_date ? `Due ${q.due_date}` : 'No due date'}
                          </div>
                        </div>
                        {canWrite ? (
                          <form method="post" action="/app/emails/outbox/remove" style="justify-self:end;">
                            <input type="hidden" name="id" value={q.id} />
                            <input type="hidden" name="kind" value="reminder" />
                            <input type="hidden" name="back" value="/app/speakers" />
                            <button
                              type="submit"
                              class="spk-remundo"
                              style="background:#fff;border:1px solid #e2e3e8;font-size:11.5px;color:#c92a2a;cursor:pointer;"
                            >
                              Undo
                            </button>
                          </form>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ))}
                <div style="padding:8px 14px;font-size:11.5px;color:#9a9da6;">
                  Reminders for the same speaker are combined into a single email. Also lives at{' '}
                  <a href="/app/emails?tab=outbox" style="color:#4c5fd5;">
                    Emails → Outbox
                  </a>
                  . Undo removes a reminder before it sends.
                </div>
              </div>
            </details>
          </div>
        ) : null}
        <div class="spk-filters">
          <select id="f-task" class="spk-filtersel" style="font-size:12.5px;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#33343c;">
            <option value="">Task: any</option>
            {data.active.map((t) => (
              <option value={t.id}>{t.name}</option>
            ))}
          </select>
          <select id="f-state" class="spk-filtersel" style="font-size:12.5px;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#33343c;">
            <option value="">State: any</option>
            <option value="c">Complete</option>
            <option value="p">To do</option>
            <option value="o">Overdue</option>
            <option value="-">Not assigned</option>
          </select>
          <input id="f-q" class="spk-search" placeholder="Search name or talk title…" style="border:1px solid #e2e3e8;font-size:12.5px;background:#fff;" />
          {data.pendingReview ? (
            <button id="f-review" class="spk-chip" style="font-size:12.5px;cursor:pointer;border:1px solid #e8d79a;background:#fdf5dc;color:#b08800;font-weight:600;">
              {`Pending review (${data.pendingReview})`}
            </button>
          ) : null}
          <div class="spk-actions">
            <button id="assign-open" class="spk-action-primary" style="font-size:12.5px;cursor:pointer;border:none;background:#4c5fd5;color:#fff;font-weight:600;">
              Assign task
            </button>
            {canWrite ? (
              <button
                type="button"
                data-dialog-open="#dlg-directory"
                class="spk-action"
                style="font-size:12.5px;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#33343c;"
              >
                Add from directory
              </button>
            ) : null}
            {canWrite ? (
              <button id="btn-import" class="spk-action" style="font-size:12.5px;cursor:pointer;border:1px solid #e2e3e8;background:#fff;color:#33343c;">
                Import CSV
              </button>
            ) : null}
            <a href="/app/speakers.csv" class="spk-action" style="font-size:12.5px;border:1px solid #e2e3e8;background:#fff;color:#33343c;text-decoration:none;">
              Export CSV
            </a>
          </div>
        </div>

        <Grid data={data} />

        <div class="spk-legend">
          <span>
            <span style="display:inline-block;width:10px;height:10px;background:#2b8a3e;vertical-align:-1px;"></span> complete
          </span>
          <span>
            <span style="display:inline-block;width:10px;height:10px;background:#e2e3e8;vertical-align:-1px;"></span> to do
          </span>
          <span>
            <span style="display:inline-block;width:10px;height:10px;background:#c92a2a;vertical-align:-1px;"></span> overdue
          </span>
          {data.pendingReview ? (
            <span>
              <span style="display:inline-block;width:10px;height:10px;background:#fdf5dc;border:1px solid #e8d79a;vertical-align:-1px;"></span>{' '}
              pending review
            </span>
          ) : null}
          <span>
            <span style="display:inline-block;width:10px;height:10px;background:#fafafb;border:1px solid #e2e3e8;vertical-align:-1px;"></span>{' '}
            not assigned
          </span>
        </div>

        <TemplateCards data={data} />
      </div>

      <div id="drawer" data-drawer hidden></div>
      <EditorDrawer files={files} />
      <Dialogs eventName={event.name} userEmail={c.var.user?.email ?? ''} />
      {canWrite ? <ImportDialog /> : null}
      {canWrite ? <DirectoryDialog rows={directory.rows} more={directory.more} /> : null}
      <script type="application/json" id="data-speakers">
        {raw(JSON.stringify(payload).replace(/</g, '\\u003c'))}
      </script>
    </AdminLayout>
  );
});

/* ----------------------------------------------------------------- CSV */

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

app.get('/app/speakers.csv', async (c) => {
  const event = c.var.event;
  if (!event) return c.text('No event', 400);
  const data = await loadPage(c.env, event.id);
  const header = ['Speaker', 'Email', 'Title & Company', 'Session', ...data.active.map((t) => t.name), 'Done'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of data.rows) {
    lines.push(
      [
        r.name,
        r.email,
        r.affiliation,
        r.session,
        ...data.active.map((t) => TIP[r.cells[t.id]]),
        `${r.done}/${r.assigned}`,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return new Response(lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${event.slug}-speaker-tasks.csv"`,
    },
  });
});

/** Starter sheet for the importer — headers the mapper auto-matches, plus one example row. */
app.get('/app/speakers/import-template.csv', (c) => {
  const body = toCsv(
    [
      {
        Name: 'Ada Lovelace',
        Email: 'ada@example.com',
        Tagline: 'Analyst at the Analytical Engine',
        Bio: 'Ada writes about computing before it exists.',
        Pronouns: 'she/her',
        LinkedIn: 'https://linkedin.com/in/example',
        X: '',
        Website: 'https://example.com',
      },
    ],
    ['Name', 'Email', 'Tagline', 'Bio', 'Pronouns', 'LinkedIn', 'X', 'Website']
  );
  return new Response(body, { headers: csvHeaders('speaker-import-template.csv') });
});

/* --------------------------------------------------------- CSV import */

/**
 * Bulk-add speakers who never came through the CFP. Matching is by email
 * (the profile's natural key — `speaker_profiles` is UNIQUE on event+email),
 * so re-importing a corrected sheet updates in place instead of duplicating.
 *
 * Mirrors the submissions importer (`/app/api/submissions/import`): the client
 * previews and maps columns, the server re-parses the same text with
 * `lib/csv.ts` before writing anything.
 */

/** One mapped column target. `link:*` writes into the links_json object. */
type ImportTarget = 'ignore' | 'name' | 'email' | 'bio' | 'job_title' | 'company' | 'tagline' | 'pronouns' | `link:${LinkKey}`;

const IMPORT_MAX_ROWS = 500;

type ImportProfile = {
  id: string;
  email: string;
  name: string;
  bio: string;
  job_title: string | null;
  company: string | null;
  tagline: string | null;
  pronouns: string | null;
  links_json: string | null;
  slug: string;
  imported_at: string | null;
  /** Not importable — carried so recorded version snapshots stay complete. */
  headshot_file_id?: string | null;
  created_at?: string;
};

app.post('/app/api/speakers/import', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No active event' }, 400);
  const input = await c.req.json<{ text?: string; mapping?: string[] }>();
  const text = input.text ?? '';
  const mapping = (input.mapping ?? []) as ImportTarget[];
  if (!text.trim()) return c.json({ ok: false, error: 'The file looked empty.' }, 400);
  if (!mapping.includes('email')) {
    return c.json({ ok: false, error: 'Map one column to Email — speakers are matched by email address.' }, 400);
  }

  const table = parseCsvTable(text);
  if (!table.rows.length) return c.json({ ok: false, error: 'No data rows found below the header.' }, 400);
  if (table.rows.length > IMPORT_MAX_ROWS) {
    return c.json({ ok: false, error: `Import at most ${IMPORT_MAX_ROWS} rows at a time.` }, 400);
  }

  const existing = await all<ImportProfile>(
    c.env.DB,
    `SELECT id, email, name, bio, job_title, company, tagline, pronouns, links_json, slug, imported_at, headshot_file_id, created_at
       FROM speaker_profiles WHERE event_id = ?`,
    event.id
  );
  const byEmail = new Map(existing.map((p) => [p.email.toLowerCase(), p]));
  const takenSlugs = new Set(existing.map((p) => p.slug));

  const stamp = now();
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  const stmts: Array<[string, unknown[]]> = [];
  /** Rows already handled this run, so a sheet listing someone twice merges instead of colliding. */
  const seen = new Map<string, ImportProfile & { dirty: boolean }>();
  const badEmails: string[] = [];
  const badLinks: string[] = [];
  let created = 0;
  let updated = 0;
  /** Already on file with nothing new in the sheet — a re-import is a no-op, not a failure. */
  let unchanged = 0;
  /** No usable email, so there was nothing to match on. */
  let skipped = 0;

  table.rows.forEach((cells, index) => {
    const line = index + 2; // header is line 1
    let email = '';
    let name = '';
    let bio = '';
    let jobTitle = '';
    let company = '';
    let tagline = '';
    let pronouns = '';
    const links: SpeakerLinks = {};

    mapping.forEach((target, col) => {
      if (!target || target === 'ignore') return;
      const value = (cells[col] ?? '').trim();
      if (!value) return;
      if (target === 'email') email = value;
      else if (target === 'name') name = value;
      else if (target === 'bio') bio = value;
      else if (target === 'job_title') jobTitle = value;
      else if (target === 'company') company = value;
      else if (target === 'tagline') tagline = value;
      else if (target === 'pronouns') pronouns = value;
      else if (target.startsWith('link:')) {
        const key = target.slice(5) as LinkKey;
        const url = normalizeLink(value);
        if (url) links[key] = url;
        else badLinks.push(`line ${line}`);
      }
    });

    if (!email) {
      skipped++;
      return;
    }
    // Deliberately permissive — organizer sheets carry odd but real addresses.
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      badEmails.push(`line ${line}: ${email}`);
      skipped++;
      return;
    }

    const key = email.toLowerCase();
    const prior = seen.get(key) ?? byEmail.get(key);

    if (prior) {
      // Fill in what the sheet provides; never blank a field that's already set.
      const merged: SpeakerLinks = { ...jsonParse<SpeakerLinks>(prior.links_json, {}), ...links };
      const next: ImportProfile = {
        ...prior,
        name: name || prior.name,
        bio: bio || prior.bio,
        job_title: jobTitle || prior.job_title,
        company: company || prior.company,
        tagline: tagline || prior.tagline,
        pronouns: pronouns || prior.pronouns,
        links_json: linksJson(merged),
      };
      const changed =
        next.name !== prior.name ||
        next.bio !== prior.bio ||
        next.job_title !== prior.job_title ||
        next.company !== prior.company ||
        next.tagline !== prior.tagline ||
        next.pronouns !== prior.pronouns ||
        next.links_json !== prior.links_json;
      const already = seen.get(key);
      if (!already) {
        if (changed) updated++;
        else unchanged++;
      } else if (changed && !already.dirty) {
        // A later row for the same speaker filled in what the first one left blank.
        updated++;
        unchanged--;
      }
      seen.set(key, { ...next, dirty: (already?.dirty ?? false) || changed });
      return;
    }

    const base = slugify(name || email.split('@')[0], 'speaker');
    let slug = base;
    for (let n = 2; takenSlugs.has(slug); n++) slug = `${base}-${n}`;
    takenSlugs.add(slug);

    seen.set(key, {
      id: newId('spk'),
      email,
      name: name || email,
      bio,
      job_title: jobTitle || null,
      company: company || null,
      tagline: tagline || null,
      pronouns: pronouns || null,
      links_json: linksJson(links),
      slug,
      imported_at: stamp,
      dirty: true,
    });
    created++;
  });

  for (const [key, p] of seen) {
    if (!p.dirty) continue; // already on file and unchanged — no write, no activity noise
    const prior = byEmail.get(key);
    if (prior) {
      stmts.push([
        `UPDATE speaker_profiles SET name = ?, bio = ?, job_title = ?, company = ?, tagline = ?, pronouns = ?, links_json = ?
          WHERE id = ? AND event_id = ?`,
        [p.name, p.bio, p.job_title, p.company, p.tagline, p.pronouns, p.links_json, prior.id, event.id],
      ]);
    } else {
      stmts.push([
        `INSERT INTO speaker_profiles
           (id, event_id, user_id, email, name, bio, job_title, company, tagline, pronouns, links_json, headshot_file_id, slug,
            created_at, imported_at)
         VALUES (?,?,NULL,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
        [p.id, event.id, p.email, p.name, p.bio, p.job_title, p.company, p.tagline, p.pronouns, p.links_json, p.slug, stamp, stamp],
      ]);
    }
    stmts.push([
      `INSERT INTO activity (id, event_id, subject_type, subject_id, actor, action, detail, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        newId('act'),
        event.id,
        'speaker',
        prior ? prior.id : p.id,
        actor,
        prior ? 'Updated from CSV' : 'Imported from CSV',
        p.email,
        stamp,
      ],
    ]);
  }

  // Only a genuine dead end is an error — a sheet that's simply already
  // up to date reports success with `unchanged`.
  if (!created && !updated && !unchanged) {
    return c.json(
      {
        ok: false,
        error: badEmails.length
          ? `No rows imported — ${badEmails.length} unusable email address${
              badEmails.length === 1 ? '' : 'es'
            } (${badEmails.slice(0, 3).join('; ')}${badEmails.length > 3 ? '; …' : ''}).`
          : 'No rows had an email address — check the column mapping.',
      },
      400
    );
  }
  await batch(c.env.DB, stmts);

  // Mirror imported speakers into the org's contact directory (Speaker CRM).
  for (const [key, p] of seen) {
    if (byEmail.has(key)) continue; // already a profile here, so already a contact
    await upsertOrgContact(
      c.env.DB,
      event.org_id,
      {
        email: p.email,
        name: p.name,
        bio: p.bio,
        job_title: p.job_title,
        company: p.company,
        tagline: p.tagline,
        pronouns: p.pronouns,
        links_json: p.links_json,
      },
      'import'
    );
  }

  // Version history for overwritten profiles (new profiles start theirs on
  // their first later edit). Snapshots are complete: headshot rode along on
  // the prior row and imports never change it.
  for (const [key, p] of seen) {
    const prior = byEmail.get(key);
    if (!p.dirty || !prior) continue;
    await recordContentVersion(c.env.DB, {
      eventId: event.id,
      subjectType: 'speaker',
      subjectId: prior.id,
      editor: actor,
      before: speakerSnapshotOf({ ...prior, headshot_file_id: prior.headshot_file_id ?? null }),
      after: speakerSnapshotOf({ ...p, headshot_file_id: prior.headshot_file_id ?? null }),
      subjectCreatedAt: prior.created_at,
      summary: 'Updated from CSV import',
    });
  }

  const warnings: string[] = [];
  if (badEmails.length) {
    warnings.push(
      `${badEmails.length} row${badEmails.length === 1 ? '' : 's'} skipped for an unusable email (${badEmails
        .slice(0, 3)
        .join('; ')}${badEmails.length > 3 ? '; …' : ''})`
    );
  }
  if (badLinks.length) {
    warnings.push(
      badLinks.length === 1
        ? `1 link dropped as an unreadable URL (${badLinks[0]})`
        : `${badLinks.length} links dropped as unreadable URLs`
    );
  }
  return c.json({ ok: true, created, updated, unchanged, skipped, warnings });
});

/* ----------------------------------------------------------------- ZIPs */

app.get('/app/speakers/headshots.zip', async (c) => {
  const event = c.var.event;
  if (!event) return c.text('No event', 400);
  const res = await zipHeadshots(c.env, event.id);
  return res ?? c.text('File storage not yet enabled', 503);
});

app.get('/app/speakers/slides.zip', async (c) => {
  const event = c.var.event;
  if (!event) return c.text('No event', 400);
  const res = await zipSlides(c.env, event.id);
  return res ?? c.text('File storage not yet enabled', 503);
});

/* ------------------------------------------------------------ drawer API */

type DrawerTask = {
  id: string;
  name: string;
  tag: string;
  state: string;
  stateLabel: string;
  due: string | null;
  removable: boolean;
  remindable: boolean;
  /** A queued manual reminder is waiting in Emails → Outbox. */
  reminderQueued: boolean;
  review: boolean;
  file: string | null;
  /** Submitted mini-form answers (AV requirements, travel details…) for the organizer to review. */
  answers: { label: string; value: string }[] | null;
};

app.get('/app/api/speakers/detail/:id', async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const profile = await one<FullProfileRow>(
    c.env.DB,
    `SELECT * FROM speaker_profiles WHERE id = ? AND event_id = ?`,
    c.req.param('id'),
    event.id
  );
  if (!profile) return c.json({ ok: false, error: 'Speaker not found' }, 404);

  const sessionIds = (
    await all<{ session_id: string }>(
      c.env.DB,
      `SELECT session_id FROM session_speakers WHERE speaker_profile_id = ?`,
      profile.id
    )
  ).map((r) => r.session_id);

  const tasks = await all<
    T.TaskRow & { tpl_name: string | null; tpl_type: string | null; tpl_target: string | null; tpl_settings: string | null }
  >(
    c.env.DB,
    `SELECT t.*, tt.name AS tpl_name, tt.type AS tpl_type, tt.target AS tpl_target, tt.settings_json AS tpl_settings
       FROM tasks t LEFT JOIN task_templates tt ON tt.id = t.template_id
      WHERE t.event_id = ? AND t.status != 'cancelled'
        AND (t.speaker_profile_id = ?${sessionIds.length ? ` OR t.session_id IN (${sessionIds.map(() => '?').join(',')})` : ''})`,
    event.id,
    profile.id,
    ...sessionIds
  );

  const today = T.todayISO();
  const stateLabel: Record<string, string> = { c: 'DONE', p: 'TO DO', o: 'OVERDUE', r: 'IN REVIEW' };
  const queuedReminders = new Set(
    (
      await all<{ task_id: string }>(
        c.env.DB,
        `SELECT task_id FROM task_reminder_queue WHERE speaker_profile_id = ?`,
        profile.id
      )
    ).map((r) => r.task_id)
  );
  const rows: DrawerTask[] = [];
  for (const t of T.dedupeTasks(tasks)) {
    const oneOff = t.template_id ? null : jsonParse<T.OneOffSpec>(t.one_off_json, { name: 'Task', type: 'checkbox' });
    const state = T.cellState(t, today);
    const file =
      t.status === 'pending_review' || t.status === 'done'
        ? (
            await one<{ filename: string }>(
              c.env.DB,
              `SELECT filename FROM files WHERE subject_type = 'task' AND subject_id = ? ORDER BY version DESC LIMIT 1`,
              t.id
            )
          )?.filename ?? null
        : null;
    // Mini-form answers land in tasks.response_json — this drawer is where the
    // organizer reads them (the portal only shows them back to the speaker).
    let answers: { label: string; value: string }[] | null = null;
    if ((t.tpl_type ?? oneOff?.type) === 'form' && t.response_json) {
      const response = jsonParse<Record<string, unknown>>(t.response_json, {});
      const spec = T.formSpecOf(jsonParse<T.TaskSettings>(t.tpl_settings, {}));
      answers = spec.fields
        .map((f) => {
          const v = response[f.id];
          return { label: f.label, value: f.type === 'CHK' ? (v ? 'Yes' : '') : String(v ?? '').trim() };
        })
        .filter((a) => a.value);
      if (!answers.length) answers = null;
    }
    rows.push({
      id: t.id,
      name: T.snapshotOf(t)?.name ?? t.tpl_name ?? oneOff?.name ?? 'Task',
      tag: t.template_id ? (t.tpl_target === 'session' ? 'SESSION' : '') : 'ONE-OFF',
      state,
      stateLabel: stateLabel[state],
      due: t.due_date,
      removable: state !== 'c',
      remindable: state !== 'c',
      reminderQueued: queuedReminders.has(t.id),
      review: t.status === 'pending_review',
      file,
      answers,
    });
  }
  rows.sort((a, b) => (a.state === 'c' ? 1 : 0) - (b.state === 'c' ? 1 : 0));

  const assignedIds = new Set(tasks.map((t) => t.template_id).filter(Boolean) as string[]);
  const templates = await all<T.TaskTemplateRow>(
    c.env.DB,
    `SELECT * FROM task_templates WHERE event_id = ? AND archived = 0 ORDER BY created_at`,
    event.id
  );

  const sub = await one<{
    id: string;
    seq: number;
    status: string;
    title: string;
    track: string | null;
    color: string | null;
    format: string | null;
    level: string | null;
    session_id: string | null;
    session_status: string | null;
  }>(
    c.env.DB,
    `SELECT s.id, s.seq, s.status, s.title,
            tr.name AS track, tr.color AS color, fo.name AS format, se.level AS level, se.id AS session_id,
            se.status AS session_status
       FROM submissions s
       JOIN submission_speakers sp ON sp.submission_id = s.id
       LEFT JOIN sessions se ON se.submission_id = s.id
       LEFT JOIN taxonomy_options tr ON tr.id = se.track_option_id
       LEFT JOIN taxonomy_options fo ON fo.id = se.format_option_id
      WHERE s.event_id = ? AND sp.email = ?
      ORDER BY CASE WHEN se.status = 'confirmed' THEN 0 WHEN s.status = 'accepted' THEN 1 ELSE 2 END, s.seq DESC
      LIMIT 1`,
    event.id,
    profile.email
  );

  let score = '';
  if (sub) {
    const ev = await one<{ n: number; avg: number | null }>(
      c.env.DB,
      `SELECT COUNT(*) AS n, NULL AS avg FROM evaluations WHERE submission_id = ?`,
      sub.id
    );
    if (ev?.n) score = `${ev.n} review${ev.n === 1 ? '' : 's'}`;
  }

  const done = rows.filter((r) => r.state === 'c').length;
  const versions = await listContentVersions(c.env.DB, 'speaker', profile.id);
  // "Confirmed" is the more informative badge when it applies, but it is the
  // session's state now (migration 0011) — the submission stays `accepted`.
  const badge = sub?.session_status === 'confirmed' ? 'confirmed' : (sub?.status ?? '');
  return c.json({
    ok: true,
    speaker: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      affiliation: speakerAffiliation(profile),
      bio: profile.bio,
      slug: profile.slug,
      travel: profile.travel_notes ?? '',
    },
    submission: sub
      ? {
          id: sub.id,
          label: `SUB-${sub.seq}`,
          status: sub.status,
          statusLabel: (STATUS_COLORS[badge] ?? { label: badge }).label,
          fg: (STATUS_COLORS[badge] ?? { fg: '#686b74' }).fg,
          bg: (STATUS_COLORS[badge] ?? { bg: '#f1f3f5' }).bg,
          title: sub.title,
          track: sub.track ?? '',
          color: sub.color ?? '#9a9da6',
          meta: [sub.format, sub.level].filter(Boolean).join(' · '),
          score,
          sessionId: sub.session_id,
        }
      : null,
    tasks: rows,
    frac: { done, total: rows.length },
    versions: speakerVersionPayload(versions, profile),
    assignable: templates
      .filter((t) => !assignedIds.has(t.id))
      .map((t) => ({
        id: t.id,
        label: `${t.name} · ${T.TYPE_LABEL[t.type]}${t.target === 'session' ? ' · session' : ''}`,
      })),
    eventSlug: event.slug,
  });
});

/**
 * Travel & logistics notes — the drawer's organizer-entered CRM field
 * (arrival details, seating, dietary needs). Free text on the profile;
 * never shown to the speaker.
 */
app.post('/app/api/speakers/travel', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const body = await c.req.json<{ speakerProfileId: string; travel: string }>();
  const profile = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM speaker_profiles WHERE id = ? AND event_id = ?`,
    body.speakerProfileId,
    event.id
  );
  if (!profile) return c.json({ ok: false, error: 'Speaker not found' }, 404);
  const travel = (body.travel ?? '').trim().slice(0, 4000);
  await run(c.env.DB, `UPDATE speaker_profiles SET travel_notes = ? WHERE id = ?`, travel || null, profile.id);
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'speaker',
    subjectId: profile.id,
    actor: c.var.user?.name || c.var.user?.email || 'Organizer',
    action: travel ? 'Updated travel & logistics notes' : 'Cleared travel & logistics notes',
  });
  return c.json({ ok: true, travel });
});

/**
 * Restore a profile-content version from the drawer's VERSION HISTORY panel.
 * Applies the snapshot (name, tagline, bio, pronouns, links, headshot) and
 * appends a new version row — history is append-only, so a restore is itself
 * undoable. Travel notes are organizer CRM data, not versioned content.
 */
app.post('/app/api/speakers/restore', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const body = await c.req.json<{ id?: string; versionId?: string }>();
  if (!body?.id || !body?.versionId) return c.json({ ok: false, error: 'Missing speaker or version id.' }, 400);
  const cur = await one<FullProfileRow>(
    c.env.DB,
    `SELECT * FROM speaker_profiles WHERE id = ? AND event_id = ?`,
    body.id,
    event.id
  );
  if (!cur) return c.json({ ok: false, error: 'Speaker not found' }, 404);
  const version = await one<VersionRow>(
    c.env.DB,
    `SELECT id, event_id, editor, summary, snapshot_json, created_at FROM content_versions
      WHERE id = ? AND subject_type = 'speaker' AND subject_id = ?`,
    body.versionId,
    body.id
  );
  if (!version) return c.json({ ok: false, error: 'Version not found' }, 404);

  const snap = snapshotOf<SpeakerSnapshot>(version, speakerSnapshotOf(cur));
  const name = (snap.name ?? '').trim() || cur.name;
  // Keep the current photo rather than restore a pointer to a file that no longer exists.
  let headshot = snap.headshot_file_id ?? null;
  if (headshot && !(await one(c.env.DB, `SELECT 1 FROM files WHERE id = ?`, headshot))) {
    headshot = cur.headshot_file_id;
  }
  const after = {
    name,
    tagline: snap.tagline ?? null,
    bio: String(snap.bio ?? ''),
    pronouns: snap.pronouns ?? null,
    links_json: snap.links_json ?? null,
    headshot_file_id: headshot,
  };
  await run(
    c.env.DB,
    `UPDATE speaker_profiles SET name = ?, tagline = ?, bio = ?, pronouns = ?, links_json = ?, headshot_file_id = ? WHERE id = ?`,
    after.name,
    after.tagline,
    after.bio,
    after.pronouns,
    after.links_json,
    after.headshot_file_id,
    cur.id
  );

  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  await recordContentVersion(c.env.DB, {
    eventId: event.id,
    subjectType: 'speaker',
    subjectId: cur.id,
    editor: actor,
    before: speakerSnapshotOf(cur),
    after,
    subjectCreatedAt: cur.created_at,
    summary: restoreSummary(version),
  });
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'speaker',
    subjectId: cur.id,
    actor,
    action: 'Version restored',
    detail: after.name,
  });
  return c.json({ ok: true, message: `Restored — ${after.name}'s profile reverted` });
});

/* ------------------------------------------------------- template CRUD */

type TemplateInput = {
  id?: string | null;
  name: string;
  desc: string;
  type: T.TaskType;
  target: T.TaskTargetKind;
  required: boolean;
  lock: boolean;
  trigger: T.TemplateTrigger;
  settings: T.TaskSettings;
  due: T.DueSpec;
  grace: T.GraceSpec;
  clauses: T.ClauseSpec[];
  reminders: T.ReminderSpec;
  applyMode?: 'future' | 'open';
};

app.post('/app/api/speakers/template', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const body = await c.req.json<TemplateInput>();
  const name = (body.name || '').trim();
  if (!name) return c.json({ ok: false, error: 'Name the template first' }, 400);
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';

  const cols = [
    name,
    body.desc || '',
    body.type,
    body.target,
    JSON.stringify(body.settings ?? {}),
    body.required ? 1 : 0,
    body.lock ? 1 : 0,
    JSON.stringify(body.due ?? T.DEFAULT_DUE),
    JSON.stringify(body.grace ?? T.DEFAULT_GRACE),
    body.trigger,
    JSON.stringify(body.clauses ?? []),
    JSON.stringify(body.reminders ?? { on: true, days: [7, 2], subject: T.REM_SUBJ, body: T.REM_BODY }),
  ];

  if (body.id) {
    const existing = await one<T.TaskTemplateRow>(
      c.env.DB,
      `SELECT * FROM task_templates WHERE id = ? AND event_id = ?`,
      body.id,
      event.id
    );
    if (!existing) return c.json({ ok: false, error: 'Template not found' }, 404);
    // Pin the wording speakers have already seen onto every live instance
    // before the template changes underneath them (tasks-spec §4.8.3).
    await run(
      c.env.DB,
      `UPDATE tasks SET snapshot_json = ?
        WHERE template_id = ? AND snapshot_json IS NULL AND status != 'cancelled'`,
      JSON.stringify({ name: existing.name, description: existing.description }),
      body.id
    );
    await run(
      c.env.DB,
      `UPDATE task_templates SET name = ?, description = ?, type = ?, target = ?, settings_json = ?, required = ?,
         lock_on_complete = ?, due_json = ?, grace_json = ?, trigger = ?, clauses_json = ?, reminders_json = ?
       WHERE id = ?`,
      ...cols,
      body.id
    );
    let updated = 0;
    if (body.applyMode === 'open') {
      // Open instances follow the new definition: drop the pin and re-date them.
      // Completed instances keep their snapshot and never change.
      const open = await all<T.TaskRow>(
        c.env.DB,
        `SELECT * FROM tasks WHERE template_id = ? AND status IN ('open','pending_review')`,
        body.id
      );
      for (const t of open) {
        const due = T.computeDueDate(body.due ?? T.DEFAULT_DUE, event.start_date, t.created_at.slice(0, 10));
        await run(c.env.DB, `UPDATE tasks SET due_date = ?, snapshot_json = NULL WHERE id = ?`, due, t.id);
      }
      updated = open.length;
    }
    await logActivity(c.env.DB, {
      eventId: event.id,
      subjectType: 'task',
      subjectId: body.id,
      actor,
      action: 'Task template saved',
      detail:
        body.applyMode === 'open'
          ? `“${name}” — ${updated} open instances updated, completed ones untouched`
          : `“${name}” — future assignments only`,
    });
    return c.json({
      ok: true,
      id: body.id,
      message:
        body.applyMode === 'open'
          ? `Saved · ${updated} open instances updated · logged`
          : 'Saved · future assignments only · logged',
    });
  }

  const id = newId('tsk');
  await run(
    c.env.DB,
    `INSERT INTO task_templates (id, event_id, name, description, type, target, settings_json, required,
       lock_on_complete, due_json, grace_json, trigger, clauses_json, reminders_json, archived, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    id,
    event.id,
    ...cols,
    now()
  );
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'task',
    subjectId: id,
    actor,
    action: 'Task template created',
    detail: `“${name}” · ${body.trigger}`,
  });
  return c.json({
    ok: true,
    id,
    message:
      body.trigger === 'manual'
        ? `“${name}” created. Assign it from a speaker profile.`
        : `“${name}” created — assigns on ${body.trigger}. Not retroactive.`,
  });
});

/**
 * Who does an assignment rule reach right now? Read-only preview behind the
 * editor drawer's live match line and the post-create "assign now?" offer.
 */
app.post('/app/api/speakers/template/match', async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const body = await c.req.json<{ trigger: T.TemplateTrigger; clauses: T.ClauseSpec[] }>();
  const preview = await T.previewTemplateMatch(c.env, event.id, {
    trigger: body.trigger,
    clauses: Array.isArray(body.clauses) ? body.clauses : [],
  });
  return c.json({ ok: true, ...preview });
});

app.post('/app/api/speakers/template/archive', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const { id } = await c.req.json<{ id: string }>();
  const tpl = await one<T.TaskTemplateRow>(
    c.env.DB,
    `SELECT * FROM task_templates WHERE id = ? AND event_id = ?`,
    id,
    event.id
  );
  if (!tpl) return c.json({ ok: false, error: 'Template not found' }, 404);
  const next = tpl.archived ? 0 : 1;
  await run(c.env.DB, `UPDATE task_templates SET archived = ? WHERE id = ?`, next, id);
  const open = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM tasks WHERE template_id = ? AND status IN ('open','pending_review')`,
    id
  );
  const message = next
    ? `“${tpl.name}” archived. ${open?.n ?? 0} open instances kept.`
    : `“${tpl.name}” restored — assigns again per its rule`;
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'task',
    subjectId: id,
    actor: c.var.user?.name || c.var.user?.email || 'Organizer',
    action: next ? 'Task template archived' : 'Task template restored',
    detail: tpl.name,
  });
  return c.json({ ok: true, message });
});

/* --------------------------------------------------------- assignment */

app.post('/app/api/speakers/assign', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const body = await c.req.json<{
    speakerProfileId: string;
    templateId?: string;
    oneOff?: T.OneOffSpec;
  }>();
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  const profile = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM speaker_profiles WHERE id = ? AND event_id = ?`,
    body.speakerProfileId,
    event.id
  );
  if (!profile) return c.json({ ok: false, error: 'Speaker not found' }, 404);
  const first = profile.name.split(' ')[0] || profile.name;

  if (body.oneOff) {
    const name = (body.oneOff.name || '').trim();
    if (!name) return c.json({ ok: false, error: 'Name the one-off task first' }, 400);
    await T.stampOneOff(c.env, {
      eventId: event.id,
      speakerProfileId: profile.id,
      spec: { name, type: body.oneOff.type || 'checkbox', due: body.oneOff.due || null },
      actor,
      speakerName: profile.name,
    });
    return c.json({ ok: true, message: `One-off task assigned — ${first} sees it in the portal now · logged` });
  }

  const tpl = await one<T.TaskTemplateRow>(
    c.env.DB,
    `SELECT * FROM task_templates WHERE id = ? AND event_id = ?`,
    body.templateId ?? '',
    event.id
  );
  if (!tpl) return c.json({ ok: false, error: 'Template not found' }, 404);

  let sessionId: string | null = null;
  if (tpl.target === 'session') {
    const s = await one<{ session_id: string }>(
      c.env.DB,
      `SELECT session_id FROM session_speakers WHERE speaker_profile_id = ? LIMIT 1`,
      profile.id
    );
    if (!s) return c.json({ ok: false, error: `${first} has no session yet — session tasks need one` }, 400);
    sessionId = s.session_id;
  }
  const res = await T.stampInstance(c.env, {
    template: tpl,
    eventStart: event.start_date,
    speakerProfileId: tpl.target === 'session' ? null : profile.id,
    sessionId,
    actor,
    detail: profile.name,
  });
  if (!res) return c.json({ ok: false, error: `${first} already has “${tpl.name}”` }, 400);
  return c.json({ ok: true, message: `“${tpl.name}” assigned to ${first} — ${T.dueDesc(tpl)} · logged` });
});

app.post('/app/api/speakers/bulk-assign', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const body = await c.req.json<{ templateId: string; speakerIds: string[] }>();
  const tpl = await one<T.TaskTemplateRow>(
    c.env.DB,
    `SELECT * FROM task_templates WHERE id = ? AND event_id = ?`,
    body.templateId,
    event.id
  );
  if (!tpl) return c.json({ ok: false, error: 'Template not found' }, 404);
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';

  let created = 0;
  let skippedNoSession = 0;
  let skippedOther = 0; // already assigned (or unknown speaker id)
  for (const speakerId of body.speakerIds ?? []) {
    const profile = await one<{ id: string; name: string }>(
      c.env.DB,
      `SELECT id, name FROM speaker_profiles WHERE id = ? AND event_id = ?`,
      speakerId,
      event.id
    );
    if (!profile) {
      skippedOther++;
      continue;
    }
    let sessionId: string | null = null;
    if (tpl.target === 'session') {
      const s = await one<{ session_id: string }>(
        c.env.DB,
        `SELECT session_id FROM session_speakers WHERE speaker_profile_id = ? LIMIT 1`,
        profile.id
      );
      if (!s) {
        skippedNoSession++;
        continue;
      }
      sessionId = s.session_id;
    }
    const res = await T.stampInstance(c.env, {
      template: tpl,
      eventStart: event.start_date,
      speakerProfileId: tpl.target === 'session' ? null : profile.id,
      sessionId,
      actor,
      detail: profile.name,
    });
    if (res) created++;
    else skippedOther++;
  }
  // Report every skip honestly — a silently missing task is a speaker who
  // shows up without slides.
  const parts = [`Created ${created} “${tpl.name}” task${created === 1 ? '' : 's'}`];
  if (skippedNoSession) {
    parts.push(`skipped ${skippedNoSession} speaker${skippedNoSession === 1 ? '' : 's'} with no session`);
  }
  if (skippedOther) parts.push(`skipped ${skippedOther} already assigned`);
  const skipped = skippedNoSession + skippedOther;
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'task',
    subjectId: tpl.id,
    actor,
    action: 'Bulk assignment',
    detail: `“${tpl.name}” · ${created} created${
      skippedNoSession ? `, ${skippedNoSession} skipped (no session)` : ''
    }${skippedOther ? `, ${skippedOther} skipped (already assigned)` : ''}`,
  });
  return c.json({ ok: true, created, skipped, skippedNoSession, message: `${parts.join(' · ')} · logged` });
});

/* ------------------------------------------------------------ task ops */

async function taskContext(c: { env: Ctx['Bindings']; var: Ctx['Variables'] }, taskId: string) {
  const event = c.var.event;
  if (!event) return null;
  const task = await one<T.TaskRow>(
    c.env.DB,
    `SELECT * FROM tasks WHERE id = ? AND event_id = ?`,
    taskId,
    event.id
  );
  if (!task) return null;
  const template = task.template_id
    ? await one<T.TaskTemplateRow>(c.env.DB, `SELECT * FROM task_templates WHERE id = ?`, task.template_id)
    : null;
  const name = template?.name ?? jsonParse<T.OneOffSpec>(task.one_off_json, { name: 'Task', type: 'checkbox' }).name;
  return { event, task, template, name };
}

app.post('/app/api/speakers/task/remove', requireOrgRole('collaborator'), async (c) => {
  const { taskId } = await c.req.json<{ taskId: string }>();
  const ctx = await taskContext(c, taskId);
  if (!ctx) return c.json({ ok: false, error: 'Task not found' }, 404);
  if (ctx.task.status === 'done') return c.json({ ok: false, error: 'Completed tasks are kept for the record' }, 400);
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';
  await run(c.env.DB, `UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?`, now(), taskId);
  await logActivity(c.env.DB, {
    eventId: ctx.event.id,
    subjectType: 'task',
    subjectId: taskId,
    actor,
    action: 'Task removed',
    detail: `“${ctx.name}”`,
  });
  return c.json({ ok: true, message: `“${ctx.name}” removed · logged with actor` });
});

app.post('/app/api/speakers/task/remind', requireOrgRole('collaborator'), async (c) => {
  const { taskId, speakerProfileId } = await c.req.json<{ taskId: string; speakerProfileId: string }>();
  const ctx = await taskContext(c, taskId);
  if (!ctx) return c.json({ ok: false, error: 'Task not found' }, 404);
  if (ctx.task.status === 'done') return c.json({ ok: false, error: 'Already complete — no reminder needed' }, 400);
  const profile = await one<{ id: string; name: string; email: string }>(
    c.env.DB,
    `SELECT id, name, email FROM speaker_profiles WHERE id = ? AND event_id = ?`,
    speakerProfileId,
    ctx.event.id
  );
  if (!profile) return c.json({ ok: false, error: 'Speaker not found' }, 404);
  // Like decisions, reminding is two steps: this queues, Emails → Outbox sends.
  await queueTaskReminder(c.env, {
    eventId: ctx.event.id,
    taskId: ctx.task.id,
    speakerProfileId: profile.id,
    taskName: ctx.name,
    actorName: c.var.user?.name || c.var.user?.email || 'Organizer',
  });
  const queued = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM task_reminder_queue WHERE speaker_profile_id = ?`,
    profile.id
  );
  const others = (queued?.n ?? 1) - 1;
  return c.json({
    ok: true,
    message: others
      ? `Reminder queued: “${ctx.name}” — goes out with ${others} other${others === 1 ? '' : 's'} as ONE email to ${profile.name}, from Emails → Outbox`
      : `Reminder to ${profile.name} queued: “${ctx.name}” — send it from Emails → Outbox`,
  });
});

/**
 * Queue a reminder for every open task the speaker still has — the drawer's
 * "Remind all". Everything queued here goes out as one batched email.
 */
app.post('/app/api/speakers/task/remind-all', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const { speakerProfileId } = await c.req.json<{ speakerProfileId: string }>();
  const profile = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM speaker_profiles WHERE id = ? AND event_id = ?`,
    speakerProfileId,
    event.id
  );
  if (!profile) return c.json({ ok: false, error: 'Speaker not found' }, 404);
  const first = profile.name.split(' ')[0] || profile.name;

  const sessionIds = (
    await all<{ session_id: string }>(
      c.env.DB,
      `SELECT session_id FROM session_speakers WHERE speaker_profile_id = ?`,
      profile.id
    )
  ).map((r) => r.session_id);
  const open = T.dedupeTasks(
    await all<T.TaskRow & { tpl_name: string | null }>(
      c.env.DB,
      `SELECT t.*, tt.name AS tpl_name
         FROM tasks t LEFT JOIN task_templates tt ON tt.id = t.template_id
        WHERE t.event_id = ? AND t.status NOT IN ('cancelled','done')
          AND (t.speaker_profile_id = ?${sessionIds.length ? ` OR t.session_id IN (${sessionIds.map(() => '?').join(',')})` : ''})`,
      event.id,
      profile.id,
      ...sessionIds
    )
  );
  if (!open.length) return c.json({ ok: false, error: `Nothing to remind — ${first} has no open tasks` }, 400);

  const actorName = c.var.user?.name || c.var.user?.email || 'Organizer';
  for (const t of open) {
    const name =
      T.snapshotOf(t)?.name ??
      t.tpl_name ??
      jsonParse<T.OneOffSpec>(t.one_off_json, { name: 'Task', type: 'checkbox' }).name;
    await queueTaskReminder(c.env, {
      eventId: event.id,
      taskId: t.id,
      speakerProfileId: profile.id,
      taskName: name,
      actorName,
    });
  }
  return c.json({
    ok: true,
    message: `${open.length} reminder${open.length === 1 ? '' : 's'} queued for ${first} — they go out as ONE email, from Emails → Outbox`,
  });
});

app.post('/app/api/speakers/task/review', requireOrgRole('collaborator'), async (c) => {
  const body = await c.req.json<{ taskId: string; action: 'approve' | 'changes'; message?: string }>();
  const ctx = await taskContext(c, body.taskId);
  if (!ctx) return c.json({ ok: false, error: 'Task not found' }, 404);
  const actor = c.var.user?.name || c.var.user?.email || 'Organizer';

  if (body.action === 'approve') {
    await T.approveTask(c.env, ctx.task, actor);
    return c.json({ ok: true, message: `“${ctx.name}” approved — the speaker is done here` });
  }

  const message = (body.message || '').trim();
  if (!message) return c.json({ ok: false, error: 'Add a short message — we never deny silently' }, 400);
  await T.requestChanges(c.env, ctx.task, message, actor);

  // Notify every speaker who can act on it (session tasks reach all co-speakers).
  const recipients = ctx.task.speaker_profile_id
    ? await all<{ name: string; email: string }>(
        c.env.DB,
        `SELECT name, email FROM speaker_profiles WHERE id = ?`,
        ctx.task.speaker_profile_id
      )
    : await all<{ name: string; email: string }>(
        c.env.DB,
        `SELECT sp.name, sp.email FROM speaker_profiles sp
           JOIN session_speakers ss ON ss.speaker_profile_id = sp.id WHERE ss.session_id = ?`,
        ctx.task.session_id ?? ''
      );
  for (const r of recipients) {
    await sendEmail(c.env, {
      eventId: ctx.event.id,
      to: r.email,
      toName: r.name,
      templateKey: 'task_nag',
      subject: `Changes requested: “${ctx.name}” — ${ctx.event.name}`,
      text:
        `Hi ${r.name},\n\nWe had a look at your upload for “${ctx.name}” and need one change:\n\n${message}\n\n` +
        `Re-upload from your speaker portal — your previous file is kept as a version:\n${c.env.APP_ORIGIN}/${ctx.event.slug}/portal\n\n— The ${ctx.event.name} program team`,
      subjectType: 'task',
      subjectId: ctx.task.id,
    });
  }
  return c.json({ ok: true, message: `Changes requested — ${recipients.length} speaker emailed · logged` });
});

/* --------------------------------------------------------------- email */

app.post('/app/api/speakers/email', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  const body = await c.req.json<{ speakerProfileId: string; subject: string; body: string }>();
  const profile = await one<{ id: string; name: string; email: string }>(
    c.env.DB,
    `SELECT id, name, email FROM speaker_profiles WHERE id = ? AND event_id = ?`,
    body.speakerProfileId,
    event.id
  );
  if (!profile) return c.json({ ok: false, error: 'Speaker not found' }, 404);
  const subject = (body.subject || '').trim();
  if (!subject) return c.json({ ok: false, error: 'Add a subject line' }, 400);

  const vars = {
    speaker_name: profile.name,
    event_name: event.name,
    portal_link: `${c.env.APP_ORIGIN}/${event.slug}/portal`,
  };
  const res = await sendEmail(c.env, {
    eventId: event.id,
    to: profile.email,
    toName: profile.name,
    templateKey: null,
    subject: renderTemplate(subject, vars),
    text: renderTemplate(body.body || '', vars),
    subjectType: 'speaker',
    subjectId: profile.id,
  });
  await logActivity(c.env.DB, {
    eventId: event.id,
    subjectType: 'speaker',
    subjectId: profile.id,
    actor: c.var.user?.name || c.var.user?.email || 'Organizer',
    action: 'Email sent',
    detail: subject,
  });
  return c.json({
    ok: true,
    message: `Email sent to ${profile.email}${res.status === 'simulated' ? ' (simulated — see the email log)' : ''}`,
  });
});

app.post('/app/api/speakers/test-email', requireOrgRole('collaborator'), async (c) => {
  const event = c.var.event;
  const user = c.var.user;
  if (!event || !user) return c.json({ ok: false, error: 'No event' }, 400);
  const body = await c.req.json<{ subject: string; body: string; taskName?: string }>();
  const sample = {
    speaker_name: user.name || 'Priya Raghavan',
    task_name: body.taskName || 'Upload slides',
    event_name: event.name,
    due_date: T.addDays(T.todayISO(), 7),
    days_left: '7 days',
    portal_link: `${c.env.APP_ORIGIN}/${event.slug}/portal`,
    session_title: 'Edge caching patterns that survive real traffic',
    session_slot: 'Wed 11:20 · Main Hall',
  };
  const res = await sendEmail(c.env, {
    eventId: event.id,
    to: user.email,
    toName: user.name,
    templateKey: 'task_nag',
    subject: `[TEST] ${renderTemplate(body.subject || T.REM_SUBJ, sample)}`,
    text: renderTemplate(body.body || T.REM_BODY, sample),
    subjectType: 'event',
    subjectId: event.id,
  });
  return c.json({
    ok: true,
    message: `Test sent to ${user.email}.${
      res.status === 'simulated' ? ' · simulated, see the email log' : ''
    }`,
  });
});

/* --------------------------------------------------- add from directory */

/**
 * Add picked org contacts to this event as speaker profiles. `addContactToEvent`
 * is idempotent by email, so a contact who is already here is counted, not
 * duplicated.
 */
app.post('/app/speakers/add-from-directory', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.redirect('/app/events/new');
  const form = await c.req.parseBody({ all: true });
  const raw = form.ids;
  const ids = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
    .map((v) => String(v).trim())
    .filter(Boolean)
    .slice(0, DIRECTORY_ADD_MAX);
  if (!ids.length) return redirectWithToast(c, '/app/speakers', 'Pick a contact first');

  // json_each keeps this to two bound parameters — D1 allows 100 per statement.
  const valid = await all<{ id: string }>(
    c.env.DB,
    `SELECT id FROM org_contacts WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))`,
    event.org_id,
    JSON.stringify(ids)
  );

  let added = 0;
  let already = 0;
  for (const row of valid) {
    const res = await addContactToEvent(c.env.DB, row.id, event.id);
    if (!res) continue;
    if (res.created) added++;
    else already++;
  }

  if (added) {
    await logActivity(c.env.DB, {
      eventId: event.id,
      subjectType: 'event',
      subjectId: event.id,
      actor: c.var.user?.name || c.var.user?.email || 'Organizer',
      action: 'Added speakers',
      detail: `${added} from the directory`,
    });
  }

  return redirectWithToast(
    c,
    '/app/speakers',
    `Added ${added} from the directory${already ? ` (${already} already on this event)` : ''}`
  );
});

/* ---------------------------------------------------------- sample file */

app.post('/app/api/speakers/sample', requireOrgRole('admin'), async (c) => {
  const event = c.var.event;
  if (!event) return c.json({ ok: false, error: 'No event' }, 400);
  if (!filesEnabled(c.env)) return c.json({ ok: false, error: 'File storage not yet enabled' }, 400);
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ ok: false, error: 'Pick a file first' }, 400);
  const res = await saveUpload(c.env, {
    eventId: event.id,
    kind: 'sample',
    subjectType: 'task_template',
    subjectId: String(form.get('templateId') || 'new'),
    file,
    uploadedBy: c.var.user?.email ?? null,
    maxMb: 100,
  });
  if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
  return c.json({ ok: true, fileId: res.file.id, filename: res.file.filename });
});

export default app;
