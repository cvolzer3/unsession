/**
 * Minimal store-only ZIP writer (spec §4.8.8 "bulk content retrieval").
 *
 * No compression: headshots are JPEG/PNG and decks are PDF/Keynote — already
 * compressed formats where deflate buys nothing but CPU. That lets the whole
 * archive be ~120 lines of local file headers + a central directory, streamed
 * straight out of R2 one object at a time (constant memory per entry, no
 * dependency, no Workers-incompatible zlib).
 */
import { all } from './db';
import { extOf } from './files';
import { slugify } from './slugify';
import type { Bindings } from '../types';

export type ZipEntry = {
  /** path inside the archive, e.g. `day-1/main-stage/postgres-at-the-edge.pdf` */
  name: string;
  r2_key: string;
  modified?: string | null;
};

/* ----------------------------------------------------------------- crc32 */

let TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (TABLE) return TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  TABLE = t;
  return t;
}

export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* --------------------------------------------------------------- writing */

function dosStamp(iso?: string | null): { time: number; date: number } {
  const d = iso ? new Date(iso) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const year = Math.max(1980, t.getUTCFullYear());
  return {
    time: (t.getUTCHours() << 11) | (t.getUTCMinutes() << 5) | Math.floor(t.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((t.getUTCMonth() + 1) << 5) | t.getUTCDate(),
  };
}

/** UTF-8 name flag (bit 11) — filenames may carry accents from speaker names. */
const FLAG_UTF8 = 0x0800;

function localHeader(name: Uint8Array, crc: number, size: number, stamp: { time: number; date: number }): Uint8Array {
  const buf = new Uint8Array(30 + name.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true); // version needed
  v.setUint16(6, FLAG_UTF8, true);
  v.setUint16(8, 0, true); // method: store
  v.setUint16(10, stamp.time, true);
  v.setUint16(12, stamp.date, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true); // compressed
  v.setUint32(22, size, true); // uncompressed
  v.setUint16(26, name.length, true);
  v.setUint16(28, 0, true); // extra
  buf.set(name, 30);
  return buf;
}

function centralHeader(
  name: Uint8Array,
  crc: number,
  size: number,
  stamp: { time: number; date: number },
  offset: number
): Uint8Array {
  const buf = new Uint8Array(46 + name.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true); // version made by
  v.setUint16(6, 20, true); // version needed
  v.setUint16(8, FLAG_UTF8, true);
  v.setUint16(10, 0, true); // method: store
  v.setUint16(12, stamp.time, true);
  v.setUint16(14, stamp.date, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, name.length, true);
  v.setUint16(30, 0, true); // extra
  v.setUint16(32, 0, true); // comment
  v.setUint16(34, 0, true); // disk
  v.setUint16(36, 0, true); // internal attrs
  v.setUint32(38, 0, true); // external attrs
  v.setUint32(42, offset, true);
  buf.set(name, 46);
  return buf;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const buf = new Uint8Array(22);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(4, 0, true);
  v.setUint16(6, 0, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  v.setUint16(20, 0, true);
  return buf;
}

/** Streams entries out of R2 as one store-only archive. Missing objects are skipped. */
export function zipStream(bucket: R2Bucket, entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let index = 0;
  let offset = 0;
  let count = 0;
  const central: Uint8Array[] = [];

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < entries.length) {
        const entry = entries[index++];
        const obj = await bucket.get(entry.r2_key);
        if (!obj) return; // skipped — pull runs again for the next entry
        const data = new Uint8Array(await obj.arrayBuffer());
        const name = enc.encode(entry.name);
        const stamp = dosStamp(entry.modified);
        const crc = crc32(data);
        const header = localHeader(name, crc, data.length, stamp);
        controller.enqueue(header);
        controller.enqueue(data);
        central.push(centralHeader(name, crc, data.length, stamp, offset));
        offset += header.length + data.length;
        count++;
        return;
      }
      const start = offset;
      let size = 0;
      for (const rec of central) {
        controller.enqueue(rec);
        size += rec.length;
      }
      controller.enqueue(endOfCentralDirectory(count, size, start));
      controller.close();
    },
  });
}

export function zipResponse(bucket: R2Bucket, entries: ZipEntry[], filename: string): Response {
  return new Response(zipStream(bucket, entries), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

/* ----------------------------------------------------------- collections */

function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 500; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  used.add(name);
  return name;
}

/** `<speaker-slug>.<ext>` for every speaker profile with a headshot. */
export async function headshotEntries(env: Bindings, eventId: string): Promise<ZipEntry[]> {
  const rows = await all<{ slug: string; r2_key: string; filename: string; created_at: string }>(
    env.DB,
    `SELECT sp.slug AS slug, f.r2_key AS r2_key, f.filename AS filename, f.created_at AS created_at
       FROM speaker_profiles sp
       JOIN files f ON f.id = sp.headshot_file_id
      WHERE sp.event_id = ?
      ORDER BY sp.name`,
    eventId
  );
  const used = new Set<string>();
  return rows.map((r) => ({
    name: uniqueName(used, `${r.slug}.${extOf(r.filename) || 'jpg'}`),
    r2_key: r.r2_key,
    modified: r.created_at,
  }));
}

/**
 * Decks from session file-tasks, newest version per task, filed under
 * `day-N/<room>/` when the session is scheduled and `unscheduled/` when not.
 */
export async function slideEntries(env: Bindings, eventId: string): Promise<ZipEntry[]> {
  const rows = await all<{
    task_id: string;
    r2_key: string;
    filename: string;
    created_at: string;
    version: number;
    title: string | null;
    day: number | null;
    room: string | null;
  }>(
    env.DB,
    `SELECT t.id AS task_id, f.r2_key AS r2_key, f.filename AS filename, f.created_at AS created_at,
            f.version AS version, s.title AS title, s.day AS day, r.name AS room
       FROM tasks t
       JOIN files f ON f.subject_type = 'task' AND f.subject_id = t.id
       LEFT JOIN sessions s ON s.id = t.session_id
       LEFT JOIN rooms r ON r.id = s.room_id
      WHERE t.event_id = ? AND t.session_id IS NOT NULL AND t.status != 'cancelled'
      ORDER BY t.id, f.version DESC`,
    eventId
  );
  const used = new Set<string>();
  const seen = new Set<string>();
  const out: ZipEntry[] = [];
  for (const r of rows) {
    if (seen.has(r.task_id)) continue; // ORDER BY version DESC → first row is newest
    seen.add(r.task_id);
    const stem = slugify(r.title || 'session', 'session');
    const ext = extOf(r.filename) || 'pdf';
    const dir =
      r.day === null || r.day === undefined
        ? 'unscheduled'
        : `day-${r.day + 1}/${slugify(r.room || 'unassigned-room', 'room')}`;
    out.push({
      name: uniqueName(used, `${dir}/${stem}.${ext}`),
      r2_key: r.r2_key,
      modified: r.created_at,
    });
  }
  return out;
}

export async function zipHeadshots(env: Bindings, eventId: string): Promise<Response | null> {
  if (!env.FILES) return null;
  return zipResponse(env.FILES, await headshotEntries(env, eventId), 'headshots.zip');
}

export async function zipSlides(env: Bindings, eventId: string): Promise<Response | null> {
  if (!env.FILES) return null;
  return zipResponse(env.FILES, await slideEntries(env, eventId), 'slides.zip');
}
