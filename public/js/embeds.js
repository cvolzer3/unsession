/**
 * /app/embeds island — create embeds, toggle enabled state, delete, and
 * auto-open the Get Code dialog for a just-created embed (?code=<id>).
 * Copy buttons and dialog open/close come from ui.js.
 */
import { api, toast, openDialog } from './ui.js';

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

document.querySelectorAll('input[name="ne-widget"]').forEach((radio) => {
  radio.addEventListener('change', syncFields);
});
syncFields();

const createBtn = document.getElementById('ne-create');
if (createBtn) {
  createBtn.addEventListener('click', async () => {
    const widget = currentWidget();
    const tracks = [...document.querySelectorAll('[data-ne-track]:checked')].map((cb) => cb.value);
    // Unticked visible field boxes become the hide-list.
    const hide = [...document.querySelectorAll(`[data-ne-field-for="${widget}"] [data-ne-field]`)]
      .filter((cb) => !cb.checked)
      .map((cb) => cb.value);
    const accentOn = document.getElementById('ne-accent-on').checked;
    createBtn.disabled = true;
    try {
      const res = await api('/app/api/embeds/create', {
        name: document.getElementById('ne-name').value,
        widget,
        format: document.getElementById('ne-format').value,
        config: {
          transparent: document.getElementById('ne-transparent').checked,
          accent: accentOn ? document.getElementById('ne-accent').value : null,
          tracks,
          hide,
        },
      });
      location.href = '/app/embeds?ok=' + encodeURIComponent('Embed created') + '&code=' + encodeURIComponent(res.id);
    } catch (err) {
      toast(err.message, false);
      createBtn.disabled = false;
    }
  });
}

document.addEventListener('change', async (e) => {
  const cb = e.target.closest('[data-embed-toggle]');
  if (!cb) return;
  const row = cb.closest('[data-embed-row]');
  try {
    const res = await api('/app/api/embeds/toggle', { id: cb.dataset.embedToggle, enabled: cb.checked });
    const state = row && row.querySelector('[data-embed-state]');
    if (state) {
      state.textContent = res.enabled ? 'ON' : 'OFF';
      state.style.color = res.enabled ? '#2b8a3e' : '#9a9da6';
    }
    toast(res.enabled ? 'Embed enabled' : 'Embed disabled — its snippet now renders nothing');
  } catch (err) {
    cb.checked = !cb.checked;
    toast(err.message, false);
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-embed-delete]');
  if (!btn || e.defaultPrevented) return; // data-confirm (ui.js) already declined
  try {
    await api('/app/api/embeds/delete', { id: btn.dataset.embedDelete });
    const row = btn.closest('[data-embed-row]');
    if (row) row.remove();
    toast('Embed deleted');
  } catch (err) {
    toast(err.message, false);
  }
});

// Freshly created embed → open its Get Code dialog straight away.
const codeId = new URL(location.href).searchParams.get('code');
if (codeId) {
  openDialog('#code-' + codeId);
  if (history.replaceState) {
    const u = new URL(location.href);
    u.searchParams.delete('code');
    history.replaceState({}, '', u.pathname + (u.search || ''));
  }
}
