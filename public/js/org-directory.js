/**
 * Speaker Directory island (`/app/org/contacts`).
 *
 * Only two jobs: the bulk-select bar, and small conveniences in the import and
 * composer modals. Search, filters, tabs, segments, creation, import and sends
 * are all plain GET/POST — this file adds nothing they depend on.
 */
import { toast, api, openDialog } from './ui.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ------------------------------------------------------------- bulk select */

const bar = $('#bulk-bar');
const countLabel = $('#bulk-count');
const selectAll = $('#select-all');

function checks() {
  return $$('[data-row-check]');
}

function selected() {
  return checks().filter((el) => el.checked);
}

function syncBar() {
  if (!bar) return;
  const rows = selected();
  bar.hidden = rows.length === 0;
  if (countLabel) countLabel.textContent = `${rows.length} selected`;

  const ids = rows.map((el) => el.value).join(',');
  $$('[data-bulk-ids]').forEach((input) => {
    input.value = ids;
  });

  const list = $('#comm-recipients');
  if (list) {
    list.textContent = rows.map((el) => `${el.dataset.name} <${el.dataset.email}>`).join(', ');
  }
  const label = $('#comm-recip-label');
  if (label) label.textContent = `RECIPIENTS · ${rows.length}`;
  const summary = $('#add-event-summary');
  if (summary) {
    summary.textContent = rows.length === 1 ? '1 CONTACT SELECTED' : `${rows.length} CONTACTS SELECTED`;
  }

  if (selectAll) {
    const all = checks();
    selectAll.checked = all.length > 0 && rows.length === all.length;
    selectAll.indeterminate = rows.length > 0 && rows.length < all.length;
  }
}

document.addEventListener('change', (e) => {
  if (e.target === selectAll) {
    checks().forEach((el) => {
      el.checked = selectAll.checked;
    });
    syncBar();
    return;
  }
  if (e.target.matches('[data-row-check]')) syncBar();
});

const clearBtn = $('#bulk-clear');
if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    checks().forEach((el) => {
      el.checked = false;
    });
    syncBar();
  });
}

// The bulk buttons open their modal only after the ids are copied across.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bulk-open]');
  if (!btn) return;
  e.preventDefault();
  if (!selected().length) {
    toast('Select contacts first', false);
    return;
  }
  syncBar();
  openDialog(btn.getAttribute('data-bulk-open'));
});

syncBar();

/* ------------------------------------------------------------ import modal */

const importFile = $('#import-file');
const importNext = $('#import-next');
if (importFile && importNext) {
  const sync = () => {
    const ready = importFile.files && importFile.files.length > 0;
    importNext.disabled = !ready;
    importNext.style.background = ready ? '#4c5fd5' : '#e2e3e8';
    importNext.style.color = ready ? '#fff' : '#9a9da6';
    importNext.style.cursor = ready ? 'pointer' : 'default';
  };
  importFile.addEventListener('change', sync);
  sync();
}

/* -------------------------------------------------------------- composer */

const previewBtn = $('#comm-preview-btn');
const previewBox = $('#comm-preview');
if (previewBtn && previewBox) {
  previewBtn.addEventListener('click', async () => {
    if (!previewBox.hidden) {
      previewBox.hidden = true;
      previewBtn.textContent = 'Preview first recipient';
      return;
    }
    const first = selected()[0];
    if (!first) {
      toast('Select contacts first', false);
      return;
    }
    const form = previewBtn.closest('form');
    try {
      const res = await api('/app/api/org/contacts/preview', {
        id: first.value,
        subject: form.querySelector('[name=subject]').value,
        body: form.querySelector('[name=body]').value,
      });
      previewBox.textContent = `To: ${res.to}\nSubject: ${res.subject}\n\n${res.body}`;
      previewBox.hidden = false;
      previewBtn.textContent = 'Hide preview';
    } catch (err) {
      toast(err.message, false);
    }
  });
}
