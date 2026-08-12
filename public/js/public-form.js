/**
 * Public submission form island (track B1) — `Submit.dc.html` behaviour.
 *
 *   · debounced autosave (800 ms) of the whole answer set to /p/api/draft
 *   · auth-lite: the first save asks for an email, creates the speaker account
 *     and emails a draft link (D3)
 *   · conditional show/hide with kept-hidden-values semantics
 *   · live word counters, co-speaker cards, agent mode, headshot/file uploads
 *   · client-side error summary + scroll-to-first-error before the real POST
 *
 * It also exports the renderer the admin builder's Preview mode imports, so the
 * preview and the public form stay one implementation.
 */
import { toast, api } from './ui.js';

/* ------------------------------------------------------------------ shared: conditions */

export function asList(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String).filter((s) => s !== '');
  if (typeof v === 'boolean') return v ? ['true'] : [];
  const s = String(v);
  return s === '' ? [] : [s];
}

export function isAnswered(v) {
  return asList(v).length > 0;
}

export function evalCond(cond, answers) {
  if (!cond) return true;
  const a = answers[cond.src];
  const list = asList(a);
  const val = String(cond.val ?? '');
  const lower = val.toLowerCase();
  switch (cond.op) {
    case 'is answered':
      return isAnswered(a);
    case 'is blank':
      return !isAnswered(a);
    case 'is':
      return list.includes(val);
    case 'is not':
      return isAnswered(a) && !list.includes(val);
    case 'contains':
      return list.some((s) => s === val || s.toLowerCase().includes(lower));
    case 'does not contain':
      return isAnswered(a) && !list.some((s) => s === val || s.toLowerCase().includes(lower));
    case 'gt':
      return list.length > 0 && Number(list[0]) > Number(val);
    case 'lt':
      return list.length > 0 && Number(list[0]) < Number(val);
    default:
      return true;
  }
}

/** Top-down single pass — a hidden source hides everything downstream. */
export function visibleIds(fields, answers) {
  const out = new Set();
  for (const f of fields) {
    if (!f.cond) {
      out.add(f.id);
      continue;
    }
    const exists = fields.some((x) => x.id === f.cond.src);
    const srcVisible = !exists || out.has(f.cond.src);
    if (srcVisible && evalCond(f.cond, answers)) out.add(f.id);
  }
  return out;
}

export function wordCount(s) {
  const t = (s || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

export function requiredWhenVisible(f) {
  return !!f.required || !!(f.cond && f.cond.alsoReq);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Mirrors `src/lib/conditions.ts` validateSubmission for the hard checks the UI shows. */
export function validate(fields, answers, speakers, cap) {
  const ids = visibleIds(fields, answers);
  const errors = {};
  const list = [];
  const fail = (key, msg, summary) => {
    if (errors[key]) return;
    errors[key] = msg;
    list.push(summary);
  };
  for (const f of fields) {
    if (!ids.has(f.id) || f.type === 'HDR' || f.type === 'GRP') continue;
    const v = answers[f.id];
    const V = f.validation || {};
    const req = requiredWhenVisible(f);
    if (f.type === 'CHK') {
      const checked = v === true || v === 'true';
      if ((req || V.mustCheck) && !checked) fail(f.id, 'Must be checked to submit.', `${f.label} — must be checked`);
      continue;
    }
    if (!isAnswered(v)) {
      if (req) fail(f.id, `${f.label} is required.`, `${f.label} — required`);
      continue;
    }
    const first = asList(v)[0] ?? '';
    if (f.type === 'TXT') {
      if (V.minChars && first.trim().length < V.minChars) {
        fail(f.id, `Use at least ${V.minChars} characters.`, `${f.label} — at least ${V.minChars} characters`);
      }
      if (V.maxChars && first.trim().length > V.maxChars) {
        fail(f.id, `Over the ${V.maxChars}-character limit by ${first.trim().length - V.maxChars}.`, `${f.label} — over the ${V.maxChars}-character limit`);
      }
    } else if (f.type === 'LONG' && V.maxWords) {
      const w = wordCount(first);
      if (w > V.maxWords) fail(f.id, `Over the ${V.maxWords}-word limit by ${w - V.maxWords}.`, `${f.label} — over the ${V.maxWords}-word limit`);
    } else if (f.type === 'EML' && !EMAIL_RE.test(first.trim())) {
      fail(f.id, 'Enter a valid email address.', `${f.label} — not a valid email`);
    } else if (f.type === 'NUM') {
      const n = Number(first);
      if (!Number.isFinite(n)) fail(f.id, 'Enter a number.', `${f.label} — not a number`);
      else if (V.min !== undefined && n < V.min) fail(f.id, `Must be ${V.min} or more.`, `${f.label} — must be ${V.min} or more`);
      else if (V.max !== undefined && n > V.max) fail(f.id, `Must be ${V.max} or less.`, `${f.label} — must be ${V.max} or less`);
    } else if (f.type === 'MULTI') {
      const n = asList(v).length;
      if (V.min !== undefined && n < V.min) fail(f.id, `Choose at least ${V.min}.`, `${f.label} — choose at least ${V.min}`);
      if (V.max !== undefined && n > V.max) fail(f.id, `Choose at most ${V.max}.`, `${f.label} — choose at most ${V.max}`);
    }
  }
  const grp = fields.find((f) => f.type === 'GRP');
  if (grp && ids.has(grp.id)) {
    const rows = speakers || [];
    if (!rows.length) fail('speakers', 'Add at least one speaker.', 'Speakers — add at least one speaker');
    if (cap && rows.length > cap) fail('speakers', `At most ${cap} speakers per submission.`, `Speakers — at most ${cap} allowed`);
    rows.forEach((s, i) => {
      const nameOk = !!(s.name || '').trim();
      const emailOk = EMAIL_RE.test((s.email || '').trim());
      if (!nameOk || !emailOk) {
        if (!nameOk) errors[`sp${i}.name`] = 'Name is required.';
        if (!emailOk) errors[`sp${i}.email`] = 'A valid email is required.';
        list.push(`Speaker ${i + 1} — name and a valid email required`);
      }
    });
  }
  return { errors, list };
}

/* ------------------------------------------------------------------ shared: markup */

const INPUT = (bad) =>
  `width:100%;padding:11px 12px;border:1px solid ${bad ? '#e03131' : 'var(--border-strong)'};font-size:14px;background:var(--card);outline-color:var(--primary);font-family:inherit;resize:vertical;`;

export function speakerCardHtml(i, s, opts) {
  const label =
    opts.agentMode && i === 0
      ? 'SPEAKER 1 · THE ACTUAL SPEAKER (YOU MANAGE, THEY GET SPEAKER EMAILS)'
      : `SPEAKER ${i + 1}${i === 0 && !opts.agentMode ? ' · YOU' : ''}`;
  const slot = opts.filesEnabled
    ? `<label style="display:block;border:1px dashed var(--border-strong);padding:12px;text-align:center;font-size:12.5px;color:var(--muted);background:repeating-linear-gradient(45deg,#fdfcfa,#fdfcfa 8px,var(--bg) 8px,var(--bg) 16px);cursor:pointer;">
         <input type="file" accept="image/*" style="display:none;" data-headshot-input>
         <span data-headshot-label><span style="font-family:var(--font-mono);">headshot</span> — tap to upload from camera roll · JPG/PNG · 10 MB</span>
       </label>`
    : `<div title="File storage not yet enabled" style="border:1px dashed var(--border-strong);padding:12px;text-align:center;font-size:12.5px;color:var(--faint);background:repeating-linear-gradient(45deg,#fdfcfa,#fdfcfa 8px,var(--bg) 8px,var(--bg) 16px);cursor:not-allowed;">
         <span style="font-family:var(--font-mono);">headshot</span> — file storage not yet enabled
       </div>`;
  return `<div data-speaker="${i}" style="border:1px solid var(--border-strong);background:var(--card);padding:16px;display:grid;gap:12px;">
    <div style="display:flex;align-items:center;">
      <div data-speaker-label style="font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.1em;color:var(--muted);">${escapeHtml(label)}</div>
      ${i > 0 ? '<button type="button" data-remove-speaker style="margin-left:auto;background:none;border:none;color:var(--muted);font-size:12.5px;cursor:pointer;">Remove</button>' : ''}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div><input name="sp_name[]" value="${escapeHtml(s.name || '')}" placeholder="Full name *" style="${INPUT(false)}"></div>
      <div><input name="sp_email[]" type="email" inputmode="email" value="${escapeHtml(s.email || '')}" placeholder="Email *" style="${INPUT(false)}"></div>
    </div>
    <textarea name="sp_bio[]" rows="2" placeholder="Short bio (shown on the public agenda)" style="width:100%;padding:10px 12px;border:1px solid var(--border-strong);font-size:13.5px;resize:vertical;font-family:inherit;background:var(--card);">${escapeHtml(s.bio || '')}</textarea>
    <input type="hidden" name="sp_headshot[]" value="${escapeHtml(s.headshotFileId || '')}">
    ${slot}
  </div>`;
}

/**
 * Renders a schema the way the public form does — used by the admin builder's
 * Preview mode. `state.answers` is throwaway; `onAnswer` fires on every edit.
 */
export function renderPreview(root, state) {
  const fields = state.fields || [];
  const answers = state.answers || {};
  const vis = visibleIds(fields, answers);
  const kicker = `${(state.eventName || '').toUpperCase()} · ${(state.formName || '').toUpperCase()}`;

  if (state.welcomeOn && !state.started) {
    root.innerHTML = `
      <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;color:var(--primary);margin-bottom:6px;">${escapeHtml(kicker)}</div>
      <div style="font-size:21px;font-weight:700;margin-bottom:18px;">${escapeHtml(state.title || 'Submit a proposal')}</div>
      <div style="font-size:14px;line-height:1.65;color:#33343c;">${state.welcomeHtml || ''}</div>
      <button type="button" data-preview-start style="margin-top:22px;padding:11px 26px;background:var(--primary);color:var(--on-primary);border:none;font-size:14px;font-weight:600;cursor:pointer;">Start →</button>`;
    const start = root.querySelector('[data-preview-start]');
    if (start) start.addEventListener('click', () => state.onStart && state.onStart());
    return;
  }

  const rows = fields
    .filter((f) => vis.has(f.id))
    .map((f) => {
      const req = requiredWhenVisible(f);
      const star = req ? '<span style="color:#c92a2a;">*</span>' : '';
      const fired = f.cond ? '<span style="font-family:var(--font-mono);font-size:10px;color:#b08800;">← CONDITION FIRED</span>' : '';
      const label = f.type === 'GRP' ? 'Speaker name' : f.label;
      const v = answers[f.id];
      let control = '';
      if (f.type === 'HDR') {
        return `<div style="font-family:var(--font-mono);font-size:10.5px;letter-spacing:0.14em;color:var(--muted);border-bottom:1px solid var(--border);padding-bottom:6px;">${escapeHtml(f.label.toUpperCase())}</div>`;
      } else if (f.type === 'SEL') {
        const opts = (f.opts || [])
          .map((o) => `<option value="${escapeHtml(o)}"${String(v ?? '') === o ? ' selected' : ''}>${escapeHtml(o)}</option>`)
          .join('');
        control = `<select data-pv="${f.id}" style="width:100%;padding:9px 10px;border:1px solid #e2e3e8;font-size:13.5px;background:#fff;"><option value="">Choose…</option>${opts}</select>`;
      } else if (f.type === 'MULTI') {
        const chosen = asList(v);
        control = `<div style="display:grid;gap:6px;">${(f.opts || [])
          .map(
            (o) =>
              `<label style="display:flex;gap:8px;font-size:13px;align-items:center;color:#33343c;"><input type="checkbox" data-pv-multi="${f.id}" value="${escapeHtml(o)}"${
                chosen.includes(o) ? ' checked' : ''
              } style="accent-color:var(--primary);">${escapeHtml(o)}</label>`
          )
          .join('')}</div>`;
      } else if (f.type === 'LONG') {
        const words = wordCount(String(v ?? ''));
        control =
          `<textarea data-pv="${f.id}" rows="3" placeholder="${escapeHtml(f.placeholder || '')}" style="width:100%;padding:9px 10px;border:1px solid #e2e3e8;font-size:13.5px;resize:vertical;font-family:inherit;">${escapeHtml(v ?? '')}</textarea>` +
          (f.validation && f.validation.maxWords
            ? `<div style="font-family:var(--font-mono);font-size:10.5px;color:${
                words > f.validation.maxWords ? '#c92a2a' : '#9a9da6'
              };text-align:right;">${words} / ${f.validation.maxWords} words</div>`
            : '');
      } else if (f.type === 'CHK') {
        control = `<label style="display:flex;gap:8px;font-size:13px;align-items:center;color:#33343c;"><input type="checkbox" data-pv-check="${f.id}"${
          v === true || v === 'true' ? ' checked' : ''
        } style="accent-color:var(--primary);">${escapeHtml(f.placeholder || f.label)}</label>`;
        return `<div><div style="font-size:13.5px;font-weight:600;margin-bottom:5px;">${escapeHtml(label)} ${star} ${fired}</div>${control}</div>`;
      } else if (f.type === 'GRP') {
        control = `<input placeholder="Full name" style="width:100%;padding:9px 10px;border:1px solid #e2e3e8;font-size:13.5px;">`;
      } else if (f.type === 'FILE') {
        control = `<div style="border:1px dashed #d8d9de;padding:11px;text-align:center;font-size:12.5px;color:#9a9da6;">Tap to upload${
          f.validation && f.validation.fileExts ? ` · ${escapeHtml(f.validation.fileExts)}` : ''
        }</div>`;
      } else {
        const t = f.type === 'DATE' ? 'date' : f.type === 'NUM' ? 'number' : f.type === 'EML' ? 'email' : 'text';
        control = `<input type="${t}" data-pv="${f.id}" value="${escapeHtml(v ?? '')}" placeholder="${escapeHtml(
          f.placeholder || (f.type === 'URL' ? 'https://…' : '')
        )}" style="width:100%;padding:9px 10px;border:1px solid #e2e3e8;font-size:13.5px;">`;
      }
      return `<div><div style="font-size:13.5px;font-weight:600;margin-bottom:5px;">${escapeHtml(label)} ${star} ${fired}</div>${control}</div>`;
    })
    .join('');

  root.innerHTML = `
    <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;color:var(--primary);margin-bottom:6px;">${escapeHtml(kicker)}</div>
    <div style="font-size:21px;font-weight:700;margin-bottom:18px;">${escapeHtml(state.title || 'Submit a proposal')}</div>
    <div style="display:grid;gap:16px;">${rows}
      <button type="button" style="justify-self:start;padding:11px 26px;background:var(--primary);color:var(--on-primary);border:none;font-size:14px;font-weight:600;cursor:pointer;">Submit session</button>
    </div>`;

  const emit = (id, value) => state.onAnswer && state.onAnswer(id, value);
  root.querySelectorAll('[data-pv]').forEach((el) => {
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => emit(el.getAttribute('data-pv'), el.value));
  });
  root.querySelectorAll('[data-pv-check]').forEach((el) => {
    el.addEventListener('change', () => emit(el.getAttribute('data-pv-check'), el.checked));
  });
  root.querySelectorAll('[data-pv-multi]').forEach((el) => {
    el.addEventListener('change', () => {
      const id = el.getAttribute('data-pv-multi');
      const picked = [...root.querySelectorAll(`[data-pv-multi="${id}"]`)].filter((x) => x.checked).map((x) => x.value);
      emit(id, picked);
    });
  });
}

/* ------------------------------------------------------------------ the public form island */

function init() {
  const dataEl = document.getElementById('pf-data');
  if (!dataEl) return;
  const D = JSON.parse(dataEl.textContent);
  const form = document.getElementById('pf-form');
  if (!form) return;

  const fields = D.fields || [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  let submissionId = D.submissionId || null;
  let saveTimer = null;
  let saving = false;
  let dirty = false;

  const dot = document.getElementById('pf-dot');
  const saveLabel = document.getElementById('pf-save');
  const emailInput = document.getElementById('pf-email');
  const emailBlock = document.getElementById('pf-email-block');
  const speakersWrap = document.getElementById('pf-speakers');
  const addSpeakerBtn = document.getElementById('pf-add-speaker');
  const cap = D.cap || 3;

  function setSaveState(text, colour) {
    if (saveLabel) saveLabel.textContent = text;
    if (dot) dot.style.background = colour;
  }

  /* ---------------------------------------------------------- read state */

  function wrapFor(id) {
    return form.querySelector(`[data-fw="${CSS.escape(id)}"]`);
  }

  function readField(f) {
    const wrap = wrapFor(f.id);
    if (!wrap) return undefined;
    if (f.type === 'MULTI') {
      return [...wrap.querySelectorAll('input[type="checkbox"]')].filter((i) => i.checked).map((i) => i.value);
    }
    if (f.type === 'CHK') {
      const box = wrap.querySelector('input[type="checkbox"]');
      return !!(box && box.checked);
    }
    if (f.type === 'FILE') {
      const hidden = wrap.querySelector('input[type="hidden"]');
      return (hidden ? hidden.value : '').split(',').filter(Boolean);
    }
    const el = wrap.querySelector('input:not([type="hidden"]),textarea,select');
    return el ? el.value : '';
  }

  function readAnswers() {
    const answers = {};
    for (const f of fields) {
      if (f.type === 'HDR' || f.type === 'GRP') continue;
      const v = readField(f);
      if (v !== undefined) answers[f.id] = v;
    }
    return answers;
  }

  function readSpeakers() {
    if (!speakersWrap) return [];
    return [...speakersWrap.querySelectorAll('[data-speaker]')].map((card) => ({
      name: (card.querySelector('[name="sp_name[]"]') || {}).value || '',
      email: (card.querySelector('[name="sp_email[]"]') || {}).value || '',
      bio: (card.querySelector('[name="sp_bio[]"]') || {}).value || '',
      headshotFileId: (card.querySelector('[name="sp_headshot[]"]') || {}).value || null,
    }));
  }

  function agentMode() {
    const box = form.querySelector('[data-agent]');
    return !!(box && box.checked);
  }

  /* ---------------------------------------------------------- conditions */

  function applyConditions() {
    const answers = readAnswers();
    const vis = visibleIds(fields, answers);
    for (const f of fields) {
      const wrap = wrapFor(f.id);
      if (!wrap) continue;
      const show = vis.has(f.id);
      if (wrap.hidden === !show) continue;
      wrap.hidden = !show;
    }
  }

  function updateCounters() {
    form.querySelectorAll('[data-words]').forEach((ta) => {
      const wrap = ta.closest('[data-fw]');
      if (!wrap) return;
      const id = wrap.getAttribute('data-fw');
      const max = Number(ta.getAttribute('data-words'));
      const counter = form.querySelector(`[data-counter="${CSS.escape(id)}"]`);
      if (!counter) return;
      const w = wordCount(ta.value);
      counter.textContent = `${w} / ${max} words`;
      counter.style.color = w > max ? '#c92a2a' : 'var(--muted)';
    });
  }

  /* ---------------------------------------------------------- speakers */

  function renumberSpeakers() {
    if (!speakersWrap) return;
    const cards = [...speakersWrap.querySelectorAll('[data-speaker]')];
    cards.forEach((card, i) => {
      card.setAttribute('data-speaker', String(i));
      const label = card.querySelector('[data-speaker-label]');
      if (label) {
        label.textContent =
          agentMode() && i === 0
            ? 'SPEAKER 1 · THE ACTUAL SPEAKER (YOU MANAGE, THEY GET SPEAKER EMAILS)'
            : `SPEAKER ${i + 1}${i === 0 && !agentMode() ? ' · YOU' : ''}`;
      }
    });
    if (addSpeakerBtn) {
      addSpeakerBtn.hidden = cards.length >= cap;
      addSpeakerBtn.textContent = `+ Add co-speaker (${cards.length}/${cap})`;
    }
  }

  if (addSpeakerBtn) {
    addSpeakerBtn.addEventListener('click', () => {
      const cards = speakersWrap.querySelectorAll('[data-speaker]').length;
      if (cards >= cap) return;
      speakersWrap.insertAdjacentHTML(
        'beforeend',
        speakerCardHtml(cards, { name: '', email: '', bio: '' }, { agentMode: agentMode(), filesEnabled: D.filesEnabled })
      );
      renumberSpeakers();
      queueSave();
    });
  }

  form.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove-speaker]');
    if (rm) {
      e.preventDefault();
      const card = rm.closest('[data-speaker]');
      if (card) card.remove();
      renumberSpeakers();
      queueSave();
    }
  });

  /* ---------------------------------------------------------- uploads */

  async function ensureDraft() {
    if (submissionId) return submissionId;
    await save({ immediate: true });
    return submissionId;
  }

  async function upload(file, extra) {
    const id = await ensureDraft();
    if (!id) return null;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('submissionId', id);
    Object.keys(extra || {}).forEach((k) => fd.append(k, extra[k]));
    const res = await fetch('/p/api/upload', { method: 'POST', body: fd });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok === false) {
      toast((body && body.error) || 'Upload failed', false);
      return null;
    }
    return body;
  }

  form.addEventListener('change', async (e) => {
    const head = e.target.closest('[data-headshot-input]');
    if (head && head.files && head.files[0]) {
      const card = head.closest('[data-speaker]');
      const pos = card ? card.getAttribute('data-speaker') : '0';
      const label = card ? card.querySelector('[data-headshot-label]') : null;
      if (label) label.textContent = 'uploading…';
      const res = await upload(head.files[0], { kind: 'headshot', position: pos });
      if (res && card) {
        const hidden = card.querySelector('[name="sp_headshot[]"]');
        if (hidden) hidden.value = res.id;
        if (label) label.textContent = `${res.filename} — tap to replace`;
        queueSave();
      } else if (label) {
        label.textContent = 'headshot — tap to upload from camera roll · JPG/PNG · 10 MB';
      }
      return;
    }
    const fileInput = e.target.closest('[data-file-input]');
    if (fileInput && fileInput.files && fileInput.files[0]) {
      const fid = fileInput.getAttribute('data-file-input');
      const wrap = wrapFor(fid);
      const label = wrap ? wrap.querySelector(`[data-file-label="${CSS.escape(fid)}"]`) : null;
      if (label) label.textContent = 'uploading…';
      const res = await upload(fileInput.files[0], { kind: 'upload', fieldId: fid });
      if (res && wrap) {
        const hidden = wrap.querySelector('input[type="hidden"]');
        if (hidden) hidden.value = res.id;
        if (label) label.textContent = `${res.filename} — tap to replace`;
        queueSave();
      } else if (label) {
        label.textContent = 'Tap to upload';
      }
    }
  });

  /* ---------------------------------------------------------- autosave */

  async function save(opts) {
    if (!D.allowDrafts) return;
    if (saving) return;
    const email = emailInput ? emailInput.value.trim() : '';
    if (!submissionId && D.needEmail && !EMAIL_RE.test(email)) {
      if (opts && opts.immediate && emailBlock) {
        emailBlock.style.borderColor = '#e03131';
        emailInput.focus();
        toast('Add your email so we can save this draft', false);
      }
      return;
    }
    saving = true;
    dirty = false;
    setSaveState('SAVING…', '#e6a817');
    try {
      const body = await api('/p/api/draft', {
        eventSlug: D.eventSlug,
        formSlug: D.formSlug,
        submissionId,
        email,
        answers: readAnswers(),
        speakers: readSpeakers(),
        agentMode: agentMode(),
      });
      if (body.needEmail) {
        setSaveState('NOT SAVED YET', '#c9cbd3');
        return;
      }
      submissionId = body.submissionId;
      const hidden = document.getElementById('pf-submission-id');
      if (hidden) hidden.value = submissionId;
      if (body.simulatedLink && emailBlock) {
        const note = document.createElement('div');
        note.style.cssText =
          'margin-top:10px;font-family:var(--font-mono);font-size:11px;background:var(--chip);padding:8px 10px;word-break:break-all;';
        note.innerHTML = `Email sending is simulated here — your draft link: <a href="${escapeHtml(body.simulatedLink)}">${escapeHtml(
          body.simulatedLink
        )}</a>`;
        emailBlock.appendChild(note);
      }
      setSaveState('DRAFT SAVED', '#2b8a3e');
    } catch (err) {
      setSaveState('NOT SAVED', '#c92a2a');
      toast(err.message, false);
    } finally {
      saving = false;
      if (dirty) queueSave();
    }
  }

  function queueSave() {
    dirty = true;
    setSaveState('SAVING…', '#e6a817');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save({}), 800);
  }

  /* ---------------------------------------------------------- errors */

  function clearErrors() {
    form.querySelectorAll('[data-err]').forEach((el) => {
      el.textContent = '';
      el.removeAttribute('style');
    });
    form.querySelectorAll('input,textarea,select').forEach((el) => {
      el.style.borderColor = 'var(--border-strong)';
    });
  }

  function showErrors(result) {
    clearErrors();
    const box = document.getElementById('pf-errors');
    if (box) {
      box.hidden = result.list.length === 0;
      box.innerHTML = result.list.length
        ? `<div style="font-weight:700;font-size:13.5px;color:#c92a2a;margin-bottom:6px;">Fix ${result.list.length} thing${
            result.list.length > 1 ? 's' : ''
          } before submitting:</div>` + result.list.map((e) => `<div style="font-size:13px;color:#c92a2a;">· ${escapeHtml(e)}</div>`).join('')
        : '';
    }
    let first = null;
    Object.keys(result.errors).forEach((key) => {
      const m = /^sp(\d+)\.(name|email)$/.exec(key);
      if (m) {
        const card = form.querySelector(`[data-speaker="${m[1]}"]`);
        const el = card && card.querySelector(`[name="sp_${m[2]}[]"]`);
        if (el) {
          el.style.borderColor = '#e03131';
          if (!first) first = el;
        }
        return;
      }
      const slot = form.querySelector(`[data-err="${CSS.escape(key)}"]`);
      if (slot) {
        slot.textContent = result.errors[key];
        slot.style.cssText = 'font-size:12px;color:#c92a2a;margin-top:4px;';
      }
      const wrap = wrapFor(key);
      const el = wrap && wrap.querySelector('input:not([type="hidden"]),textarea,select');
      if (el) {
        el.style.borderColor = '#e03131';
        if (!first) first = el;
      }
      if (!first && wrap) first = wrap;
    });
    const target = result.list.length ? box || first : first;
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------------------------------------------------------- wiring */

  form.addEventListener('input', (e) => {
    if (e.target.closest('#pf-email-block')) {
      // Typing the email doesn't save on its own, but finishing it unblocks
      // the very first autosave.
      if (emailBlock) emailBlock.style.borderColor = 'var(--border-strong)';
      if (!submissionId && EMAIL_RE.test(e.target.value.trim())) queueSave();
      return;
    }
    applyConditions();
    updateCounters();
    queueSave();
  });
  form.addEventListener('change', (e) => {
    if (e.target.type === 'file') return;
    if (e.target.hasAttribute && e.target.hasAttribute('data-agent')) renumberSpeakers();
    applyConditions();
    queueSave();
  });

  form.addEventListener(
    'blur',
    (e) => {
      const el = e.target;
      if (el && el.hasAttribute && el.hasAttribute('data-url') && el.value.trim() && !/^https?:\/\//i.test(el.value.trim())) {
        el.value = `https://${el.value.trim()}`;
        queueSave();
      }
    },
    true
  );

  form.addEventListener('submit', (e) => {
    const answers = readAnswers();
    const speakers = readSpeakers();
    const result = validate(fields, answers, speakers, cap);
    if (D.needEmail && !submissionId) {
      const email = emailInput ? emailInput.value.trim() : '';
      if (!EMAIL_RE.test(email)) {
        result.errors.email = 'We need an email address to send your confirmation.';
        result.list.unshift('Email — required so we can confirm your submission');
      }
    }
    if (result.list.length) {
      e.preventDefault();
      showErrors(result);
      return;
    }
    clearTimeout(saveTimer);
    setSaveState('SUBMITTING…', '#e6a817');
  });

  const start = document.getElementById('pf-start');
  const body = document.getElementById('pf-body');
  if (start && body) {
    start.addEventListener('click', (e) => {
      e.preventDefault();
      start.closest('div').hidden = true;
      body.hidden = false;
      body.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  applyConditions();
  updateCounters();
  renumberSpeakers();
  setSaveState(submissionId ? 'DRAFT SAVED' : D.allowDrafts ? 'NOT SAVED YET' : 'DRAFTS OFF', submissionId ? '#2b8a3e' : '#c9cbd3');
}

init();
