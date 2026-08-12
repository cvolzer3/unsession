/**
 * `/app/agenda` island — the drag-and-drop agenda builder.
 *
 * Geometry, conflict rules, colours and copy are ported from
 * `Agenda Builder.dc.html`: K = 1.3 px/min vertical, KB = 1.75 horizontal,
 * 15-minute snap, service blocks as grey bands across all rooms, sponsor blocks
 * tinted #fff4e6, conflicted blocks #fdecec with a #d64545 border.
 *
 * Every placement persists immediately (`/app/api/agenda/place`); the UI is
 * optimistic and reverts when the server says no.
 *
 * OWNER: B4.
 */
import { toast, api, openDialog } from './ui.js';
import { wireNewSession } from './sessions.js';

const root = document.getElementById('data-agenda');
if (root) boot(JSON.parse(root.textContent || '{}'));

function boot(D) {
  const K = D.K || 1.3;
  const KB = D.KB || 1.75;
  const SNAP = D.snap || 15;
  const D0 = D.dayStart;
  const DMAX = D.dayEnd;
  const GUT = 56;
  const RPAD = 10;
  const HEAD = 29; // room column header height — keeps the hour gutter aligned
  const MONO = "'IBM Plex Mono',monospace";
  const nDays = D.days.length;

  const S = {
    sessions: D.sessions.slice(),
    day: 0,
    view: 'rooms',
    layout: 'cols',
    selId: null,
    svcId: null,
    schedId: null,
    schedDay: 0,
    schedStart: Math.min(DMAX - 60, D0 + 240),
    schedRoom: D.rooms.length ? D.rooms[0].id : null,
    quickEdit: false,
    warn: null,
    snapshot: null,
    dragId: null,
    q: '',
    fDay: 'all',
    fTrack: 'all',
    fRoom: 'all',
    fStatus: 'all',
    sortKey: 'time',
    sortDir: 1,
    page: 0,
    unpublished: !!D.unpublished,
  };

  /* ------------------------------------------------------------- helpers */
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtTime = (m) => {
    const t = 480 + Math.round(m);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  const span = (p) => `${fmtTime(p.start)}–${fmtTime(p.end)}`;
  const trackOf = (id) => D.tracks.find((t) => t.id === id) || { name: '—', color: '#adb5bd' };
  const roomOf = (id) => D.rooms.find((r) => r.id === id);
  const roomName = (p) => (p.allRooms ? 'ALL ROOMS' : (roomOf(p.roomId) || {}).name || 'Unassigned');
  const byId = (id) => S.sessions.find((s) => s.id === id);
  const placedAll = () => S.sessions.filter((s) => s.day !== null && s.start !== null);
  const dayPlaced = (day) => placedAll().filter((s) => s.day === day).sort(byStart);
  const bin = () => S.sessions.filter((s) => s.day === null || s.start === null);
  const snap = (v) => Math.max(D0, Math.min(DMAX - SNAP, Math.round(v / SNAP) * SNAP));
  const byStart = (a, b) => a.start - b.start || a.end - b.end || (a.allRooms ? -1 : 1);
  const statusDot = (s) => (s.status === 'confirmed' ? '#2b8a3e' : '#e6a817');
  const speakerNames = (p) => p.speakers.map((x) => x.name).join(', ');
  const tabBtn = (on) =>
    `padding:7px 13px;border:none;font-size:12.5px;cursor:pointer;font-weight:600;background:${on ? '#16171d' : '#fff'};color:${
      on ? '#fff' : '#686b74'
    };white-space:nowrap;`;

  /* ------------------------------------------------------------- filters */
  const SEL_STYLE = 'padding:7px 8px;border:1px solid #d4d5db;font-size:12px;background:#fff;color:#33343c;';
  const filterSel = (name, value, opts) =>
    `<select data-filter="${name}" style="${SEL_STYLE}">` +
    opts.map((o) => `<option value="${esc(o.v)}"${String(o.v) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('') +
    '</select>';
  const trackOpts = () => [{ v: 'all', label: 'All tracks' }, ...D.tracks.map((t) => ({ v: t.id, label: t.name }))];
  const roomOpts = () => [
    { v: 'all', label: 'All rooms' },
    { v: 'ALL', label: 'All-room blocks' },
    ...D.rooms.map((r) => ({ v: r.id, label: r.name })),
  ];
  // Grid-view filters: venue-wide service bands always stay visible.
  const passTrack = (p) => S.fTrack === 'all' || p.allRooms || p.trackId === S.fTrack;
  const passRoom = (p) => {
    if (p.allRooms) return true;
    if (S.fRoom === 'all') return true;
    if (S.fRoom === 'ALL') return false;
    return p.roomId === S.fRoom;
  };

  /** Prototype `conflicts()` — mirrored on the server in `lib/agenda.ts`. */
  function conflicts(item, placed) {
    const msgs = [];
    if (item.day === null || item.start === null) return msgs;
    if (item.end > DMAX) msgs.push(`Runs past the event day (ends ${fmtTime(item.end)}, day ends ${fmtTime(DMAX)}).`);
    if (item.allRooms) return msgs;
    for (const o of placed) {
      if (o.id === item.id || o.allRooms) continue;
      if (o.day !== item.day) continue;
      if (!(item.start < o.end && o.start < item.end)) continue;
      if (o.roomId && o.roomId === item.roomId) {
        msgs.push(`Room double-booked: “${o.title}” is already in ${roomName(o)} at ${fmtTime(o.start)}.`);
      }
      const mine = item.speakers.map((x) => x.id);
      const both = o.speakers.filter((x) => mine.includes(x.id)).map((x) => x.name);
      if (both.length) msgs.push(`${both.join(' and ')} would be in two places at once (also in “${o.title}”, ${roomName(o)}).`);
    }
    return msgs;
  }

  function conflictSet() {
    const placed = placedAll();
    const out = new Set();
    for (const p of placed) {
      if (p.allRooms) continue;
      if (conflicts(p, placed).length) out.add(p.id);
    }
    return out;
  }

  /* ---------------------------------------------------------- persistence */
  function slotOf(s) {
    return s ? { day: s.day, start: s.start, end: s.end, roomId: s.roomId, allRooms: s.allRooms } : null;
  }

  function upsert(session) {
    const i = S.sessions.findIndex((s) => s.id === session.id);
    if (i === -1) S.sessions.push(session);
    else S.sessions[i] = session;
  }

  async function place(id, roomId, minutes, day, opts = {}) {
    const cur = byId(id);
    if (!cur) return;
    const before = slotOf(cur);
    const wasUnscheduled = cur.day === null;
    // Optimistic: move locally, then confirm with the server.
    const dur = cur.end !== null && cur.start !== null ? cur.end - cur.start : cur.dur;
    const end = opts.endMin != null ? opts.endMin : minutes + dur;
    Object.assign(cur, {
      day,
      start: minutes,
      end,
      roomId: cur.allRooms ? null : roomId,
      allRooms: cur.allRooms,
    });
    render();
    try {
      const res = await api('/app/api/agenda/place', {
        id,
        day,
        startMin: minutes,
        endMin: opts.endMin ?? null,
        roomId: cur.allRooms ? null : roomId,
        allRooms: cur.allRooms,
      });
      upsert(res.session);
      S.snapshot = { id, before, wasUnscheduled };
      S.warn = res.conflicts && res.conflicts.length ? { msgs: res.conflicts } : null;
      if (!S.warn) {
        flash(`Scheduled “${res.session.title}” — ${fmtTime(res.session.start)}, ${res.session.allRooms ? 'all rooms' : roomName(res.session)}`);
      }
      markDirty();
      render();
    } catch (err) {
      Object.assign(cur, before);
      render();
      toast(err.message, false);
    }
  }

  async function unschedule(id) {
    const cur = byId(id);
    if (!cur) return;
    const before = slotOf(cur);
    Object.assign(cur, { day: null, start: null, end: null });
    if (S.selId === id) S.selId = null;
    if (S.svcId === id) S.svcId = null;
    render();
    try {
      const res = await api('/app/api/agenda/unschedule', { id });
      upsert(res.session);
      S.snapshot = { id, before, wasUnscheduled: false };
      S.warn = null;
      flash(`“${res.session.title}” sent back to the bin`);
      markDirty();
      render();
    } catch (err) {
      Object.assign(cur, before);
      render();
      toast(err.message, false);
    }
  }

  async function undoDrop() {
    const snapshot = S.snapshot;
    S.warn = null;
    if (!snapshot) {
      render();
      return;
    }
    S.snapshot = null;
    if (snapshot.wasUnscheduled || snapshot.before.day === null) {
      await unschedule(snapshot.id);
    } else {
      const b = snapshot.before;
      await place(snapshot.id, b.roomId, b.start, b.day, { endMin: b.end });
    }
  }

  function markDirty() {
    S.unpublished = true;
    const dot = document.getElementById('unpublished-dot');
    if (dot) dot.hidden = false;
  }

  function flash(msg) {
    toast(msg);
  }

  /* --------------------------------------------------------------- render */
  const daybar = document.getElementById('daybar');
  const gridEl = document.getElementById('grid');
  const binEl = document.getElementById('bin');
  const binCount = document.getElementById('bin-count');
  const cardsEl = document.getElementById('cards');

  function render() {
    renderDaybar();
    renderBin();
    renderGrid();
    renderCards();
  }

  function renderDaybar() {
    const showDays = S.view === 'day' || S.view === 'rooms';
    let h = '';
    if (showDays) {
      h += '<div style="display:flex;border:1px solid #e2e3e8;background:#fff;">';
      for (const d of D.days) h += `<button type="button" data-day="${d.index}" style="${tabBtn(S.day === d.index)}">${esc(d.label)}</button>`;
      h += '</div>';
    }
    if (S.view === 'rooms') {
      h +=
        '<div style="margin-left:auto;display:flex;align-items:center;gap:8px;">' +
        filterSel('fTrack', S.fTrack, trackOpts()) +
        `<span style="font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;">LAYOUT</span>` +
        '<div style="display:flex;border:1px solid #e2e3e8;background:#fff;">' +
        `<button type="button" data-layout="cols" style="${tabBtn(S.layout === 'cols')}">Columns</button>` +
        `<button type="button" data-layout="lanes" style="${tabBtn(S.layout === 'lanes')}">Lanes</button>` +
        '</div></div>';
    } else if (S.view === 'day' || S.view === 'week') {
      h +=
        '<div style="margin-left:auto;display:flex;align-items:center;gap:8px;">' +
        filterSel('fTrack', S.fTrack, trackOpts()) +
        filterSel('fRoom', S.fRoom, roomOpts()) +
        '</div>';
    }
    daybar.innerHTML = h;
    daybar.style.display = h ? 'flex' : 'none';
  }

  function renderBin() {
    const list = bin();
    binCount.textContent = `${list.length} SESSION${list.length === 1 ? '' : 'S'}`;
    if (!list.length) {
      binEl.innerHTML =
        '<div style="border:1px dashed #d4d5db;padding:20px 14px;font-size:12.5px;color:#9a9da6;text-align:center;">Nothing waiting. Accepted sessions land here — or drag a scheduled card back.</div>';
      return;
    }
    binEl.innerHTML = list
      .map((b) => {
        const tr = trackOf(b.trackId);
        const status = b.type === 'service' ? 'SERVICE' : b.type === 'sponsor' ? 'SPONSOR' : String(b.status || '').toUpperCase();
        const statusColor = b.status === 'confirmed' && b.type === 'talk' ? '#2b8a3e' : b.type === 'talk' ? '#b08800' : '#9a9da6';
        return (
          `<div draggable="true" data-drag data-sid="${b.id}" style="border:1px solid #e2e3e8;border-left:3px solid ${tr.color};padding:9px 11px;background:#fff;cursor:grab;">` +
          '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">' +
          `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tr.color};"></span>` +
          `<span style="font-family:${MONO};font-size:10px;color:#9a9da6;">${b.dur} MIN</span>` +
          `<span style="margin-left:auto;font-family:${MONO};font-size:9px;color:${statusColor};">${esc(status)}</span>` +
          '</div>' +
          `<div style="font-size:12.5px;font-weight:600;line-height:1.3;">${esc(b.type === 'sponsor' ? 'SP · ' + b.title : b.title)}</div>` +
          `<div style="font-size:11.5px;color:#686b74;margin-top:2px;">${esc(speakerNames(b))}</div>` +
          (S.view === 'list'
            ? `<button type="button" data-schedule="${b.id}" style="margin-top:7px;width:100%;padding:5px 0;background:#eef0fb;border:1px solid #cdd4f0;color:#4c5fd5;font-size:11.5px;font-weight:600;cursor:pointer;">Schedule…</button>`
            : '') +
          '</div>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------ grid views */
  const gridH = () => (DMAX - D0) * K;

  function hourList() {
    const out = [];
    for (let m = Math.ceil((D0 + 1) / 60) * 60; m <= DMAX; m += 60) out.push(m);
    return out;
  }

  function blockStyle(p, conflicted, horizontal) {
    const tr = trackOf(p.trackId);
    const border = conflicted ? '#d64545' : p.type === 'sponsor' ? '#f0c078' : tr.color;
    const bg = conflicted ? '#fdecec' : p.type === 'sponsor' ? '#fff4e6' : '#fff';
    const geo = horizontal
      ? `left:${(p.start - D0) * KB}px;width:${(p.end - p.start) * KB - 3}px;top:5px;bottom:5px;`
      : `top:${(p.start - D0) * K}px;height:${(p.end - p.start) * K - 3}px;left:3px;right:3px;`;
    return (
      `position:absolute;overflow:hidden;cursor:grab;background:${bg};border:1px solid ${border};border-left:3px solid ${border};padding:4px 7px;` +
      geo +
      (S.selId === p.id ? 'outline:2px solid #4c5fd5;' : '')
    );
  }

  function blockHtml(p, cset, horizontal) {
    const conflicted = cset.has(p.id);
    const title = (p.type === 'sponsor' ? 'SP · ' : '') + p.title;
    const dot = `<span style="position:absolute;top:5px;right:5px;width:7px;height:7px;background:${statusDot(p)};"></span>`;
    if (horizontal) {
      return (
        `<div draggable="true" data-drag data-sid="${p.id}" style="${blockStyle(p, conflicted, true)}">` +
        `<div style="font-size:11px;font-weight:600;line-height:1.2;overflow:hidden;">${esc(title)}</div>` +
        `<div style="font-family:${MONO};font-size:9px;opacity:0.75;">${span(p)}</div>${dot}</div>`
      );
    }
    return (
      `<div draggable="true" data-drag data-sid="${p.id}" style="${blockStyle(p, conflicted, false)}">` +
      `<div style="font-family:${MONO};font-size:9px;opacity:0.75;">${span(p)}</div>` +
      `<div style="font-size:11.5px;font-weight:600;line-height:1.25;overflow:hidden;">${esc(title)}</div>` +
      `<div style="font-size:10.5px;opacity:0.75;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${esc(speakerNames(p))}</div>` +
      dot +
      '</div>'
    );
  }

  function svcPill(p, vertical) {
    return (
      `<span draggable="true" data-drag data-sid="${p.id}" title="Drag to move · click to edit" style="pointer-events:auto;cursor:grab;font-family:${MONO};font-size:${
        vertical ? 9 : 10
      }px;letter-spacing:0.08em;padding:${vertical ? '8px 3px' : '3px 9px'};background:#fff;border:1px solid #d4d7dc;color:#686b74;${
        vertical ? 'writing-mode:vertical-rl;' : ''
      }${S.svcId === p.id ? 'outline:2px solid #4c5fd5;' : ''}">${esc(p.title.toUpperCase())}${vertical ? '' : ' · ' + span(p) + ' ✎'}</span>`
    );
  }

  function renderRoomsCols() {
    const cset = conflictSet();
    const items = dayPlaced(S.day);
    const hours = hourList();
    let gutter = `<div style="position:relative;height:${gridH() + HEAD}px;">`;
    for (const m of hours) {
      gutter += `<div style="position:absolute;top:${(m - D0) * K - 7 + HEAD}px;right:8px;font-family:${MONO};font-size:10px;color:#9a9da6;">${fmtTime(
        m
      )}</div>`;
    }
    gutter += '</div>';

    let cols = `<div style="display:grid;grid-template-columns:repeat(${Math.max(1, D.rooms.length)},1fr);gap:6px;">`;
    for (const room of D.rooms) {
      const blocks = items.filter((p) => !p.allRooms && p.roomId === room.id && passTrack(p));
      cols +=
        '<div style="min-width:0;">' +
        `<div style="height:${HEAD}px;font-size:12.5px;font-weight:700;padding:0 2px 6px;display:flex;align-items:flex-end;"><span>${esc(
          room.name
        )}</span><span style="margin-left:auto;font-family:${MONO};font-size:10px;color:#9a9da6;">${blocks.length}</span></div>` +
        `<div data-drop="room:${room.id}" data-axis="v" style="position:relative;height:${gridH()}px;background:#fff;border:1px solid #e2e3e8;">` +
        hours.map((m) => `<div style="position:absolute;top:${(m - D0) * K}px;left:0;right:0;border-top:1px solid #f0f1f4;pointer-events:none;"></div>`).join('') +
        blocks.map((p) => blockHtml(p, cset, false)).join('') +
        '</div></div>';
    }
    cols += '</div>';

    const services = items
      .filter((p) => p.allRooms)
      .map(
        (p) =>
          `<div style="position:absolute;left:0;right:0;top:${(p.start - D0) * K + HEAD}px;height:${
            (p.end - p.start) * K - 3
          }px;background:rgba(173,181,189,0.16);border-top:1px solid #d4d7dc;border-bottom:1px solid #d4d7dc;display:flex;align-items:center;justify-content:center;color:#686b74;pointer-events:none;z-index:3;">${svcPill(
            p,
            false
          )}</div>`
      )
      .join('');

    gridEl.innerHTML =
      `<div style="display:grid;grid-template-columns:56px 1fr;gap:0;">${gutter}<div style="position:relative;">${cols}${services}</div></div>`;
  }

  function renderRoomsLanes() {
    const cset = conflictSet();
    const items = dayPlaced(S.day);
    const hours = hourList();
    let ruler = '<div style="position:relative;height:26px;margin-left:120px;">';
    for (const m of hours) {
      ruler += `<div style="position:absolute;left:${(m - D0) * KB - 14}px;top:4px;font-family:${MONO};font-size:10px;color:#9a9da6;">${fmtTime(
        m
      )}</div>`;
    }
    ruler += '</div>';

    let lanes = '<div style="position:relative;">';
    for (const room of D.rooms) {
      const blocks = items.filter((p) => !p.allRooms && p.roomId === room.id && passTrack(p));
      lanes +=
        '<div style="display:grid;grid-template-columns:120px 1fr;border-bottom:1px solid #e9eaee;">' +
        `<div style="padding:12px 10px;font-size:12.5px;font-weight:700;background:#fff;border-right:1px solid #e2e3e8;">${esc(
          room.name
        )}<div style="font-family:${MONO};font-size:10px;color:#9a9da6;font-weight:400;">${blocks.length} sessions</div></div>` +
        `<div data-drop="lane:${room.id}" data-axis="h" style="position:relative;height:74px;background:#fff;">` +
        hours
          .map((m) => `<div style="position:absolute;left:${(m - D0) * KB}px;top:0;bottom:0;border-left:1px solid #f0f1f4;pointer-events:none;"></div>`)
          .join('') +
        blocks.map((p) => blockHtml(p, cset, true)).join('') +
        '</div></div>';
    }
    lanes += items
      .filter((p) => p.allRooms)
      .map(
        (p) =>
          `<div style="position:absolute;top:0;bottom:0;left:${120 + (p.start - D0) * KB}px;width:${
            (p.end - p.start) * KB
          }px;background:rgba(173,181,189,0.16);border-left:1px solid #d4d7dc;border-right:1px solid #d4d7dc;display:flex;align-items:center;justify-content:center;color:#868e96;pointer-events:none;z-index:3;">${svcPill(
            p,
            true
          )}</div>`
      )
      .join('');
    lanes += '</div>';
    gridEl.innerHTML = `<div style="min-width:1180px;">${ruler}${lanes}</div>`;
  }

  /** Concurrency layout — the prototype's `layPrev`. */
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

  function pvBlock(p, fx0, fx1, cset) {
    const svc = p.allRooms;
    const tr = trackOf(p.trackId);
    const conflicted = cset.has(p.id);
    const top = (p.start - D0) * K;
    const h = (p.end - p.start) * K - 4;
    const left = `calc(${GUT + 3}px + (100% - ${GUT + RPAD + 3}px)*${fx0})`;
    const width = `calc((100% - ${GUT + RPAD + 3}px)*${fx1 - fx0} - 5px)`;
    const selOutline = S.selId === p.id || S.svcId === p.id ? 'outline:2px solid #4c5fd5;' : '';
    const style =
      `position:absolute;top:${top}px;height:${h}px;left:${left};width:${width};overflow:hidden;cursor:grab;${selOutline}` +
      (svc
        ? 'background:#f0f1f4;padding:5px 10px;'
        : `background:${conflicted ? '#fdecec' : '#fff'};border:1px solid ${conflicted ? '#d64545' : '#e2e3e8'};border-left:3px solid ${
            conflicted ? '#d64545' : tr.color
          };padding:5px 8px;`);
    const titleStyle = svc
      ? `font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;margin-top:1px;`
      : 'font-size:11.5px;font-weight:600;line-height:1.25;letter-spacing:-0.01em;margin-top:1px;';
    const title = svc ? p.title.toUpperCase() : (p.type === 'sponsor' ? 'SP · ' : '') + p.title;
    return (
      `<div draggable="true" data-drag data-sid="${p.id}" style="${style}">` +
      `<div style="display:flex;gap:6px;font-family:${MONO};font-size:9px;color:#9a9da6;overflow:hidden;"><span style="white-space:nowrap;flex-shrink:0;">${span(
        p
      )}</span><span style="margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(roomName(p))}</span></div>` +
      `<div style="${titleStyle}">${esc(title)}</div>` +
      `<div style="font-size:10px;color:#9a9da6;margin-top:1px;">${esc(svc ? '' : speakerNames(p))}</div>` +
      (svc ? '' : `<span style="position:absolute;top:5px;right:5px;width:7px;height:7px;background:${statusDot(p)};"></span>`) +
      '</div>'
    );
  }

  function pvLayout(day, fx0, fx1, cset) {
    const items = dayPlaced(day).filter((p) => passTrack(p) && passRoom(p));
    const out = [];
    for (const a of items.filter((x) => x.allRooms)) out.push(pvBlock(a, fx0, fx1, cset));
    for (const o of lay(items)) {
      const w = (fx1 - fx0) / o.cols;
      out.push(pvBlock(o.a, fx0 + w * o.col, fx0 + w * (o.col + 1), cset));
    }
    return out.join('');
  }

  function hourMarks(maxEnd) {
    let out = '';
    for (let m = Math.ceil((D0 + 1) / 60) * 60; m <= maxEnd; m += 60) {
      out +=
        `<div style="position:absolute;left:${GUT}px;right:0;top:${(m - D0) * K}px;border-top:1px solid #f0f1f4;"></div>` +
        `<div style="position:absolute;left:0;top:${(m - D0) * K - 6}px;width:${GUT - 10}px;text-align:right;font-family:${MONO};font-size:9.5px;color:#c2c4cb;">${fmtTime(
          m
        )}</div>`;
    }
    return out;
  }

  function renderDayView() {
    const cset = conflictSet();
    const maxEnd = Math.max(DMAX, ...dayPlaced(S.day).map((p) => p.end), DMAX);
    gridEl.innerHTML =
      '<div style="background:#fff;border:1px solid #e2e3e8;padding-top:8px;">' +
      `<div data-drop="pvday" data-axis="v" style="position:relative;height:${(maxEnd - D0 + 25) * K}px;">` +
      hourMarks(maxEnd) +
      pvLayout(S.day, 0, 1, cset) +
      '</div></div>';
  }

  function renderWeekView() {
    const cset = conflictSet();
    const maxEnd = Math.max(DMAX, ...placedAll().map((p) => p.end), DMAX);
    const w = 1 / nDays;
    let heads = `<div style="display:grid;grid-template-columns:56px repeat(${nDays},1fr);border-bottom:1px solid #e2e3e8;"><div></div>`;
    for (const d of D.days) {
      heads += `<div style="padding:10px 12px;font-family:${MONO};font-size:12px;font-weight:600;letter-spacing:0.1em;color:#33343c;background:#f5f5f7;border-left:1px solid #f0f1f4;">DAY ${
        d.index + 1
      } · ${esc(d.long)}</div>`;
    }
    heads += '</div>';
    let dividers = '';
    for (let i = 1; i < nDays; i++) {
      dividers += `<div style="position:absolute;top:0;bottom:0;left:calc(${GUT + 3}px + (100% - ${GUT + RPAD + 3}px)*${
        i * w
      });border-left:1px solid #e2e3e8;"></div>`;
    }
    let blocks = '';
    for (let i = 0; i < nDays; i++) blocks += pvLayout(i, i * w, (i + 1) * w - 0.01, cset);
    gridEl.innerHTML =
      '<div style="background:#fff;border:1px solid #e2e3e8;">' +
      heads +
      `<div data-drop="pvweek" data-axis="v" style="position:relative;height:${(maxEnd - D0 + 25) * K}px;">` +
      hourMarks(maxEnd) +
      dividers +
      blocks +
      '</div></div>';
  }

  /* ------------------------------------------------------------ list view */
  function statusKey(p, cset) {
    return p.allRooms ? 'service' : cset.has(p.id) ? 'conflict' : p.type === 'sponsor' ? 'sponsor' : p.status || p.type;
  }

  function renderListView() {
    const cset = conflictSet();
    const fq = (S.q || '').trim().toLowerCase();
    let rows = placedAll().filter(
      (p) =>
        (S.fDay === 'all' || p.day === +S.fDay) &&
        (S.fRoom === 'all' || (S.fRoom === 'ALL' ? p.allRooms : p.roomId === S.fRoom)) &&
        (S.fTrack === 'all' || p.trackId === S.fTrack) &&
        (S.fStatus === 'all' || statusKey(p, cset) === S.fStatus) &&
        (!fq || (p.title + ' ' + speakerNames(p)).toLowerCase().includes(fq))
    );
    const chrono = (p) => p.day * 10000 + p.start;
    const sortFns = {
      day: (p) => p.day,
      time: chrono,
      title: (p) => p.title.toLowerCase(),
      track: (p) => trackOf(p.trackId).name,
      room: (p) => roomName(p),
      status: (p) => statusKey(p, cset),
    };
    const kf = sortFns[S.sortKey] || chrono;
    rows = rows.slice().sort((a, b) => {
      const ka = kf(a);
      const kb = kf(b);
      return ((ka > kb) - (ka < kb)) * S.sortDir || chrono(a) - chrono(b);
    });
    const PAGE = 10;
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    const page = Math.min(S.page, pages - 1);
    const pageRows = rows.slice(page * PAGE, (page + 1) * PAGE);
    const hasFilters = !!fq || S.fDay !== 'all' || S.fTrack !== 'all' || S.fRoom !== 'all' || S.fStatus !== 'all';

    let head = '<div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap;">';
    head += `<input data-filter="q" value="${esc(S.q)}" placeholder="Search title or speaker…" style="flex:1;min-width:180px;max-width:280px;padding:7px 10px;border:1px solid #d4d5db;font-size:12.5px;background:#fff;">`;
    head += filterSel('fDay', S.fDay, [{ v: 'all', label: 'All days' }, ...D.days.map((d) => ({ v: String(d.index), label: d.label }))]);
    head += filterSel('fTrack', S.fTrack, trackOpts());
    head += filterSel('fRoom', S.fRoom, roomOpts());
    head += filterSel('fStatus', S.fStatus, [
      { v: 'all', label: 'All statuses' },
      { v: 'confirmed', label: 'Confirmed' },
      { v: 'pending', label: 'Pending' },
      { v: 'conflict', label: 'Conflicts' },
      { v: 'service', label: 'Service blocks' },
      { v: 'sponsor', label: 'Sponsor' },
    ]);
    if (hasFilters)
      head +=
        '<button type="button" data-clear-filters style="padding:7px 10px;background:none;border:none;color:#4c5fd5;font-size:12px;cursor:pointer;text-decoration:underline;">Clear filters</button>';
    head +=
      '<a href="/app/api/sessions/export.csv" style="margin-left:auto;padding:7px 10px;border:1px solid #e2e3e8;background:#fff;color:#16171d;font-size:12px;text-decoration:none;">Export CSV</a>';
    head += '</div>';

    const cols = '80px 96px 1fr 150px 110px 90px';
    let table = '<div style="background:#fff;border:1px solid #e2e3e8;">';
    table += `<div style="display:grid;grid-template-columns:${cols};gap:12px;padding:9px 14px;border-bottom:1px solid #e2e3e8;">`;
    for (const [k, label] of [
      ['day', 'DAY'],
      ['time', 'TIME'],
      ['title', 'SESSION'],
      ['track', 'TRACK'],
      ['room', 'ROOM'],
      ['status', 'STATUS'],
    ]) {
      table += `<button type="button" data-sort="${k}" style="background:none;border:none;padding:0;text-align:left;cursor:pointer;font-family:${MONO};font-size:9.5px;letter-spacing:0.12em;color:${
        S.sortKey === k ? '#4c5fd5' : '#9a9da6'
      };">${label}${S.sortKey === k ? (S.sortDir === 1 ? ' ▲' : ' ▼') : ''}</button>`;
    }
    table += '</div>';
    for (const p of pageRows) {
      const svc = p.allRooms;
      const conflicted = cset.has(p.id);
      const tr = trackOf(p.trackId);
      const st = svc ? 'SERVICE' : conflicted ? 'CONFLICT' : String(p.type === 'sponsor' ? 'sponsor' : p.status || p.type).toUpperCase();
      const stColor = conflicted ? '#b03434' : svc ? '#9a9da6' : p.status === 'confirmed' ? '#2b8a3e' : '#b08800';
      table +=
        `<div data-open="${p.id}" style="display:grid;grid-template-columns:${cols};gap:12px;padding:10px 14px;border-bottom:1px solid #f0f1f4;align-items:${
          svc ? 'center' : 'start'
        };cursor:pointer;${svc ? 'background:#f8f8fa;' : conflicted ? 'background:#fdecec;' : ''}${
          S.selId === p.id || S.svcId === p.id ? 'outline:2px solid #4c5fd5;outline-offset:-2px;' : ''
        }">` +
        `<span style="font-family:${MONO};font-size:10.5px;color:#9a9da6;">${esc((D.days[p.day] || {}).short || '')}</span>` +
        `<span style="font-family:${MONO};font-size:10.5px;font-weight:600;">${span(p)}</span>` +
        '<span>' +
        `<span style="${
          svc
            ? `font-family:${MONO};font-size:10.5px;letter-spacing:0.08em;color:#9a9da6;`
            : 'font-size:13px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;'
        }">${esc(svc ? p.title.toUpperCase() : (p.type === 'sponsor' ? 'SP · ' : '') + p.title)}</span>` +
        `<div style="font-size:11.5px;color:#686b74;margin-top:2px;">${esc(svc ? '' : speakerNames(p))}</div></span>` +
        `<span style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:#33343c;">${
          svc ? '' : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tr.color};flex-shrink:0;"></span>${esc(tr.name)}`
        }</span>` +
        `<span style="font-family:${MONO};font-size:10px;color:#9a9da6;">${esc(roomName(p))}</span>` +
        `<span style="font-family:${MONO};font-size:9.5px;color:${stColor};">${st}</span>` +
        '</div>';
    }
    if (!rows.length) table += '<div style="padding:28px 14px;text-align:center;font-size:12.5px;color:#9a9da6;">No sessions match these filters.</div>';
    table +=
      `<div style="display:flex;align-items:center;gap:8px;padding:9px 14px;font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;">` +
      `<span>${rows.length ? `${page * PAGE + 1}–${Math.min(rows.length, (page + 1) * PAGE)} OF ${rows.length} ITEMS` : '0 ITEMS'}</span>` +
      '<div style="margin-left:auto;display:flex;gap:8px;align-items:center;">' +
      `<button type="button" data-page="prev" style="padding:5px 10px;border:1px solid #e2e3e8;background:#fff;font-size:11.5px;cursor:pointer;${
        page === 0 ? 'opacity:0.4;pointer-events:none;' : ''
      }">← Prev</button>` +
      `<span>PAGE ${page + 1} / ${pages}</span>` +
      `<button type="button" data-page="next" style="padding:5px 10px;border:1px solid #e2e3e8;background:#fff;font-size:11.5px;cursor:pointer;${
        page >= pages - 1 ? 'opacity:0.4;pointer-events:none;' : ''
      }">Next →</button>` +
      '</div></div></div>';
    gridEl.innerHTML = head + table;
  }

  function renderGrid() {
    if (S.view === 'rooms') return S.layout === 'cols' ? renderRoomsCols() : renderRoomsLanes();
    if (S.view === 'day') return renderDayView();
    if (S.view === 'week') return renderWeekView();
    return renderListView();
  }

  /* ------------------------------------------------------ selection cards */
  const CARD = 'position:fixed;right:20px;bottom:20px;width:320px;background:#fff;border:1px solid #e2e3e8;box-shadow:0 16px 48px rgba(22,23,29,0.18);';

  function timeOpts(selected, filterFn) {
    let out = '';
    for (let m = D0; m <= DMAX; m += SNAP) {
      if (filterFn && !filterFn(m)) continue;
      out += `<option value="${m}"${m === selected ? ' selected' : ''}>${fmtTime(m)}</option>`;
    }
    return out;
  }

  function dayToggle(active, attr) {
    return (
      '<div style="display:flex;border:1px solid #e2e3e8;">' +
      D.days.map((d) => `<button type="button" ${attr}="${d.index}" style="${tabBtn(active === d.index)}flex:1;">${esc(d.label)}</button>`).join('') +
      '</div>'
    );
  }

  function renderCards() {
    let h = '';
    const sel = S.selId ? byId(S.selId) : null;
    const svc = S.svcId ? byId(S.svcId) : null;
    const sched = S.schedId ? byId(S.schedId) : null;

    if (sel && sel.day !== null) {
      const dur = sel.end - sel.start;
      h +=
        `<div style="${CARD}z-index:50;">` +
        '<div style="padding:14px 16px;border-bottom:1px solid #eceded;display:flex;align-items:flex-start;gap:8px;">' +
        `<div><div style="font-size:14px;font-weight:700;line-height:1.3;">${esc(sel.title)}</div>` +
        `<div style="font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:2px;">${span(sel)} · ${esc(roomName(sel))} · ${esc(
          String(sel.status || sel.type).toUpperCase()
        )}</div></div>` +
        '<button type="button" data-close="sel" style="margin-left:auto;background:none;border:none;font-size:16px;color:#9a9da6;cursor:pointer;">✕</button></div>' +
        '<div style="padding:12px 16px;font-size:12.5px;color:#33343c;display:grid;gap:10px;">' +
        `<div>${esc(speakerNames(sel) || 'No speakers (service block)')}</div>` +
        '<div style="border-top:1px solid #eceded;padding-top:10px;display:grid;gap:8px;">' +
        `<div style="font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;">MOVE</div>` +
        dayToggle(sel.day, 'data-sel-day') +
        '<div style="display:flex;gap:8px;">' +
        '<label style="flex:1;display:grid;gap:4px;font-size:11px;color:#686b74;">Starts' +
        `<select data-sel-start style="padding:6px;border:1px solid #d4d5db;font-size:12.5px;background:#fff;">${timeOpts(
          sel.start,
          (m) => m <= DMAX - dur
        )}</select></label>` +
        '<label style="flex:1;display:grid;gap:4px;font-size:11px;color:#686b74;">Room' +
        `<select data-sel-room style="padding:6px;border:1px solid #d4d5db;font-size:12.5px;background:#fff;">${D.rooms
          .map((r) => `<option value="${r.id}"${r.id === sel.roomId ? ' selected' : ''}>${esc(r.name)}</option>`)
          .join('')}</select></label></div></div>`;

      if (S.quickEdit) {
        h +=
          '<div style="border-top:1px solid #eceded;padding-top:10px;display:grid;gap:8px;">' +
          `<div style="font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;">QUICK EDIT</div>` +
          `<input data-qe-title value="${esc(sel.title)}" style="padding:7px 9px;border:1px solid #d4d5db;font-size:13px;font-weight:600;">` +
          `<label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;"><input type="checkbox" data-qe-pub${
            sel.published ? ' checked' : ''
          } style="width:14px;height:14px;accent-color:#4c5fd5;">Show on the public agenda</label>` +
          '<button type="button" data-qe-save style="padding:7px 0;background:#4c5fd5;color:#fff;border:none;font-size:12px;font-weight:600;cursor:pointer;">Save</button></div>';
      }

      h +=
        '<div style="display:flex;gap:6px;">' +
        '<button type="button" data-to-bin style="flex:1;padding:7px 0;background:#fde8e8;border:1px solid #f0c4c4;color:#8a2c2c;font-size:12px;cursor:pointer;">Back to bin</button>' +
        `<button type="button" data-quick-edit style="flex:1;padding:7px 0;background:${
          S.quickEdit ? '#eef0fb' : '#fff'
        };border:1px solid #e2e3e8;font-size:12px;cursor:pointer;">Quick edit</button></div></div></div>`;
    }

    if (svc && svc.day !== null) {
      const nextDay = (svc.day + 1) % nDays;
      h +=
        `<div style="${CARD}z-index:60;">` +
        '<div style="padding:14px 16px;border-bottom:1px solid #eceded;display:flex;align-items:center;gap:8px;">' +
        '<div style="font-size:14px;font-weight:700;">Service block</div>' +
        `<div style="font-family:${MONO};font-size:10px;color:#9a9da6;">${svc.allRooms ? 'SPANS ALL ROOMS' : esc(roomName(svc))}</div>` +
        '<button type="button" data-close="svc" style="margin-left:auto;background:none;border:none;font-size:16px;color:#9a9da6;cursor:pointer;">✕</button></div>' +
        '<div style="padding:12px 16px;display:grid;gap:10px;">' +
        '<label style="display:grid;gap:4px;font-size:11px;color:#686b74;">Title' +
        `<input data-svc-title value="${esc(svc.title)}" style="padding:7px 9px;border:1px solid #d4d5db;font-size:13px;font-weight:600;"></label>` +
        '<div style="display:grid;gap:4px;font-size:11px;color:#686b74;">Day' +
        dayToggle(svc.day, 'data-svc-day') +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
        '<label style="flex:1;display:grid;gap:4px;font-size:11px;color:#686b74;">Starts' +
        `<select data-svc-start style="padding:6px;border:1px solid #d4d5db;font-size:12.5px;background:#fff;">${timeOpts(
          svc.start,
          (m) => m < DMAX
        )}</select></label>` +
        '<label style="flex:1;display:grid;gap:4px;font-size:11px;color:#686b74;">Ends' +
        `<select data-svc-end style="padding:6px;border:1px solid #d4d5db;font-size:12.5px;background:#fff;">${timeOpts(
          svc.end,
          (m) => m > svc.start
        )}</select></label></div>` +
        '<div style="display:flex;gap:6px;">' +
        `<button type="button" data-svc-copy="${nextDay}" style="flex:1;padding:7px 0;background:#fff;border:1px solid #e2e3e8;font-size:12px;cursor:pointer;">Copy to Day ${
          nextDay + 1
        }</button>` +
        '<button type="button" data-svc-del style="flex:1;padding:7px 0;background:#fff;border:1px solid #f0c4c4;color:#c92a2a;font-size:12px;cursor:pointer;">Delete</button>' +
        '</div></div></div>';
    }

    if (sched) {
      h +=
        `<div style="${CARD}z-index:70;">` +
        '<div style="padding:14px 16px;border-bottom:1px solid #eceded;display:flex;align-items:flex-start;gap:8px;">' +
        `<div><div style="font-size:14px;font-weight:700;line-height:1.3;">${esc(sched.title)}</div>` +
        `<div style="font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:2px;">SCHEDULE · ${sched.dur} MIN</div></div>` +
        '<button type="button" data-close="sched" style="margin-left:auto;background:none;border:none;font-size:16px;color:#9a9da6;cursor:pointer;">✕</button></div>' +
        '<div style="padding:12px 16px;display:grid;gap:10px;">' +
        '<div style="display:grid;gap:4px;font-size:11px;color:#686b74;">Day' +
        dayToggle(S.schedDay, 'data-sched-day') +
        '</div><div style="display:flex;gap:8px;">' +
        '<label style="flex:1;display:grid;gap:4px;font-size:11px;color:#686b74;">Starts' +
        `<select data-sched-start style="padding:6px;border:1px solid #d4d5db;font-size:12.5px;background:#fff;">${timeOpts(
          S.schedStart,
          (m) => m <= DMAX - sched.dur
        )}</select></label>` +
        '<label style="flex:1;display:grid;gap:4px;font-size:11px;color:#686b74;">Room' +
        `<select data-sched-room style="padding:6px;border:1px solid #d4d5db;font-size:12.5px;background:#fff;">${D.rooms
          .map((r) => `<option value="${r.id}"${r.id === S.schedRoom ? ' selected' : ''}>${esc(r.name)}</option>`)
          .join('')}</select></label></div>` +
        '<button type="button" data-sched-place style="padding:9px 0;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">Place on agenda</button>' +
        '</div></div>';
    }

    if (S.warn) {
      h +=
        '<div style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#402b00;color:#ffe8b3;padding:14px 18px;z-index:80;box-shadow:0 8px 24px rgba(22,23,29,0.35);max-width:560px;">' +
        '<div style="display:flex;gap:10px;align-items:flex-start;"><span style="font-size:15px;">⚠</span>' +
        '<div style="flex:1;"><div style="font-weight:700;font-size:13px;margin-bottom:4px;">Placed with conflicts</div>' +
        S.warn.msgs.map((m) => `<div style="font-size:12.5px;line-height:1.45;">${esc(m)}</div>`).join('') +
        '</div>' +
        '<button type="button" data-undo style="padding:6px 12px;background:#ffe8b3;color:#402b00;border:none;font-size:12px;font-weight:700;cursor:pointer;">Undo</button>' +
        '<button type="button" data-dismiss-warn style="padding:6px 10px;background:transparent;color:#ffe8b3;border:1px solid #7a5c1a;font-size:12px;cursor:pointer;">Replace</button>' +
        '</div></div>';
    }
    cardsEl.innerHTML = h;
  }

  /* --------------------------------------------------------- interactions */
  document.addEventListener('click', async (e) => {
    const t = e.target;

    const viewBtn = t.closest('[data-view]');
    if (viewBtn) {
      S.view = viewBtn.dataset.view;
      document.querySelectorAll('[data-view]').forEach((b) => {
        b.setAttribute('style', tabBtn(b.dataset.view === S.view));
      });
      render();
      return;
    }
    const dayBtn = t.closest('[data-day]');
    if (dayBtn) {
      S.day = +dayBtn.dataset.day;
      render();
      return;
    }
    const layoutBtn = t.closest('[data-layout]');
    if (layoutBtn) {
      S.layout = layoutBtn.dataset.layout;
      render();
      return;
    }
    if (t.closest('[data-clear-filters]')) {
      Object.assign(S, { q: '', fDay: 'all', fTrack: 'all', fRoom: 'all', fStatus: 'all', page: 0 });
      renderGrid();
      return;
    }
    const sortBtn = t.closest('[data-sort]');
    if (sortBtn) {
      const k = sortBtn.dataset.sort;
      if (S.sortKey === k) S.sortDir = -S.sortDir;
      else {
        S.sortKey = k;
        S.sortDir = 1;
        S.page = 0;
      }
      renderGrid();
      return;
    }
    const pageBtn = t.closest('[data-page]');
    if (pageBtn) {
      S.page = Math.max(0, S.page + (pageBtn.dataset.page === 'next' ? 1 : -1));
      renderGrid();
      return;
    }

    const blk = t.closest('[data-sid]');
    if (blk && !t.closest('[data-schedule]')) {
      const s = byId(blk.dataset.sid);
      if (s && s.day !== null) {
        if (s.allRooms) {
          S.svcId = s.id;
          S.selId = null;
        } else {
          S.selId = s.id;
          S.svcId = null;
          S.quickEdit = false;
        }
        renderGrid();
        renderCards();
      }
      return;
    }
    const listRow = t.closest('[data-open]');
    if (listRow) {
      const s = byId(listRow.dataset.open);
      if (s) {
        if (s.allRooms) {
          S.svcId = s.id;
          S.selId = null;
        } else {
          S.selId = s.id;
          S.svcId = null;
          S.quickEdit = false;
        }
        renderGrid();
        renderCards();
      }
      return;
    }
    const schedBtn = t.closest('[data-schedule]');
    if (schedBtn) {
      S.schedId = schedBtn.dataset.schedule;
      S.schedDay = S.day;
      S.selId = null;
      S.svcId = null;
      renderCards();
      return;
    }

    const close = t.closest('[data-close]');
    if (close) {
      const which = close.dataset.close;
      if (which === 'sel') S.selId = null;
      if (which === 'svc') S.svcId = null;
      if (which === 'sched') S.schedId = null;
      renderGrid();
      renderCards();
      return;
    }
    if (t.closest('[data-dismiss-warn]')) {
      S.warn = null;
      renderCards();
      return;
    }
    if (t.closest('[data-undo]')) {
      await undoDrop();
      return;
    }
    if (t.closest('[data-quick-edit]')) {
      S.quickEdit = !S.quickEdit;
      renderCards();
      return;
    }
    if (t.closest('[data-qe-save]')) {
      const title = cardsEl.querySelector('[data-qe-title]').value.trim();
      const published = cardsEl.querySelector('[data-qe-pub]').checked;
      try {
        const res = await api('/app/api/sessions/update', { id: S.selId, patch: { title, published } });
        upsert(res.session);
        markDirty();
        toast('Saved — synced to agenda and public pages');
        render();
      } catch (err) {
        toast(err.message, false);
      }
      return;
    }
    if (t.closest('[data-to-bin]')) {
      await unschedule(S.selId);
      return;
    }

    const selDay = t.closest('[data-sel-day]');
    if (selDay) {
      const s = byId(S.selId);
      if (s) await place(s.id, s.roomId, s.start, +selDay.dataset.selDay);
      return;
    }
    const svcDay = t.closest('[data-svc-day]');
    if (svcDay) {
      const s = byId(S.svcId);
      if (s) {
        S.day = +svcDay.dataset.svcDay;
        await place(s.id, s.roomId, s.start, +svcDay.dataset.svcDay, { endMin: s.end });
      }
      return;
    }
    const schedDay = t.closest('[data-sched-day]');
    if (schedDay) {
      S.schedDay = +schedDay.dataset.schedDay;
      renderCards();
      return;
    }
    const copyBtn = t.closest('[data-svc-copy]');
    if (copyBtn) {
      try {
        const res = await api('/app/api/agenda/duplicate', { id: S.svcId, day: +copyBtn.dataset.svcCopy });
        upsert(res.session);
        markDirty();
        flash(`“${res.session.title}” copied to ${(D.days[res.session.day] || {}).label || 'the other day'}`);
        render();
      } catch (err) {
        toast(err.message, false);
      }
      return;
    }
    if (t.closest('[data-svc-del]')) {
      const s = byId(S.svcId);
      if (!s) return;
      try {
        await api('/app/api/agenda/delete', { id: s.id });
        S.sessions = S.sessions.filter((x) => x.id !== s.id);
        S.svcId = null;
        markDirty();
        flash(`“${s.title}” removed`);
        render();
      } catch (err) {
        toast(err.message, false);
      }
      return;
    }
    if (t.closest('[data-sched-place]')) {
      const s = byId(S.schedId);
      if (!s) return;
      S.schedId = null;
      S.day = S.schedDay;
      await place(s.id, S.schedRoom, S.schedStart, S.schedDay);
      return;
    }

    // Both sidebar buttons open the shared #new-session dialog with the right
    // Type preselected (the change event shows the matching branch).
    const addBtn = t.closest('#add-service') ? 'service' : t.closest('[data-dialog-open="#new-session"]') ? 'sponsor' : null;
    if (addBtn) {
      const kindSel = document.getElementById('ns-kind');
      if (kindSel && kindSel.value !== addBtn) {
        kindSel.value = addBtn;
        kindSel.dispatchEvent(new Event('change'));
      }
      if (t.closest('#add-service')) openDialog('#new-session');
      return;
    }

    if (t.closest('#publish-btn')) {
      const btn = t.closest('#publish-btn');
      btn.disabled = true;
      try {
        await api('/app/api/agenda/publish', {});
        S.unpublished = false;
        const dot = document.getElementById('unpublished-dot');
        if (dot) dot.hidden = true;
        toast('Published — public agenda updated');
      } catch (err) {
        toast(err.message, false);
      }
      btn.disabled = false;
    }
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    const filter = t.closest('[data-filter]');
    if (filter) {
      const key = filter.dataset.filter;
      S[key] = filter.value;
      S.page = 0;
      renderGrid();
      return;
    }
    if (t.matches('[data-sel-start]')) {
      const s = byId(S.selId);
      if (s) await place(s.id, s.roomId, +t.value, s.day);
      return;
    }
    if (t.matches('[data-sel-room]')) {
      const s = byId(S.selId);
      if (s) await place(s.id, t.value, s.start, s.day);
      return;
    }
    if (t.matches('[data-svc-start]')) {
      const s = byId(S.svcId);
      if (s) {
        const dur = s.end - s.start;
        await place(s.id, s.roomId, +t.value, s.day, { endMin: Math.min(DMAX, +t.value + dur) });
      }
      return;
    }
    if (t.matches('[data-svc-end]')) {
      const s = byId(S.svcId);
      if (s) await place(s.id, s.roomId, s.start, s.day, { endMin: +t.value });
      return;
    }
    if (t.matches('[data-sched-start]')) {
      S.schedStart = +t.value;
      return;
    }
    if (t.matches('[data-sched-room]')) {
      S.schedRoom = t.value;
    }
  });

  document.addEventListener('input', (e) => {
    const f = e.target.closest('input[data-filter]');
    if (!f) return;
    S[f.dataset.filter] = f.value;
    S.page = 0;
    const at = f.selectionStart;
    renderGrid();
    const again = gridEl.querySelector('input[data-filter="q"]');
    if (again) {
      again.focus();
      again.setSelectionRange(at, at);
    }
  });

  cardsEl.addEventListener('blur', async (e) => {
    const title = e.target.closest('[data-svc-title]');
    if (!title) return;
    const s = byId(S.svcId);
    if (!s || title.value.trim() === s.title) return;
    try {
      const res = await api('/app/api/sessions/update', { id: s.id, patch: { title: title.value.trim() } });
      upsert(res.session);
      markDirty();
      render();
    } catch (err) {
      toast(err.message, false);
    }
  }, true);

  /* -------------------------------------------------------- drag and drop */
  let ghost = null;

  function ensureGhost(zone) {
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.id = 'drag-ghost';
    }
    if (ghost.parentElement !== zone) zone.appendChild(ghost);
    return ghost;
  }

  function clearGhost() {
    if (ghost && ghost.parentElement) ghost.parentElement.removeChild(ghost);
  }

  function dragDur() {
    const s = byId(window.__dragId);
    if (!s) return 30;
    return s.start !== null && s.end !== null ? s.end - s.start : s.dur;
  }

  function ghostLabel(start, dur) {
    return `<span style="font-family:${MONO};font-size:9px;font-weight:700;background:#4c5fd5;color:#fff;padding:1px 5px;">${fmtTime(
      start
    )}–${fmtTime(start + dur)}</span>`;
  }

  function zoneTime(zone, e) {
    const rect = zone.getBoundingClientRect();
    if (zone.dataset.axis === 'h') return snap((e.clientX - rect.left) / KB + D0);
    return snap((e.clientY - rect.top) / K + D0);
  }

  function weekDayAt(zone, e) {
    const rect = zone.getBoundingClientRect();
    const frac = (e.clientX - rect.left - GUT - 3) / (rect.width - GUT - RPAD - 3);
    return Math.max(0, Math.min(nDays - 1, Math.floor(frac * nDays)));
  }

  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-drag]');
    if (!card) return;
    window.__dragId = card.dataset.sid;
    try {
      e.dataTransfer.setData('text', card.dataset.sid);
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      /* older browsers */
    }
  });

  document.addEventListener('dragend', clearGhost);

  document.addEventListener('dragover', (e) => {
    const zone = e.target.closest('[data-drop]');
    if (!zone) return;
    e.preventDefault();
    const kind = zone.dataset.drop;
    if (kind === 'bin') return;
    const dur = dragDur();
    const g = ensureGhost(zone);
    const start = zoneTime(zone, e);
    if (kind.startsWith('room:')) {
      g.style.cssText = `position:absolute;top:${(start - D0) * K}px;height:${
        dur * K - 3
      }px;left:3px;right:3px;background:rgba(76,95,213,0.10);border:1px dashed #4c5fd5;pointer-events:none;z-index:4;display:flex;align-items:flex-start;`;
    } else if (kind.startsWith('lane:')) {
      g.style.cssText = `position:absolute;left:${(start - D0) * KB}px;width:${
        dur * KB - 3
      }px;top:5px;bottom:5px;background:rgba(76,95,213,0.10);border:1px dashed #4c5fd5;pointer-events:none;z-index:4;display:flex;align-items:flex-start;`;
    } else {
      const day = kind === 'pvweek' ? weekDayAt(zone, e) : S.day;
      const w = kind === 'pvweek' ? 1 / nDays : 1;
      const fx0 = kind === 'pvweek' ? day * w : 0;
      const fx1 = fx0 + w - (kind === 'pvweek' ? 0.01 : 0);
      g.style.cssText = `position:absolute;top:${(start - D0) * K}px;height:${dur * K - 4}px;left:calc(${GUT + 3}px + (100% - ${
        GUT + RPAD + 3
      }px)*${fx0});width:calc((100% - ${GUT + RPAD + 3}px)*${
        fx1 - fx0
      } - 5px);background:rgba(76,95,213,0.10);border:1px dashed #4c5fd5;pointer-events:none;z-index:4;display:flex;align-items:flex-start;`;
    }
    g.innerHTML = ghostLabel(start, dur);
  });

  document.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('[data-drop]');
    if (!zone) return;
    if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
    clearGhost();
  });

  /** First room with no overlap at that slot — the prototype's `autoRoom`. */
  function autoRoom(start, dur, day) {
    const free = D.rooms.find((r) => !placedAll().some((p) => p.day === day && p.roomId === r.id && p.start < start + dur && start < p.end));
    return (free || D.rooms[0] || {}).id || null;
  }

  document.addEventListener('drop', async (e) => {
    const zone = e.target.closest('[data-drop]');
    if (!zone) return;
    e.preventDefault();
    clearGhost();
    const id = window.__dragId || (e.dataTransfer && e.dataTransfer.getData('text'));
    window.__dragId = null;
    const s = byId(id);
    if (!s) return;
    const kind = zone.dataset.drop;
    if (kind === 'bin') {
      if (s.day !== null) await unschedule(s.id);
      return;
    }
    const start = zoneTime(zone, e);
    if (kind.startsWith('room:') || kind.startsWith('lane:')) {
      await place(s.id, kind.slice(kind.indexOf(':') + 1), start, S.day);
      return;
    }
    const day = kind === 'pvweek' ? weekDayAt(zone, e) : S.day;
    const dur = s.start !== null && s.end !== null ? s.end - s.start : s.dur;
    await place(s.id, s.roomId || autoRoom(start, dur, day), start, day);
  });

  wireNewSession();
  render();
}
