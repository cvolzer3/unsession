/**
 * Speakers & Tasks island (`/app/speakers`).
 *
 * The grid, its legend and the template cards are server-rendered; this file
 * owns the interactive parts of `Speakers.dc.html`: filtering + pagination over
 * the rendered rows, the speaker drawer, the task-template editor drawer with
 * its apply-to-open-instances dialog, bulk assignment, the reminder-email
 * editor and the file review loop.
 */
import { toast, api, openDialog, closeDialog } from './ui.js';

const DATA = JSON.parse(document.getElementById('data-speakers').textContent);
const MONO = "'IBM Plex Mono',monospace";
const PAGE = 8;

const CELL = {
  c: 'background:#2b8a3e;color:#fff;',
  p: 'background:#e2e3e8;color:#9a9da6;',
  o: 'background:#c92a2a;color:#fff;',
  r: 'background:#fdf5dc;border:1px solid #e8d79a;color:#b08800;',
  '-': 'background:#fafafb;border:1px solid #eceded;color:#c9cbd2;',
};
const GLYPH = { c: '✓', p: '·', o: '!', r: '⋯', '-': '' };
const TIPS = { c: 'Complete', p: 'To do', o: 'Overdue', r: 'Pending review', '-': 'Not assigned' };
const STATE_COLOR = { c: '#2b8a3e', p: '#9a9da6', o: '#c92a2a', r: '#b08800' };
const TYPE_LABEL = { checkbox: 'CHECK', file: 'FILE', form: 'FORM', profile: 'AUTO' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

const seg = (on) =>
  `padding:8px 6px;font-size:12px;cursor:pointer;border:1px solid ${on ? '#4c5fd5' : '#e2e3e8'};background:${
    on ? '#eef0fb' : '#fff'
  };color:${on ? '#4c5fd5' : '#33343c'};font-weight:${on ? '600' : '400'};`;
const card = (on) =>
  `padding:9px 10px;text-align:left;cursor:pointer;border:1px solid ${on ? '#4c5fd5' : '#e2e3e8'};background:${
    on ? '#eef0fb' : '#fff'
  };color:#16171d;`;
const box = (on) =>
  `display:inline-grid;place-items:center;width:20px;height:20px;border:1.5px solid ${on ? '#4c5fd5' : '#c9cbd2'};background:${
    on ? '#4c5fd5' : '#fff'
  };color:#fff;font-size:12px;flex:none;margin-top:1px;`;
const boxOf = (s) =>
  `display:inline-grid;place-items:center;width:22px;height:22px;font-size:12px;flex:none;${CELL[s]}font-family:${MONO};`;
const filterStyle = (on) =>
  `padding:6px 8px;font-size:12.5px;cursor:pointer;border:1px solid ${on ? '#4c5fd5' : '#e2e3e8'};background:${
    on ? '#eef0fb' : '#fff'
  };color:${on ? '#4c5fd5' : '#33343c'};font-weight:${on ? '600' : '400'};`;
const pgBtn = (on) =>
  `padding:6px 12px;font-size:12px;border:1px solid #e2e3e8;background:#fff;${
    on ? 'color:#33343c;cursor:pointer;' : 'color:#c9cbd2;cursor:default;'
  }`;

function reload(message) {
  location.href = '/app/speakers' + (message ? '?ok=' + encodeURIComponent(message) : '');
}

/* ------------------------------------------------------------ the grid */

const rowsEls = $$('[data-row]');
const rows = rowsEls.map((el) => ({
  el,
  id: el.dataset.id,
  name: el.dataset.name || '',
  session: el.dataset.session || '',
  status: el.dataset.status || '',
  confirmed: el.dataset.confirmed === '1',
  cells: Object.fromEntries((el.dataset.cells || '').split(',').filter(Boolean).map((p) => p.split(':'))),
}));

const state = { task: '', state: '', q: '', review: false, unconfirmed: false, page: 0 };

function filtered() {
  let out = rows;
  if (state.task) {
    out = out.filter((r) => (state.state ? (r.cells[state.task] || '-') === state.state : (r.cells[state.task] || '-') !== '-'));
  } else if (state.state) {
    out = out.filter((r) => Object.values(r.cells).includes(state.state));
  }
  if (state.review) out = out.filter((r) => Object.values(r.cells).includes('r'));
  // Accepted no longer flips to a 'confirmed' status — the session carries that.
  if (state.unconfirmed) out = out.filter((r) => r.status === 'accepted' && !r.confirmed);
  const q = state.q.trim().toLowerCase();
  if (q) out = out.filter((r) => r.name.toLowerCase().includes(q) || r.session.toLowerCase().includes(q));
  return out;
}

function renderGrid() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  if (state.page > pages - 1) state.page = pages - 1;
  const page = Math.max(0, state.page);
  const visible = new Set(list.slice(page * PAGE, page * PAGE + PAGE).map((r) => r.id));
  rows.forEach((r) => {
    // 'grid', not '' — clearing display would drop the row's inline display:grid.
    r.el.style.display = visible.has(r.id) ? 'grid' : 'none';
  });
  $('#grid-empty').hidden = list.length !== 0;
  $('#page-info').textContent = `${list.length ? page * PAGE + 1 : 0}–${page * PAGE + visible.size} OF ${list.length}`;
  $('#pg-prev').style.cssText = pgBtn(page > 0);
  $('#pg-next').style.cssText = pgBtn(page < pages - 1);
  $('#f-task').style.cssText = filterStyle(!!state.task);
  $('#f-state').style.cssText = filterStyle(!!state.state);
  const chip = $('#f-review');
  if (chip) {
    chip.style.cssText = `padding:6px 11px;font-size:12.5px;cursor:pointer;border:1px solid ${
      state.review ? '#b08800' : '#e8d79a'
    };background:#fdf5dc;color:#b08800;font-weight:600;`;
  }
}

$('#f-task').addEventListener('change', (e) => {
  state.task = e.target.value;
  state.page = 0;
  renderGrid();
});
$('#f-state').addEventListener('change', (e) => {
  state.state = e.target.value;
  state.page = 0;
  renderGrid();
});
$('#f-q').addEventListener('input', (e) => {
  state.q = e.target.value;
  state.page = 0;
  renderGrid();
});
if ($('#f-review')) {
  $('#f-review').addEventListener('click', () => {
    state.review = !state.review;
    state.page = 0;
    renderGrid();
  });
}
$('#pg-prev').addEventListener('click', () => {
  if (state.page > 0) {
    state.page--;
    renderGrid();
  }
});
$('#pg-next').addEventListener('click', () => {
  state.page++;
  renderGrid();
});

renderGrid();

/* ------------------------------------------- dashboard deep links (?focus=) */

const focusParam = new URLSearchParams(location.search).get('focus');
if (focusParam === 'overdue' || focusParam === 'unconfirmed') {
  if (focusParam === 'overdue') {
    state.state = 'o';
    $('#f-state').value = 'o';
  } else {
    state.unconfirmed = true;
  }
  state.page = 0;
  renderGrid();

  const n = filtered().length;
  const label =
    focusParam === 'overdue'
      ? `${n} speaker${n === 1 ? '' : 's'} with overdue tasks`
      : `${n} accepted speaker${n === 1 ? '' : 's'} who haven’t confirmed yet`;
  const gridWrap = $('#grid-body').parentElement;
  const banner = document.createElement('div');
  banner.style.cssText =
    'display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px 14px;background:#fdf5dc;border:1px solid #e8d79a;font-size:12.5px;color:#7a5c0a;';
  banner.innerHTML =
    `<span>Showing <b>${esc(label)}</b>.</span>` +
    '<button type="button" data-focus-clear style="margin-left:auto;background:none;border:none;color:#7a5c0a;font-size:12.5px;cursor:pointer;text-decoration:underline;padding:0;white-space:nowrap;">Show all speakers</button>';
  gridWrap.parentNode.insertBefore(banner, gridWrap);
  banner.querySelector('[data-focus-clear]').addEventListener('click', () => {
    state.state = '';
    state.unconfirmed = false;
    $('#f-state').value = '';
    banner.remove();
    history.replaceState(null, '', '/app/speakers');
    renderGrid();
  });

  const pulse = document.createElement('style');
  pulse.textContent = '@keyframes usFocusPulse{0%{box-shadow:0 0 0 0 rgba(176,136,0,0.4)}100%{box-shadow:0 0 0 12px rgba(176,136,0,0)}}';
  document.head.appendChild(pulse);
  gridWrap.style.animation = 'usFocusPulse 1.2s ease-out 2';
}

/* -------------------------------------------------------- speaker drawer */

const drawer = $('#drawer');
let current = null;

async function openSpeaker(id) {
  const res = await api(`/app/api/speakers/detail/${id}`, undefined, 'GET');
  current = res;
  drawer.hidden = false;
  drawer.innerHTML = drawerHtml(res);
}

function closeSpeaker() {
  drawer.hidden = true;
  drawer.innerHTML = '';
  current = null;
}

function drawerHtml(d) {
  const s = d.speaker;
  const first = (s.name || '').split(' ')[0] || s.name;
  const sub = d.submission;
  const fracColor =
    d.frac.total && d.frac.done === d.frac.total
      ? '#2b8a3e'
      : d.tasks.some((t) => t.state === 'o')
        ? '#c92a2a'
        : '#686b74';

  const taskRows = d.tasks
    .map(
      (t) => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f2f3f5;">
        <span style="${boxOf(t.state)}">${GLYPH[t.state]}</span>
        <div style="font-size:13px;">${esc(t.name)}</div>
        ${t.tag ? `<span style="font-family:${MONO};font-size:8.5px;color:#9a9da6;background:#f4f4f6;padding:2px 5px;flex:none;">${esc(t.tag)}</span>` : ''}
        <div style="margin-left:auto;font-family:${MONO};font-size:10.5px;color:${STATE_COLOR[t.state]};flex:none;">${t.stateLabel}</div>
        ${
          t.review
            ? `<button data-approve="${t.id}" style="padding:4px 9px;background:#e6f4ea;border:1px solid #b7dfc4;font-size:11.5px;color:#2b8a3e;cursor:pointer;flex:none;">Approve</button>
               <button data-changes="${t.id}" style="padding:4px 9px;background:#fff;border:1px solid #e8d79a;font-size:11.5px;color:#b08800;cursor:pointer;flex:none;">Request changes</button>`
            : ''
        }
        ${t.nudgeable ? `<button data-nudge="${t.id}" style="padding:4px 9px;background:#fff;border:1px solid #e2e3e8;font-size:11.5px;cursor:pointer;flex:none;">Nudge</button>` : ''}
        ${t.removable ? `<button data-remove="${t.id}" title="Remove this task (logged)" style="padding:4px 8px;background:#fff;border:1px solid #e2e3e8;font-size:11.5px;color:#9a9da6;cursor:pointer;flex:none;">×</button>` : ''}
      </div>`
    )
    .join('');

  const assign = `
    <div style="border-top:1px solid #f2f3f5;padding-top:14px;display:grid;gap:8px;">
      <div style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;">ASSIGN A TASK</div>
      <select id="asg-pick" style="width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;">
        <option value="">Pick a template…</option>
        ${d.assignable.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('')}
        <option value="oneoff">One-off task…</option>
      </select>
      <div id="asg-oneoff" hidden style="display:grid;gap:6px;">
        <input id="oo-name" placeholder="Task name — e.g. Re-record your intro video" style="width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;">
        <div style="display:flex;gap:6px;">
          <select id="oo-type" style="flex:1;padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;">
            <option value="checkbox">Checkbox</option>
            <option value="file">File request</option>
            <option value="form">Form</option>
          </select>
          <input id="oo-due" type="date" style="width:150px;padding:7px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;">
        </div>
      </div>
      <button id="asg-do" style="justify-self:start;padding:7px 13px;background:#fff;border:1px solid #e2e3e8;font-size:12.5px;cursor:pointer;">Assign to ${esc(first)}</button>
    </div>`;

  return `
  <div data-close-drawer style="position:fixed;inset:0;background:rgba(22,23,29,0.28);z-index:60;"></div>
  <div style="position:fixed;top:0;right:0;bottom:0;width:440px;background:#fff;z-index:70;box-shadow:-12px 0 40px rgba(0,0,0,0.14);animation:slidein 0.18s ease;display:flex;flex-direction:column;">
    <div style="padding:16px 22px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;">
      <div style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;">SPEAKER</div>
      <button data-close-drawer style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;">×</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:20px 22px;display:flex;flex-direction:column;gap:18px;">
      <div>
        <div style="font-size:19px;font-weight:700;letter-spacing:-0.01em;">${esc(s.name)}</div>
        <div style="font-family:${MONO};font-size:11.5px;color:#4c5fd5;margin-top:2px;">${esc(s.email)}</div>
        <div style="margin-top:7px;"><a href="/${esc(d.eventSlug)}/speakers/${esc(s.slug)}" target="_blank" rel="noreferrer" style="font-size:12px;">View public profile ↗</a></div>
        <div style="font-size:13px;color:#686b74;margin-top:6px;line-height:1.5;">${esc(s.bio)}</div>
      </div>
      ${
        sub
          ? `<div>
        <div style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:8px;">SUBMISSION · SESSION</div>
        <div style="border:1px solid #eceded;padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;align-items:baseline;gap:8px;">
            <div style="font-family:${MONO};font-size:11px;color:#9a9da6;">${esc(sub.label)}</div>
            <span style="font-family:${MONO};font-size:10.5px;padding:2px 7px;color:${sub.fg};background:${sub.bg};">${esc(sub.statusLabel)}</span>
            <div style="margin-left:auto;font-family:${MONO};font-size:11px;color:#686b74;">${esc(sub.score)}</div>
          </div>
          <div style="font-size:14px;font-weight:600;line-height:1.35;">${esc(sub.title)}</div>
          <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:#686b74;"><span style="width:8px;height:8px;border-radius:50%;background:${sub.color};flex:none;"></span>${esc(sub.track)}<span style="color:#c9cbd2;">·</span>${esc(sub.meta)}</div>
          <div><a href="/app/sessions${sub.sessionId ? '?open=' + encodeURIComponent(sub.sessionId) : ''}" style="font-size:12px;">Open in Sessions ↗</a></div>
        </div>
      </div>`
          : ''
      }
      <div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px;">
          <div style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;">TASKS</div>
          <div style="margin-left:auto;font-family:${MONO};font-size:11px;color:${fracColor};font-weight:600;">${d.frac.done}/${d.frac.total} complete</div>
        </div>
        <div style="display:flex;flex-direction:column;">${taskRows || '<div style="font-size:12.5px;color:#9a9da6;padding:6px 0;">No tasks yet.</div>'}</div>
      </div>
      ${assign}
    </div>
    <div style="padding:14px 22px;border-top:1px solid #e2e3e8;display:flex;gap:8px;">
      <button id="drawer-email" style="padding:9px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">Email speaker</button>
      <button data-close-drawer style="padding:9px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;">Close</button>
    </div>
  </div>`;
}

document.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open-speaker]');
  if (open) {
    openSpeaker(open.getAttribute('data-open-speaker')).catch((err) => toast(err.message, false));
    return;
  }
  if (e.target.closest('[data-close-drawer]')) {
    closeSpeaker();
    return;
  }
  if (!current) return;

  const nudge = e.target.closest('[data-nudge]');
  if (nudge) {
    try {
      const res = await api('/app/api/speakers/task/nudge', {
        taskId: nudge.getAttribute('data-nudge'),
        speakerProfileId: current.speaker.id,
      });
      nudge.textContent = 'Sent ✓';
      nudge.disabled = true;
      nudge.style.color = '#2b8a3e';
      toast(res.message);
    } catch (err) {
      toast(err.message, false);
    }
    return;
  }

  const remove = e.target.closest('[data-remove]');
  if (remove) {
    try {
      const res = await api('/app/api/speakers/task/remove', { taskId: remove.getAttribute('data-remove') });
      toast(res.message);
      await openSpeaker(current.speaker.id);
      markStale();
    } catch (err) {
      toast(err.message, false);
    }
    return;
  }

  const approve = e.target.closest('[data-approve]');
  if (approve) {
    try {
      const res = await api('/app/api/speakers/task/review', {
        taskId: approve.getAttribute('data-approve'),
        action: 'approve',
      });
      toast(res.message);
      await openSpeaker(current.speaker.id);
      markStale();
    } catch (err) {
      toast(err.message, false);
    }
    return;
  }

  const changes = e.target.closest('[data-changes]');
  if (changes) {
    $('#changes-go').dataset.taskId = changes.getAttribute('data-changes');
    $('#changes-msg').value = '';
    openDialog('#dlg-changes');
    return;
  }

  if (e.target.closest('#drawer-email')) {
    const tplSel = $('#compose-tpl');
    tplSel.innerHTML =
      '<option value="">Blank message</option>' +
      (DATA.emailTemplates || []).map((t) => `<option value="${t.key}">${esc(t.name)}</option>`).join('');
    $('#compose-to').textContent = `TO: ${current.speaker.name} · ${current.speaker.email}`.toUpperCase();
    $('#compose-subj').value = '';
    $('#compose-body').value = '';
    openDialog('#dlg-compose');
    return;
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'asg-pick') {
    $('#asg-oneoff').hidden = e.target.value !== 'oneoff';
  }
});

document.addEventListener('click', async (e) => {
  if (!e.target.closest('#asg-do') || !current) return;
  const pick = $('#asg-pick').value;
  if (!pick) {
    toast('Pick a template first', false);
    return;
  }
  try {
    const payload =
      pick === 'oneoff'
        ? {
            speakerProfileId: current.speaker.id,
            oneOff: { name: $('#oo-name').value, type: $('#oo-type').value, due: $('#oo-due').value },
          }
        : { speakerProfileId: current.speaker.id, templateId: pick };
    const res = await api('/app/api/speakers/assign', payload);
    toast(res.message);
    await openSpeaker(current.speaker.id);
    markStale();
  } catch (err) {
    toast(err.message, false);
  }
});

/** The grid is server-rendered: after a mutation, offer the fresh numbers. */
let stale = false;
function markStale() {
  if (stale) return;
  stale = true;
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;bottom:24px;left:24px;background:#16171d;color:#fff;padding:10px 14px;font-size:12.5px;z-index:85;display:flex;gap:10px;align-items:center;';
  bar.innerHTML = 'Grid is out of date <button style="background:#4c5fd5;color:#fff;border:none;padding:5px 10px;font-size:12px;cursor:pointer;">Refresh</button>';
  bar.querySelector('button').addEventListener('click', () => reload());
  document.body.appendChild(bar);
}

$('#changes-go').addEventListener('click', async () => {
  const taskId = $('#changes-go').dataset.taskId;
  try {
    const res = await api('/app/api/speakers/task/review', {
      taskId,
      action: 'changes',
      message: $('#changes-msg').value,
    });
    closeDialog('#dlg-changes');
    toast(res.message);
    if (current) await openSpeaker(current.speaker.id);
    markStale();
  } catch (err) {
    toast(err.message, false);
  }
});

$('#compose-tpl').addEventListener('change', (e) => {
  const tpl = (DATA.emailTemplates || []).find((t) => t.key === e.target.value);
  if (!tpl) return;
  $('#compose-subj').value = tpl.subject;
  $('#compose-body').value = tpl.body;
});

$('#compose-send').addEventListener('click', async () => {
  if (!current) return;
  try {
    const res = await api('/app/api/speakers/email', {
      speakerProfileId: current.speaker.id,
      subject: $('#compose-subj').value,
      body: $('#compose-body').value,
    });
    closeDialog('#dlg-compose');
    toast(res.message);
  } catch (err) {
    toast(err.message, false);
  }
});

/* ------------------------------------------------------- template editor */

const REM_PRESETS = [30, 14, 10, 7, 5, 3, 2, 1, 0];
let ed = null;

function blankTemplate() {
  return {
    id: null,
    name: '',
    desc: '',
    type: 'checkbox',
    target: 'speaker',
    required: false,
    lock: false,
    trigger: 'confirmation',
    archived: false,
    settings: { link: '', ext: '', capMb: 100, maxFiles: 1, review: false, formSpec: DATA.miniForms[0] },
    due: { mode: 'before', n: 14, date: DATA.event.start },
    grace: { mode: 'none', days: 3 },
    clauses: [],
    reminders: { on: true, days: [7, 2], subject: DATA.defaults.subject, body: DATA.defaults.body },
  };
}

function openEditor(tpl) {
  ed = tpl ? JSON.parse(JSON.stringify(tpl)) : blankTemplate();
  if (!ed.settings) ed.settings = {};
  if (typeof ed.settings.capMb !== 'number') ed.settings.capMb = 100;
  $('#editor').hidden = false;
  renderEditor();
}

function closeEditor() {
  $('#editor').hidden = true;
  ed = null;
  clearTimeout(matchTimer);
}

function openCount(id) {
  return rows.reduce((n, r) => n + (['p', 'o', 'r'].includes(r.cells[id]) ? 1 : 0), 0);
}

function renderEditor() {
  if (!ed) return;
  $('#ed-title').textContent = ed.id ? 'EDIT TEMPLATE' : 'NEW TASK TEMPLATE';
  $('#ed-name').value = ed.name;
  $('#ed-desc').value = ed.desc;
  $$('[data-seg="type"]').forEach((b) => (b.style.cssText = seg(b.dataset.value === ed.type)));
  $$('[data-seg="trigger"]').forEach((b) => (b.style.cssText = seg(b.dataset.value === ed.trigger)));
  $$('[data-seg="target"]').forEach((b) => (b.style.cssText = card(b.dataset.value === ed.target)));

  $('#ed-check').hidden = ed.type !== 'checkbox';
  $('#ed-file').hidden = ed.type !== 'file';
  $('#ed-form').hidden = ed.type !== 'form';
  $('#ed-profile').hidden = ed.type !== 'profile';
  $('#ed-link').value = ed.settings.link || '';
  $('#ed-ext').value = ed.settings.ext || '';
  $('#ed-cap').value = String(ed.settings.capMb || 100);
  $('#ed-maxn').value = String(ed.settings.maxFiles || 1);
  const sampleName = ed.settings.sampleFileName || ed.settings.sampleFile || '';
  $('#ed-sample-on').hidden = !sampleName;
  $('#ed-sample-off').hidden = !!sampleName;
  $('#ed-sample-name').textContent = sampleName;
  $('[data-box="review"]').style.cssText = box(!!ed.settings.review);
  $('[data-box="review"]').textContent = ed.settings.review ? '✓' : '';

  const spec = ed.settings.formSpec;
  const isCustom = spec && typeof spec === 'object';
  $('#ed-formspec').value = isCustom ? '__new' : spec || DATA.miniForms[0];
  $('#ed-formbuilder').hidden = !isCustom;
  if (isCustom) {
    $('#ed-formname').value = spec.name || '';
    (spec.fields || []).forEach((f, i) => {
      const t = $(`[data-mf-type="${i}"]`);
      const l = $(`[data-mf-label="${i}"]`);
      if (t) t.value = f.type;
      if (l) l.value = f.opts && f.opts.length ? `${f.label}: ${f.opts.join(', ')}` : f.label;
    });
  }

  $('[data-box="required"]').style.cssText = box(ed.required);
  $('[data-box="required"]').textContent = ed.required ? '✓' : '';
  $('[data-box="lock"]').style.cssText = box(ed.lock);
  $('[data-box="lock"]').textContent = ed.lock ? '✓' : '';

  $('#ed-clauses-wrap').hidden = ed.trigger === 'manual';
  $('#ed-clauses').innerHTML = ed.clauses
    .map((cl, i) => {
      const opts = DATA.taxonomies[cl.field] || null;
      const valueEl = opts
        ? `<select data-clause-val="${i}" style="flex:1;padding:8px 8px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;">${opts
            .map((o) => `<option value="${esc(o)}"${o === cl.value ? ' selected' : ''}>${esc(o)}</option>`)
            .join('')}</select>`
        : `<input data-clause-val="${i}" value="${esc(cl.value)}" placeholder="e.g. Travel support = Yes" style="flex:1;padding:8px 10px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;">`;
      return `<div style="display:flex;gap:6px;align-items:center;">
        <select data-clause-field="${i}" style="width:126px;flex:none;padding:8px 8px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;">
          ${['Track', 'Format', 'Level', 'Form answer']
            .map((f) => `<option${f === cl.field ? ' selected' : ''}>${f}</option>`)
            .join('')}
        </select>
        ${valueEl}
        <button data-clause-rm="${i}" style="background:none;border:none;color:#9a9da6;font-size:15px;cursor:pointer;padding:2px;flex:none;">×</button>
      </div>`;
    })
    .join('');

  const hasDue = ed.type !== 'profile';
  $('#ed-due-wrap').hidden = !hasDue;
  $('#ed-rem-wrap').hidden = !hasDue;
  $('#ed-duemode').value = ed.due.mode;
  $('#ed-duen').hidden = ed.due.mode === 'abs';
  $('#ed-duen').value = String(ed.due.n ?? 0);
  $('#ed-duedate').hidden = ed.due.mode !== 'abs';
  $('#ed-duedate').value = ed.due.date || DATA.event.start;
  $('#ed-grace').value = ed.grace.mode;
  $('#ed-gracen').hidden = ed.grace.mode !== 'lock';
  $('#ed-gracen-label').hidden = ed.grace.mode !== 'lock';
  $('#ed-gracen').value = String(ed.grace.days ?? 0);

  const rem = ed.reminders;
  $('[data-box="remOn"]').style.cssText = box(rem.on);
  $('[data-box="remOn"]').textContent = rem.on ? '✓' : '';
  $('#ed-rem-body').hidden = !rem.on;
  $('#ed-rem-days').innerHTML = [...rem.days]
    .sort((a, b) => b - a)
    .map(
      (n) =>
        `<span style="display:inline-flex;align-items:center;gap:7px;border:1px solid #e2e3e8;background:#fff;padding:5px 9px;font-size:12px;">${
          n === 0 ? 'On the due date' : `${n} day${n > 1 ? 's' : ''} before due`
        }<button data-rem-rm="${n}" title="Remove this reminder" style="background:none;border:none;color:#9a9da6;font-size:13px;cursor:pointer;padding:0;line-height:1;">×</button></span>`
    )
    .join('');
  $('#ed-rem-none').hidden = rem.days.length !== 0;
  $('#ed-rem-add').innerHTML =
    '<option value="">＋ Add reminder…</option>' +
    REM_PRESETS.filter((n) => !rem.days.includes(n))
      .map((n) => `<option value="${n}">${n === 0 ? 'On the due date' : `${n} days before due`}</option>`)
      .join('');
  $('#ed-rem-add').value = '';
  $('#ed-rem-subj').value = rem.subject;
  $('#ed-rem-body-text').value = rem.body;
  const custom = rem.subject !== DATA.defaults.subject || rem.body !== DATA.defaults.body;
  $('#ed-rem-custom').hidden = !custom;
  $('#ed-rem-reset').hidden = !custom;

  $('#ed-save').textContent = ed.id ? 'Save template' : 'Create template';
  $('#ed-archive').hidden = !ed.id;
  $('#ed-archive').textContent = ed.archived ? 'Restore template' : 'Archive template';
  scheduleMatch();
}

/* ------------------------------------------------- live rule-match line */

/** Last preview fetched for the editor's rule — reused by the create flow. */
let matchPreview = null;
let matchKey = '';
let matchTimer = null;
let matchSeq = 0;

function scheduleMatch() {
  clearTimeout(matchTimer);
  matchTimer = setTimeout(refreshMatch, 250);
}

async function refreshMatch() {
  const el = $('#ed-match');
  if (!el) return;
  if (!ed || ed.trigger === 'manual') {
    el.hidden = true;
    matchPreview = null;
    matchKey = '';
    return;
  }
  const key = JSON.stringify({ trigger: ed.trigger, clauses: ed.clauses });
  if (key === matchKey && matchPreview) {
    renderMatchLine();
    return;
  }
  const seq = ++matchSeq;
  el.hidden = false;
  el.style.color = '#9a9da6';
  el.textContent = 'Checking who matches…';
  try {
    const res = await api('/app/api/speakers/template/match', { trigger: ed.trigger, clauses: ed.clauses });
    if (seq !== matchSeq || !ed) return;
    matchKey = key;
    matchPreview = res;
    renderMatchLine();
  } catch {
    if (seq === matchSeq && el) el.hidden = true;
  }
}

function renderMatchLine() {
  const el = $('#ed-match');
  if (!el || !ed || ed.trigger === 'manual' || !matchPreview) return;
  el.hidden = false;
  const who = ed.trigger === 'acceptance' ? 'accepted' : 'confirmed';
  if (!matchPreview.speakers && !matchPreview.sessions) {
    el.style.color = '#b08800';
    el.textContent = ed.clauses.length
      ? 'Matches nothing right now — check the clauses'
      : `Matches nothing right now — no ${who} speakers yet`;
    return;
  }
  el.style.color = '#686b74';
  el.textContent = `Matches ${matchPreview.speakers} ${who} speaker${matchPreview.speakers === 1 ? '' : 's'} · ${
    matchPreview.sessions
  } session${matchPreview.sessions === 1 ? '' : 's'} right now`;
}

$('#new-tpl').addEventListener('click', () => openEditor(null));
$$('[data-tpl-card]').forEach((el) =>
  el.addEventListener('click', () => {
    const tpl = DATA.templates.find((t) => t.id === el.getAttribute('data-tpl-card'));
    if (tpl) openEditor(tpl);
  })
);
$$('[data-tpl-head]').forEach((el) =>
  el.addEventListener('click', () => {
    const tpl = DATA.templates.find((t) => t.id === el.getAttribute('data-tpl-head'));
    if (tpl) openEditor(tpl);
  })
);
$$('[data-close-editor]').forEach((el) => el.addEventListener('click', closeEditor));

$('#editor').addEventListener('click', (e) => {
  if (!ed) return;
  const segBtn = e.target.closest('[data-seg]');
  if (segBtn) {
    const key = segBtn.dataset.seg;
    ed[key] = segBtn.dataset.value;
    renderEditor();
    return;
  }
  if (e.target.closest('[data-flag-row="required"]')) {
    ed.required = !ed.required;
    renderEditor();
    return;
  }
  if (e.target.closest('[data-flag-row="lock"]')) {
    ed.lock = !ed.lock;
    renderEditor();
    return;
  }
  if (e.target.closest('#ed-review-row')) {
    ed.settings.review = !ed.settings.review;
    renderEditor();
    return;
  }
  if (e.target.closest('#ed-rem-row')) {
    ed.reminders.on = !ed.reminders.on;
    renderEditor();
    return;
  }
  const remRm = e.target.closest('[data-rem-rm]');
  if (remRm) {
    const n = Number(remRm.getAttribute('data-rem-rm'));
    ed.reminders.days = ed.reminders.days.filter((x) => x !== n);
    renderEditor();
    return;
  }
  const clauseRm = e.target.closest('[data-clause-rm]');
  if (clauseRm) {
    ed.clauses.splice(Number(clauseRm.getAttribute('data-clause-rm')), 1);
    renderEditor();
    return;
  }
  if (e.target.closest('#ed-add-clause')) {
    const track = (DATA.taxonomies.Track || [])[0] || '';
    ed.clauses.push({ field: 'Track', value: track });
    renderEditor();
    return;
  }
  if (e.target.closest('#ed-sample-rm')) {
    ed.settings.sampleFileId = null;
    ed.settings.sampleFileName = '';
    ed.settings.sampleFile = '';
    renderEditor();
    return;
  }
  if (e.target.closest('#ed-rem-reset')) {
    ed.reminders.subject = DATA.defaults.subject;
    ed.reminders.body = DATA.defaults.body;
    renderEditor();
  }
});

$('#editor').addEventListener('input', (e) => {
  if (!ed) return;
  const id = e.target.id;
  if (id === 'ed-name') ed.name = e.target.value;
  else if (id === 'ed-desc') ed.desc = e.target.value;
  else if (id === 'ed-link') ed.settings.link = e.target.value;
  else if (id === 'ed-ext') ed.settings.ext = e.target.value;
  else if (id === 'ed-maxn') ed.settings.maxFiles = Number(e.target.value) || 1;
  else if (id === 'ed-duen') ed.due.n = Number(e.target.value) || 0;
  else if (id === 'ed-duedate') ed.due.date = e.target.value;
  else if (id === 'ed-gracen') ed.grace.days = Number(e.target.value) || 0;
  else if (id === 'ed-rem-subj') ed.reminders.subject = e.target.value;
  else if (id === 'ed-rem-body-text') ed.reminders.body = e.target.value;
  else if (e.target.dataset.clauseVal !== undefined) {
    ed.clauses[Number(e.target.dataset.clauseVal)].value = e.target.value;
    scheduleMatch(); // clause typing skips renderEditor to keep focus — refresh the match line directly
  }
  else if (id === 'ed-formname' || e.target.dataset.mfLabel !== undefined) collectMiniForm();
});

$('#editor').addEventListener('change', async (e) => {
  if (!ed) return;
  const id = e.target.id;
  if (id === 'ed-cap') ed.settings.capMb = Number(e.target.value) || 100;
  else if (id === 'ed-duemode') {
    ed.due.mode = e.target.value;
    renderEditor();
  } else if (id === 'ed-grace') {
    ed.grace.mode = e.target.value;
    renderEditor();
  } else if (id === 'ed-rem-add') {
    const v = e.target.value;
    if (v !== '' && !ed.reminders.days.includes(Number(v))) ed.reminders.days.push(Number(v));
    renderEditor();
  } else if (id === 'ed-formspec') {
    ed.settings.formSpec =
      e.target.value === '__new' ? { name: 'New mini-form', fields: [] } : e.target.value;
    renderEditor();
  } else if (e.target.dataset.clauseField !== undefined) {
    const i = Number(e.target.dataset.clauseField);
    const field = e.target.value;
    const opts = DATA.taxonomies[field];
    ed.clauses[i] = { field, value: opts ? opts[0] || '' : '' };
    renderEditor();
  } else if (e.target.dataset.mfType !== undefined) {
    collectMiniForm();
  } else if (id === 'ed-sample-input') {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('templateId', ed.id || 'new');
    try {
      const res = await fetch('/app/api/speakers/sample', { method: 'POST', body: fd }).then((r) => r.json());
      if (!res.ok) throw new Error(res.error || 'Upload failed');
      ed.settings.sampleFileId = res.fileId;
      ed.settings.sampleFileName = res.filename;
      renderEditor();
      toast('Sample attached — speakers see it next to the uploader');
    } catch (err) {
      toast(err.message, false);
    }
  }
});

function collectMiniForm() {
  const fields = [0, 1, 2]
    .map((i) => {
      const type = $(`[data-mf-type="${i}"]`).value;
      const raw = $(`[data-mf-label="${i}"]`).value.trim();
      if (!raw) return null;
      const [label, optStr] = raw.split(':');
      const opts = optStr ? optStr.split(',').map((s) => s.trim()).filter(Boolean) : [];
      return { id: `mf_${i}`, type, label: label.trim(), required: i === 0, opts: opts.length ? opts : undefined };
    })
    .filter(Boolean);
  ed.settings.formSpec = { name: $('#ed-formname').value.trim() || 'New mini-form', fields };
}

$('#ed-archive').addEventListener('click', async () => {
  try {
    const res = await api('/app/api/speakers/template/archive', { id: ed.id });
    reload(res.message);
  } catch (err) {
    toast(err.message, false);
  }
});

async function saveTemplate(applyMode) {
  const payload = {
    id: ed.id,
    name: ed.name,
    desc: ed.desc,
    type: ed.type,
    target: ed.target,
    required: ed.required,
    lock: ed.lock,
    trigger: ed.trigger,
    settings: ed.settings,
    due: ed.due,
    grace: ed.grace,
    clauses: ed.clauses,
    reminders: ed.reminders,
    applyMode,
  };
  const res = await api('/app/api/speakers/template', payload);
  // Create ≠ apply: a new rule stamps zero instances (never retroactive). If
  // people already match it right now, surface the assign decision instead of
  // leaving a silent rule-only template — declining keeps it rule-only.
  if (!payload.id && payload.trigger !== 'manual') {
    let preview = null;
    try {
      preview = await api('/app/api/speakers/template/match', {
        trigger: payload.trigger,
        clauses: payload.clauses,
      });
    } catch {
      preview = null;
    }
    if (preview && preview.speakerIds && preview.speakerIds.length) {
      DATA.templates.push({
        id: res.id,
        name: payload.name.trim(),
        desc: payload.desc,
        type: payload.type,
        target: payload.target,
        required: payload.required,
        lock: payload.lock,
        trigger: payload.trigger,
        archived: false,
        settings: payload.settings,
        due: payload.due,
        grace: payload.grace,
        clauses: payload.clauses,
        reminders: payload.reminders,
        typeLabel: TYPE_LABEL[payload.type],
      });
      closeEditor();
      openBulkForNewTemplate(res.id, preview, res.message);
      return;
    }
  }
  reload(res.message);
}

$('#ed-save').addEventListener('click', async () => {
  if (!ed.name.trim()) {
    toast('Name the template first', false);
    return;
  }
  const open = ed.id ? openCount(ed.id) : 0;
  if (ed.id && open > 0) {
    $('#apply-copy').textContent = `“${ed.name}” has ${open} open instances. Speakers may have already acted on the old wording — nothing updates silently.`;
    $('#apply-future-sub').textContent = `New instances get the new definition; the ${open} open ones keep what speakers saw.`;
    $('#apply-open-label').textContent = `Also update ${open} open instances`;
    pickApply('future');
    openDialog('#dlg-apply');
    return;
  }
  try {
    await saveTemplate(null);
  } catch (err) {
    toast(err.message, false);
  }
});

let applyChoice = 'future';
function pickApply(v) {
  applyChoice = v;
  $$('[data-apply]').forEach((el) => {
    const on = el.getAttribute('data-apply') === v;
    el.style.cssText = `border:1px solid ${on ? '#4c5fd5' : '#e2e3e8'};background:${on ? '#eef0fb' : '#fff'};padding:11px 13px;cursor:pointer;`;
  });
}
$$('[data-apply]').forEach((el) => el.addEventListener('click', () => pickApply(el.getAttribute('data-apply'))));
$('#apply-go').addEventListener('click', async () => {
  try {
    await saveTemplate(applyChoice);
  } catch (err) {
    toast(err.message, false);
  }
});

/* --------------------------------------------------- reminder email editor */

let emlTab = 'edit';
function renderEml() {
  const on = (v) =>
    `padding:6px 16px;font-size:12px;cursor:pointer;border:1px solid ${v ? '#4c5fd5' : '#e2e3e8'};background:${
      v ? '#eef0fb' : '#fff'
    };color:${v ? '#4c5fd5' : '#33343c'};font-weight:${v ? '600' : '400'};${v ? '' : 'margin-left:-1px;'}`;
  $('#eml-tab-edit').style.cssText = on(emlTab === 'edit');
  $('#eml-tab-prev').style.cssText = on(emlTab === 'preview');
  $('#eml-edit').hidden = emlTab !== 'edit';
  $('#eml-prev').hidden = emlTab !== 'preview';
  if (emlTab === 'preview') {
    const sample = {
      speaker_name: 'Priya Raghavan',
      task_name: (ed && ed.name) || 'Upload slides',
      event_name: DATA.event.name,
      due_date: 'Sep 14, 2027',
      days_left: '7 days',
      portal_link: `${location.origin}/${DATA.event.slug}/portal`,
      session_title: 'Edge caching patterns that survive real traffic',
      session_slot: 'Wed 11:20 · Main Hall',
    };
    const fill = (s) => String(s).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (sample[k] !== undefined ? sample[k] : m));
    $('#eml-prev-to').textContent = 'Priya Raghavan · priya@meridianlabs.dev';
    $('#eml-prev-subj').textContent = fill($('#eml-subj').value);
    $('#eml-prev-body').textContent = fill($('#eml-body').value);
  }
}

$('#eml-open').addEventListener('click', () => {
  $('#eml-title').textContent = `REMINDER EMAIL · ${(ed.name || 'NEW TEMPLATE').toUpperCase()}`;
  $('#eml-subj').value = ed.reminders.subject;
  $('#eml-body').value = ed.reminders.body;
  emlTab = 'edit';
  renderEml();
  openDialog('#dlg-eml');
});
$('#eml-tab-edit').addEventListener('click', () => {
  emlTab = 'edit';
  renderEml();
});
$('#eml-tab-prev').addEventListener('click', () => {
  emlTab = 'preview';
  renderEml();
});
$('#eml-save').addEventListener('click', () => {
  ed.reminders.subject = $('#eml-subj').value;
  ed.reminders.body = $('#eml-body').value;
  closeDialog('#dlg-eml');
  renderEditor();
  toast('Reminder email updated — takes effect when you save the template');
});
$('#eml-test').addEventListener('click', async () => {
  try {
    const res = await api('/app/api/speakers/test-email', {
      subject: $('#eml-subj').value,
      body: $('#eml-body').value,
      taskName: ed ? ed.name : '',
    });
    toast(res.message);
  } catch (err) {
    toast(err.message, false);
  }
});

/* ------------------------------------------------------------ bulk assign */

function activeTemplates() {
  return DATA.templates.filter((t) => !t.archived);
}

/**
 * Post-create "assign now?" offer: the candidate set is the rule-matching
 * speakers (from /template/match), not the current filtered view. Declining
 * (any way the dialog closes without assigning) keeps the template rule-only.
 */
let bulkPreset = null; // { ids: Set, noSession: Set, declineMessage }

function fillBulkTemplates() {
  $('#bulk-tpl').innerHTML = activeTemplates()
    .map((t) => `<option value="${t.id}">${esc(t.name)} · ${TYPE_LABEL[t.type]}${t.target === 'session' ? ' · session' : ''}</option>`)
    .join('');
}

function renderBulk() {
  const preset = bulkPreset;
  const list = preset
    ? [...preset.ids].map((id) => rows.find((r) => r.id === id) || { id, name: '', session: '', cells: {} })
    : filtered();
  const tplId = $('#bulk-tpl').value;
  const tpl = activeTemplates().find((t) => t.id === tplId) || activeTemplates()[0];
  if (!tpl) {
    $('#bulk-preview').textContent = 'No active templates.';
    $('#bulk-go').disabled = true;
    return;
  }
  const candidates = list.filter((r) => (r.cells[tpl.id] || '-') === '-');
  const already = list.length - candidates.length;
  const noSess = preset && tpl.target === 'session' ? candidates.filter((r) => preset.noSession.has(r.id)).length : 0;
  const create = candidates.length - noSess;
  if (preset) {
    const who = tpl.trigger === 'acceptance' ? 'ACCEPTED' : 'CONFIRMED';
    $('#bulk-view').textContent = `RULE MATCH: ${list.length} ${who} SPEAKER${list.length === 1 ? '' : 'S'} RIGHT NOW`;
  } else {
    const label =
      (state.task ? activeTemplates().find((t) => t.id === state.task)?.name || 'All speakers' : 'All speakers') +
      (state.state ? ` · ${TIPS[state.state]}` : '') +
      (state.review ? ' · Pending review' : '') +
      (state.q.trim() ? ` · “${state.q.trim()}”` : '');
    $('#bulk-view').textContent = `VIEW: ${label.toUpperCase()} — ${list.length} SPEAKERS`;
  }
  const skips = [
    already ? `${already} already have it and are skipped` : '',
    noSess ? `${noSess} speaker${noSess === 1 ? '' : 's'} with no session are skipped` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  $('#bulk-preview').textContent = create
    ? `This will create ${create} “${tpl.name}” task${create === 1 ? '' : 's'}${
        skips ? ` · ${skips}` : ''
      }. Speakers see them in their portals immediately; assignment email follows the digest schedule.`
    : noSess
      ? `Nothing to create — ${noSess} matching speaker${noSess === 1 ? '' : 's'} have no session yet; session tasks need one.`
      : 'Everyone in this view already has this task — nothing to create.';
  $('#bulk-go').textContent = `Create ${create} tasks`;
  $('#bulk-go').style.cssText = `padding:9px 16px;border:none;font-size:13px;font-weight:600;${
    create ? 'background:#4c5fd5;color:#fff;cursor:pointer;' : 'background:#e2e3e8;color:#9a9da6;cursor:default;'
  }`;
  // Send every unassigned candidate — the server reports no-session skips honestly.
  $('#bulk-go').dataset.ids = create ? candidates.map((r) => r.id).join(',') : '';
  $('#bulk-go').dataset.tpl = tpl.id;
}

function openBulkForNewTemplate(tplId, preview, createdMessage) {
  bulkPreset = {
    ids: new Set(preview.speakerIds),
    noSession: new Set(preview.noSessionIds || []),
    declineMessage: createdMessage,
  };
  const n = preview.speakerIds.length;
  $('#bulk-title').textContent = `${n} existing speaker${n === 1 ? '' : 's'} match — assign now?`;
  fillBulkTemplates();
  $('#bulk-tpl').value = tplId;
  $('#bulk-tpl').disabled = true; // the offer is about the template just created
  renderBulk();
  openDialog('#dlg-bulk');
}

$('#bulk-open').addEventListener('click', () => {
  bulkPreset = null;
  $('#bulk-title').textContent = 'Assign a template to the current view';
  $('#bulk-tpl').disabled = false;
  fillBulkTemplates();
  renderBulk();
  openDialog('#dlg-bulk');
});
$('#bulk-tpl').addEventListener('change', renderBulk);
$('#bulk-go').addEventListener('click', async () => {
  const ids = ($('#bulk-go').dataset.ids || '').split(',').filter(Boolean);
  if (!ids.length) return;
  try {
    const res = await api('/app/api/speakers/bulk-assign', { templateId: $('#bulk-go').dataset.tpl, speakerIds: ids });
    bulkPreset = null; // assigned — the decline path must not fire
    reload(res.message);
  } catch (err) {
    toast(err.message, false);
  }
});

// Declining the post-create offer (Cancel, backdrop, Escape) leaves the
// template rule-only — but the page still reloads so the new template card
// and grid column appear.
new MutationObserver(() => {
  if ($('#dlg-bulk').hidden && bulkPreset) {
    const msg = bulkPreset.declineMessage;
    bulkPreset = null;
    reload(msg);
  }
}).observe($('#dlg-bulk'), { attributes: true, attributeFilter: ['hidden'] });

/* -------------------------------------------------------------- deep link */

const openParam = new URL(location.href).searchParams.get('open');
if (openParam) openSpeaker(openParam).catch(() => {});
