/**
 * iCalendar (RFC 5545) generation for session slots.
 *
 * Wall-clock times are stored as `day` + minutes from the 08:00 grid origin.
 * DTSTART/DTEND are emitted in UTC, converted from the event's IANA timezone
 * with the runtime's own tz database (`wallToEpoch`) — correct across DST
 * transitions mid-event, with no VTIMEZONE component to get wrong. Clients
 * display in the viewer's local zone; `X-WR-TIMEZONE` hints the event zone.
 *
 * Three flavours:
 *   METHOD:REQUEST — the speaker's own invite (ORGANIZER + ATTENDEE), so a
 *                    re-download with a bumped SEQUENCE supersedes the import.
 *   METHOD:CANCEL  — same UID; clears a previously imported slot.
 *   METHOD:PUBLISH — anonymous fan-out (public feed, per-session download);
 *                    carries no ORGANIZER/ATTENDEE so clients import it as a
 *                    plain event, never an invitation.
 *
 * `SEQUENCE` comes from `sessions.ics_sequence`, bumped on every schedule
 * change (see `bumpIcsSequence` in `lib/agenda.ts`). DTSTAMP prefers the
 * session's `updated_at` so subscribed feeds stay byte-stable between edits.
 */
import { addDays, GRID_ORIGIN_MIN } from './agenda';
import type { Event } from '../types';

export type IcsSession = {
  id: string;
  title: string;
  abstract?: string | null;
  day: number | null;
  start_min: number | null;
  end_min: number | null;
  duration_min?: number;
  ics_sequence?: number;
  status?: string;
  type?: string;
  /** ISO timestamp of the last edit — becomes DTSTAMP so feeds stay stable. */
  updated_at?: string | null;
};

export type IcsSpeaker = { name: string; email?: string | null };

export type IcsOptions = {
  /** Room name — becomes the first half of LOCATION. */
  roomName?: string | null;
  /** ORGANIZER mailto — pass `env.EMAIL_FROM`. Ignored by METHOD:PUBLISH. */
  from?: string;
  /** Absolute link back to the session (portal / public agenda). */
  url?: string | null;
};

type IcsMethod = 'REQUEST' | 'CANCEL' | 'PUBLISH';

const PRODID = '-//Unsession//Agenda//EN';
export const UID_DOMAIN = 'unsession.dev';

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** RFC 5545 text escaping: backslash, semicolon, comma, newline. */
export function escText(value: string): string {
  return (value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * RFC 5545 param-value (e.g. CN=): backslash escapes are NOT valid here —
 * values containing `,;:` must be quoted instead, and DQUOTE cannot appear.
 */
function escParam(value: string): string {
  const clean = (value || '').replace(/["\r\n]/g, ' ').trim();
  return /[,;:]/.test(clean) ? `"${clean}"` : clean;
}

/** Fold content lines to 75 octets, continuation lines start with one space. */
export function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    if (curBytes + size > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74; // continuation lines lose one octet to the leading space
    }
    cur += ch;
    curBytes += size;
  }
  if (cur) out.push(cur);
  return out.map((s, i) => (i === 0 ? s : ' ' + s)).join('\r\n');
}

/** `YYYYMMDDTHHMMSSZ` for an instant. */
export function icsStamp(d = new Date()): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Minutes east of UTC for `tz` at `epochMs` (Intl-derived, DST-aware). */
function offsetAt(tz: string, epochMs: number): number {
  const p: Record<string, string> = {};
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(epochMs);
  for (const part of parts) p[part.type] = part.value;
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - epochMs) / 60000;
}

/**
 * Epoch ms of a wall-clock moment in `tz`: `dateIso` at `minutesFromOrigin`
 * past the 08:00 grid origin. Two offset passes settle DST edges. An unknown
 * timezone falls back to treating the wall time as UTC rather than throwing.
 */
export function wallToEpoch(dateIso: string, minutesFromOrigin: number, tz: string): number {
  const wall = Date.parse(`${dateIso.slice(0, 10)}T00:00:00Z`) + (GRID_ORIGIN_MIN + Math.round(minutesFromOrigin)) * 60000;
  try {
    let epoch = wall - offsetAt(tz, wall) * 60000;
    epoch = wall - offsetAt(tz, epoch) * 60000;
    return epoch;
  } catch {
    return wall;
  }
}

function stamp(session: IcsSession): string {
  if (session.updated_at) {
    const d = new Date(session.updated_at);
    if (!Number.isNaN(d.getTime())) return icsStamp(d);
  }
  return icsStamp();
}

function buildEvent(event: Event, session: IcsSession, speakers: IcsSpeaker[], opts: IcsOptions, method: IcsMethod): string[] | null {
  if (session.day === null || session.start_min === null) return null;
  const dateIso = addDays(event.start_date, session.day);
  const end = session.end_min ?? session.start_min + (session.duration_min ?? 30);
  const location = [opts.roomName || '', event.venue || ''].filter(Boolean).join(' · ');
  const names = speakers.map((s) => s.name).filter(Boolean);
  const descParts: string[] = [];
  if (names.length) descParts.push(`Speakers: ${names.join(', ')}`);
  if (session.abstract) descParts.push(session.abstract);
  if (opts.url) descParts.push(opts.url);

  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${session.id}@${UID_DOMAIN}`,
    `SEQUENCE:${Math.max(0, Number(session.ics_sequence ?? 0))}`,
    `DTSTAMP:${stamp(session)}`,
    `DTSTART:${icsStamp(new Date(wallToEpoch(dateIso, session.start_min, event.timezone)))}`,
    `DTEND:${icsStamp(new Date(wallToEpoch(dateIso, end, event.timezone)))}`,
    `SUMMARY:${escText(session.title)}`,
  ];
  if (location) lines.push(`LOCATION:${escText(location)}`);
  if (descParts.length) lines.push(`DESCRIPTION:${escText(descParts.join('\n\n'))}`);
  // URL is a URI value type — TEXT escaping would corrupt it.
  if (opts.url) lines.push(`URL:${opts.url}`);
  if (method !== 'PUBLISH') {
    lines.push(`ORGANIZER;CN=${escParam(event.name)}:mailto:${opts.from || 'no-reply@unsession.dev'}`);
    for (const s of speakers) {
      if (!s.email) continue;
      lines.push(`ATTENDEE;CN=${escParam(s.name)};ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${s.email}`);
    }
  }
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push('TRANSP:OPAQUE');
  lines.push('END:VEVENT');
  return lines;
}

function calendar(event: Event, method: IcsMethod, components: string[], feedHints = false): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    `X-WR-CALNAME:${escText(event.name)}`,
    `X-WR-TIMEZONE:${event.timezone}`,
    // Subscription clients poll on these hints; the agenda republishes far
    // more often than daily near the event, so ask for a 6-hour cadence.
    ...(feedHints ? ['REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'] : []),
    ...components,
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** VCALENDAR/METHOD:REQUEST for one scheduled session. Returns '' if unscheduled. */
export function sessionIcs(event: Event, session: IcsSession, speakers: IcsSpeaker[] = [], opts: IcsOptions = {}): string {
  const body = buildEvent(event, session, speakers, opts, 'REQUEST');
  if (!body) return '';
  return calendar(event, 'REQUEST', body);
}

/**
 * VCALENDAR/METHOD:PUBLISH containing every scheduled session passed in — the
 * public agenda feed, the itinerary's "my schedule" export and the public
 * per-session download. Anonymous: no ORGANIZER, no ATTENDEE — callers must
 * still pass speakers with names only, never emails. Unscheduled sessions are
 * skipped.
 */
export function agendaIcs(
  event: Event,
  sessions: { session: IcsSession; speakers?: IcsSpeaker[]; roomName?: string | null; url?: string | null }[],
  opts: { url?: string | null } = {}
): string {
  const parts: string[] = [];
  for (const s of sessions) {
    const body = buildEvent(event, s.session, s.speakers ?? [], { roomName: s.roomName, url: s.url ?? opts.url }, 'PUBLISH');
    if (body) parts.push(...body);
  }
  return calendar(event, 'PUBLISH', parts, true);
}

/**
 * VCALENDAR/METHOD:CANCEL — same UID, SEQUENCE already bumped by the caller.
 * Works for sessions that have LOST their slot too (unscheduled after a
 * download): those emit a slotless cancellation, which clients match by UID.
 */
export function cancelIcs(event: Event, session: IcsSession, speakers: IcsSpeaker[] = [], opts: IcsOptions = {}): string {
  const body =
    buildEvent(event, session, speakers, opts, 'CANCEL') ??
    [
      'BEGIN:VEVENT',
      `UID:${session.id}@${UID_DOMAIN}`,
      `SEQUENCE:${Math.max(0, Number(session.ics_sequence ?? 0))}`,
      `DTSTAMP:${stamp(session)}`,
      `SUMMARY:${escText(session.title)}`,
      `ORGANIZER;CN=${escParam(event.name)}:mailto:${opts.from || 'no-reply@unsession.dev'}`,
      'STATUS:CANCELLED',
      'END:VEVENT',
    ];
  return calendar(event, 'CANCEL', body);
}

/** `Prompt-Injection-Is-the-New-SQL-Injection.ics` */
export function icsFilename(title: string): string {
  const base = (title || 'session')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'session'}.ics`;
}
