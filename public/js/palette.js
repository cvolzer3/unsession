/**
 * Command palette. Loaded on every admin page by AdminLayout.
 *
 *   ⌘K / Ctrl+K   open the palette: the last three submissions on top, then
 *                 every admin page (read from the sidebar nav) with its jump
 *                 shortcut
 *   ⌘L / Ctrl+L   the same palette, submissions only
 *   ⌘<letter>     jump straight to one page — the KEYS table below; each
 *                 palette row shows its own combo
 *
 * Arrow keys move the selection across sections, Enter goes, Escape closes.
 * Keyboard-only — there is deliberately no visible trigger.
 *
 * The recent-submissions list is prefetched at every page load and carried
 * across navigations in sessionStorage (scoped to the active event via the
 * us-event-id meta tag), so opening the palette never waits on the network.
 */
import { api } from './ui.js';

const MONO = "'IBM Plex Mono',monospace";
const STORE = 'us-palette-subs';
const EVENT_ID = document.querySelector('meta[name="us-event-id"]')?.content || '';
const PLACEHOLDERS = { pages: 'Jump to…', subs: 'Filter submissions…' };
const LABEL_CSS = `padding:12px 16px 2px;font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const IS_MAC = /Mac|iP/.test(navigator.platform);

/**
 * Per-page jump shortcuts, keyed by sidebar href. ⌘/Ctrl + first letter where
 * it is free; colliding letters (S, E, F, D) move their second page to the
 * ⇧ tier. T/W/N stay with the browser (not interceptable) and A/C/V/X/Z stay
 * with the clipboard, so Team, Speakers, Agenda and API use in-word letters.
 */
const KEYS = {
  '/app': 'd',
  '/app/setup': 'u', // setUp
  '/app/forms': 'f',
  '/app/emails': 'e',
  '/app/submissions': 's',
  '/app/evaluation': 'shift+e',
  '/app/sessions': 'shift+s',
  '/app/speakers': 'shift+k', // speaKers
  '/app/files': 'shift+f',
  '/app/agenda': 'g', // aGenda
  '/app/embeds': 'b', // emBeds
  '/app/org/contacts': 'shift+d', // Directory
  '/app/org/pipeline': 'p',
  '/app/team': 'shift+m', // teaM
  '/app/api': 'i', // apI
};

function keyLabel(spec) {
  const shift = spec.startsWith('shift+');
  const letter = spec.slice(shift ? 6 : 0).toUpperCase();
  return IS_MAC ? `⌘${shift ? '⇧' : ''}${letter}` : `Ctrl+${shift ? 'Shift+' : ''}${letter}`;
}

const isEditable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));

let overlay = null; // built on first open
let panel, input, listEl;
let mode = 'pages';
/** Sections: { label, items, filtered, note } — `note` renders when no rows do. */
let groups = [];
let shown = []; // flattened filtered items across groups
let rows = []; // rendered row elements, parallel to `shown`
let sel = 0;
let moved = false; // arrows/typing since open — keeps selection put on async updates
let prevFocus = null;
let fetchSeq = 0; // ignores stale recent-submissions responses
let subsCache = null; // null until the first fetch (or sessionStorage) delivers

/**
 * The sidebar already lists this user's pages (sandbox orgs hide API, roles
 * may differ) — read it instead of keeping a second list. The logo link is
 * svg-only, so the text filter drops it. A page absent from the sidebar also
 * loses its KEYS shortcut, since the jump handler matches against this list.
 */
let pages = null;
function pageItems() {
  if (pages) return pages;
  const seen = new Set();
  const out = [];
  document.querySelectorAll('#us-sidenav a[href^="/app"]').forEach((a) => {
    const label = a.textContent.trim();
    const href = a.getAttribute('href');
    if (!label || a.querySelector('svg') || seen.has(href)) return;
    seen.add(href);
    const spec = KEYS[href];
    out.push({
      label,
      href,
      shift: !!spec && spec.startsWith('shift+'),
      letter: spec ? spec.slice(spec.startsWith('shift+') ? 6 : 0) : null,
      keyLabel: spec ? keyLabel(spec) : '',
    });
  });
  return (pages = out);
}

function build() {
  overlay = document.createElement('div');
  overlay.id = 'us-palette';
  overlay.hidden = true;
  overlay.style.cssText = 'position:fixed;inset:0;z-index:76;background:rgba(22,23,29,0.45);';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Command palette');
  panel.style.cssText =
    'width:min(520px,calc(100vw - 32px));margin:14vh auto 0;background:#fff;border:1px solid #e2e3e8;box-shadow:0 24px 64px rgba(22,23,29,0.35);';

  input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'us-palette-list');
  input.setAttribute('aria-label', 'Command palette search');
  input.autocomplete = 'off';
  input.style.cssText =
    'display:block;width:100%;border:none;outline:none;background:none;padding:14px 16px;font-size:15px;font-family:inherit;color:#16171d;border-bottom:1px solid #eceded;';
  input.addEventListener('input', () => {
    moved = true;
    refilter(false);
  });

  listEl = document.createElement('div');
  listEl.id = 'us-palette-list';
  listEl.setAttribute('role', 'listbox');
  listEl.style.cssText = 'max-height:360px;overflow-y:auto;padding:2px 0 8px;';

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Kept from document: ui.js would also close any dialog under the palette.
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      moved = true;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[sel]) location.href = shown[sel].href;
    }
  });

  panel.appendChild(input);
  panel.appendChild(listEl);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function noteEl(text) {
  const el = document.createElement('div');
  el.style.cssText = 'padding:8px 16px;font-size:13px;color:#686b74;';
  el.textContent = text;
  return el;
}

function refilter(preserve) {
  const q = input.value.trim().toLowerCase();
  const keep = preserve ? shown[sel] : null;
  for (const g of groups) {
    g.filtered = q ? g.items.filter((it) => `${it.label} ${it.num || ''}`.toLowerCase().includes(q)) : g.items;
  }
  shown = groups.flatMap((g) => g.filtered);
  sel = keep ? Math.max(0, shown.indexOf(keep)) : 0;
  render();
}

function render() {
  listEl.textContent = '';
  rows = [];
  let any = false;
  for (const g of groups) {
    if (!g.filtered.length && !g.note) continue; // e.g. no submissions in ⌘K view
    any = true;
    const lab = document.createElement('div');
    lab.style.cssText = LABEL_CSS;
    lab.textContent = g.label;
    listEl.appendChild(lab);
    if (!g.filtered.length) {
      listEl.appendChild(noteEl(g.note));
      continue;
    }
    for (const it of g.filtered) listEl.appendChild(makeRow(it, rows.length));
  }
  if (!any) listEl.appendChild(noteEl('No matches'));
  paint();
}

function makeRow(it, i) {
  const row = document.createElement('div');
  row.id = `us-palette-opt-${i}`;
  row.setAttribute('role', 'option');
  row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 16px;cursor:pointer;';

  if (it.num) {
    const num = document.createElement('span');
    num.style.cssText = `flex:none;font-family:${MONO};font-size:11px;color:#9a9da6;`;
    num.textContent = it.num;
    row.appendChild(num);
  }
  const label = document.createElement('span');
  label.style.cssText =
    'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;color:#16171d;';
  label.textContent = it.label;
  row.appendChild(label);
  const meta = document.createElement('span');
  meta.style.cssText = it.keyLabel
    ? `flex:none;font-family:${MONO};font-size:10px;color:#686b74;background:#f1f3f5;padding:2px 6px;`
    : `flex:none;font-family:${MONO};font-size:10px;letter-spacing:0.06em;color:#9a9da6;`;
  meta.textContent = it.status || it.keyLabel || '';
  row.appendChild(meta);

  row.addEventListener('mouseenter', () => {
    if (sel !== i) {
      moved = true;
      sel = i;
      paint();
    }
  });
  row.addEventListener('click', () => {
    location.href = it.href;
  });
  rows.push({ row, label });
  return row;
}

function paint() {
  rows.forEach(({ row, label }, i) => {
    const on = i === sel;
    row.style.background = on ? '#eef0fb' : '';
    row.setAttribute('aria-selected', on ? 'true' : 'false');
    label.style.color = on ? '#4c5fd5' : '#16171d';
    label.style.fontWeight = on ? '600' : '400';
  });
  input.setAttribute('aria-activedescendant', rows[sel] ? `us-palette-opt-${sel}` : '');
  if (rows[sel]) rows[sel].row.scrollIntoView({ block: 'nearest' });
}

/**
 * Fetch the list and store it. Runs once at every page load; open() calls it
 * again only when that fetch has not delivered anything yet.
 */
function refreshSubs() {
  if (!EVENT_ID) {
    subsCache = subsCache || []; // no active event — nothing to fetch
    return;
  }
  const token = ++fetchSeq;
  api('/app/api/submissions/recent', undefined, 'GET')
    .then((res) => {
      if (token !== fetchSeq) return;
      subsCache = (res.submissions || []).map((s) => ({
        label: s.title || 'Untitled',
        href: `/app/submissions?open=${s.id}`,
        num: s.num,
        status: (s.status || '').replace(/_/g, ' ').toUpperCase(),
      }));
      try {
        sessionStorage.setItem(STORE, JSON.stringify({ event: EVENT_ID, subs: subsCache }));
      } catch {
        // storage full or blocked — the in-page cache still works
      }
      syncSubsGroup(null);
    })
    .catch((err) => {
      if (token === fetchSeq) syncSubsGroup(err.message);
    });
}

/** Repaint an open palette's RECENT SUBMISSIONS section in place. */
function syncSubsGroup(error) {
  if (!overlay || overlay.hidden) return;
  const g = groups[0];
  if (!g || !g.subs) return;
  if (subsCache) {
    g.items = subsCache;
    g.note = subsCache.length || mode !== 'subs' ? null : 'No submissions yet';
  } else if (error && !g.items.length) {
    g.note = error;
  }
  // Selection follows the top only while the user has not touched anything.
  refilter(moved);
}

function open(next) {
  if (!overlay) build();
  if (overlay.hidden) prevFocus = document.activeElement;
  mode = next;
  overlay.hidden = false;
  input.value = '';
  input.placeholder = PLACEHOLDERS[next];
  moved = false;
  sel = 0;
  const subsGroup = {
    subs: true,
    label: 'RECENT SUBMISSIONS',
    items: subsCache || [],
    note: subsCache ? (subsCache.length || next !== 'subs' ? null : 'No submissions yet') : 'Loading…',
  };
  groups = next === 'pages' ? [subsGroup, { label: 'PAGES', items: pageItems(), note: null }] : [subsGroup];
  // The page-load prefetch already ran — retry only if it never delivered.
  if (!subsCache) refreshSubs();
  refilter(false);
  input.focus();
}

function close() {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  prevFocus = null;
}

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.repeat) return;
  // The rich editor claims ⌘K/⌘B/⌘I for its own commands and preventDefaults first.
  if (e.defaultPrevented) return;
  const k = e.key.toLowerCase();

  if (!e.shiftKey && (k === 'k' || k === 'l')) {
    e.preventDefault();
    const next = k === 'k' ? 'pages' : 'subs';
    if (overlay && !overlay.hidden && mode === next) close();
    else open(next);
    return;
  }

  // Page jumps run anywhere except while typing — unless the palette itself
  // has focus, where the row hints invite exactly these keys.
  if (isEditable(e.target) && !(overlay && !overlay.hidden)) return;
  const hit = pageItems().find((it) => it.letter === k && it.shift === e.shiftKey);
  if (hit) {
    e.preventDefault();
    location.href = hit.href;
  }
});

// Prefetch at every page load, seeded from the last navigation's copy so the
// palette opens complete even before this refresh lands.
try {
  const saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
  if (saved && saved.event === EVENT_ID && Array.isArray(saved.subs)) subsCache = saved.subs;
} catch {
  // unreadable saved copy — the fetch below rebuilds it
}
refreshSubs();
