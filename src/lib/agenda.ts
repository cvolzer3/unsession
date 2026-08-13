/**
 * Agenda domain helpers — shared by `/app/sessions`, `/app/agenda`, the public
 * agenda, the speaker pages and the ICS route.
 *
 * Geometry and conflict rules are ported from `Agenda Builder.dc.html`
 * (`K = 1.3` px/min vertical, `KB = 1.75` horizontal, 15-minute snap) and are
 * mirrored 1:1 in `public/js/agenda-builder.js`.
 *
 * Times are minutes from the 08:00 grid origin with a day index; `day IS NULL`
 * means unscheduled (DECISIONS D9).
 */
import { all, now, one, run } from './db';
import { logActivity } from './activity';
import { renderTemplate, sendEmail } from './email';
import type { Bindings, Event } from '../types';

/** The grid's zero point: 08:00 local event time. */
export const GRID_ORIGIN_MIN = 480;
/** Vertical pixels per minute (prototype `K`). */
export const K = 1.3;
/** Horizontal pixels per minute in the lanes layout (prototype `KB`). */
export const KB = 1.75;
/** Drag snap, in minutes. */
export const SNAP = 15;

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `fmtTime` from the prototype's `data.js` — minutes from 08:00 → "14:00". */
export function fmtTime(m: number): string {
  const t = GRID_ORIGIN_MIN + Math.round(m);
  const h = Math.floor(t / 60);
  const mm = ((t % 60) + 60) % 60;
  return `${h}:${String(mm).padStart(2, '0')}`;
}

export function fmtSpan(start: number, end: number): string {
  return `${fmtTime(start)}–${fmtTime(end)}`;
}

/** Calendar-day arithmetic on `YYYY-MM-DD` strings (UTC, no DST surprises). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.round((db - da) / 86400000);
}

export type EventDay = { index: number; date: string; label: string; short: string; long: string };

/** One entry per calendar day of the event (1–5 in practice, hard-capped at 14). */
export function eventDays(event: Pick<Event, 'start_date' | 'end_date'>): EventDay[] {
  const span = Math.max(0, Math.min(13, daysBetween(event.start_date, event.end_date)));
  const out: EventDay[] = [];
  for (let i = 0; i <= span; i++) {
    const date = addDays(event.start_date, i);
    const d = new Date(`${date}T00:00:00Z`);
    const wd = WEEKDAYS[d.getUTCDay()];
    const mon = MONTHS[d.getUTCMonth()];
    const dom = d.getUTCDate();
    out.push({
      index: i,
      date,
      label: `Day ${i + 1} · ${wd}, ${mon} ${dom}`,
      short: `${wd.toUpperCase()} ${dom}`,
      long: `${wd.toUpperCase()} · ${mon.toUpperCase()} ${dom}`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ rows */

export type SessionRow = {
  id: string;
  event_id: string;
  submission_id: string | null;
  type: string; // talk | sponsor | service
  title: string;
  abstract: string;
  track_option_id: string | null;
  format_option_id: string | null;
  level: string | null;
  duration_min: number;
  room_id: string | null;
  all_rooms: number;
  day: number | null;
  start_min: number | null;
  end_min: number | null;
  status: string; // pending | confirmed
  published: number;
  sponsor_name: string | null;
  /** Sponsor sessions only: show the SPONSORED badge on public pages. */
  sponsor_badge: number;
  stream_url: string | null;
  visibility_json: string | null;
  ics_sequence: number;
  created_at: string;
  updated_at: string;
  sub_seq?: number | null;
};

export type RoomRow = { id: string; name: string; capacity: number | null; priority: number };
export type OptRow = {
  id: string;
  name: string;
  color: string | null;
  duration_min: number | null;
  position: number;
  taxonomy: string;
};
export type SpeakerLite = {
  id: string;
  name: string;
  slug: string;
  email: string;
  bio: string;
  job_title: string | null;
  company: string | null;
  /** Legacy free-text "CTO at Acme" line — display fallback when job_title/company are unset. */
  tagline: string | null;
  headshot_file_id: string | null;
};

/** "Job title · Company" line for a speaker, falling back to the legacy free-text tagline. */
export function speakerAffiliation(p: { job_title?: string | null; company?: string | null; tagline?: string | null }): string {
  const title = (p.job_title ?? '').trim();
  const company = (p.company ?? '').trim();
  if (title || company) return [title, company].filter(Boolean).join(' · ');
  return (p.tagline ?? '').trim();
}

export type AgendaBundle = {
  rooms: RoomRow[];
  tracks: OptRow[];
  formats: OptRow[];
  levels: OptRow[];
  sessions: SessionRow[];
  /** sessionId → speakers, in position order. */
  speakers: Map<string, SpeakerLite[]>;
};

export const TRACK_FALLBACK = { name: '—', color: '#adb5bd' };

export async function loadAgenda(db: D1Database, eventId: string): Promise<AgendaBundle> {
  const [rooms, options, sessions, links] = await Promise.all([
    all<RoomRow>(db, `SELECT id, name, capacity, priority FROM rooms WHERE event_id = ? ORDER BY priority, name`, eventId),
    all<OptRow>(
      db,
      `SELECT o.id, o.name, o.color, o.duration_min, o.position, t.name AS taxonomy
         FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
        WHERE t.event_id = ? ORDER BY t.position, o.position, o.name`,
      eventId
    ),
    all<SessionRow>(
      db,
      `SELECT s.*, sub.seq AS sub_seq FROM sessions s
         LEFT JOIN submissions sub ON sub.id = s.submission_id
        WHERE s.event_id = ?
        ORDER BY (s.day IS NULL), s.day, s.start_min, s.created_at`,
      eventId
    ),
    all<SpeakerLite & { session_id: string; position: number }>(
      db,
      `SELECT ss.session_id, ss.position, sp.id, sp.name, sp.slug, sp.email, sp.bio, sp.job_title, sp.company, sp.tagline, sp.headshot_file_id
         FROM session_speakers ss
         JOIN speaker_profiles sp ON sp.id = ss.speaker_profile_id
         JOIN sessions s ON s.id = ss.session_id
        WHERE s.event_id = ? ORDER BY ss.position`,
      eventId
    ),
  ]);
  const speakers = new Map<string, SpeakerLite[]>();
  for (const l of links) {
    const list = speakers.get(l.session_id) ?? [];
    list.push({
      id: l.id,
      name: l.name,
      slug: l.slug,
      email: l.email,
      bio: l.bio,
      job_title: l.job_title,
      company: l.company,
      tagline: l.tagline,
      headshot_file_id: l.headshot_file_id,
    });
    speakers.set(l.session_id, list);
  }
  return {
    rooms,
    tracks: options.filter((o) => o.taxonomy === 'Track'),
    formats: options.filter((o) => o.taxonomy === 'Format'),
    levels: options.filter((o) => o.taxonomy === 'Level'),
    sessions,
    speakers,
  };
}

/** Display id: `#147` for talks from submissions, `SP-1` / `SV-3` otherwise. */
export function displayIds(sessions: SessionRow[]): Map<string, string> {
  const out = new Map<string, string>();
  let sp = 0;
  let sv = 0;
  for (const s of sessions) {
    if (s.type === 'sponsor') out.set(s.id, `SP-${++sp}`);
    else if (s.type === 'service') out.set(s.id, `SV-${++sv}`);
    else out.set(s.id, s.sub_seq ? `#${s.sub_seq}` : '—');
  }
  return out;
}

/* ------------------------------------------------------- view projection */

export type ViewSession = {
  id: string;
  displayId: string;
  type: string;
  title: string;
  abstract: string;
  trackId: string | null;
  formatId: string | null;
  level: string | null;
  dur: number;
  roomId: string | null;
  allRooms: boolean;
  day: number | null;
  start: number | null;
  end: number | null;
  status: string;
  published: boolean;
  sponsorName: string | null;
  sponsorBadge: boolean;
  speakers: { id: string; name: string; slug: string }[];
  submissionId: string | null;
};

export function toViewSession(s: SessionRow, bundle: AgendaBundle, ids: Map<string, string>): ViewSession {
  return {
    id: s.id,
    displayId: ids.get(s.id) ?? s.id,
    type: s.type,
    title: s.title,
    abstract: s.abstract,
    trackId: s.track_option_id,
    formatId: s.format_option_id,
    level: s.level,
    dur: s.duration_min,
    roomId: s.room_id,
    allRooms: !!s.all_rooms,
    day: s.day,
    start: s.start_min,
    end: s.end_min,
    status: s.status,
    published: !!s.published,
    sponsorName: s.sponsor_name,
    sponsorBadge: !!s.sponsor_badge,
    speakers: (bundle.speakers.get(s.id) ?? []).map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
    submissionId: s.submission_id,
  };
}

/* ---------------------------------------------------------- conflicts */

export type ConflictItem = {
  id: string;
  title: string;
  day: number | null;
  start: number | null;
  end: number | null;
  roomId: string | null;
  allRooms: boolean;
  speakerIds: string[];
};

export function conflictItem(s: SessionRow, bundle: AgendaBundle): ConflictItem {
  return {
    id: s.id,
    title: s.title,
    day: s.day,
    start: s.start_min,
    end: s.end_min,
    roomId: s.room_id,
    allRooms: !!s.all_rooms,
    speakerIds: (bundle.speakers.get(s.id) ?? []).map((p) => p.id),
  };
}

/**
 * Prototype `conflicts()`: room double-booking, a speaker in two places at
 * once, and running past the end of the event day. Warns, never blocks.
 */
export function conflictMessages(
  item: ConflictItem,
  placed: ConflictItem[],
  opts: { dayEnd: number; roomName: (id: string | null) => string; speakerName: (id: string) => string }
): string[] {
  const msgs: string[] = [];
  if (item.day === null || item.start === null || item.end === null) return msgs;
  if (item.end > opts.dayEnd) {
    msgs.push(`Runs past the event day (ends ${fmtTime(item.end)}, day ends ${fmtTime(opts.dayEnd)}).`);
  }
  if (item.allRooms) return msgs;
  for (const o of placed) {
    if (o.id === item.id || o.allRooms) continue;
    if (o.day !== item.day || o.start === null || o.end === null) continue;
    if (!(item.start < o.end && o.start < item.end)) continue;
    if (o.roomId && o.roomId === item.roomId) {
      msgs.push(`Room double-booked: “${o.title}” is already in ${opts.roomName(o.roomId)} at ${fmtTime(o.start)}.`);
    }
    const both = item.speakerIds.filter((s) => o.speakerIds.includes(s));
    if (both.length) {
      const who = both.map(opts.speakerName).join(' and ');
      msgs.push(`${who} would be in two places at once (also in “${o.title}”, ${opts.roomName(o.roomId)}).`);
    }
  }
  return msgs;
}

/** Ids of every placed session that currently has at least one conflict. */
export function conflictIds(bundle: AgendaBundle, dayEnd: number): Set<string> {
  const items = bundle.sessions.filter((s) => s.day !== null && s.start_min !== null).map((s) => conflictItem(s, bundle));
  const roomName = roomNamer(bundle);
  const speakerName = speakerNamer(bundle);
  const out = new Set<string>();
  for (const it of items) {
    if (it.allRooms) continue;
    if (conflictMessages(it, items, { dayEnd, roomName, speakerName }).length) out.add(it.id);
  }
  return out;
}

export function roomNamer(bundle: AgendaBundle): (id: string | null) => string {
  const map = new Map(bundle.rooms.map((r) => [r.id, r.name]));
  return (id) => (id ? map.get(id) ?? 'Unassigned' : 'Unassigned');
}

export function speakerNamer(bundle: AgendaBundle): (id: string) => string {
  const map = new Map<string, string>();
  for (const list of bundle.speakers.values()) for (const p of list) map.set(p.id, p.name);
  return (id) => map.get(id) ?? 'A speaker';
}

/* --------------------------------------------------------- publishing */

export function publishedRev(event: Event & { published_rev?: number }): number {
  return Number(event.published_rev ?? 0);
}

/** True when a session changed after the last publish (the builder's dot). */
export async function hasUnpublishedChanges(db: D1Database, event: Event & { published_at?: string | null }): Promise<boolean> {
  if (!event.published) return true;
  const since = event.published_at;
  if (!since) return true;
  const row = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM sessions WHERE event_id = ? AND updated_at > ?`,
    event.id,
    since
  );
  return (row?.n ?? 0) > 0;
}

/* ------------------------------------------------- schedule notifications */

export type ScheduleSlot = { day: number; start: number; end: number; roomId: string | null; allRooms: boolean };

export function sameSlot(a: ScheduleSlot | null, b: ScheduleSlot | null): boolean {
  if (!a || !b) return a === b;
  return a.day === b.day && a.start === b.start && a.end === b.end && a.roomId === b.roomId;
}

export function slotLabel(event: Event, s: { day: number | null; start_min: number | null; end_min: number | null }, room: string): string {
  if (s.day === null || s.start_min === null) return 'To be announced';
  const days = eventDays(event);
  const d = days[s.day] ?? days[0];
  const span = s.end_min === null ? fmtTime(s.start_min) : fmtSpan(s.start_min, s.end_min);
  return `${d ? d.label : `Day ${s.day + 1}`} · ${span}${room ? ` · ${room}` : ''}`;
}

/**
 * Queue a `schedule_notice` email to each speaker of a confirmed session whose
 * slot or room moved. Activity-logged; the fresh ICS is pulled from the portal.
 */
export async function notifyScheduleChange(
  env: Bindings,
  event: Event,
  sessionId: string,
  actor: string
): Promise<number> {
  const session = await one<SessionRow>(env.DB, `SELECT * FROM sessions WHERE id = ?`, sessionId);
  if (!session || session.status !== 'confirmed') return 0;
  const speakers = await all<SpeakerLite>(
    env.DB,
    `SELECT sp.* FROM session_speakers ss JOIN speaker_profiles sp ON sp.id = ss.speaker_profile_id
      WHERE ss.session_id = ? ORDER BY ss.position`,
    sessionId
  );
  if (!speakers.length) return 0;
  const room = session.all_rooms
    ? 'All rooms'
    : session.room_id
      ? (await one<{ name: string }>(env.DB, `SELECT name FROM rooms WHERE id = ?`, session.room_id))?.name ?? ''
      : '';
  const tpl = await one<{ subject: string; body: string }>(
    env.DB,
    `SELECT subject, body FROM email_templates WHERE event_id = ? AND key = ?`,
    event.id,
    'schedule_notice'
  );
  const subject = tpl?.subject ?? 'Your slot at {{event_name}} — {{session_title}}';
  const body =
    tpl?.body ??
    'Hi {{speaker_name}},\n\n“{{session_title}}” is now scheduled for {{slot_time}}.\n\nYour speaker portal has the details and a calendar file:\n{{portal_link}}\n\n— The {{event_name}} program team';
  const portalLink = `${env.APP_ORIGIN}/${event.slug}/portal`;
  const slot = slotLabel(event, session, room);
  const timeOnly =
    session.day === null || session.start_min === null
      ? 'a slot to be announced'
      : `${eventDays(event)[session.day]?.label ?? `Day ${session.day + 1}`}, ${
          session.end_min === null ? fmtTime(session.start_min) : fmtSpan(session.start_min, session.end_min)
        }`;
  let sent = 0;
  for (const sp of speakers) {
    if (!sp.email) continue;
    // `slot_time` is the shared contract; the seeded template also uses
    // `session_time` / `session_room`, so both are supplied.
    const vars = {
      speaker_name: sp.name,
      session_title: session.title,
      event_name: event.name,
      slot_time: slot,
      session_time: timeOnly,
      session_room: room || 'a room to be confirmed',
      portal_link: portalLink,
    };
    await sendEmail(env, {
      eventId: event.id,
      to: sp.email,
      toName: sp.name,
      templateKey: 'schedule_notice',
      subject: renderTemplate(subject, vars),
      text: renderTemplate(body, vars),
      subjectType: 'session',
      subjectId: session.id,
    });
    sent++;
  }
  if (sent) {
    await logActivity(env.DB, {
      eventId: event.id,
      subjectType: 'session',
      subjectId: session.id,
      actor,
      action: 'Schedule notice sent',
      detail: `${sent} speaker${sent === 1 ? '' : 's'} · ${slot}`,
    });
  }
  return sent;
}

/** Bump the ICS SEQUENCE so calendar clients accept the updated invite. */
export async function bumpIcsSequence(db: D1Database, sessionId: string): Promise<void> {
  await run(db, `UPDATE sessions SET ics_sequence = ics_sequence + 1, updated_at = ? WHERE id = ?`, now(), sessionId);
}

/* --------------------------------------------------------------- csv */

export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
