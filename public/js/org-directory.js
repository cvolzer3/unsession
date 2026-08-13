/**
 * Speaker Directory island (`/app/org/contacts`, `/app/org/segments/new`).
 *
 * Three jobs: the bulk-select bar, small conveniences in the import and
 * composer modals, and filtering the contact picker on the segment builder.
 * Search, filters, tabs, segments, creation, import and sends are all plain
 * GET/POST — this file adds nothing they depend on.
 */
import { toast, api, openDialog } from './ui.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------------------------------------------------------- search (server) */

// The contacts table is paginated, so search runs on the server. Typing submits
// the GET form after a pause; Enter still submits it without this.
const SEARCH_DEBOUNCE = 400;
const FOCUS_KEY = 'org-directory:search-focus';

const searchForm = $('#contacts-search');
if (searchForm) {
  const input = searchForm.querySelector('[name=q]');
  const initial = input.value.trim();
  let timer;

  // A debounced submit reloads the page. Put the caret back so typing continues.
  if (sessionStorage.getItem(FOCUS_KEY)) {
    sessionStorage.removeItem(FOCUS_KEY);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (input.value.trim() === initial) return;
      sessionStorage.setItem(FOCUS_KEY, '1');
      searchForm.submit();
    }, SEARCH_DEBOUNCE);
  });

  searchForm.addEventListener('submit', () => clearTimeout(timer));
}

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
  const segSummary = $('#bulk-segment-summary');
  if (segSummary) {
    segSummary.textContent = `Curated segment with ${rows.length} selected contact${rows.length === 1 ? '' : 's'}.`;
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

/* ------------------------------------------------------- segment builder */

// The builder is a plain form. This only filters the rendered rows and counts
// the ticks; ticked contacts stay ticked while you type.
const segQ = $('#seg-q');
const segCount = $('#seg-count');
const segChecks = () => $$('[data-seg-check]');

if (segQ) {
  const segRows = $$('[data-seg-row]');
  const segEmpty = $('#seg-empty');
  segQ.addEventListener('input', () => {
    const q = segQ.value.trim().toLowerCase();
    let shown = 0;
    segRows.forEach((row) => {
      const hit = !q || row.dataset.search.includes(q);
      row.hidden = !hit;
      if (hit) shown++;
    });
    segEmpty.hidden = shown > 0;
  });
}

if (segCount) {
  const syncSegCount = () => {
    const n = segChecks().filter((el) => el.checked).length;
    segCount.textContent = `${n} selected`;
  };
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-seg-check]')) syncSegCount();
  });
  syncSegCount();
}

// Dim the type you are not building, so the active section reads first.
const segSections = $$('[data-seg-section]');
if (segSections.length) {
  const syncSegKind = () => {
    const kind = document.querySelector('[name=kind]:checked')?.value;
    segSections.forEach((s) => {
      s.style.opacity = s.dataset.segSection === kind ? '1' : '0.55';
    });
  };
  document.addEventListener('change', (e) => {
    if (e.target.matches('[name=kind]')) syncSegKind();
  });
  // Ticking a contact means you want a curated segment.
  document.addEventListener('change', (e) => {
    if (!e.target.matches('[data-seg-check]') || !e.target.checked) return;
    const curated = document.querySelector('[name=kind][value=curated]');
    if (curated && !curated.checked) {
      curated.checked = true;
      syncSegKind();
    }
  });
  syncSegKind();
}
