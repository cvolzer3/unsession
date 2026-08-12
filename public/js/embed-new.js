/**
 * /app/embeds/new island — live preview of the unsaved draft, plus the create
 * POST. The preview passes the draft display config inline as `?cfg=` (see
 * `draftConfig` in src/routes/public-embed.tsx), so nothing is written to the
 * `embeds` table until Create embed is pressed. The widget × format → URL
 * mapping comes from the server as `data-preview-urls`.
 */
import { api, toast } from './ui.js';

const preview = document.getElementById('ne-preview');
const frame = document.getElementById('ne-frame');
const dataBox = document.getElementById('ne-data');
const urlLine = document.getElementById('ne-url');
const createBtn = document.getElementById('ne-create');
const formatSel = document.getElementById('ne-format');
const urls = JSON.parse((preview && preview.dataset.previewUrls) || '{}');

/** Formats served as HTML go in the iframe; the rest are feeds shown as text. */
const HTML_FORMATS = new Set(['styled', 'basic']);

function currentWidget() {
  const checked = document.querySelector('input[name="ne-widget"]:checked');
  return checked ? checked.value : 'sessions';
}

/** Only the field checkboxes that apply to the chosen widget are visible. */
function syncFields() {
  const widget = currentWidget();
  document.querySelectorAll('[data-ne-field-for]').forEach((label) => {
    label.hidden = label.dataset.neFieldFor !== widget;
  });
}

function draftConfig() {
  const widget = currentWidget();
  // Unticked visible field boxes become the hide-list.
  const hide = [...document.querySelectorAll(`[data-ne-field-for="${widget}"] [data-ne-field]`)]
    .filter((cb) => !cb.checked)
    .map((cb) => cb.value);
  return {
    transparent: document.getElementById('ne-transparent').checked,
    accent: document.getElementById('ne-accent-on').checked ? document.getElementById('ne-accent').value : null,
    tracks: [...document.querySelectorAll('[data-ne-track]:checked')].map((cb) => cb.value),
    hide,
  };
}

function previewUrl() {
  const template = urls[`${currentWidget()}:${formatSel.value}`];
  if (!template) return null;
  return template.replace('__CFG__', encodeURIComponent(JSON.stringify(draftConfig())));
}

// A slow feed fetch must never overwrite the preview of a newer draft.
let seq = 0;

async function render() {
  const url = previewUrl();
  if (!url || !frame) return;
  urlLine.textContent = location.origin + url;
  if (HTML_FORMATS.has(formatSel.value)) {
    dataBox.hidden = true;
    frame.hidden = false;
    frame.src = url;
    return;
  }
  frame.hidden = true;
  dataBox.hidden = false;
  const mine = ++seq;
  dataBox.textContent = 'Loading…';
  try {
    const res = await fetch(url);
    const text = await res.text();
    if (mine === seq) dataBox.textContent = text;
  } catch (err) {
    if (mine === seq) dataBox.textContent = `Preview failed: ${err.message}`;
  }
}

let timer = null;
function onEdit(e) {
  if (!e.target.matches || !e.target.matches('input,select')) return;
  if (e.target.id === 'ne-name') return; // the name is not display config

  if (e.target.name === 'ne-widget') syncFields();
  clearTimeout(timer);
  timer = setTimeout(render, 300);
}

document.addEventListener('change', onEdit);
// The colour picker only fires `change` on some browsers once the dialog closes.
document.addEventListener('input', onEdit);
syncFields();

if (createBtn) {
  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    try {
      const res = await api('/app/api/embeds/create', {
        name: document.getElementById('ne-name').value,
        widget: currentWidget(),
        format: formatSel.value,
        config: draftConfig(),
      });
      location.href = '/app/embeds?ok=' + encodeURIComponent('Embed created') + '&code=' + encodeURIComponent(res.id);
    } catch (err) {
      toast(err.message, false);
      createBtn.disabled = false;
    }
  });
}
