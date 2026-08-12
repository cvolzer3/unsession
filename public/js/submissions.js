/**
 * Submissions island (B2) — filtering, selection, the detail drawer, the
 * decision modal, internal comments with @-mentions, the group-mail composer
 * and CSV import/export.
 *
 * The server renders every row; this file only shows, hides, reorders and
 * decorates them, so the page works (filtered by query params) without JS.
 */
import { api, toast, openDialog, closeDialog } from './ui.js';

const node = document.getElementById('data-submissions');
if (node) boot(JSON.parse(node.textContent));

function boot(DATA) {
  const MONO = "'IBM Plex Mono',monospace";
  const rowsEl = document.getElementById('rows');
  const rowEls = rowsEl ? Array.from(rowsEl.querySelectorAll('[data-row]')) : [];
  const original = rowEls.slice();

  const state = {
    status: DATA.filter.status || 'all',
    form: DATA.filter.form || 'all',
    track: DATA.filter.track || 'all',
    q: (DATA.filter.q || '').toLowerCase(),
    sortScore: false,
    sel: new Set(),
    decision: null,
    drawer: null,
    mail: null,
    import: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const plural = (n) => (n === 1 ? '' : 's');
  const rowById = (id) => DATA.rows.find((r) => r.id === id);

  /* ------------------------------------------------------------ filtering */

  const countLabel = $('#count-label');
  const chips = Array.from(document.querySelectorAll('[data-chip]'));
  const bulkBar = $('#bulk-bar');
  const bulkCount = $('#bulk-count');
  const scoreArrow = $('#score-arrow');

  function matches(el) {
    const d = el.dataset;
    if (state.status !== 'all' && d.status !== state.status) return false;
    if (state.form !== 'all' && d.form !== state.form) return false;
    if (state.track !== 'all' && d.track !== state.track) return false;
    if (state.q && !(d.search || '').includes(state.q)) return false;
    return true;
  }

  function paintChips() {
    chips.forEach((chip) => {
      const on = chip.dataset.chip === state.status;
      chip.style.border = `1px solid ${on ? '#4c5fd5' : '#e2e3e8'}`;
      chip.style.background = on ? '#eef0fb' : '#fff';
      chip.style.color = on ? '#4c5fd5' : '#33343c';
      chip.style.fontWeight = on ? '600' : '400';
    });
  }

  function render() {
    let shown = 0;
    rowEls.forEach((el) => {
      const on = matches(el);
      el.style.display = on ? 'grid' : 'none';
      if (on) shown++;
      const picked = state.sel.has(el.dataset.id);
      el.style.background = picked ? '#eef0fb' : '#fff';
      const box = el.querySelector('[data-check]');
      if (box) box.checked = picked;
    });
    if (countLabel) countLabel.textContent = `${shown} of ${DATA.total ?? rowEls.length} shown`;
    paintChips();
    const checkAll = $('#check-all');
    if (checkAll) {
      const vis = rowEls.filter((el) => el.style.display !== 'none');
      checkAll.checked = vis.length > 0 && vis.every((el) => state.sel.has(el.dataset.id));
    }
    if (bulkBar) {
      bulkBar.hidden = state.sel.size === 0;
      if (bulkCount) bulkCount.textContent = `${state.sel.size} selected`;
    }
  }

  function applySort() {
    if (!rowsEl) return;
    const list = state.sortScore
      ? rowEls.slice().sort((a, b) => score(b) - score(a))
      : original;
    list.forEach((el) => rowsEl.appendChild(el));
    if (scoreArrow) scoreArrow.textContent = state.sortScore ? '↓' : '';
  }
  const score = (el) => (el.dataset.score === '' ? -1 : parseFloat(el.dataset.score));

  /** Past ROW_CAP rows the server owns filtering — round-trip through the URL. */
  function reloadFiltered() {
    const p = new URLSearchParams();
    if (state.status !== 'all') p.set('status', state.status);
    if (state.form !== 'all') p.set('form', state.form);
    if (state.track !== 'all') p.set('track', state.track);
    if (state.q) p.set('q', state.q);
    const qs = p.toString();
    location.href = `/app/submissions${qs ? `?${qs}` : ''}`;
  }
  const changed = () => (DATA.serverFilter ? reloadFiltered() : render());

  chips.forEach((chip) =>
    chip.addEventListener('click', () => {
      state.status = chip.dataset.chip;
      changed();
    })
  );
  const formSel = $('#filter-form');
  if (formSel)
    formSel.addEventListener('change', () => {
      state.form = formSel.value;
      changed();
    });
  const trackSel = $('#filter-track');
  if (trackSel)
    trackSel.addEventListener('change', () => {
      state.track = trackSel.value;
      changed();
    });
  const qInput = $('#filter-q');
  if (qInput) {
    let t;
    qInput.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.q = qInput.value.trim().toLowerCase();
        changed();
      }, DATA.serverFilter ? 400 : 120);
    });
  }
  const sortBtn = $('#sort-score');
  if (sortBtn)
    sortBtn.addEventListener('click', () => {
      state.sortScore = !state.sortScore;
      applySort();
    });

  /* ------------------------------------------------------------ selection */

  rowEls.forEach((el) => {
    const box = el.querySelector('[data-check]');
    if (box) {
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        if (box.checked) state.sel.add(el.dataset.id);
        else state.sel.delete(el.dataset.id);
        render();
      });
    }
    el.addEventListener('click', () => openDrawer(el.dataset.id));
  });

  const checkAll = $('#check-all');
  if (checkAll)
    checkAll.addEventListener('change', () => {
      const vis = rowEls.filter((el) => el.style.display !== 'none');
      const all = vis.length > 0 && vis.every((el) => state.sel.has(el.dataset.id));
      state.sel.clear();
      if (!all) vis.forEach((el) => state.sel.add(el.dataset.id));
      render();
    });

  const clearBtn = $('#bulk-clear');
  if (clearBtn)
    clearBtn.addEventListener('click', () => {
      state.sel.clear();
      render();
    });

  document.querySelectorAll('[data-bulk]').forEach((btn) =>
    btn.addEventListener('click', () => openDecision(btn.dataset.bulk, Array.from(state.sel)))
  );

  /* --------------------------------------------------------------- drawer */

  const drawer = $('#drawer');
  const drawerPanel = $('#drawer-panel');
  const backdrop = $('#drawer-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeDrawer);

  function closeDrawer() {
    state.drawer = null;
    if (drawer) drawer.hidden = true;
  }

  // ui.js only knows about [data-dialog]; the drawer closes on Escape too.
  // Capture phase so this runs before ui.js hides open dialogs: when a modal
  // is layered above the drawer, Escape closes only the modal.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !drawer || drawer.hidden) return;
      if (document.querySelector('[data-dialog]:not([hidden])')) return;
      closeDrawer();
    },
    true
  );

  async function openDrawer(id) {
    if (!drawer || !drawerPanel) return;
    state.drawer = id;
    drawerPanel.innerHTML = `<div style="padding:24px;font-size:13px;color:#9a9da6;">Loading…</div>`;
    drawer.hidden = false;
    drawerPanel.scrollTop = 0;
    try {
      const res = await api(`/app/api/submissions/${encodeURIComponent(id)}`, undefined, 'GET');
      if (state.drawer !== id) return;
      drawerPanel.innerHTML = drawerHtml(res.sub);
      wireDrawer(res.sub);
    } catch (err) {
      drawerPanel.innerHTML = `<div style="padding:24px;font-size:13px;color:#c92a2a;">${esc(err.message)}</div>`;
    }
  }

  function card(label, inner) {
    return `<div style="border:1px solid #e2e3e8;padding:10px 12px;"><div style="font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;">${label}</div><div style="font-size:13px;font-weight:600;margin-top:3px;display:flex;align-items:center;gap:6px;">${inner}</div></div>`;
  }
  const micro = (text) =>
    `<div style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:8px;">${text}</div>`;

  function fileRow(f, last) {
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;${last ? '' : 'border-bottom:1px solid #f2f3f5;'}">
      <div style="flex:none;width:34px;height:34px;background:#eef0f3;display:grid;place-items:center;font-family:${MONO};font-size:9.5px;color:#686b74;">${esc(f.ext)}</div>
      <div style="min-width:0;flex:1;"><div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(f.name)}</div><div style="font-family:${MONO};font-size:10.5px;color:#9a9da6;">${esc(f.size)}</div></div>
      <a href="/files/${esc(f.id)}" style="font-size:12px;font-weight:600;color:#4c5fd5;text-decoration:none;">Download</a>
    </div>`;
  }

  function drawerHtml(s) {
    const actions = DATA.canWrite
      ? `<div style="display:flex;gap:8px;margin-top:14px;">
          <button type="button" data-drawer-action="accept" style="padding:7px 14px;background:#2b8a3e;color:#fff;border:none;font-size:12.5px;font-weight:600;cursor:pointer;">Accept…</button>
          <button type="button" data-drawer-action="waitlist" style="padding:7px 14px;background:#fff;color:#9c36b5;border:1px solid #dcc3e4;font-size:12.5px;font-weight:600;cursor:pointer;">Waitlist…</button>
          <button type="button" data-drawer-action="decline" style="padding:7px 14px;background:#fff;color:#c92a2a;border:1px solid #ecc5c5;font-size:12.5px;font-weight:600;cursor:pointer;">Decline…</button>
        </div>`
      : '';

    const answers = s.answers.length
      ? `<div>${micro('ANSWERS')}<div style="display:grid;gap:12px;">${s.answers
          .map(
            (a) => `<div>
              <div style="font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#9a9da6;">${esc(a.label.toUpperCase())}</div>
              ${
                a.files && a.files.length
                  ? `<div style="border:1px solid #e2e3e8;display:grid;margin-top:6px;">${a.files
                      .map((f, i) => fileRow(f, i === a.files.length - 1))
                      .join('')}</div>`
                  : `<div style="font-size:13px;color:#33343c;line-height:1.5;margin-top:3px;white-space:pre-wrap;">${esc(a.value)}</div>`
              }
            </div>`
          )
          .join('')}</div></div>`
      : '';

    const uploads = s.uploads.length
      ? `<div>${micro('UPLOADS')}<div style="border:1px solid #e2e3e8;display:grid;">${s.uploads
          .map((f, i) => fileRow(f, i === s.uploads.length - 1))
          .join('')}</div></div>`
      : '';

    const speakers = `<div>${micro('SPEAKERS')}${s.speakers
      .map(
        (sp) => `<div style="display:flex;gap:12px;border:1px solid #e2e3e8;padding:12px;margin-bottom:8px;">
          ${
            sp.headshot
              ? `<img src="${esc(sp.headshot)}" alt="" style="width:38px;height:38px;object-fit:cover;flex-shrink:0;">`
              : `<div style="width:38px;height:38px;background:#eef0fb;color:#4c5fd5;display:grid;place-items:center;font-weight:700;font-size:13px;flex-shrink:0;">${esc(sp.initials)}</div>`
          }
          <div><div style="font-size:13.5px;font-weight:600;">${esc(sp.name)}</div><div style="font-family:${MONO};font-size:11px;color:#9a9da6;">${esc(sp.email)}</div><div style="font-size:12.5px;color:#686b74;margin-top:3px;">${esc(sp.bio)}</div></div>
        </div>`
      )
      .join('')}</div>`;

    const criteria = s.evaluation.criteria
      .map(
        (c) => `<div style="display:grid;grid-template-columns:86px 1fr 28px;gap:8px;align-items:center;font-size:12px;color:#686b74;">
          <div>${esc(c.name)}</div>
          <div style="height:5px;background:#eef0f3;"><div style="height:5px;width:${c.pct}%;background:#4c5fd5;"></div></div>
          <div style="font-family:${MONO};font-size:11px;">${esc(c.val)}</div>
        </div>`
      )
      .join('');

    const evaluation = `<div>${micro(`EVALUATION · ${esc(s.evaluation.label)}`)}
      <div style="border:1px solid #e2e3e8;padding:14px;display:flex;gap:18px;align-items:center;">
        <div style="font-size:28px;font-weight:700;font-family:${MONO};">${esc(s.evaluation.avg)}</div>
        <div style="flex:1;display:grid;gap:6px;">${
          criteria || `<div style="font-size:12px;color:#9a9da6;">No evaluations in yet.</div>`
        }</div>
      </div></div>`;

    const comments = `<div>${micro('INTERNAL COMMENTS · TEAM ONLY')}
      <div id="comment-list">${s.comments.map(commentHtml).join('')}</div>
      <div style="display:flex;gap:8px;position:relative;">
        <input id="comment-input" placeholder="Comment… use @ to mention teammates" autocomplete="off" style="flex:1;padding:8px 12px;border:1px solid #e2e3e8;font-size:13px;outline-color:#4c5fd5;">
        <button type="button" id="comment-post" style="padding:8px 14px;background:#16171d;color:#fff;border:none;font-size:12.5px;cursor:pointer;">Post</button>
        <div id="mention-menu" hidden style="position:absolute;bottom:calc(100% + 4px);left:0;width:260px;background:#fff;border:1px solid #e2e3e8;box-shadow:0 8px 24px rgba(22,23,29,0.12);z-index:5;max-height:180px;overflow-y:auto;"></div>
      </div></div>`;

    const activity = `<div>${micro('ACTIVITY LOG')}${s.activity
      .map(
        (a) => `<div style="display:flex;gap:10px;font-size:12.5px;padding:5px 0;border-bottom:1px solid #f2f3f5;">
          <div style="font-family:${MONO};font-size:11px;color:#9a9da6;min-width:74px;">${esc(a.when)}</div>
          <div style="color:#33343c;">${esc(a.text)}</div>
        </div>`
      )
      .join('')}</div>`;

    return `<div style="padding:20px 24px;border-bottom:1px solid #e2e3e8;position:sticky;top:0;background:#fff;z-index:2;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <span style="font-family:${MONO};font-size:11.5px;color:#9a9da6;">${esc(s.num)}</span>
          <span style="${esc(s.badge)}">${esc(s.statusLabel)}</span>
          <button type="button" data-drawer-close style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;">✕</button>
        </div>
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;line-height:1.25;">${esc(s.title)}</div>
        ${actions}
      </div>
      <div style="padding:20px 24px;display:grid;gap:20px;">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
          ${card('TRACK', `<span style="display:inline-block;width:8px;height:8px;background:${esc(s.trackColor)};"></span>${esc(s.trackName)}`)}
          ${card('FORMAT', esc(s.format))}
          ${card('LEVEL', esc(s.level))}
        </div>
        <div>
          <div style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:6px;">ABSTRACT</div>
          <div style="font-size:14px;line-height:1.55;color:#33343c;white-space:pre-wrap;">${esc(s.abstract)}</div>
        </div>
        ${answers}
        ${uploads}
        ${speakers}
        ${evaluation}
        ${comments}
        ${activity}
      </div>`;
  }

  function commentHtml(c) {
    return `<div style="border-left:2px solid #e2e3e8;padding:2px 0 2px 12px;margin-bottom:10px;">
      <div style="font-size:13px;color:#33343c;">${esc(c.text)}</div>
      <div style="font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:2px;">${esc(c.who)} · ${esc(c.when)}</div>
    </div>`;
  }

  function wireDrawer(s) {
    drawerPanel.querySelectorAll('[data-drawer-close]').forEach((b) => b.addEventListener('click', closeDrawer));
    drawerPanel
      .querySelectorAll('[data-drawer-action]')
      .forEach((b) => b.addEventListener('click', () => openDecision(b.dataset.drawerAction, [s.id])));

    const input = drawerPanel.querySelector('#comment-input');
    const post = drawerPanel.querySelector('#comment-post');
    const list = drawerPanel.querySelector('#comment-list');
    const menu = drawerPanel.querySelector('#mention-menu');
    if (!input || !post || !list || !menu) return;

    const hideMenu = () => {
      menu.hidden = true;
      menu.innerHTML = '';
    };

    function mentionQuery() {
      const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
      const at = upto.lastIndexOf('@');
      if (at < 0) return null;
      const frag = upto.slice(at + 1);
      if (/\s/.test(frag)) return null;
      return { at, frag: frag.toLowerCase() };
    }

    function showMentions() {
      const q = mentionQuery();
      if (!q) return hideMenu();
      const hits = DATA.members
        .filter((m) => !q.frag || m.name.toLowerCase().includes(q.frag) || m.email.toLowerCase().includes(q.frag))
        .slice(0, 6);
      if (!hits.length) return hideMenu();
      menu.innerHTML = hits
        .map(
          (m) => `<button type="button" data-mention="${esc(m.name)}" style="display:block;width:100%;text-align:left;padding:8px 10px;background:#fff;border:none;border-bottom:1px solid #f2f3f5;cursor:pointer;font-size:12.5px;">
            <span style="font-weight:600;">${esc(m.name)}</span> <span style="font-family:${MONO};font-size:10.5px;color:#9a9da6;">${esc(m.email)}</span>
          </button>`
        )
        .join('');
      menu.hidden = false;
      menu.querySelectorAll('[data-mention]').forEach((b) =>
        b.addEventListener('click', () => {
          const q2 = mentionQuery();
          if (!q2) return hideMenu();
          const before = input.value.slice(0, q2.at);
          const after = input.value.slice((input.selectionStart ?? input.value.length));
          input.value = `${before}@${b.dataset.mention} ${after}`;
          hideMenu();
          input.focus();
        })
      );
    }

    input.addEventListener('input', showMentions);
    input.addEventListener('blur', () => setTimeout(hideMenu, 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) {
        e.stopPropagation();
        hideMenu();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!menu.hidden) {
        const first = menu.querySelector('[data-mention]');
        if (first) return first.click();
      }
      submit();
    });
    post.addEventListener('click', submit);

    async function submit() {
      const body = input.value.trim();
      if (!body) return;
      post.disabled = true;
      try {
        const res = await api('/app/api/submissions/comment', { submissionId: s.id, body });
        list.insertAdjacentHTML('beforeend', commentHtml(res.comment));
        input.value = '';
        hideMenu();
        toast(res.mentioned.length ? `Comment posted · ${res.mentioned.length} teammate${plural(res.mentioned.length)} notified` : 'Comment posted');
      } catch (err) {
        toast(err.message, false);
      } finally {
        post.disabled = false;
      }
    }
  }

  /* ------------------------------------------------------- decision modal */

  const VERB = { accept: 'Accept', decline: 'Decline', waitlist: 'Waitlist' };
  const DONE = { accept: 'Accepted', decline: 'Declined', waitlist: 'Waitlisted' };
  const COLOR = { accept: '#2b8a3e', decline: '#c92a2a', waitlist: '#9c36b5' };

  function summaryFor(kind, n) {
    const s = plural(n);
    if (kind === 'accept')
      return `On send: status → Accepted · ${n} email${s} queued (background job) · confirmation loop opens · logged to activity.`;
    if (kind === 'decline')
      return `On send: status → Declined · ${n} email${s} queued · individual feedback merged per recipient · logged to activity.`;
    return `On send: status → Waitlisted · ${n} email${s} queued · promoting later re-runs the accept flow · logged to activity.`;
  }

  function openDecision(kind, ids) {
    if (!VERB[kind]) return;
    if (!ids.length) return toast('Select at least one submission first.', false);
    const rows = ids.map(rowById).filter(Boolean);
    if (!rows.length) return;
    const tpl = DATA.templates[kind] || { name: kind, subject: '', body: '' };
    const n = rows.length;

    $('#decision-heading').textContent = `${VERB[kind]} ${n} submission${plural(n)}`;
    $('#decision-recip-label').textContent = `RECIPIENTS · ${n} — CHECK THIS LIST. THIS EMAIL CANNOT BE UNSENT.`;
    $('#decision-recipients').innerHTML = rows
      .map((r) => {
        const sp = r.speakers[0] || { name: 'No speaker on file', email: '—' };
        return `<div style="border:1px solid #e2e3e8;padding:10px 12px;margin-bottom:6px;">
          <div style="display:flex;gap:8px;align-items:baseline;">
            <span style="font-size:13px;font-weight:600;">${esc(sp.name)}</span>
            <span style="font-family:${MONO};font-size:11px;color:#9a9da6;">${esc(sp.email)}</span>
            <span style="font-size:12px;color:#686b74;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;">${esc(r.title)}</span>
          </div>
          ${
            kind === 'decline'
              ? `<input data-feedback="${esc(r.id)}" placeholder="Optional individual feedback for this speaker…" style="margin-top:8px;width:100%;padding:7px 10px;border:1px solid #e2e3e8;font-size:12.5px;outline-color:#4c5fd5;">`
              : ''
          }
        </div>`;
      })
      .join('');
    $('#decision-template').textContent = `TEMPLATE “${tpl.name}” — editable per send`;
    $('#decision-subject').value = tpl.subject || '';
    const body = $('#decision-body');
    body.value = tpl.body || '';
    body.rows = Math.min(22, (tpl.body || '').split('\n').length + 1);
    $('#decision-vars').textContent =
      'Variables resolve per recipient: {{speaker_name}} {{session_title}} ' +
      (kind === 'accept' ? '{{confirmation_link}}' : kind === 'decline' ? '{{individual_feedback}}' : '');
    const confirmRow = $('#decision-confirm-row');
    confirmRow.hidden = kind !== 'accept';
    $('#decision-request-confirmation').checked = true;
    $('#decision-summary').textContent = summaryFor(kind, n);
    const send = $('#decision-send');
    send.style.background = COLOR[kind];
    send.textContent = `Send ${n} email${plural(n)} & update status`;

    state.decision = { kind, ids: rows.map((r) => r.id) };
    openDialog('#decision-modal'); // layers above the drawer, which stays open
  }

  const sendBtn = $('#decision-send');
  if (sendBtn)
    sendBtn.addEventListener('click', async () => {
      if (!state.decision) return;
      const { kind, ids } = state.decision;
      const feedback = {};
      document.querySelectorAll('[data-feedback]').forEach((el) => {
        if (el.value.trim()) feedback[el.dataset.feedback] = el.value.trim();
      });
      const payload = {
        decision: kind,
        subject: $('#decision-subject').value,
        body: $('#decision-body').value,
        feedback,
        requestConfirmation: $('#decision-request-confirmation').checked,
      };
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      try {
        let updated = 0;
        let emailed = 0;
        let simulated = 0;
        for (let i = 0; i < ids.length; i += 50) {
          const res = await api('/app/api/submissions/decide', { ...payload, ids: ids.slice(i, i + 50) });
          updated += res.result.updated;
          emailed += res.result.emailed;
          simulated += res.result.simulated;
        }
        const note = simulated
          ? ` — sending is simulated, open Emails → Log for the ${simulated > 1 ? 'messages' : 'message'}`
          : '';
        const msg = `${emailed} email${plural(emailed)} queued · ${updated} → ${DONE[kind]} · activity logged${note}`;
        location.href = `/app/submissions?ok=${encodeURIComponent(msg)}`;
      } catch (err) {
        toast(err.message, false);
        sendBtn.disabled = false;
        sendBtn.textContent = `Send ${ids.length} email${plural(ids.length)} & update status`;
      }
    });

  /* ----------------------------------------------------------- group mail */

  function openMail(ids) {
    if (!ids.length) return toast('Select at least one submission first.', false);
    const rows = ids.map(rowById).filter(Boolean);
    const recipients = [];
    const seen = new Set();
    rows.forEach((r) =>
      r.speakers.forEach((sp) => {
        const key = (sp.email || '').toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        recipients.push({ name: sp.name, email: sp.email, title: r.title });
      })
    );
    state.mail = { ids: rows.map((r) => r.id), recipients };
    $('#mail-recip-label').textContent = `RECIPIENTS · ${recipients.length} SPEAKER${
      recipients.length === 1 ? '' : 'S'
    } OF ${rows.length} SUBMISSION${plural(rows.length).toUpperCase()}`;
    $('#mail-recipients').innerHTML = recipients
      .map(
        (r) =>
          `<div style="padding:2px 0;"><span style="font-weight:600;color:#16171d;">${esc(r.name)}</span> <span style="font-family:${MONO};font-size:11px;color:#9a9da6;">${esc(r.email)}</span></div>`
      )
      .join('');
    $('#mail-template').value = '';
    $('#mail-subject').value = '';
    $('#mail-body').value = '';
    $('#mail-preview').hidden = true;
    $('#mail-send').textContent = `Send ${recipients.length} email${plural(recipients.length)}`;
    openDialog('#mail-modal'); // layers above the drawer, which stays open
  }

  const mailTemplate = $('#mail-template');
  if (mailTemplate)
    mailTemplate.addEventListener('change', () => {
      const tpl = DATA.mailTemplates.find((t) => t.key === mailTemplate.value);
      $('#mail-subject').value = tpl ? tpl.subject : '';
      $('#mail-body').value = tpl ? tpl.body : '';
    });

  const previewToggle = $('#mail-preview-toggle');
  if (previewToggle)
    previewToggle.addEventListener('click', () => {
      const box = $('#mail-preview');
      if (!box.hidden) {
        box.hidden = true;
        previewToggle.textContent = 'Preview first recipient';
        return;
      }
      const first = (state.mail && state.mail.recipients[0]) || { name: 'Speaker', email: '', title: 'Session title' };
      const vars = {
        speaker_name: first.name,
        first_name: (first.name || '').split(/\s+/)[0],
        session_title: first.title,
        event_name: DATA.eventName,
        portal_link: `${DATA.origin}/${DATA.eventSlug}/portal`,
      };
      const fill = (s) => (s || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, k) => (vars[k] === undefined ? all : vars[k]));
      box.textContent = `To: ${first.name} <${first.email}>\nSubject: ${fill($('#mail-subject').value)}\n\n${fill(
        $('#mail-body').value
      )}`;
      box.hidden = false;
      previewToggle.textContent = 'Hide preview';
    });

  const mailSend = $('#mail-send');
  if (mailSend)
    mailSend.addEventListener('click', async () => {
      if (!state.mail) return;
      mailSend.disabled = true;
      try {
        const res = await api('/app/api/submissions/mail', {
          ids: state.mail.ids,
          templateKey: mailTemplate ? mailTemplate.value : '',
          subject: $('#mail-subject').value,
          body: $('#mail-body').value,
        });
        closeDialog('#mail-modal');
        toast(
          res.simulated
            ? `${res.sent} email${plural(res.sent)} queued · sending is simulated, see Emails → Log`
            : `${res.sent} email${plural(res.sent)} queued`
        );
      } catch (err) {
        toast(err.message, false);
      } finally {
        mailSend.disabled = false;
      }
    });

  const bulkEmail = $('#bulk-email');
  if (bulkEmail) bulkEmail.addEventListener('click', () => openMail(Array.from(state.sel)));

  /* ---------------------------------------------------------------- CSV */

  function exportUrl(ids) {
    const p = new URLSearchParams();
    if (ids && ids.length) p.set('ids', ids.join(','));
    else {
      if (state.status !== 'all') p.set('status', state.status);
      if (state.form !== 'all') p.set('form', state.form);
      if (state.track !== 'all') p.set('track', state.track);
      if (state.q) p.set('q', state.q);
    }
    const qs = p.toString();
    return `/app/api/submissions/export.csv${qs ? `?${qs}` : ''}`;
  }

  const exportBtn = $('#btn-export');
  if (exportBtn)
    exportBtn.addEventListener('click', () => {
      location.href = exportUrl(null);
      toast('Export ready — check your downloads');
    });
  const exportSel = $('#bulk-export');
  if (exportSel)
    exportSel.addEventListener('click', () => {
      location.href = exportUrl(Array.from(state.sel));
      toast(`Exporting ${state.sel.size} submission${plural(state.sel.size)}`);
    });

  /* Minimal RFC-4180 reader for the mapping preview; the server re-parses the
     same text with lib/csv.ts before writing anything. */
  function parseCsv(text) {
    const src = text.replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += ch;
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
    return rows;
  }

  const importModal = $('#import-modal');
  const importFile = $('#import-file');
  const importForm = $('#import-form');
  const importRun = $('#import-run');

  function openImport() {
    if (!importModal) return;
    state.import = null;
    if (importFile) importFile.value = '';
    $('#import-mapping-wrap').hidden = true;
    $('#import-preview').hidden = true;
    if (importRun) importRun.disabled = true;
    openDialog('#import-modal');
  }
  const importBtn = $('#btn-import');
  if (importBtn) importBtn.addEventListener('click', openImport);
  const emptyImport = $('#empty-import');
  if (emptyImport)
    emptyImport.addEventListener('click', (e) => {
      e.preventDefault();
      openImport();
    });

  function guessTarget(header, fields) {
    const h = header.toLowerCase().trim();
    if (!h) return 'ignore';
    if (h.includes('email')) return 'speaker_email';
    if (h === 'status') return 'status';
    if (h.includes('abstract') || h.includes('description')) return 'abstract';
    if (h.includes('title')) return 'title';
    if (h.includes('speaker') || h === 'name') return 'speaker_name';
    const field = fields.find((f) => f.label.toLowerCase() === h);
    return field ? `field:${field.id}` : 'ignore';
  }

  function renderMapping() {
    if (!state.import) return;
    const form = DATA.forms.find((f) => f.id === importForm.value) || DATA.forms[0];
    const fields = form ? form.fields : [];
    const wrap = $('#import-mapping');
    wrap.innerHTML = state.import.headers
      .map((h, i) => {
        const guess = guessTarget(h, fields);
        const opts = [
          ['ignore', 'Ignore'],
          ['title', 'Session title'],
          ['abstract', 'Abstract'],
          ['speaker_name', 'Speaker name'],
          ['speaker_email', 'Speaker email'],
          ['status', 'Status'],
          ...fields.map((f) => [`field:${f.id}`, `Field · ${f.label}`]),
        ];
        return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center;">
          <div style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(h || `Column ${i + 1}`)}</div>
          <select data-map="${i}" style="padding:6px 8px;border:1px solid #e2e3e8;background:#fff;font-size:12.5px;">
            ${opts
              .map(([v, l]) => `<option value="${esc(v)}"${v === guess ? ' selected' : ''}>${esc(l)}</option>`)
              .join('')}
          </select>
        </div>`;
      })
      .join('');
    $('#import-mapping-wrap').hidden = false;
    const preview = $('#import-preview');
    preview.textContent = `${state.import.rows.length} row${plural(state.import.rows.length)} ready · first: “${
      (state.import.rows[0] || []).find((c) => c.trim()) || '—'
    }”`;
    preview.hidden = false;
    importRun.disabled = state.import.rows.length === 0;
  }

  if (importFile)
    importFile.addEventListener('change', async () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;
      const text = await file.text();
      const rows = parseCsv(text);
      if (!rows.length) {
        toast('That file had no rows', false);
        return;
      }
      state.import = {
        text,
        headers: rows[0].map((h) => h.trim()),
        rows: rows.slice(1).filter((r) => r.some((c) => c.trim() !== '')),
      };
      renderMapping();
    });
  if (importForm) importForm.addEventListener('change', renderMapping);

  if (importRun)
    importRun.addEventListener('click', async () => {
      if (!state.import) return;
      const mapping = state.import.headers.map((_, i) => {
        const sel = document.querySelector(`[data-map="${i}"]`);
        return sel ? sel.value : 'ignore';
      });
      importRun.disabled = true;
      try {
        const res = await api('/app/api/submissions/import', {
          text: state.import.text,
          formId: importForm.value,
          mapping,
        });
        location.href = `/app/submissions?ok=${encodeURIComponent(
          `${res.created} submission${plural(res.created)} imported from CSV`
        )}`;
      } catch (err) {
        toast(err.message, false);
        importRun.disabled = false;
      }
    });

  /* ------------------------------------------------------------ deep links */

  render();
  applySort();

  if (DATA.open) {
    const target = rowById(DATA.open);
    if (target) {
      if (VERB[DATA.action]) openDecision(DATA.action, [DATA.open]);
      else openDrawer(DATA.open);
    } else {
      toast('That submission is not in this event', false);
    }
    if (history.replaceState) {
      const u = new URL(location.href);
      u.searchParams.delete('open');
      u.searchParams.delete('action');
      history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    }
  }
}
