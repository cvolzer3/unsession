/**
 * iCalendar (RFC 5545) generation for session slots.
 *
 * Wall-clock times are stored as `day` + minutes from the 08:00 grid origin, so
 * DTSTART/DTEND are emitted as floating local times qualified with the event's
 * TZID. A one-component VTIMEZONE carrying the real UTC offset for the event
 * window is included so clients that refuse bare TZIDs still resolve the time.
 *
 * `SEQUENCE` comes from `sessions.ics_sequence`, bumped on every schedule change
 * (see `bumpIcsSequence` in `lib/agenda.ts`) so updates supersede the original.
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
};

export type IcsSpeaker = { name: string; email?: string | null };

export type IcsOptions = {
  /** Room name — becomes the first half of LOCATION. */
  roomName?: string | null;
  /** ORGANIZER mailto — pass `env.EMAIL_FROM`. */
  from?: string;
  /** Absolute link back to the session (portal / public agenda). */
  url?: string | null;
};

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

/** `YYYYMMDDTHHMMSSZ` for the current instant. */
export function icsStamp(d = new Date()): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Local wall time for a grid minute on a given date: `20271014T140000`. */
export function icsLocal(dateIso: string, minutesFromOrigin: number): string {
  const total = GRID_ORIGIN_MIN + Math.round(minutesFromOrigin);
  const dayShift = Math.floor(total / 1440);
  const inDay = ((total % 1440) + 1440) % 1440;
  const date = dayShift ? addDays(dateIso, dayShift) : dateIso.slice(0, 10);
  return `${date.replace(/-/g, '')}T${pad(Math.floor(inDay / 60))}${pad(inDay % 60)}00`;
}

/** UTC offset of `tz` on `dateIso`, formatted `+0200`. */
export function tzOffset(tz: string, dateIso: string): string {
  const at = new Date(`${dateIso.slice(0, 10)}T12:00:00Z`);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (m) return `${m[1]}${pad(Number(m[2]))}${m[3] ?? '00'}`;
    if (/^(GMT|UTC)$/.test(name)) return '+0000';
  } catch {
    /* unknown tz — fall through */
  }
  return '+0000';
}

export function tzAbbrev(tz: string, dateIso: string): string {
  const at = new Date(`${dateIso.slice(0, 10)}T12:00:00Z`);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz;
  } catch {
    return tz;
  }
}

function vtimezone(tz: string, dateIso: string): string[] {
  const off = tzOffset(tz, dateIso);
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tz}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${off}`,
    `TZOFFSETTO:${off}`,
    `TZNAME:${tzAbbrev(tz, dateIso)}`,
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

function buildEvent(
  event: Event,
  session: IcsSession,
  speakers: IcsSpeaker[],
  opts: IcsOptions,
  method: 'REQUEST' | 'CANCEL'
): { lines: string[]; dateIso: string } | null {
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
    `DTSTAMP:${icsStamp()}`,
    `DTSTART;TZID=${event.timezone}:${icsLocal(dateIso, session.start_min)}`,
    `DTEND;TZID=${event.timezone}:${icsLocal(dateIso, end)}`,
    `SUMMARY:${escText(session.title)}`,
  ];
  if (location) lines.push(`LOCATION:${escText(location)}`);
  if (descParts.length) lines.push(`DESCRIPTION:${escText(descParts.join('\n\n'))}`);
  if (opts.url) lines.push(`URL:${escText(opts.url)}`);
  lines.push(`ORGANIZER;CN=${escText(event.name)}:mailto:${opts.from || 'no-reply@unsession.dev'}`);
  for (const s of speakers) {
    if (!s.email) continue;
    lines.push(`ATTENDEE;CN=${escText(s.name)};ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${s.email}`);
  }
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push('TRANSP:OPAQUE');
  lines.push('END:VEVENT');
  return { lines, dateIso };
}

function calendar(event: Event, method: 'REQUEST' | 'CANCEL', body: { lines: string[]; dateIso: string }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    `X-WR-CALNAME:${escText(event.name)}`,
    ...vtimezone(event.timezone, body.dateIso),
    ...body.lines,
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

/** VCALENDAR/METHOD:CANCEL — same UID, SEQUENCE bumped by the caller. */
export function cancelIcs(event: Event, session: IcsSession, speakers: IcsSpeaker[] = [], opts: IcsOptions = {}): string {
  const body = buildEvent(event, session, speakers, opts, 'CANCEL');
  if (!body) return '';
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
