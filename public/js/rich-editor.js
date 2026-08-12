/**
 * Rich-lite WYSIWYG island (DECISIONS C3/R3). The editor is the UX; rich-lite
 * is the allowed output: strong/em, a[href] (https/http/mailto), ul/ol/li,
 * h2/h3, p, br — nothing else. The server re-sanitizes on save
 * (src/lib/rich.ts); this mirror keeps pasted content honest client-side.
 *
 *   import { mountRichEditor } from './rich-editor.js';
 *   mountRichEditor(container, { name: 'body', value: tpl.body });
 *
 * Auto-mounts in place of any `<textarea data-rich-editor>` (the textarea
 * stays in the form, hidden and kept in sync, so plain POSTs keep working).
 * Also wires the template editor page's Editor/Preview toggle when present.
 */
import { api, toast } from './ui.js';

const ALLOWED = { STRONG: 1, B: 1, EM: 1, I: 1, A: 1, UL: 1, OL: 1, LI: 1, H2: 1, H3: 1, P: 1, BR: 1 };
const DROP = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, SVG: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1, NOSCRIPT: 1, SELECT: 1, TEXTAREA: 1 };

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const looksRich = (s) => /<(p|ul|ol|h2|h3|a|strong|em|b|i|br|li)[\s>/]/i.test(s || '');
const safeHref = (v) => (/^(https?:\/\/|mailto:)/i.test(String(v || '').trim()) ? String(v).trim() : null);

/** Upgrade a legacy plain-text body: blank lines → paragraphs, \n → <br>. */
function plainToRich(text) {
  const paras = String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+$/, ''))
    .filter(Boolean)
    .map((p) => `<p>${escText(p).replace(/\n/g, '<br>')}</p>`);
  return paras.join('') || '<p><br></p>';
}

function cleanChildren(parent) {
  let child = parent.firstChild;
  while (child) {
    const next = child.nextSibling;
    if (child.nodeType === Node.TEXT_NODE) {
      child = next;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE || DROP[child.tagName]) {
      parent.removeChild(child);
      child = next;
      continue;
    }
    cleanChildren(child);
    const keepHref = child.tagName === 'A' ? safeHref(child.getAttribute('href')) : null;
    // Google Docs wraps copies in <b style="font-weight:normal"> — not bold.
    const fakeBold = (child.tagName === 'B' || child.tagName === 'STRONG') && /^(normal|400)$/.test(child.style.fontWeight);
    if (ALLOWED[child.tagName] && !fakeBold && (child.tagName !== 'A' || keepHref)) {
      for (let i = child.attributes.length - 1; i >= 0; i--) child.removeAttribute(child.attributes[i].name);
      if (keepHref) child.setAttribute('href', keepHref);
    } else {
      while (child.firstChild) parent.insertBefore(child.firstChild, child); // unwrap, keep content
      parent.removeChild(child);
    }
    child = next;
  }
}

/** Client-side mirror of the server whitelist (paste + submit hygiene). */
export function sanitizeHtml(html) {
  const box = document.createElement('div');
  box.innerHTML = String(html || '');
  cleanChildren(box);
  return box.innerHTML;
}

function ensureStyles() {
  if (document.getElementById('us-rich-style')) return;
  const st = document.createElement('style');
  st.id = 'us-rich-style';
  st.textContent =
    '.us-rich-area{padding:12px 14px;min-height:180px;max-height:60vh;overflow-y:auto;font-size:13px;line-height:1.6;color:#16171d;outline:none;}' +
    '.us-rich-area:focus{box-shadow:inset 0 0 0 1px #4c5fd5;}' +
    '.us-rich-area p{margin:0 0 10px;}' +
    '.us-rich-area h2{font-size:17px;letter-spacing:-0.01em;margin:14px 0 8px;}' +
    '.us-rich-area h3{font-size:14.5px;margin:12px 0 6px;}' +
    '.us-rich-area ul,.us-rich-area ol{margin:0 0 10px;padding-left:22px;}' +
    '.us-rich-area li{margin:0 0 4px;}' +
    '.us-rich-btn{background:none;border:1px solid transparent;padding:3px 8px;font-size:12px;color:#33343c;cursor:pointer;line-height:1.4;}' +
    '.us-rich-btn:hover{border-color:#e2e3e8;}' +
    '.us-rich-btn[data-on]{background:#eef0fb;color:#4c5fd5;}';
  document.head.appendChild(st);
}

/**
 * Mount the editor into `container`. Keeps a hidden `<textarea name>` in sync
 * for form posts. Returns { area, hidden, sync }.
 */
export function mountRichEditor(container, opts) {
  ensureStyles();
  opts = opts || {};
  const value = opts.value || '';
  container.innerHTML = '';
  container.style.cssText += 'border:1px solid #e2e3e8;background:#fff;';

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:2px;flex-wrap:wrap;padding:4px;border-bottom:1px solid #e2e3e8;background:#fafafb;';
  const area = document.createElement('div');
  area.contentEditable = 'true';
  area.className = 'us-rich-area';
  if (opts.minHeight) area.style.minHeight = opts.minHeight;
  area.innerHTML = looksRich(value) ? sanitizeHtml(value) : plainToRich(value);
  const hidden = document.createElement('textarea');
  hidden.name = opts.name || 'body';
  hidden.hidden = true;
  container.append(bar, area, hidden);

  // A cleared document is `<p><br></p>` in the DOM but means "no content" to
  // the server (welcome pages toggle off an empty body) — sync it as ''.
  let notify = false;
  const sync = () => {
    hidden.value = area.textContent.trim() ? area.innerHTML : '';
    if (notify && opts.onChange) opts.onChange(hidden.value);
  };
  const exec = (cmd, val) => {
    area.focus();
    document.execCommand(cmd, false, val);
    sync();
    refresh();
  };
  const closestIn = (sel) => {
    const s = getSelection();
    let node = s && s.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const hit = node && node.closest && node.closest(sel);
    return hit && area.contains(hit) ? hit : null;
  };
  const blockCmd = (tag) => exec('formatBlock', closestIn(tag) ? '<p>' : `<${tag}>`);

  const linkFlow = () => {
    area.focus();
    const existing = closestIn('a');
    const entered = window.prompt('Link URL — https://, http:// or mailto:', existing ? existing.getAttribute('href') : 'https://');
    if (entered === null) return;
    let url = entered.trim();
    if (!url) {
      if (existing) exec('unlink');
      return;
    }
    if (!/^(https?:\/\/|mailto:)/i.test(url)) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) url = 'mailto:' + url;
      else if (/^[\w-]+(\.[\w-]+)+/.test(url)) url = 'https://' + url;
      else return toast('Links must be https://, http:// or mailto:', false);
    }
    const sel = getSelection();
    if (!existing && sel && sel.isCollapsed) exec('insertHTML', `<a href="${escText(url).replace(/"/g, '&quot;')}">${escText(url)}</a>`);
    else exec('createLink', url);
  };

  const buttons = [
    ['B', 'Bold (⌘B)', () => exec('bold'), 'bold', 'font-weight:700;'],
    ['I', 'Italic (⌘I)', () => exec('italic'), 'italic', 'font-style:italic;'],
    ['Link', 'Insert link (⌘K)', linkFlow, 'a', ''],
    ['• List', 'Bulleted list', () => exec('insertUnorderedList'), 'insertUnorderedList', ''],
    ['1. List', 'Numbered list', () => exec('insertOrderedList'), 'insertOrderedList', ''],
    ['H2', 'Heading', () => blockCmd('h2'), 'h2', ''],
    ['H3', 'Subheading', () => blockCmd('h3'), 'h3', ''],
  ].map(([label, title, fn, state, extra]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'us-rich-btn';
    b.title = title;
    b.textContent = label;
    if (extra) b.style.cssText = extra;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    b.addEventListener('click', fn);
    b._state = state;
    bar.appendChild(b);
    return b;
  });

  const refresh = () => {
    for (const b of buttons) {
      let on = false;
      if (b._state === 'a' || b._state === 'h2' || b._state === 'h3') on = !!closestIn(b._state);
      else {
        try {
          on = document.queryCommandState(b._state);
        } catch {
          on = false;
        }
      }
      if (on) b.setAttribute('data-on', '');
      else b.removeAttribute('data-on');
    }
  };

  area.addEventListener('input', sync);
  area.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'b') (e.preventDefault(), exec('bold'));
    else if (k === 'i') (e.preventDefault(), exec('italic'));
    else if (k === 'k') (e.preventDefault(), linkFlow());
  });
  area.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (html) exec('insertHTML', sanitizeHtml(html));
    else if (text) exec('insertHTML', escText(text).replace(/\n/g, '<br>'));
  });
  document.addEventListener('selectionchange', () => {
    const s = getSelection();
    if (s && s.anchorNode && area.contains(s.anchorNode)) refresh();
  });

  const form = container.closest('form');
  if (form)
    form.addEventListener('submit', () => {
      hidden.value = area.textContent.trim() ? sanitizeHtml(area.innerHTML) : '';
    });

  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch {
    /* older engines */
  }
  sync();
  notify = true;
  return { area, hidden, sync };
}

/* ------------------------------------------------- auto-mount + page glue */

for (const src of document.querySelectorAll('textarea[data-rich-editor]')) {
  const holder = document.createElement('div');
  src.parentNode.insertBefore(holder, src);
  const name = src.name;
  const value = src.value;
  const minHeight = src.getAttribute('data-rich-min') || '';
  src.remove();
  mountRichEditor(holder, { name, value, minHeight });
}

/* Editor/Preview toggle on /app/emails/t/:id — snaps between the editor and a
   server-rendered preview of the themed email (dummy variables). */
(() => {
  const editorBtn = document.getElementById('tpl-editor-btn');
  const previewBtn = document.getElementById('tpl-preview-btn');
  const editorPane = document.getElementById('tpl-editor-pane');
  const previewPane = document.getElementById('tpl-preview-pane');
  const frame = document.getElementById('tpl-preview-frame');
  if (!editorBtn || !previewBtn || !editorPane || !previewPane || !frame) return;

  const setTab = (btn, on) => {
    btn.style.background = on ? '#16171d' : '#fff';
    btn.style.color = on ? '#fff' : '#686b74';
  };
  editorBtn.addEventListener('click', () => {
    editorPane.hidden = false;
    previewPane.hidden = true;
    setTab(editorBtn, true);
    setTab(previewBtn, false);
  });
  previewBtn.addEventListener('click', async () => {
    const subject = (document.querySelector('input[name="subject"]') || {}).value || '';
    const body = (document.querySelector('textarea[name="body"]') || {}).value || '';
    try {
      const res = await api('/app/emails/preview', { subject, body });
      const subjectEl = document.getElementById('tpl-preview-subject');
      if (subjectEl) subjectEl.textContent = res.subject;
      frame.srcdoc = res.html;
      editorPane.hidden = true;
      previewPane.hidden = false;
      setTab(previewBtn, true);
      setTab(editorBtn, false);
    } catch (err) {
      toast(err.message, false);
    }
  });
})();
