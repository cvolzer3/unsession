/**
 * `/app/evaluation` island (track B3).
 *
 * Server-rendered pages carry the data; this file owns the pieces the
 * prototype animates: the plan editor (criteria, reviewers, live rule preview,
 * scoring demo) and the reminders modal (selection, merged preview, automation).
 */
import { toast, api, busy, done } from './ui.js';

const MONO = "'IBM Plex Mono',monospace";
const node = document.getElementById('data-evaluation');
const DATA = node ? JSON.parse(node.textContent) : null;
if (DATA) boot();

function el(tag, style, text) {
  const n = document.createElement(tag);
  if (style) n.setAttribute('style', style);
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function boot() {
  autoSubmitFilters();
  cardLinks();
  toggleSwitches();
  if (DATA.editing) planEditor();
  reminders();
}

/* ------------------------------------------------------------ list filters */

function autoSubmitFilters() {
  document.querySelectorAll('form[data-autosubmit] select').forEach((s) => {
    s.addEventListener('change', () => s.form.submit());
  });
}

function cardLinks() {
  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-card-href]');
    if (!card) return;
    if (e.target.closest('[data-stop]') || e.target.closest('a')) return;
    location.href = card.getAttribute('data-card-href');
  });
}

/** The prototype's pill switch: an invisible checkbox painting a track + knob. */
function toggleSwitches() {
  document.querySelectorAll('[data-toggle-switch]').forEach((input) => {
    const wrap = input.parentElement;
    const track = wrap.querySelector('[data-track]');
    const knob = wrap.querySelector('[data-knob]');
    const paint = () => {
      track.style.background = input.checked ? '#4c5fd5' : '#d5d6db';
      knob.style.left = input.checked ? '16px' : '2px';
    };
    input.addEventListener('change', paint);
    paint();
  });
}

/* -------------------------------------------------------------- plan editor */

function planEditor() {
  const draft = DATA.draft;
  const demo = {};
  const $ = (id) => document.getElementById(id);

  const name = $('p-name');
  const opens = $('p-opens');
  const deadline = $('p-deadline');
  const anon = $('p-anon');
  const rem = $('p-reminders');
  const instructions = $('p-instructions');
  const reviewsPer = $('p-reviewsper');
  reviewsPer.value = String(draft.reviewsPer || 3);

  const critRows = $('crit-rows');
  const revRows = $('rev-rows');
  const ruleRow = $('rule-row');
  const pickRows = $('pick-rows');

  const RULE_DEFS = [
    { key: 'track', all: 'All tracks', opts: DATA.tracks.map((t) => ({ v: t.id, l: t.name })) },
    { key: 'form', all: 'All forms', opts: DATA.forms.map((f) => ({ v: f.id, l: f.name })) },
    { key: 'format', all: 'All formats', opts: DATA.formats.map((f) => ({ v: f, l: f })) },
    { key: 'level', all: 'All levels', opts: DATA.levels.map((l) => ({ v: l, l })) },
  ];

  function renderRules() {
    ruleRow.innerHTML = '';
    RULE_DEFS.forEach((def) => {
      const sel = el('select', 'padding:7px 8px;border:1px solid #e2e3e8;background:#fff;font-size:12.5px;');
      sel.appendChild(new Option(def.all, 'all'));
      def.opts.forEach((o) => sel.appendChild(new Option(o.l, o.v)));
      sel.value = draft.rules[def.key] || 'all';
      if (sel.value !== (draft.rules[def.key] || 'all')) sel.value = 'all';
      sel.addEventListener('change', () => {
        draft.rules[def.key] = sel.value;
        renderPreview();
      });
      ruleRow.appendChild(sel);
    });
    const status = el('select', 'padding:7px 8px;border:1px solid #e2e3e8;background:#fff;font-size:12.5px;');
    [
      ['active', 'Undecided (In Review)'],
      ['all', 'Any status'],
    ].forEach(([v, l]) => status.appendChild(new Option(l, v)));
    status.value = draft.rules.status || 'active';
    status.addEventListener('change', () => {
      draft.rules.status = status.value;
      renderPreview();
    });
    ruleRow.appendChild(status);

    const dirty =
      draft.rules.track !== 'all' ||
      draft.rules.form !== 'all' ||
      draft.rules.format !== 'all' ||
      draft.rules.level !== 'all' ||
      draft.rules.status !== 'active';
    if (dirty) {
      const reset = el('button', 'padding:7px 8px;background:none;border:none;color:#4c5fd5;font-size:12px;font-weight:600;cursor:pointer;', 'Reset rules ×');
      reset.type = 'button';
      reset.addEventListener('click', () => {
        draft.rules = { track: 'all', form: 'all', format: 'all', level: 'all', status: 'active' };
        renderRules();
        renderPreview();
      });
      ruleRow.appendChild(reset);
    }
  }

  function renderCriteria() {
    critRows.innerHTML = '';
    draft.criteria.forEach((c, i) => {
      c.type = c.type === 'select' || c.type === 'text' ? c.type : 'scale';
      if (!Array.isArray(c.options)) c.options = [];
      if (!(Number(c.weight) > 0)) c.weight = 1;

      const wrap = el('div', 'display:grid;gap:6px;');
      const row = el('div', 'display:grid;grid-template-columns:170px 1fr 106px 30px;gap:8px;align-items:center;');
      const nm = el('input', 'padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;font-weight:600;outline-color:#4c5fd5;');
      nm.value = c.name;
      nm.placeholder = 'Criterion';
      nm.addEventListener('input', () => {
        c.name = nm.value;
        renderPreview();
      });
      const hint = el('input', 'padding:8px 10px;border:1px solid #e2e3e8;font-size:12.5px;outline-color:#4c5fd5;');
      hint.value = c.hint || '';
      hint.placeholder = 'One-line hint for reviewers (optional)';
      hint.addEventListener('input', () => {
        c.hint = hint.value;
        renderPreview();
      });
      const type = el('select', 'padding:8px 6px;border:1px solid #e2e3e8;background:#fff;font-size:12px;');
      [
        ['scale', 'Rating'],
        ['select', 'Dropdown'],
        ['text', 'Free text'],
      ].forEach(([v, l]) => type.appendChild(new Option(l, v)));
      type.value = c.type;
      type.addEventListener('change', () => {
        c.type = type.value;
        renderCriteria();
        renderPreview();
      });
      const x = el('button', 'background:none;border:none;color:#9a9da6;font-size:15px;cursor:pointer;', '✕');
      x.type = 'button';
      x.addEventListener('click', () => {
        draft.criteria.splice(i, 1);
        renderCriteria();
        renderPreview();
      });
      row.append(nm, hint, type, x);
      wrap.appendChild(row);

      if (c.type === 'scale') {
        const cfg = el('div', 'display:flex;gap:8px;align-items:center;padding-left:178px;');
        const scale = el('select', 'padding:6px;border:1px solid #e2e3e8;background:#fff;font-size:12px;');
        [3, 5, 10].forEach((n) => scale.appendChild(new Option(n === 3 ? '1–3' : n === 5 ? '1–5' : '1–10', String(n))));
        scale.value = String(c.scale || 5);
        scale.addEventListener('change', () => {
          c.scale = Number(scale.value);
          renderPreview();
        });
        const wLabel = el('label', 'display:flex;gap:6px;align-items:center;font-size:11.5px;color:#686b74;', 'Weight ×');
        const weight = el('input', 'width:56px;padding:6px;border:1px solid #e2e3e8;font-size:12px;outline-color:#4c5fd5;');
        weight.type = 'number';
        weight.min = '0.5';
        weight.step = '0.5';
        weight.value = String(c.weight);
        weight.addEventListener('input', () => {
          c.weight = Number(weight.value) > 0 ? Number(weight.value) : 1;
          renderPreview();
        });
        wLabel.appendChild(weight);
        cfg.append(scale, wLabel);
        wrap.appendChild(cfg);
      } else if (c.type === 'select') {
        const cfg = el('div', 'padding-left:178px;display:grid;gap:6px;');
        c.options.forEach((opt, oi) => {
          const line = el('div', 'display:grid;grid-template-columns:1fr 30px;gap:8px;align-items:center;');
          const inp = el('input', 'padding:7px 10px;border:1px solid #e2e3e8;font-size:12.5px;outline-color:#4c5fd5;');
          inp.value = opt;
          inp.placeholder = `Option ${oi + 1}`;
          inp.addEventListener('input', () => {
            c.options[oi] = inp.value;
            renderPreview();
          });
          const rm = el('button', 'background:none;border:none;color:#9a9da6;font-size:13px;cursor:pointer;', '✕');
          rm.type = 'button';
          rm.addEventListener('click', () => {
            c.options.splice(oi, 1);
            renderCriteria();
            renderPreview();
          });
          line.append(inp, rm);
          cfg.appendChild(line);
        });
        const add = el('button', 'justify-self:start;padding:6px 12px;background:#fafafc;border:1px dashed #c9cbd2;color:#686b74;font-size:12px;cursor:pointer;', '+ Add option');
        add.type = 'button';
        add.addEventListener('click', () => {
          c.options.push('');
          renderCriteria();
          renderPreview();
          // renderCriteria rebuilt the rows — focus the new option in the fresh DOM.
          const fresh = critRows.children[i] && critRows.children[i].querySelectorAll('input[placeholder^="Option"]');
          if (fresh && fresh.length) fresh[fresh.length - 1].focus();
        });
        cfg.appendChild(add);
        wrap.appendChild(cfg);
      }
      critRows.appendChild(wrap);
    });
  }

  function renderReviewers() {
    revRows.innerHTML = '';
    draft.reviewers.forEach((r, i) => {
      const row = el('div', 'display:grid;grid-template-columns:1fr 110px 30px;gap:10px;align-items:center;border:1px solid #eceded;padding:7px 12px;');
      const who = el('div', 'min-width:0;');
      who.appendChild(el('div', 'font-size:13px;font-weight:600;', r.name));
      who.appendChild(el('div', `font-family:${MONO};font-size:10px;color:#9a9da6;`, r.email));
      const role = el('select', 'padding:6px 8px;border:1px solid #e2e3e8;background:#fff;font-size:12.5px;');
      role.appendChild(new Option('Member', 'member'));
      role.appendChild(new Option('Chair', 'chair'));
      role.value = r.role;
      role.addEventListener('change', () => {
        r.role = role.value;
        renderPreview();
      });
      const x = el('button', 'background:none;border:none;color:#9a9da6;font-size:14px;cursor:pointer;', '✕');
      x.type = 'button';
      x.addEventListener('click', () => {
        draft.reviewers.splice(i, 1);
        renderReviewers();
        renderAddOptions();
        renderPreview();
      });
      row.append(who, role, x);
      revRows.appendChild(row);
    });
  }

  const addReviewer = $('add-reviewer');
  function renderAddOptions() {
    addReviewer.innerHTML = '';
    addReviewer.appendChild(new Option('+ Add reviewer…', ''));
    DATA.people
      .filter((p) => !draft.reviewers.some((r) => r.userId === p.id))
      .forEach((p) => addReviewer.appendChild(new Option(`${p.name} · ${p.email}`, p.id)));
    addReviewer.value = '';
  }
  addReviewer.addEventListener('change', () => {
    const id = addReviewer.value;
    if (!id) return;
    const p = DATA.people.find((x) => x.id === id);
    if (p) draft.reviewers.push({ userId: p.id, role: 'member', name: p.name, email: p.email });
    renderReviewers();
    renderAddOptions();
    renderPreview();
  });

  $('add-crit').addEventListener('click', () => {
    draft.criteria.push({ name: '', hint: '', type: 'scale', scale: 5, options: [], weight: 1 });
    renderCriteria();
    renderPreview();
  });

  [name, opens, deadline, instructions].forEach((n) => n.addEventListener('input', renderPreview));
  [anon, rem].forEach((n) => n.addEventListener('change', renderPreview));
  reviewsPer.addEventListener('change', renderPreview);

  function matches(s, r) {
    if (r.track !== 'all' && s.trackId !== r.track) return false;
    if (r.form !== 'all' && s.formId !== r.form) return false;
    if (r.format !== 'all' && s.format !== r.format) return false;
    if (r.level !== 'all' && s.level !== r.level) return false;
    if (r.status === 'active') return s.status === 'in_review';
    if (r.status !== 'all' && s.status !== r.status) return false;
    return true;
  }

  function renderPreview() {
    const named = draft.criteria.filter((c) => c.name.trim());
    const scaled = named.filter((c) => (c.type || 'scale') === 'scale');
    const cumMax = scaled.reduce((a, c) => a + (Number(c.scale) || 5), 0);
    const matched = DATA.submissions.filter((s) => matches(s, draft.rules));
    const memberN = draft.reviewers.filter((r) => r.role !== 'chair').length;
    const rp = Math.max(1, Math.min(Number(reviewsPer.value) || 3, memberN || 1));

    $('cum-max').textContent = String(cumMax);
    $('demo-max').textContent = String(cumMax);
    $('match-label').textContent = `${matched.length} submission${matched.length === 1 ? '' : 's'} currently match`;

    pickRows.innerHTML = '';
    matched.forEach((s) => {
      const row = el('div', 'display:grid;grid-template-columns:60px minmax(0,1fr) 130px 90px;gap:8px;padding:7px 12px;border-bottom:1px solid #f2f3f5;align-items:center;');
      row.appendChild(el('div', `font-family:${MONO};font-size:10.5px;color:#9a9da6;`, s.displayId));
      row.appendChild(el('div', 'font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', s.title));
      const tr = el('div', 'display:flex;align-items:center;gap:6px;font-size:11.5px;color:#33343c;');
      tr.appendChild(el('span', `width:8px;height:8px;background:${s.trackColor};flex:none;`));
      tr.appendChild(document.createTextNode(s.trackName));
      row.appendChild(tr);
      row.appendChild(el('span', s.statusStyle, s.statusLabel));
      pickRows.appendChild(row);
    });
    if (!matched.length) {
      pickRows.appendChild(el('div', 'padding:24px 16px;text-align:center;font-size:12.5px;color:#686b74;', 'Nothing matches these rules.'));
    }

    $('edit-summary').textContent = `${named.length} criteria · ${draft.reviewers.length} reviewer${
      draft.reviewers.length === 1 ? '' : 's'
    } · ${matched.length} submissions · ${rp} review${rp === 1 ? '' : 's'} each`;

    $('pv-anon').textContent = anon.checked ? 'ANONYMIZED' : 'OPEN REVIEW';
    $('pv-instructions').textContent =
      instructions.value.trim() || 'Your instructions appear here, above every scoring form.';

    const pv = $('pv-crits');
    pv.innerHTML = '';
    named.forEach((c) => {
      const box = el('div');
      const head = el('div', 'display:flex;gap:8px;align-items:baseline;');
      head.appendChild(el('span', 'font-size:12.5px;font-weight:600;', c.name));
      head.appendChild(el('span', 'font-size:11px;color:#9a9da6;', c.hint || ''));
      if ((c.type || 'scale') === 'scale' && Number(c.weight) > 0 && Number(c.weight) !== 1) {
        head.appendChild(el('span', `margin-left:auto;font-family:${MONO};font-size:10px;color:#4c5fd5;`, `×${c.weight}`));
      }
      box.appendChild(head);
      if (c.type === 'select') {
        const sel = el('select', 'width:100%;margin-top:5px;padding:6px 8px;border:1px solid #e2e3e8;background:#fff;font-size:12px;');
        sel.appendChild(new Option('Choose…', ''));
        (c.options || []).filter((o) => o.trim()).forEach((o) => sel.appendChild(new Option(o, o)));
        box.appendChild(sel);
      } else if (c.type === 'text') {
        const ta = el('textarea', 'width:100%;box-sizing:border-box;margin-top:5px;padding:6px 8px;border:1px solid #e2e3e8;font-size:12px;font-family:inherit;resize:vertical;');
        ta.rows = 2;
        ta.placeholder = c.hint || 'Free-text answer…';
        box.appendChild(ta);
      } else {
        const btns = el('div', 'display:flex;gap:3px;margin-top:5px;');
        for (let n = 1; n <= (Number(c.scale) || 5); n++) {
          const on = demo[c.name];
          const b = el(
            'button',
            `flex:1;min-width:20px;height:26px;padding:0;border:1px solid ${on === n ? '#4c5fd5' : '#e2e3e8'};background:${
              on && n <= on ? '#eef0fb' : '#fff'
            };color:${on && n <= on ? '#4c5fd5' : '#686b74'};font-size:11px;font-weight:600;cursor:pointer;font-family:${MONO};`,
            n
          );
          b.type = 'button';
          b.addEventListener('click', () => {
            demo[c.name] = n;
            renderPreview();
          });
          btns.appendChild(b);
        }
        box.appendChild(btns);
      }
      pv.appendChild(box);
    });
    const demoSum = scaled.reduce((a, c) => a + (demo[c.name] || 0), 0);
    $('demo-cum').textContent = demoSum ? String(demoSum) : '—';

    const scope = $('scope-lines');
    scope.innerHTML = '';
    [
      ['Submissions', String(matched.length)],
      ['Reviewers', `${draft.reviewers.length} (${memberN} member${memberN === 1 ? '' : 's'})`],
      ['Reviews per submission', String(rp)],
      ['Evaluations', String(matched.length * rp)],
      ['Opens', opens.value || '—'],
      ['Deadline', deadline.value || '—'],
      ['Reminders', rem.checked ? 'on' : 'off'],
    ].forEach(([k, v]) => {
      const line = el('div', 'display:flex;font-size:12.5px;');
      line.appendChild(el('span', 'color:#686b74;', k));
      line.appendChild(el('span', `margin-left:auto;font-weight:600;font-family:${MONO};font-size:12px;`, v));
      scope.appendChild(line);
    });
  }

  $('save-plan').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const named = draft.criteria.filter((c) => c.name.trim());
    if (!name.value.trim()) return toast('Name the plan first', false);
    if (!named.length) return toast('Add at least one criterion', false);
    const emptySelect = named.find(
      (c) => c.type === 'select' && (!c.options || c.options.filter((o) => o.trim()).length < 2)
    );
    if (emptySelect) return toast(`Give “${emptySelect.name}” at least two dropdown options`, false);
    if (!draft.reviewers.some((r) => r.role !== 'chair')) return toast('Assign at least one member reviewer', false);
    // Creating a plan emails every new reviewer before the response comes back,
    // so the button owes the organizer a progress state.
    busy(btn, draft.id ? 'Saving…' : 'Creating plan…');
    try {
      const res = await api('/app/api/evaluation/plan', {
        id: draft.id,
        name: name.value.trim(),
        opensAt: opens.value,
        deadline: deadline.value,
        anonymized: anon.checked,
        reminders: rem.checked,
        instructions: instructions.value,
        reviewsPer: Number(reviewsPer.value) || 3,
        criteria: named,
        reviewers: draft.reviewers.map((r) => ({ userId: r.userId, role: r.role })),
        rules: draft.rules,
      });
      if (res.links && res.links.length) {
        // Email sending is simulated in dev — surface the invite links (DECISIONS D6).
        // The plan is saved, so the button stays disabled: a re-click would
        // create a second plan.
        done(btn);
        btn.disabled = true;
        showInviteLinks(res.links, res.redirect);
      } else {
        location.href = res.redirect;
      }
    } catch (err) {
      toast(err.message, false);
      done(btn);
    }
  });

  function showInviteLinks(links, redirect) {
    const box = el('div', 'border:1px solid #b08800;background:#fdf5dc;padding:12px 14px;margin-top:10px;');
    box.appendChild(
      el('div', `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#b08800;margin-bottom:6px;`, 'PLAN SAVED · EMAIL SENDING NOT YET ENABLED')
    );
    box.appendChild(el('div', 'font-size:12.5px;color:#686b74;margin-bottom:8px;', 'Reviewer sign-in links (they expire in 30 minutes):'));
    links.forEach((l) => {
      const a = el('a', 'display:block;font-size:12px;word-break:break-all;margin-bottom:4px;', `${l.email} — ${l.link}`);
      a.href = l.link;
      box.appendChild(a);
    });
    const go = el('a', 'display:inline-block;margin-top:8px;padding:8px 14px;background:#4c5fd5;color:#fff;font-size:13px;font-weight:600;text-decoration:none;', 'Continue →');
    go.href = redirect;
    box.appendChild(go);
    document.getElementById('plan-form').appendChild(box);
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  renderRules();
  renderCriteria();
  renderReviewers();
  renderAddOptions();
  renderPreview();
}

/* ---------------------------------------------------------------- reminders */

function reminders() {
  const modal = document.getElementById('rem-modal');
  if (!modal) return;
  const R = DATA.reminders;
  const auto = { ...R.automation };
  const selected = new Set(R.rows.filter((r) => r.remaining > 0).map((r) => r.userId));
  let pane = 'send';

  const $ = (id) => document.getElementById(id);
  const panes = {};
  modal.querySelectorAll('[data-rem-pane]').forEach((p) => {
    panes[p.getAttribute('data-rem-pane')] = p;
  });

  function showPane(next) {
    pane = next;
    Object.entries(panes).forEach(([k, node]) => {
      const on = k === next;
      node.hidden = !on;
      node.style.display = on ? 'flex' : 'none';
    });
    $('rem-title').textContent =
      next === 'auto'
        ? 'Automation settings'
        : next === 'editor'
          ? 'Edit reminder email'
          : R.scope === 'plan'
            ? `Remind reviewers · ${R.planName}`
            : 'Remind evaluators';
    const hdr = $('rem-hdr-btn');
    hdr.style.display = next === 'editor' ? 'none' : 'flex';
    $('rem-hdr-label').textContent = next === 'auto' ? '← Back to send' : 'Automation settings';
    const tabs = $('ed-tabs');
    tabs.hidden = next !== 'editor';
    tabs.style.display = next === 'editor' ? 'flex' : 'none';
    if (next === 'auto') renderUpcoming();
  }

  function open() {
    modal.hidden = false;
    showPane('send');
    renderRows();
  }
  function close() {
    modal.hidden = true;
  }

  document.querySelectorAll('[data-open-reminders]').forEach((b) => b.addEventListener('click', open));
  $('rem-x').addEventListener('click', () => (pane === 'send' ? close() : showPane('send')));
  $('rem-hdr-btn').addEventListener('click', () => showPane(pane === 'send' ? 'auto' : 'send'));
  modal.querySelectorAll('[data-rem-goto]').forEach((b) =>
    b.addEventListener('click', () => showPane(b.getAttribute('data-rem-goto')))
  );
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  /* --------------------------------------------------------------- send tab */

  const subject = $('rem-subject');
  const body = $('rem-body');

  function rowEls() {
    return [...modal.querySelectorAll('[data-rem-row]')];
  }

  function renderRows() {
    rowEls().forEach((row) => {
      const id = row.getAttribute('data-rem-row');
      const remaining = Number(row.getAttribute('data-remaining'));
      const box = row.querySelector('[data-box]');
      const on = selected.has(id);
      if (remaining === 0) return;
      box.style.borderColor = on ? '#4c5fd5' : '#c9cbd3';
      box.style.background = on ? '#4c5fd5' : '#fff';
      box.textContent = on ? '✓' : '';
    });
    const n = selected.size;
    $('rem-count').textContent = String(n);
    const send = $('send-rem');
    send.textContent = `Send now to ${n} evaluator${n === 1 ? '' : 's'}`;
    send.style.background = n ? '#4c5fd5' : '#c0c5e8';
    send.style.cursor = n ? 'pointer' : 'not-allowed';
    renderPreview();
  }

  function merge(tpl, row) {
    return (tpl || '').replace(/\{\{?\s*([\w.]+)\s*\}?\}/g, (whole, key) => {
      const vars = {
        first_name: row.name.split(' ')[0],
        speaker_name: row.name,
        remaining: String(row.remaining),
        deadline: row.deadlineLabel,
        event_name: DATA.eventName,
        evaluate_link: `${location.origin}/${DATA.slug}/evaluate`,
        organizer_name: 'the program team',
      };
      return vars[key] === undefined ? whole : vars[key];
    });
  }

  function firstSelected() {
    return R.rows.find((r) => selected.has(r.userId)) || R.rows.find((r) => r.remaining > 0) || null;
  }

  function renderPreview() {
    const row = firstSelected();
    const box = $('rem-preview');
    if (!row) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    $('pv-name').textContent = row.name;
    $('pv-subject').textContent = merge(subject.value, row);
    $('pv-body').textContent = merge(body.value, row);
  }

  rowEls().forEach((row) => {
    const id = row.getAttribute('data-rem-row');
    const remaining = Number(row.getAttribute('data-remaining'));
    if (remaining === 0) return;
    row.addEventListener('click', () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      renderRows();
    });
  });
  $('sel-left').addEventListener('click', () => {
    R.rows.filter((r) => r.remaining > 0).forEach((r) => selected.add(r.userId));
    renderRows();
  });
  $('sel-none').addEventListener('click', () => {
    selected.clear();
    renderRows();
  });
  subject.addEventListener('input', renderPreview);
  body.addEventListener('input', renderPreview);

  $('send-rem').addEventListener('click', async (e) => {
    if (!selected.size) return toast('Select at least one evaluator', false);
    const btn = e.currentTarget;
    busy(btn, 'Sending…');
    try {
      const res = await api('/app/api/evaluation/remind', {
        planId: R.planId,
        userIds: [...selected],
        subject: subject.value,
        body: body.value,
      });
      rowEls().forEach((row) => {
        if (selected.has(row.getAttribute('data-rem-row'))) row.lastElementChild.textContent = 'Today';
      });
      selected.clear();
      renderRows();
      close();
      toast(`Reminder emailed to ${res.names.join(', ')}`);
    } catch (err) {
      toast(err.message, false);
    }
    done(btn);
  });

  modal.querySelectorAll('[data-send-test]').forEach((b) =>
    b.addEventListener('click', async () => {
      busy(b, 'Sending…');
      try {
        const useEditor = pane === 'editor';
        const res = await api('/app/api/evaluation/remind-test', {
          planId: R.planId,
          subject: useEditor ? $('ed-subject').value : subject.value,
          body: useEditor ? $('ed-body').value : body.value,
        });
        toast(res.message);
      } catch (err) {
        toast(err.message, false);
      }
      done(b);
    })
  );

  /* --------------------------------------------------------------- editor */

  modal.querySelectorAll('[data-ed-view]').forEach((b) =>
    b.addEventListener('click', () => {
      const view = b.getAttribute('data-ed-view');
      modal.querySelectorAll('[data-ed-view]').forEach((x) => {
        const on = x === b;
        x.style.background = on ? '#eef0fb' : '#fff';
        x.style.color = on ? '#4c5fd5' : '#686b74';
      });
      modal.querySelectorAll('[data-ed-pane]').forEach((p) => {
        const on = p.getAttribute('data-ed-pane') === view;
        p.hidden = !on;
        p.style.display = on ? (view === 'edit' ? 'grid' : 'block') : 'none';
      });
      if (view === 'prev') {
        const row = firstSelected();
        $('ed-prev-to').textContent = row ? `${row.name} · ${row.email}` : '—';
        $('ed-prev-subj').textContent = row ? merge($('ed-subject').value, row) : $('ed-subject').value;
        $('ed-prev-body').textContent = row ? merge($('ed-body').value, row) : $('ed-body').value;
      }
    })
  );

  $('ed-save').addEventListener('click', async () => {
    try {
      await api('/app/api/evaluation/reminder-template', {
        subject: $('ed-subject').value,
        body: $('ed-body').value,
      });
      subject.value = $('ed-subject').value;
      body.value = $('ed-body').value;
      renderPreview();
      showPane('send');
      toast('Reminder email updated');
    } catch (err) {
      toast(err.message, false);
    }
  });

  /* ----------------------------------------------------------- automation */

  const autoToggle = $('auto-toggle');
  const autoKnob = $('auto-knob');
  const autoBody = $('auto-body');
  const minLeft = $('auto-minleft');
  const cooldown = $('auto-cooldown');

  function paintAuto() {
    autoToggle.style.background = auto.on ? '#4c5fd5' : '#c9cbd3';
    autoKnob.style.left = auto.on ? '19px' : '2px';
    $('auto-title').textContent = auto.on ? 'Automatic reminders are on' : 'Automatic reminders are off';
    autoBody.style.opacity = auto.on ? '' : '0.45';
    autoBody.style.pointerEvents = auto.on ? '' : 'none';
    renderUpcoming();
  }

  autoToggle.addEventListener('click', () => {
    auto.on = !auto.on;
    paintAuto();
  });
  minLeft.addEventListener('change', () => {
    auto.minLeft = Number(minLeft.value);
    renderUpcoming();
  });
  cooldown.addEventListener('change', () => {
    auto.cooldown = Number(cooldown.value);
  });
  modal.querySelectorAll('[data-sched]').forEach((row) =>
    row.addEventListener('click', () => {
      const k = row.getAttribute('data-sched');
      auto[k] = !auto[k];
      const box = row.querySelector('[data-box]');
      box.style.borderColor = auto[k] ? '#4c5fd5' : '#c9cbd3';
      box.style.background = auto[k] ? '#4c5fd5' : '#fff';
      box.textContent = auto[k] ? '✓' : '';
      renderUpcoming();
    })
  );

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function renderUpcoming() {
    const host = $('upcoming');
    host.innerHTML = '';
    if (!auto.on) {
      host.appendChild(el('div', 'font-size:12px;color:#9a9da6;', 'Turn automation on to see the schedule.'));
      return;
    }
    const points = [];
    if (auto.d14) points.push([14, '14 days before']);
    if (auto.d7) points.push([7, '7 days before']);
    if (auto.d3) points.push([3, '3 days before']);
    if (auto.over) points.push([-1, '1 day overdue · chair CC’d']);
    const out = [];
    R.plans.forEach((p) => {
      if (!p.deadline) return;
      if (!p.users.some((u) => u.remaining >= auto.minLeft)) return;
      points.forEach(([minus, label]) => {
        const dt = new Date(`${p.deadline.slice(0, 10)}T09:00:00Z`);
        dt.setUTCDate(dt.getUTCDate() - minus);
        if (dt.getTime() < Date.now()) return;
        out.push({ t: dt.getTime(), date: `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`, when: `${label} · ${p.name}` });
      });
    });
    out.sort((a, b) => a.t - b.t);
    if (!out.length) {
      host.appendChild(el('div', 'font-size:12px;color:#9a9da6;', 'No sends left before the deadlines you picked.'));
      return;
    }
    out.forEach((u) => {
      const row = el('div', 'padding:9px 0;border-bottom:1px solid #f2f3f5;');
      const line = el('div', 'display:flex;gap:8px;align-items:baseline;');
      line.appendChild(el('span', `font-family:${MONO};font-size:12px;font-weight:700;`, u.date));
      line.appendChild(el('span', 'font-size:11.5px;color:#686b74;', u.when));
      row.appendChild(line);
      host.appendChild(row);
    });
  }

  $('save-auto').addEventListener('click', async () => {
    try {
      const res = await api('/app/api/evaluation/automation', { planId: R.planId, automation: auto });
      showPane('send');
      const next = $('upcoming').querySelector('span');
      toast(
        auto.on
          ? `Automation saved on ${res.plans} plan${res.plans === 1 ? '' : 's'} — next send ${next ? next.textContent : '—'}`
          : 'Automation saved (turned off)'
      );
    } catch (err) {
      toast(err.message, false);
    }
  });

  paintAuto();
  renderRows();
}
