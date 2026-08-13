/**
 * Evaluator queue island (track B3) — loaded by `/{event}/evaluate` and the
 * admin `/app/evaluation?tab=mine` tab, both rendering `views/eval-queue.tsx`.
 *
 * The review card: star rows, keys 1–5 filling the next empty criterion, Enter
 * to submit, and the Skip / Abstain actions. Scores are final, so there is no
 * edit path here — the server rejects a second write anyway. All URLs come
 * from the server-built `#data-evaluate` payload, so either base path works.
 */
import { toast, api, busy, done } from './ui.js';

const node = document.getElementById('data-evaluate');
const DATA = node ? JSON.parse(node.textContent) : null;

document.querySelectorAll('form[data-autosubmit] select').forEach((s) => {
  s.addEventListener('change', () => s.form.submit());
});

if (DATA && DATA.current) card(DATA.current);

function card(current) {
  const scores = {};
  const rows = [...document.querySelectorAll('[data-crit]')];
  const selects = [...document.querySelectorAll('[data-crit-select]')];
  const texts = [...document.querySelectorAll('[data-crit-text]')];
  const submitBtn = document.getElementById('submit-score');
  const note = document.getElementById('note');

  // Free-text criteria are optional; ratings and dropdowns must be filled.
  const required = (c) => c.type !== 'text';

  function paint() {
    rows.forEach((row) => {
      const name = row.getAttribute('data-crit');
      const val = scores[name];
      row.querySelectorAll('[data-star]').forEach((b) => {
        const n = Number(b.getAttribute('data-star'));
        const on = val && n <= val;
        b.style.borderColor = val === n ? '#4c5fd5' : '#e2e3e8';
        b.style.background = on ? '#eef0fb' : '#fff';
        b.style.color = on ? '#4c5fd5' : '#686b74';
      });
    });
    const full = current.criteria.filter(required).every((c) => scores[c.name]);
    submitBtn.style.background = full ? '#4c5fd5' : '#c0c5e8';
    submitBtn.style.cursor = full ? 'pointer' : 'not-allowed';
  }

  rows.forEach((row) => {
    const name = row.getAttribute('data-crit');
    row.querySelectorAll('[data-star]').forEach((b) => {
      b.addEventListener('click', () => {
        scores[name] = Number(b.getAttribute('data-star'));
        paint();
      });
    });
  });

  selects.forEach((sel) => {
    const name = sel.getAttribute('data-crit-select');
    sel.addEventListener('change', () => {
      if (sel.value) scores[name] = sel.value;
      else delete scores[name];
      paint();
    });
  });

  texts.forEach((ta) => {
    const name = ta.getAttribute('data-crit-text');
    ta.addEventListener('input', () => {
      if (ta.value.trim()) scores[name] = ta.value;
      else delete scores[name];
    });
  });

  function go(url, message) {
    const u = new URL(url, location.origin);
    if (message) u.searchParams.set('ok', message);
    location.href = u.pathname + (u.search || '');
  }

  async function submit() {
    const missing = current.criteria.find((c) => required(c) && !scores[c.name]);
    if (missing) {
      toast(`Fill in every criterion first (“${missing.name}” is missing)`, false);
      return;
    }
    busy(submitBtn, 'Submitting…');
    try {
      await api('/p/api/evaluate/score', {
        slug: DATA.slug,
        planId: current.planId,
        submissionId: current.submissionId,
        scores,
        note: note.value,
      });
      go(DATA.back, 'Score submitted');
    } catch (err) {
      toast(err.message, false);
      done(submitBtn);
    }
  }

  submitBtn.addEventListener('click', submit);

  document.getElementById('skip').addEventListener('click', () => {
    go(DATA.skipUrl, 'Skipped');
  });

  document.getElementById('abstain').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, 'Abstaining…');
    try {
      await api('/p/api/evaluate/abstain', {
        slug: DATA.slug,
        planId: current.planId,
        submissionId: current.submissionId,
        note: note.value,
      });
      go(DATA.back, 'Abstained');
    } catch (err) {
      toast(err.message, false);
      done(btn);
    }
  });

  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key >= '1' && e.key <= '5') {
      const scaled = current.criteria.filter((c) => (c.type || 'scale') === 'scale');
      const next = scaled.find((c) => !scores[c.name]) || scaled[scaled.length - 1];
      const n = Number(e.key);
      if (next && n <= (next.scale || 5)) {
        scores[next.name] = n;
        paint();
      }
      return;
    }
    if (e.key === 'Enter') submit();
  });

  paint();
}
