/**
 * Command palette. Loaded on every admin page by AdminLayout.
 *
 *   ⌘K / Ctrl+K   jump to any admin page (list read from the sidebar nav)
 *   ⌘L / Ctrl+L   jump to one of the last three submissions
 *
 * Arrow keys move the selection, Enter goes, Escape closes. Keyboard-only —
 * there is deliberately no visible trigger.
 */
import { api } from './ui.js';

const MONO = "'IBM Plex Mono',monospace";
const LABELS = { pages: 'PAGES', subs: 'RECENT SUBMISSIONS' };
const PLACEHOLDERS = { pages: 'Jump to a page…', subs: 'Filter submissions…' };

let overlay = null; // built on first open
let panel, input, labelEl, listEl;
let mode = 'pages';
let items = []; // full set for the current mode
let shown = []; // after filtering
let rows = []; // rendered row elements, parallel to `shown`
let sel = 0;
let prevFocus = null;

/**
 * The sidebar already lists this user's pages (sandbox orgs hide API, roles
 * may differ) — read it instead of keeping a second list. The logo link is
 * svg-only, so the text filter drops it.
 */
function pageItems() {
  const seen = new Set();
  const out = [];
  document.querySelectorAll('#us-sidenav a[href^="/app"]').forEach((a) => {
    const label = a.textContent.trim();
    const href = a.getAttribute('href');
    if (!label || a.querySelector('svg') || seen.has(href)) return;
    seen.add(href);
    out.push({ label, href, meta: href });
  });
  return out;
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
    sel = 0;
    refilter();
  });

  labelEl = document.createElement('div');
  labelEl.style.cssText = `padding:12px 16px 2px;font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;

  listEl = document.createElement('div');
  listEl.id = 'us-palette-list';
  listEl.setAttribute('role', 'listbox');
  listEl.style.cssText = 'max-height:320px;overflow-y:auto;padding:2px 0 8px;';

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Kept from document: ui.js would also close any dialog under the palette.
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[sel]) location.href = shown[sel].href;
    }
  });

  panel.appendChild(input);
  panel.appendChild(labelEl);
  panel.appendChild(listEl);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function note(text) {
  listEl.textContent = '';
  rows = [];
  const el = document.createElement('div');
  el.style.cssText = 'padding:10px 16px;font-size:13px;color:#686b74;';
  el.textContent = text;
  listEl.appendChild(el);
}

function refilter() {
  const q = input.value.trim().toLowerCase();
  shown = q ? items.filter((it) => `${it.label} ${it.num || ''}`.toLowerCase().includes(q)) : items;
  if (sel >= shown.length) sel = 0;
  render();
}

function render() {
  if (!shown.length) {
    note(items.length ? 'No matches' : mode === 'subs' ? 'No submissions yet' : 'No pages');
    return;
  }
  listEl.textContent = '';
  rows = shown.map((it, i) => {
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
    meta.style.cssText = `flex:none;font-family:${MONO};font-size:10px;letter-spacing:0.06em;color:#9a9da6;`;
    meta.textContent = it.status || it.meta || '';
    row.appendChild(meta);

    row.addEventListener('mouseenter', () => {
      if (sel !== i) {
        sel = i;
        paint();
      }
    });
    row.addEventListener('click', () => {
      location.href = it.href;
    });
    listEl.appendChild(row);
    return { row, label };
  });
  paint();
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

async function loadSubs() {
  note('Loading…');
  try {
    const res = await api('/app/api/submissions/recent', undefined, 'GET');
    if (mode !== 'subs' || overlay.hidden) return; // closed or switched while fetching
    items = (res.submissions || []).map((s) => ({
      label: s.title || 'Untitled',
      href: `/app/submissions?open=${s.id}`,
      num: s.num,
      status: (s.status || '').replace(/_/g, ' ').toUpperCase(),
    }));
    refilter();
  } catch (err) {
    note(err.message);
  }
}

function open(next) {
  if (!overlay) build();
  if (overlay.hidden) prevFocus = document.activeElement;
  mode = next;
  overlay.hidden = false;
  input.value = '';
  input.placeholder = PLACEHOLDERS[mode];
  labelEl.textContent = LABELS[mode];
  sel = 0;
  if (mode === 'pages') {
    items = pageItems();
    refilter();
  } else {
    items = [];
    shown = [];
    loadSubs();
  }
  input.focus();
}

function close() {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  prevFocus = null;
}

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k !== 'k' && k !== 'l') return;
  // The rich editor claims ⌘K for its link flow and preventDefaults first.
  if (e.defaultPrevented) return;
  e.preventDefault();
  const next = k === 'k' ? 'pages' : 'subs';
  if (overlay && !overlay.hidden && mode === next) close();
  else open(next);
});
