/**
 * /app/embeds list island — toggle enabled state, delete, and auto-open the Get
 * Code dialog for a just-created embed (?code=<id>). Creating lives on
 * /app/embeds/new (public/js/embed-new.js). Copy buttons and dialog open/close
 * come from ui.js.
 */
import { api, toast, openDialog } from './ui.js';

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
