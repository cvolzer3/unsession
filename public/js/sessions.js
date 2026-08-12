/**
 * `/app/sessions` island — chips + track + search filtering, inline persistence
 * for the TYPE / SLOT / ROOM selects, the edit drawer and the New session
 * dialog. Ported from `Sessions.dc.html`'s logic class.
 *
 * OWNER: B4.
 */
import { toast, api, closeDialog } from './ui.js';

const dataEl = document.getElementById('data-sessions');
if (dataEl) {
  const D = JSON.parse(dataEl.textContent || '{}');
  const byId = new Map(D.sessions.map((s) => [s.id, s]));
  const trackById = new Map((D.tracks || []).map((t) => [t.id, t]));
  const roomById = new Map((D.rooms || []).map((r) => [r.id, r]));
  const formatById = new Map((D.formats || []).map((f) => [f.id, f]));

  const fmtTime = (m) => {
    const t = 480 + Math.round(m);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  const stateOf = (s) => (s.day !== null && s.start !== null ? 'scheduled' : s.roomId || s.allRooms ? 'ready' : 'needs');

  /* ------------------------------------------------------------- filters */
  let filter = 'all';
  let track = 'all';
  let q = '';

  const rows = () => Array.from(document.querySelectorAll('[data-row]'));

  function applyFilters() {
    let shown = 0;
    for (const row of rows()) {
      const okState = filter === 'all' || row.dataset.state === filter;
      const okTrack = track === 'all' || row.dataset.track === track;
      const okQ = !q || (row.dataset.search || '').includes(q);
      const show = okState && okTrack && okQ;
      row.hidden = !show;
      if (show) shown++;
    }
    const empty = document.getElementById('no-rows');
    if (empty) empty.hidden = shown !== 0 || rows().length === 0;
    recount();
  }

  function recount() {
    const counts = { all: 0, needs: 0, ready: 0, scheduled: 0 };
    for (const row of rows()) {
      counts.all++;
      counts[row.dataset.state] = (counts[row.dataset.state] || 0) + 1;
    }
    for (const key of Object.keys(counts)) {
      const el = document.querySelector(`[data-chip-count="${key}"]`);
      if (el) el.textContent = String(counts[key]);
    }
    const label = document.getElementById('session-count');
    if (label) label.textContent = counts.all ? `${counts.all} sessions · ${counts.needs} need a room` : '';
  }

  document.querySelectorAll('[data-chip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.chip;
      document.querySelectorAll('[data-chip]').forEach((b) => {
        const on = b.dataset.chip === filter;
        b.style.border = `1px solid ${on ? '#4c5fd5' : '#e2e3e8'}`;
        b.style.background = on ? '#eef0fb' : '#fff';
        b.style.color = on ? '#4c5fd5' : '#16171d';
        b.style.fontWeight = on ? '600' : '400';
      });
      applyFilters();
    });
  });
  const trackSel = document.getElementById('track-filter');
  if (trackSel) trackSel.addEventListener('change', () => { track = trackSel.value; applyFilters(); });
  const search = document.getElementById('session-search');
  if (search) search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); applyFilters(); });
  const abstractToggle = document.getElementById('show-abstract');
  if (abstractToggle) {
    abstractToggle.addEventListener('change', () => {
      document.querySelectorAll('[data-abstract]').forEach((el) => {
        el.hidden = !abstractToggle.checked;
      });
    });
  }

  /* --------------------------------------------------------- row repaint */
  function repaint(s) {
    byId.set(s.id, s);
    const row = document.querySelector(`[data-row][data-id="${s.id}"]`);
    if (!row) return;
    const cells = row.children;
    const state = stateOf(s);
    row.dataset.state = state;
    row.dataset.track = s.trackId || '';
    row.dataset.search = `${s.title} ${s.speakers.map((p) => p.name).join(' ')} ${s.sponsorName || ''}`.toLowerCase();

    const titleEl = cells[1].firstElementChild;
    titleEl.textContent = s.type === 'sponsor' ? `SP · ${s.title}` : s.title;
    cells[1].children[1].textContent =
      s.speakers.map((p) => p.name).join(', ') || (s.type === 'service' ? 'Service block · all rooms' : s.sponsorName || '—');

    const tr = s.trackId ? trackById.get(s.trackId) : null;
    cells[2].firstElementChild.style.background = (tr && tr.color) || '#adb5bd';
    cells[2].lastChild.textContent = tr ? tr.name : '—';

    const fmtSel = cells[3].querySelector('select');
    if (fmtSel) fmtSel.value = s.formatId || '';
    const durSel = cells[4].querySelector('select');
    if (durSel && durSel.querySelector(`option[value="${s.dur}"]`)) durSel.value = String(s.dur);
    const roomSel = cells[5].querySelector('select');
    if (roomSel) {
      roomSel.value = s.allRooms ? 'ALL' : s.roomId || '';
      roomSel.style.border = `1px solid ${s.roomId || s.allRooms ? '#e2e3e8' : '#e8c76a'}`;
    }

    const badge = cells[6].querySelector('[data-badge]');
    if (badge) {
      const b =
        state === 'scheduled'
          ? { t: `Day ${s.day + 1} · ${fmtTime(s.start)} · scheduled`, fg: '#1c7ed6', bg: '#e7f1fb' }
          : state === 'ready'
            ? { t: 'Ready for agenda', fg: '#2b8a3e', bg: '#e6f4ea' }
            : { t: 'Needs room', fg: '#b08800', bg: '#fdf5dc' };
      badge.textContent = b.t;
      badge.style.color = b.fg;
      badge.style.background = b.bg;
    }
    applyFilters();
  }

  async function save(id, patch, message) {
    const before = byId.get(id);
    try {
      const res = await api('/app/api/sessions/update', { id, patch });
      repaint(res.session);
      if (message) toast(message);
      return res.session;
    } catch (err) {
      if (before) repaint(before);
      toast(err.message, false);
      return null;
    }
  }

  /* ------------------------------------------------------ inline selects */
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-field]');
    if (!sel) return;
    const id = sel.dataset.id;
    const s = byId.get(id);
    if (!s) return;
    if (sel.dataset.field === 'format') {
      const opt = sel.selectedOptions[0];
      const dur = opt && opt.dataset.dur ? Number(opt.dataset.dur) : s.dur;
      const label = formatById.get(sel.value);
      save(id, { formatId: sel.value || null, duration: dur }, `${s.displayId} → ${label ? label.label : 'no format'}`);
    } else if (sel.dataset.field === 'duration') {
      save(id, { duration: Number(sel.value) }, null);
    } else if (sel.dataset.field === 'room') {
      const v = sel.value;
      const room = roomById.get(v);
      const msg = v === 'ALL'
        ? `${s.displayId} spans all rooms`
        : room
          ? `${s.displayId} assigned to ${room.name}${s.day !== null ? ' — agenda updated' : ''}`
          : `${s.displayId} room unassigned`;
      save(id, { roomId: v === 'ALL' ? null : v || null, allRooms: v === 'ALL' }, msg);
    }
  });

  /* --------------------------------------------------------------- drawer */
  const drawer = document.getElementById('drawer');
  const scrim = document.getElementById('drawer-scrim');
  let editing = null;

  function openDrawer(id) {
    const s = byId.get(id);
    if (!s) return;
    editing = id;
    document.getElementById('d-num').textContent = s.displayId;
    document.getElementById('d-title').value = s.title;
    document.getElementById('d-abstract').value = s.abstract || '';
    document.getElementById('d-track').value = s.trackId || '';
    document.getElementById('d-level').value = s.level || '';
    document.getElementById('d-format').value = s.formatId || '';
    const durSel = document.getElementById('d-duration');
    if (!durSel.querySelector(`option[value="${s.dur}"]`)) {
      const o = document.createElement('option');
      o.value = String(s.dur);
      o.textContent = `${s.dur} min`;
      durSel.appendChild(o);
    }
    durSel.value = String(s.dur);
    document.getElementById('d-room').value = s.allRooms ? 'ALL' : s.roomId || '';

    // The badge is a sponsor-session thing — hide the toggle for talks/services.
    const badgeRow = document.getElementById('d-badge-row');
    const badge = document.getElementById('d-badge');
    if (badgeRow && badge) {
      badgeRow.hidden = s.type !== 'sponsor';
      badge.checked = s.sponsorBadge !== false;
    }

    const sched = document.getElementById('d-sched');
    if (s.day !== null && s.start !== null) {
      const day = (D.days || [])[s.day];
      sched.hidden = false;
      document.getElementById('d-sched-date').textContent = day ? day.label : `Day ${s.day + 1}`;
      const room = s.allRooms ? 'All rooms' : (roomById.get(s.roomId) || {}).name || '';
      document.getElementById('d-sched-time').textContent =
        `${fmtTime(s.start)}${s.end !== null ? '–' + fmtTime(s.end) : ''}${room ? ' · ' + room : ''}`;
    } else {
      sched.hidden = true;
    }

    const list = document.getElementById('d-speakers');
    list.innerHTML = '';
    if (!s.speakers.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:12.5px;color:#9a9da6;';
      empty.textContent = s.type === 'service' ? 'Service blocks have no speakers.' : 'No speakers linked yet.';
      list.appendChild(empty);
    }
    for (const p of s.speakers) {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid #eceded;padding:10px 12px;';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:baseline;gap:8px;';
      const name = document.createElement('div');
      name.style.cssText = 'font-size:13.5px;font-weight:600;';
      name.textContent = p.name;
      head.appendChild(name);
      card.appendChild(head);
      list.appendChild(card);
    }
    drawer.hidden = false;
    scrim.hidden = false;
  }

  function closeDrawer() {
    editing = null;
    drawer.hidden = true;
    scrim.hidden = true;
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-drawer-close]') || e.target === scrim) {
      closeDrawer();
      return;
    }
    const row = e.target.closest('[data-row]');
    if (row && !e.target.closest('select')) openDrawer(row.dataset.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editing) closeDrawer();
  });

  const dFormat = document.getElementById('d-format');
  if (dFormat) {
    dFormat.addEventListener('change', () => {
      const opt = dFormat.selectedOptions[0];
      if (opt && opt.dataset.dur) {
        const durSel = document.getElementById('d-duration');
        if (durSel.querySelector(`option[value="${opt.dataset.dur}"]`)) durSel.value = opt.dataset.dur;
      }
    });
  }

  const dSave = document.getElementById('d-save');
  if (dSave) {
    dSave.addEventListener('click', async () => {
      if (!editing) return;
      const room = document.getElementById('d-room').value;
      const cur = byId.get(editing);
      const patch = {
        title: document.getElementById('d-title').value,
        abstract: document.getElementById('d-abstract').value,
        trackId: document.getElementById('d-track').value || null,
        level: document.getElementById('d-level').value || null,
        formatId: document.getElementById('d-format').value || null,
        duration: Number(document.getElementById('d-duration').value),
        roomId: room === 'ALL' ? null : room || null,
        allRooms: room === 'ALL',
      };
      if (cur && cur.type === 'sponsor') patch.sponsorBadge = document.getElementById('d-badge').checked;
      const saved = await save(editing, patch, 'Saved — synced to agenda and public pages');
      if (saved) closeDrawer();
    });
  }

  /* -------------------------------------------------- new session dialog */
  wireNewSession();
  recount();
}

/**
 * Shared by `/app/sessions` and `/app/agenda` — both render the same dialog.
 * `preset` preselects the sponsor branch when the builder opens it.
 */
export function wireNewSession() {
  const kind = document.getElementById('ns-kind');
  if (!kind) return;
  const sponsor = document.getElementById('ns-sponsor');
  const service = document.getElementById('ns-service');
  const sync = () => {
    sponsor.hidden = kind.value !== 'sponsor';
    service.hidden = kind.value !== 'service';
  };
  kind.addEventListener('change', sync);
  sync();

  // The badge preview fades when the toggle is off, so the dialog shows what
  // the public agenda will (not) carry.
  const badge = document.getElementById('ns-badge');
  const preview = document.getElementById('ns-badge-preview');
  if (badge && preview) {
    const syncBadge = () => {
      preview.style.opacity = badge.checked ? '1' : '0.35';
    };
    badge.addEventListener('change', syncBadge);
    syncBadge();
  }

  const preset = document.getElementById('ns-preset');
  const svcTitle = document.getElementById('ns-svc-title');
  if (preset && svcTitle) {
    preset.addEventListener('change', () => {
      if (preset.value) svcTitle.value = preset.value;
      else {
        svcTitle.value = '';
        svcTitle.focus();
      }
    });
  }

  const btn = document.getElementById('ns-create');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const isSponsor = kind.value === 'sponsor';
    const fmt = document.getElementById('ns-format');
    const fmtOpt = fmt ? fmt.selectedOptions[0] : null;
    const body = isSponsor
      ? {
          kind: 'sponsor',
          title: document.getElementById('ns-title').value.trim(),
          sponsorName: document.getElementById('ns-sponsor-name').value.trim(),
          sponsorBadge: document.getElementById('ns-badge').checked,
          abstract: document.getElementById('ns-abstract').value.trim(),
          trackId: document.getElementById('ns-track').value || null,
          formatId: fmt ? fmt.value || null : null,
          duration: fmtOpt && fmtOpt.dataset.dur ? Number(fmtOpt.dataset.dur) : 30,
          speaker: {
            name: document.getElementById('ns-sp-name').value.trim(),
            email: document.getElementById('ns-sp-email').value.trim(),
            bio: document.getElementById('ns-sp-bio').value.trim(),
          },
        }
      : {
          kind: 'service',
          title: svcTitle ? svcTitle.value.trim() : 'New break',
          duration: Number(document.getElementById('ns-svc-dur').value),
          allRooms: document.getElementById('ns-svc-all').checked,
        };
    if (!body.title) {
      toast('Give the session a title.', false);
      return;
    }
    btn.disabled = true;
    try {
      const res = await api('/app/api/sessions/create', body);
      closeDialog('#new-session');
      const msg = isSponsor
        ? `Sponsor session created — “${res.session.title}” is in the unscheduled bin`
        : `“${res.session.title}” created — drag it onto the grid`;
      const url = new URL(location.href);
      url.searchParams.set('ok', msg);
      location.href = url.toString();
    } catch (err) {
      toast(err.message, false);
      btn.disabled = false;
    }
  });
}
