/**
 * Public agenda island — view switching (LIST / DAY / WEEK / TRACK / ROOMS),
 * day tabs, track chips, search, sortable list headers, the session detail
 * sheet and the EVENT TIME ↔ YOUR TIME timezone toggle (spec B4 §1).
 *
 * Ported from `Agenda.dc.html`: 1.3 px/min time grid, 56px gutter, 10px right
 * pad, concurrency columns inside each overlap cluster. Colours come from the
 * event theme's CSS custom properties — never a hard-coded orange.
 *
 * The class names here (`ag-row`, `ag-dayhead`, `ag-sheet`, …) are styled by
 * the responsive <style> block the route emits — keep both sides in sync.
 * View, day, track, search, tz and the open session live in the URL
 * (`?view=…&day=…&track=…&q=…&tz=local` + `#s=<id>`) so agenda links are
 * shareable and survive a reload.
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

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ----------------------------------------------------------- URL state */
  const VIEW_IDS = ['list', 'day', 'week', 'track', 'rooms'].filter((v) => v !== 'week' || nDays > 1);
  const q0 = new URL(location.href).searchParams;
  const day0 = parseInt(q0.get('day'), 10);
  const S = {
    view: VIEW_IDS.includes(q0.get('view')) ? q0.get('view') : 'list',
    day: Number.isInteger(day0) && day0 >= 0 && day0 < nDays ? day0 : 0,
    track: D.tracks.some((t) => t.id === q0.get('track')) ? q0.get('track') : 'all',
    q: (q0.get('q') || '').trim().toLowerCase(),
    sortKey: 'time',
    sortDir: 1,
    tz: q0.get('tz') === 'local' ? 'local' : 'event',
    selId: (location.hash.match(/^#s=([\w-]+)$/) || [])[1] || null,
  };
  if (S.selId && !D.sessions.some((s) => s.id === S.selId)) S.selId = null;

  function syncUrl() {
    const u = new URL(location.href);
    const set = (k, v) => (v ? u.searchParams.set(k, v) : u.searchParams.delete(k));
    const dayViews = S.view === 'day' || S.view === 'rooms' || S.view === 'track';
    set('view', S.view !== 'list' && S.view);
    set('day', dayViews && S.day > 0 && String(S.day));
    set('track', S.track !== 'all' && S.track);
    set('q', S.q);
    set('tz', S.tz === 'local' && 'local');
    u.hash = S.selId ? `s=${S.selId}` : '';
    history.replaceState(null, '', u);
  }

  /* ---------------------------------------------------------------- time */
  // Event-time labels are minutes from the 08:00 grid origin, matching the
  // server-rendered list. "Your time" converts via the event's IANA timezone.
  const evTime = (m) => {
    const t = (((480 + Math.round(m)) % 1440) + 1440) % 1440;
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };

  const dtfCache = new Map();
  const dtf = (tz, opts) => {
    const k = tz + JSON.stringify(opts);
    if (!dtfCache.has(k)) dtfCache.set(k, new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, opts)));
    return dtfCache.get(k);
  };
  const tzParts = (epoch, tz, opts) => {
    const out = {};
    for (const p of dtf(tz, opts).formatToParts(epoch)) out[p.type] = p.value;
    return out;
  };
  /** Minutes east of UTC for `tz` at `epoch`. */
  const tzOffset = (epoch, tz) => {
    const p = tzParts(epoch, tz, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - epoch) / 60000;
  };
  const epochCache = new Map();
  /** Epoch ms of event day `day` at `m` minutes past the 08:00 grid origin. */
  const epochOf = (day, m) => {
    const key = day * 100000 + m;
    if (epochCache.has(key)) return epochCache.get(key);
    const wall = Date.parse(`${(D.days[day] || D.days[0]).date}T00:00:00Z`) + (480 + m) * 60000;
    let epoch = wall - tzOffset(wall, D.timezone) * 60000;
    epoch = wall - tzOffset(epoch, D.timezone) * 60000; // second pass settles DST edges
    epochCache.set(key, epoch);
    return epoch;
  };

  const viewerTz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      return null;
    }
  })();
  // The toggle only appears when the viewer's clock actually differs from the
  // event's during the event days (Berlin vs. Paris viewers see no button).
  let tzReady = false;
  try {
    if (viewerTz && D.timezone && viewerTz !== D.timezone && nDays) {
      const probes = [epochOf(0, 0), epochOf(nDays - 1, 0)];
      tzReady = probes.some((e) => tzOffset(e, viewerTz) !== tzOffset(e, D.timezone));
    }
  } catch {
    tzReady = false;
  }
  if (!tzReady) S.tz = 'event';

  const localHm = viewerTz ? new Intl.DateTimeFormat(undefined, { timeZone: viewerTz, hour: 'numeric', minute: '2-digit' }) : null;
  const timeLabel = (day, m) => (S.tz === 'local' && tzReady ? localHm.format(epochOf(day, m)) : evTime(m));
  /** "+1d" / "−1d" when the viewer's calendar date differs from the event's. */
  const dayShift = (day, m) => {
    if (S.tz !== 'local' || !tzReady) return '';
    const p = tzParts(epochOf(day, m), viewerTz, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const local = `${p.year}-${p.month}-${p.day}`;
    const event = (D.days[day] || {}).date || local;
    return local === event ? '' : local < event ? ' −1d' : ' +1d';
  };
  const span = (a) => `${timeLabel(a.day, a.start)}–${timeLabel(a.day, a.end)}${dayShift(a.day, a.start)}`;
  const tzAbbr = (tz) => {
    try {
      return tzParts(epochOf(0, 240), tz, { timeZoneName: 'short' }).timeZoneName || tz;
    } catch {
      return tz;
    }
  };

  /* -------------------------------------------------------------- data */
  const trackOf = (id) => D.tracks.find((t) => t.id === id) || { id: null, name: '—', color: '#adb5bd' };
  const byStart = (a, b) => a.start - b.start || a.end - b.end || (a.allRooms ? -1 : 1);
  const roomLabel = (a) => (a.allRooms ? 'ALL ROOMS' : a.room || '');
  const speakerNames = (a) => a.speakers.map((p) => p.name).join(', ');
  const speakerLine = (a) => a.speakers.map((p) => (p.affiliation ? p.name + ' (' + p.affiliation + ')' : p.name)).join(', ');
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
  const toolbarEl = document.getElementById('agenda-toolbar');

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

  function hourMarks(maxEnd, tzDay) {
    let out = '';
    for (let m = 0; m <= maxEnd; m += 60) {
      out +=
        `<div style="position:absolute;left:${GUT}px;right:0;top:${m * PPM}px;border-top:1px solid var(--chip);"></div>` +
        `<div style="position:absolute;left:0;top:${m * PPM - 6}px;width:${GUT - 10}px;text-align:right;font-family:${MONO};font-size:9.5px;color:var(--faint);">${timeLabel(
          tzDay,
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
      `<div ${svc ? '' : `data-sid="${a.id}" role="button" tabindex="0"`} style="${style}">` +
      `<div style="display:flex;gap:6px;font-family:${MONO};font-size:9px;color:var(--muted);overflow:hidden;"><span style="white-space:nowrap;flex-shrink:0;">${span(
        a
      )}</span><span style="margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${
        hideRoom ? '' : esc(roomLabel(a))
      }</span></div>` +
      `<div style="${svc ? svcTitleStyle : titleStyle}">${esc(svc ? a.title.toUpperCase() : a.title)}</div>` +
      `<div style="font-size:10px;color:var(--muted);margin-top:1px;">${esc(svc ? '' : speakerLine(a))}</div>` +
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

  /** Widest concurrency cluster of the day — sets the DAY view's minimum width. */
  function maxCols(day) {
    let n = 1;
    for (const o of lay(vis(day))) n = Math.max(n, o.cols);
    return n;
  }

  /* -------------------------------------------------------------- views */
  const rowHtml = (a) => {
    const svc = a.allRooms;
    const tr = trackOf(a.trackId);
    return (
      `<div class="ag-row" ${svc ? '' : `data-sid="${a.id}" role="button" tabindex="0"`} style="${
        svc ? 'background:var(--bg);' : `cursor:pointer;${S.selId === a.id ? 'outline:2px solid var(--primary);outline-offset:-2px;' : ''}`
      }">` +
      `<span class="ag-c-day">${esc((D.days[a.day] || {}).short || '')}</span>` +
      `<span class="ag-c-time">${span(a)}</span>` +
      '<span class="ag-c-main">' +
      `<span style="${svc ? svcTitleStyle : 'font-size:13.5px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;'}">${esc(
        svc ? a.title.toUpperCase() : a.title
      )}</span>` +
      (a.sponsorBadge
        ? `<span style="font-family:${MONO};font-size:8.5px;background:var(--chip);color:var(--muted);padding:2px 6px;letter-spacing:0.08em;margin-left:8px;">SPONSORED</span>`
        : '') +
      (svc ? '' : `<div style="font-size:11.5px;color:var(--muted);margin-top:2px;">${esc(speakerLine(a))}</div>`) +
      '</span>' +
      `<span class="ag-c-track">${
        svc ? '' : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tr.color};flex-shrink:0;"></span>${esc(tr.name)}`
      }</span>` +
      `<span class="ag-c-room">${svc ? 'ALL ROOMS' : esc(a.room || '')}</span>` +
      '</div>'
    );
  };

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
    let h = '<div style="background:var(--card);border:1px solid var(--border);">';
    h += '<div class="ag-headrow">';
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
    // Chronological sorts read as a programme — split them under day headers.
    const grouped = (S.sortKey === 'time' || S.sortKey === 'day') && nDays > 1;
    let lastDay = -1;
    for (const a of rows) {
      if (grouped && a.day !== lastDay) {
        lastDay = a.day;
        h += `<div class="ag-dayhead">${esc(((D.days[a.day] || {}).label || '').toUpperCase())}</div>`;
      }
      h += rowHtml(a);
    }
    if (!rows.length)
      h += '<div style="padding:28px 16px;text-align:center;font-size:12.5px;color:var(--muted);">No sessions match — try clearing the search or track filter.</div>';
    h += '</div>';
    bodyEl.innerHTML = h;
  }

  function renderDay() {
    const maxEnd = Math.max(D.dayEnd, ...vis(S.day).map((a) => a.end));
    const minW = GUT + RPAD + 130 * maxCols(S.day);
    bodyEl.innerHTML =
      `<div class="ag-hscroll"><div style="min-width:${minW}px;background:var(--card);border:1px solid var(--border);padding-top:8px;">` +
      `<div style="position:relative;height:${(maxEnd + 25) * PPM}px;">${hourMarks(maxEnd, S.day)}${dayLayout(S.day, 0, 1)}</div></div></div>`;
  }

  function renderWeek() {
    const maxEnd = Math.max(D.dayEnd, ...D.sessions.filter(matchesTrack).map((a) => a.end));
    const w = 1 / nDays;
    let heads = `<div style="display:grid;grid-template-columns:${GUT}px repeat(${nDays},1fr);border-bottom:1px solid var(--border);"><div></div>`;
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
      `<div class="ag-hscroll"><div style="min-width:${GUT + 170 * nDays}px;background:var(--card);border:1px solid var(--border);">` +
      heads +
      `<div style="position:relative;height:${(maxEnd + 25) * PPM}px;">${hourMarks(maxEnd, 0)}${dividers}${blocks}</div></div></div>`;
  }

  function renderTrack() {
    let h = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">';
    for (const tr of D.tracks) {
      const items = D.sessions.filter((a) => a.day === S.day && !a.allRooms && a.trackId === tr.id).sort(byStart);
      h += '<div>';
      h += `<div style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:var(--text);border-bottom:3px solid ${
        tr.color
      };padding-bottom:8px;margin-bottom:10px;">${esc(tr.name.toUpperCase())}</div>`;
      h += '<div style="display:grid;gap:8px;">';
      for (const a of items) {
        h +=
          `<div data-sid="${a.id}" role="button" tabindex="0" style="background:var(--card);border:1px solid var(--border);padding:11px 12px;cursor:pointer;${
            S.selId === a.id ? 'outline:2px solid var(--primary);outline-offset:-2px;' : ''
          }">` +
          `<div style="display:flex;gap:6px;font-family:${MONO};font-size:9.5px;color:var(--muted);"><span style="color:var(--text);font-weight:600;">${span(
            a
          )}</span><span style="margin-left:auto;">${esc(roomLabel(a))}</span></div>` +
          `<div style="font-size:13px;font-weight:700;line-height:1.3;margin-top:4px;letter-spacing:-0.01em;">${esc(a.title)}</div>` +
          `<div style="font-size:11px;color:var(--muted);margin-top:3px;">${esc(speakerLine(a))}</div></div>`;
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
    let heads = `<div style="display:grid;grid-template-columns:${GUT}px repeat(${n},1fr);border-bottom:1px solid var(--border);"><div></div>`;
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
      `<div class="ag-hscroll"><div style="min-width:${GUT + 150 * n}px;background:var(--card);border:1px solid var(--border);">` +
      heads +
      `<div style="position:relative;height:${(maxEnd + 25) * PPM}px;">${hourMarks(maxEnd, S.day)}${blocks}</div></div></div>`;
  }

  /* ------------------------------------------------------------- detail */
  /** Google Calendar template link — UTC instants via epochOf, like the .ics. */
  function googleUrl(a) {
    try {
      const fmt = (e) => new Date(e).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const where = [a.allRooms ? 'All rooms' : a.room || '', D.venue || ''].filter(Boolean).join(' · ');
      const p = new URLSearchParams({
        action: 'TEMPLATE',
        text: a.title,
        dates: `${fmt(epochOf(a.day, a.start))}/${fmt(epochOf(a.day, a.end))}`,
        details: `${speakerLine(a)}\n\n${location.origin}/${D.slug}/agenda#s=${a.id}`.trim(),
      });
      if (where) p.set('location', where);
      return `https://calendar.google.com/calendar/render?${p}`;
    } catch {
      return null; // unknown event timezone — the .ics link still works
    }
  }

  function renderDetail() {
    const a = S.selId ? D.sessions.find((x) => x.id === S.selId) : null;
    if (!a) {
      detailEl.innerHTML = '';
      return;
    }
    const tr = trackOf(a.trackId);
    const dayLabel = ((D.days[a.day] || {}).long || '').toUpperCase();
    const fmt = (D.formats || []).find((f) => f.id === a.formatId);
    const fmtLabel = fmt ? (fmt.duration ? `${fmt.name} (${fmt.duration} min)` : fmt.name) : '';
    detailEl.innerHTML =
      '<div class="ag-backdrop" data-close-detail></div>' +
      `<div class="ag-sheet" role="dialog" aria-label="${esc(a.title)}">` +
      '<div style="padding:14px 16px;border-bottom:1px solid var(--chip);display:flex;align-items:flex-start;gap:8px;flex-shrink:0;"><div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:5px;">' +
      `<span style="font-size:10px;font-family:${MONO};color:#fff;background:${tr.color};padding:2px 7px;letter-spacing:0.04em;">${esc(
        tr.name
      )}</span>` +
      (a.sponsorBadge
        ? `<span style="font-family:${MONO};font-size:8.5px;background:var(--chip);color:var(--muted);padding:2px 6px;letter-spacing:0.08em;">SPONSORED</span>`
        : '') +
      '</div>' +
      `<div style="font-size:15px;font-weight:700;line-height:1.3;">${esc(a.title)}</div>` +
      `<div style="font-family:${MONO};font-size:10.5px;color:var(--muted);margin-top:3px;">${span(a)} · ${esc(dayLabel)} · ${esc(
        roomLabel(a).toUpperCase()
      )}</div>` +
      (fmtLabel
        ? `<div style="font-family:${MONO};font-size:10px;color:var(--muted);margin-top:3px;">FORMAT: ${esc(fmtLabel.toUpperCase())}</div>`
        : '') +
      '</div>' +
      '<button type="button" data-close-detail aria-label="Close" style="margin-left:auto;background:none;border:none;font-size:16px;color:var(--muted);cursor:pointer;padding:2px 4px;">✕</button></div>' +
      '<div class="ag-sheet-body" style="padding:16px;display:grid;gap:16px;">' +
      `<div style="font-size:13px;line-height:1.7;color:var(--text-secondary);">${esc(
        a.abstract || 'Session details coming soon.'
      )}</div>` +
      (() => {
        const g = googleUrl(a);
        return (
          '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding-bottom:16px;border-bottom:1px solid var(--chip);font-size:12px;">' +
          `<a href="/${D.slug}/agenda/session/${a.id}.ics" style="white-space:nowrap;">＋ Add to calendar (.ics)</a>` +
          (g ? `<a href="${esc(g)}" target="_blank" rel="noopener noreferrer" style="white-space:nowrap;">Google Calendar ↗</a>` : '') +
          '</div>'
        );
      })() +
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
            )}</a>${p.affiliation ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:1px;">${esc(p.affiliation)}</div>` : ''}${
              p.bio ? `<div style="font-size:12.5px;color:var(--muted);margin-top:1px;">${esc(p.bio)}</div>` : ''
            }</div></div>`
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
    document.querySelectorAll('[data-view]').forEach((b) => {
      const on = b.dataset.view === S.view;
      b.setAttribute('style', viewBtn(on));
      b.setAttribute('aria-pressed', String(on));
    });
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
      b.setAttribute('aria-pressed', String(on));
      const dot = b.querySelector('[data-dot]');
      if (dot) dot.style.background = on ? '#fff' : color || '#adb5bd';
    });
    searchEl.hidden = S.view !== 'list';
    clearEl.hidden = !(S.q || S.track !== 'all');
    if (tzBtn) {
      tzBtn.hidden = !tzReady;
      if (tzReady) {
        tzBtn.textContent = S.tz === 'local' ? `YOUR TIME · ${tzAbbr(viewerTz)}` : `EVENT TIME · ${tzAbbr(D.timezone)}`;
        tzBtn.setAttribute('aria-pressed', String(S.tz === 'local'));
      }
    }
  }

  function render() {
    renderChrome();
    if (S.view === 'list') renderList();
    else if (S.view === 'day') renderDay();
    else if (S.view === 'week') renderWeek();
    else if (S.view === 'track') renderTrack();
    else renderRooms();
    renderDetail();
    syncUrl();
  }

  /* -------------------------------------------------------------- events */
  const toggleDetail = (sid) => {
    S.selId = S.selId === sid ? null : sid;
    render();
  };

  document.addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]');
    if (view) {
      S.view = view.dataset.view;
      render();
      return;
    }
    // Day tabs and track chips live in the toolbar — scope the lookup so a
    // stray data-* attribute elsewhere can never swallow a session click.
    const day = e.target.closest('#day-tabs [data-day]');
    if (day) {
      S.day = +day.dataset.day;
      render();
      return;
    }
    const chip = e.target.closest('#track-chips [data-track]');
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
    if (e.target === tzBtn) {
      S.tz = S.tz === 'local' ? 'event' : 'local';
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
    const card = e.target.closest('[data-sid]');
    if (card) toggleDetail(card.dataset.sid);
  });

  searchEl.addEventListener('input', () => {
    S.q = searchEl.value.trim().toLowerCase();
    renderChrome();
    if (S.view === 'list') renderList();
    syncUrl();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.selId) {
      S.selId = null;
      render();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.matches('[data-sid]')) {
      e.preventDefault();
      const sid = e.target.dataset.sid;
      toggleDetail(sid);
      const again = document.querySelector(`[data-sid="${sid}"]`);
      if (again) again.focus();
    }
  });

  /* ---------------------------------------------------------------- boot */
  // The toolbar sticks below the site header, whose height varies when the
  // event name wraps on small screens — measure instead of hard-coding 51px.
  const headerEl = document.body.firstElementChild;
  const setTop = () => {
    if (toolbarEl && headerEl) toolbarEl.style.top = `${Math.max(0, headerEl.offsetHeight - 1)}px`;
  };
  setTop();
  window.addEventListener('resize', setTop);

  if (S.q) searchEl.value = S.q;
  const restored = S.view !== 'list' || S.day || S.track !== 'all' || S.q || S.tz === 'local' || S.selId;
  if (restored) {
    render();
    if (S.selId) {
      const row = document.querySelector(`[data-sid="${S.selId}"]`);
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    }
  } else {
    renderChrome();
  }
}
