/**
 * Public agenda island — view switching (LIST / DAY / WEEK / TRACK / ROOMS),
 * day tabs, track chips, search, sortable list headers, the session detail
 * popover and the EVENT TIME ↔ YOUR TIME toggle.
 *
 * Ported from `Agenda.dc.html`: 1.3 px/min time grid, 56px gutter, 10px right
 * pad, concurrency columns inside each overlap cluster. Colours come from the
 * event theme's CSS custom properties — never a hard-coded orange.
 *
 * OWNER: B4.
 */
const root = document.getElementById('data-public-agenda');
if (root) boot(JSON.parse(root.textContent || '{}'));

function boot(D) {
  const PPM = 1.3;
  const GUT = 56;
  const RPAD = 10;
  const MONO = 'var(--font-mono)';
  const nDays = D.days.length;

  const S = { view: 'list', day: 0, track: 'all', q: '', tz: 'event', sortKey: 'time', sortDir: 1, selId: null };

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ------------------------------------------------------------ timezone */
  function offsetMin(tz, dateIso) {
    try {
      const at = new Date(`${dateIso}T12:00:00Z`);
      const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName').value;
      const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
      if (!m) return 0;
      return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
    } catch {
      return 0;
    }
  }
  function abbrev(tz, dateIso) {
    try {
      const at = new Date(`${dateIso}T12:00:00Z`);
      const opts = { timeZoneName: 'short' };
      if (tz) opts.timeZone = tz;
      return new Intl.DateTimeFormat('en-US', opts).formatToParts(at).find((p) => p.type === 'timeZoneName').value;
    } catch {
      return tz || '';
    }
  }
  const day0 = (D.days[0] || {}).date || new Date().toISOString().slice(0, 10);
  const eventOffset = offsetMin(D.timezone, day0);
  const localOffset = -new Date(`${day0}T12:00:00Z`).getTimezoneOffset();
  const shiftMin = localOffset - eventOffset;
  const eventLabel = `EVENT TIME · ${abbrev(D.timezone, day0)}`;
  const hrs = shiftMin / 60;
  const localLabel = `YOUR TIME · ${abbrev(null, day0)} (${hrs < 0 ? '−' : '+'}${Math.abs(Number(hrs.toFixed(2)))})`;

  const shift = () => (S.tz === 'local' ? shiftMin : 0);
  const fmtTime = (m) => {
    const t = (((480 + Math.round(m + shift())) % 1440) + 1440) % 1440;
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  const span = (a) => `${fmtTime(a.start)}–${fmtTime(a.end)}`;

  /* -------------------------------------------------------------- data */
  const trackOf = (id) => D.tracks.find((t) => t.id === id) || { id: null, name: '—', color: '#adb5bd' };
  const byStart = (a, b) => a.start - b.start || a.end - b.end || (a.allRooms ? -1 : 1);
  const roomLabel = (a) => (a.allRooms ? 'ALL ROOMS' : a.room || '');
  const speakerNames = (a) => a.speakers.map((p) => p.name).join(', ');
  const matchesTrack = (a) => S.track === 'all' || a.allRooms || a.trackId === S.track;
  const matchesQ = (a) => !S.q || (a.title + ' ' + speakerNames(a)).toLowerCase().includes(S.q);
  const vis = (day) => D.sessions.filter((a) => a.day === day && matchesTrack(a)).sort(byStart);

  const bodyEl = document.getElementById('agenda-body');
  const detailEl = document.getElementById('agenda-detail');
  const dayTabs = document.getElementById('day-tabs');
  const chipsEl = document.getElementById('track-chips');
  const searchEl = document.getElementById('agenda-search');
  const clearEl = document.getElementById('clear-filters');
  const tzBtn = document.getElementById('tz-toggle');

  /* ------------------------------------------------------------- layout */
  function lay(items) {
    const talks = items.filter((a) => !a.allRooms);
    const out = [];
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
      const colsEnd = [];
      for (const s of cluster) {
        let col = colsEnd.findIndex((e) => e <= s.start);
        if (col === -1) {
          col = colsEnd.length;
          colsEnd.push(0);
        }
        colsEnd[col] = s.end;
        out.push({ a: s, col, cluster });
      }
      for (const o of out) if (o.cluster === cluster) o.cols = colsEnd.length;
    };
    for (const s of talks) {
      if (cluster.length && s.start >= clusterEnd) {
        flush();
        cluster = [];
        clusterEnd = -1;
      }
      cluster.push(s);
      clusterEnd = Math.max(clusterEnd, s.end);
    }
    if (cluster.length) flush();
    return out;
  }

  const titleStyle = 'font-size:11.5px;font-weight:600;line-height:1.25;letter-spacing:-0.01em;margin-top:1px;';
  const svcTitleStyle = `font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:var(--muted);margin-top:1px;`;

  function hourMarks(maxEnd) {
    let out = '';
    for (let m = 0; m <= maxEnd; m += 60) {
      out +=
        `<div style="position:absolute;left:${GUT}px;right:0;top:${m * PPM}px;border-top:1px solid var(--chip);"></div>` +
        `<div style="position:absolute;left:0;top:${m * PPM - 6}px;width:${GUT - 10}px;text-align:right;font-family:${MONO};font-size:9.5px;color:var(--faint);">${fmtTime(
          m
        )}</div>`;
    }
    return out;
  }

  function block(a, fx0, fx1, hideRoom) {
    const svc = a.allRooms;
    const tr = trackOf(a.trackId);
    const top = a.start * PPM;
    const h = (a.end - a.start) * PPM - 4;
    const left = `calc(${GUT + 3}px + (100% - ${GUT + RPAD + 3}px)*${fx0})`;
    const width = `calc((100% - ${GUT + RPAD + 3}px)*${fx1 - fx0} - 5px)`;
    const selOut = S.selId === a.id ? 'outline:2px solid var(--primary);outline-offset:-2px;' : '';
    const style =
      `position:absolute;top:${top}px;height:${h}px;left:${left};width:${width};overflow:hidden;` +
      (svc
        ? 'background:var(--chip);padding:5px 10px;'
        : `background:var(--card);border:1px solid var(--border);border-left:3px solid ${tr.color};padding:5px 8px;cursor:pointer;${selOut}`);
    return (
      `<div ${svc ? '' : `data-sid="${a.id}"`} style="${style}">` +
      `<div style="display:flex;gap:6px;font-family:${MONO};font-size:9px;color:var(--muted);overflow:hidden;"><span style="white-space:nowrap;flex-shrink:0;">${span(
        a
      )}</span><span style="margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${
        hideRoom ? '' : esc(roomLabel(a))
      }</span></div>` +
      `<div style="${svc ? svcTitleStyle : titleStyle}">${esc(svc ? a.title.toUpperCase() : a.title)}</div>` +
      `<div style="font-size:10px;color:var(--muted);margin-top:1px;">${esc(svc ? '' : speakerNames(a))}</div>` +
      '</div>'
    );
  }

  function dayLayout(day, fx0, fx1) {
    const items = vis(day);
    let out = '';
    for (const a of items.filter((x) => x.allRooms)) out += block(a, fx0, fx1);
    for (const o of lay(items)) {
      const w = (fx1 - fx0) / o.cols;
      out += block(o.a, fx0 + w * o.col, fx0 + w * (o.col + 1));
    }
    return out;
  }

  /* -------------------------------------------------------------- views */
  function renderList() {
    const rows = [];
    for (let i = 0; i < nDays; i++) rows.push(...vis(i).filter(matchesQ));
    const chrono = (a) => a.day * 10000 + a.start;
    const sortFns = {
      day: (a) => a.day,
      time: chrono,
      title: (a) => a.title.toLowerCase(),
      track: (a) => trackOf(a.trackId).name,
      room: (a) => roomLabel(a),
    };
    const kf = sortFns[S.sortKey] || chrono;
    rows.sort((a, b) => {
      const ka = kf(a);
      const kb = kf(b);
      return ((ka > kb) - (ka < kb)) * S.sortDir || chrono(a) - chrono(b);
    });
    const cols = '96px 100px 1fr 160px 120px';
    let h = '<div style="background:var(--card);border:1px solid var(--border);">';
    h += `<div style="display:grid;grid-template-columns:${cols};gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);">`;
    for (const [k, label] of [
      ['day', 'DAY'],
      ['time', 'TIME'],
      ['title', 'SESSION'],
      ['track', 'TRACK'],
      ['room', 'ROOM'],
    ]) {
      h += `<button type="button" data-sort="${k}" style="background:none;border:none;padding:0;text-align:left;cursor:pointer;font-family:${MONO};font-size:9.5px;letter-spacing:0.12em;color:${
        S.sortKey === k ? 'var(--primary)' : 'var(--muted)'
      };">${label}${S.sortKey === k ? (S.sortDir === 1 ? ' ▲' : ' ▼') : ''}</button>`;
    }
    h += '</div>';
    for (const a of rows) {
      const svc = a.allRooms;
      const tr = trackOf(a.trackId);
      h +=
        `<div ${svc ? '' : `data-sid="${a.id}"`} style="display:grid;grid-template-columns:${cols};gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);align-items:start;${
          svc ? 'background:var(--bg);' : `cursor:pointer;${S.selId === a.id ? 'outline:2px solid var(--primary);outline-offset:-2px;' : ''}`
        }">` +
        `<span style="font-family:${MONO};font-size:10.5px;color:var(--muted);">${esc((D.days[a.day] || {}).short || '')}</span>` +
        `<span style="font-family:${MONO};font-size:10.5px;color:var(--text);font-weight:600;">${span(a)}</span>` +
        '<span>' +
        `<span style="${
          svc ? `font-family:${MONO};font-size:10.5px;letter-spacing:0.08em;color:var(--muted);` : 'font-size:13.5px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;'
        }">${esc(svc ? a.title.toUpperCase() : a.title)}</span>` +
        (a.type === 'sponsor'
          ? `<span style="font-family:${MONO};font-size:8.5px;background:var(--chip);color:var(--muted);padding:2px 6px;letter-spacing:0.08em;margin-left:8px;">SPONSORED</span>`
          : '') +
        `<div style="font-size:11.5px;color:var(--muted);margin-top:2px;">${esc(svc ? '' : speakerNames(a))}</div></span>` +
        `<span style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--text-secondary);">${
          svc ? '' : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tr.color};flex-shrink:0;"></span>${esc(tr.name)}`
        }</span>` +
        `<span style="font-family:${MONO};font-size:10px;color:var(--muted);">${esc(roomLabel(a))}</span>` +
        '</div>';
    }
    if (!rows.length)
      h += '<div style="padding:28px 16px;text-align:center;font-size:12.5px;color:var(--muted);">No sessions match — try clearing the search or track filter.</div>';
    h += '</div>';
    bodyEl.innerHTML = h;
  }

  function renderDay() {
    const maxEnd = Math.max(D.dayEnd, ...vis(S.day).map((a) => a.end));
    bodyEl.innerHTML =
      '<div style="background:var(--card);border:1px solid var(--border);padding-top:8px;">' +
      `<div style="position:relative;height:${(maxEnd + 25) * PPM}px;">${hourMarks(maxEnd)}${dayLayout(S.day, 0, 1)}</div></div>`;
  }

  function renderWeek() {
    const maxEnd = Math.max(D.dayEnd, ...D.sessions.filter(matchesTrack).map((a) => a.end));
    const w = 1 / nDays;
    let heads = `<div style="display:grid;grid-template-columns:56px repeat(${nDays},1fr);border-bottom:1px solid var(--border);"><div></div>`;
    for (const d of D.days)
      heads += `<div style="padding:9px 10px;font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:var(--muted);border-left:1px solid var(--chip);">${esc(
        d.long
      )}</div>`;
    heads += '</div>';
    let dividers = '';
    for (let i = 1; i < nDays; i++)
      dividers += `<div style="position:absolute;top:0;bottom:0;left:calc(${GUT + 3}px + (100% - ${GUT + RPAD + 3}px)*${
        i * w
      });border-left:1px solid var(--border);"></div>`;
    let blocks = '';
    for (let i = 0; i < nDays; i++) blocks += dayLayout(i, i * w, (i + 1) * w - 0.01);
    bodyEl.innerHTML =
      '<div style="background:var(--card);border:1px solid var(--border);">' +
      heads +
      `<div style="position:relative;height:${(maxEnd + 25) * PPM}px;">${hourMarks(maxEnd)}${dividers}${blocks}</div></div>`;
  }

  function renderTrack() {
    const n = Math.max(1, D.tracks.length);
    let h = `<div style="display:grid;grid-template-columns:repeat(${n},1fr);gap:14px;">`;
    for (const tr of D.tracks) {
      const items = D.sessions.filter((a) => a.day === S.day && !a.allRooms && a.trackId === tr.id).sort(byStart);
      h += '<div>';
      h += `<div style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:var(--text);border-bottom:3px solid ${
        tr.color
      };padding-bottom:8px;margin-bottom:10px;">${esc(tr.name.toUpperCase())}</div>`;
      h += '<div style="display:grid;gap:8px;">';
      for (const a of items) {
        h +=
          `<div data-sid="${a.id}" style="background:var(--card);border:1px solid var(--border);padding:11px 12px;cursor:pointer;${
            S.selId === a.id ? 'outline:2px solid var(--primary);outline-offset:-2px;' : ''
          }">` +
          `<div style="display:flex;gap:6px;font-family:${MONO};font-size:9.5px;color:var(--muted);"><span style="color:var(--text);font-weight:600;">${span(
            a
          )}</span><span style="margin-left:auto;">${esc(roomLabel(a))}</span></div>` +
          `<div style="font-size:13px;font-weight:700;line-height:1.3;margin-top:4px;letter-spacing:-0.01em;">${esc(a.title)}</div>` +
          `<div style="font-size:11px;color:var(--muted);margin-top:3px;">${esc(speakerNames(a))}</div></div>`;
      }
      h += '</div>';
      if (!items.length) h += `<div style="font-family:${MONO};font-size:9.5px;color:var(--faint);">NO SESSIONS THIS DAY</div>`;
      h += '</div>';
    }
    h += '</div>';
    bodyEl.innerHTML = h;
  }

  function renderRooms() {
    const rooms = D.rooms;
    const n = Math.max(1, rooms.length);
    const maxEnd = Math.max(D.dayEnd, ...vis(S.day).map((a) => a.end));
    let heads = `<div style="display:grid;grid-template-columns:56px repeat(${n},1fr);border-bottom:1px solid var(--border);"><div></div>`;
    for (const r of rooms)
      heads += `<div style="padding:9px 8px;font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:var(--muted);border-left:1px solid var(--chip);">${esc(
        r.toUpperCase()
      )}</div>`;
    heads += '</div>';
    let blocks = '';
    for (const a of vis(S.day)) {
      if (a.allRooms) {
        blocks += block(a, 0, 1);
        continue;
      }
      const i = rooms.indexOf(a.room);
      const at = i === -1 ? 0 : i;
      blocks += block(a, at / n, (at + 1) / n, true);
    }
    bodyEl.innerHTML =
      '<div style="background:var(--card);border:1px solid var(--border);">' +
      heads +
      `<div style="position:relative;height:${(maxEnd + 25) * PPM}px;">${hourMarks(maxEnd)}${blocks}</div></div>`;
  }

  /* ------------------------------------------------------------- detail */
  function renderDetail() {
    const a = S.selId ? D.sessions.find((x) => x.id === S.selId) : null;
    if (!a) {
      detailEl.innerHTML = '';
      return;
    }
    const tr = trackOf(a.trackId);
    const dayLabel = ((D.days[a.day] || {}).long || '').toUpperCase();
    detailEl.innerHTML =
      '<div style="position:fixed;right:20px;bottom:20px;width:340px;max-width:calc(100vw - 40px);background:var(--card);border:1px solid var(--border);box-shadow:0 16px 48px rgba(26,26,46,0.18);z-index:50;">' +
      '<div style="padding:14px 16px;border-bottom:1px solid var(--chip);display:flex;align-items:flex-start;gap:8px;"><div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:5px;">' +
      `<span style="font-size:10px;font-family:${MONO};color:#fff;background:${tr.color};padding:2px 7px;letter-spacing:0.04em;">${esc(
        tr.name
      )}</span>` +
      (a.type === 'sponsor'
        ? `<span style="font-family:${MONO};font-size:8.5px;background:var(--chip);color:var(--muted);padding:2px 6px;letter-spacing:0.08em;">SPONSORED</span>`
        : '') +
      '</div>' +
      `<div style="font-size:15px;font-weight:700;line-height:1.3;">${esc(a.title)}</div>` +
      `<div style="font-family:${MONO};font-size:10.5px;color:var(--muted);margin-top:3px;">${span(a)} · ${esc(dayLabel)} · ${esc(
        roomLabel(a).toUpperCase()
      )}</div></div>` +
      '<button type="button" data-close-detail style="margin-left:auto;background:none;border:none;font-size:16px;color:var(--muted);cursor:pointer;">✕</button></div>' +
      '<div style="padding:16px;display:grid;gap:16px;">' +
      `<div style="font-size:13px;line-height:1.7;color:var(--text-secondary);padding-bottom:16px;border-bottom:1px solid var(--chip);">${esc(
        a.abstract || 'Session details coming soon.'
      )}</div>` +
      a.speakers
        .map(
          (p) =>
            '<div style="display:flex;gap:10px;align-items:center;">' +
            `<div style="width:32px;height:32px;background:var(--chip);color:var(--primary);display:grid;place-items:center;font-weight:700;font-size:12px;flex-shrink:0;">${esc(
              p.name
                .split(/\s+/)
                .map((w) => w[0])
                .join('')
                .slice(0, 2)
            )}</div>` +
            `<div><a href="/${D.slug}/speakers/${encodeURIComponent(p.slug)}" style="font-size:13px;font-weight:600;color:var(--text);text-decoration:none;border-bottom:1px solid var(--border-strong);">${esc(
              p.name
            )}</a>${p.bio ? ` <span style="font-size:12.5px;color:var(--muted);">— ${esc(p.bio)}</span>` : ''}</div></div>`
        )
        .join('') +
      '</div></div>';
  }

  /* ------------------------------------------------------------- chrome */
  const dayBtn = (on) =>
    `padding:7px 13px;border:1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'};background:${
      on ? 'var(--accent)' : 'var(--card)'
    };color:${on ? '#fff' : 'var(--text-secondary)'};font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;`;
  const viewBtn = (on) =>
    `padding:7px 14px;border:1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'};background:${
      on ? 'var(--accent)' : 'var(--card)'
    };color:${on ? '#fff' : 'var(--text-secondary)'};font-family:${MONO};font-size:10.5px;letter-spacing:0.1em;cursor:pointer;white-space:nowrap;flex-shrink:0;`;
  const chipStyle = (on, color) =>
    `display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid ${on ? color || 'var(--accent)' : 'var(--border-strong)'};background:${
      on ? color || 'var(--accent)' : 'var(--card)'
    };color:${on ? '#fff' : 'var(--text-secondary)'};font-size:11.5px;cursor:pointer;white-space:nowrap;flex-shrink:0;`;

  function renderChrome() {
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('style', viewBtn(b.dataset.view === S.view)));
    const showDays = S.view === 'day' || S.view === 'rooms' || S.view === 'track';
    dayTabs.hidden = !showDays || nDays < 2;
    if (showDays) {
      dayTabs.innerHTML = D.days
        .map((d) => `<button type="button" data-day="${d.index}" style="${dayBtn(S.day === d.index)}">${esc(d.label.split(' · ')[1] || d.label)}</button>`)
        .join('');
    }
    chipsEl.hidden = S.view === 'track';
    chipsEl.querySelectorAll('[data-track]').forEach((b) => {
      const id = b.dataset.track;
      const color = id === 'all' ? null : trackOf(id).color;
      const on = S.track === id;
      b.setAttribute('style', chipStyle(on, color));
      const dot = b.querySelector('[data-dot]');
      if (dot) dot.style.background = on ? '#fff' : color || '#adb5bd';
    });
    searchEl.hidden = S.view !== 'list';
    clearEl.hidden = !(S.q || S.track !== 'all');
    tzBtn.textContent = S.tz === 'event' ? eventLabel : localLabel;
  }

  function render() {
    renderChrome();
    if (S.view === 'list') renderList();
    else if (S.view === 'day') renderDay();
    else if (S.view === 'week') renderWeek();
    else if (S.view === 'track') renderTrack();
    else renderRooms();
    renderDetail();
  }

  /* -------------------------------------------------------------- events */
  document.addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]');
    if (view) {
      S.view = view.dataset.view;
      render();
      return;
    }
    const day = e.target.closest('[data-day]');
    if (day) {
      S.day = +day.dataset.day;
      render();
      return;
    }
    const chip = e.target.closest('[data-track]');
    if (chip) {
      S.track = chip.dataset.track;
      render();
      return;
    }
    const sort = e.target.closest('[data-sort]');
    if (sort) {
      const k = sort.dataset.sort;
      if (S.sortKey === k) S.sortDir = -S.sortDir;
      else {
        S.sortKey = k;
        S.sortDir = 1;
      }
      render();
      return;
    }
    if (e.target.closest('[data-close-detail]')) {
      S.selId = null;
      render();
      return;
    }
    if (e.target === clearEl || e.target.closest('#clear-filters')) {
      S.q = '';
      S.track = 'all';
      searchEl.value = '';
      render();
      return;
    }
    if (e.target.closest('#tz-toggle')) {
      S.tz = S.tz === 'event' ? 'local' : 'event';
      render();
      return;
    }
    const card = e.target.closest('[data-sid]');
    if (card) {
      S.selId = S.selId === card.dataset.sid ? null : card.dataset.sid;
      render();
    }
  });

  searchEl.addEventListener('input', () => {
    S.q = searchEl.value.trim().toLowerCase();
    renderChrome();
    if (S.view === 'list') renderList();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.selId) {
      S.selId = null;
      render();
    }
  });

  renderChrome();
}
