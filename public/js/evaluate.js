/**
 * Evaluator queue island (track B3) — loaded by `/{event}/evaluate` and the
 * admin `/app/evaluation?tab=mine` tab, both rendering `views/eval-queue.tsx`.
 *
 * The review card: star rows, keys 1–5 filling the next empty criterion, Enter
 * to submit, and the Skip / Abstain actions. Scores are final, so there is no
 * edit path here — the server rejects a second write anyway. All URLs come
 * from the server-built `#data-evaluate` payload, so either base path works.
 */
import { toast, api } from './ui.js';

const node = document.getElementById('data-evaluate');
const DATA = node ? JSON.parse(node.textContent) : null;

document.querySelectorAll('form[data-autosubmit] select').forEach((s) => {
  s.addEventListener('change', () => s.form.submit());
});

if (DATA && DATA.current) card(DATA.current);

function card(current) {
  const scores = {};
  const rows = [...document.querySelectorAll('[data-crit]')];
  const submitBtn = document.getElementById('submit-score');
  const note = document.getElementById('note');

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
    const full = current.criteria.every((c) => scores[c.name]);
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

  function go(url, message) {
    const u = new URL(url, location.origin);
    if (message) u.searchParams.set('ok', message);
    location.href = u.pathname + (u.search || '');
  }

  async function submit() {
    const missing = current.criteria.find((c) => !scores[c.name]);
    if (missing) {
      toast(`Score all ${current.criteria.length} criteria first (keys 1–5)`, false);
      return;
    }
    submitBtn.disabled = true;
    try {
      await api('/p/api/evaluate/score', {
        slug: DATA.slug,
        planId: current.planId,
        submissionId: current.submissionId,
        scores,
        note: note.value,
      });
      go(DATA.back, 'Score submitted — next one loaded');
    } catch (err) {
      toast(err.message, false);
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener('click', submit);

  document.getElementById('skip').addEventListener('click', () => {
    go(DATA.skipUrl, 'Skipped — it stays in your queue');
  });

  document.getElementById('abstain').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('/p/api/evaluate/abstain', {
        slug: DATA.slug,
        planId: current.planId,
        submissionId: current.submissionId,
        note: note.value,
      });
      go(DATA.back, 'Abstained — removed from your queue');
    } catch (err) {
      toast(err.message, false);
      btn.disabled = false;
    }
  });

  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key >= '1' && e.key <= '5') {
      const next = current.criteria.find((c) => !scores[c.name]) || current.criteria[current.criteria.length - 1];
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
