/** App-generated ids: `<prefix>_<12 lowercase alnum>`. */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Short random suffix for slug uniqueness (sandbox events etc). */
export function shortCode(n = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Per-event monotonic counter. Used for submission display ids (`SUB-<seq>`). */
export async function nextSeq(db: D1Database, eventId: string, key: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO counters (event_id, key, value) VALUES (?, ?, 1)
       ON CONFLICT (event_id, key) DO UPDATE SET value = value + 1
       RETURNING value`
    )
    .bind(eventId, key)
    .first<{ value: number }>();
  return row?.value ?? 1;
}

/** Reserve `n` sequence numbers at once; returns the first value of the block. */
export async function bumpSeq(
  db: D1Database,
  eventId: string,
  key: string,
  n: number
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO counters (event_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT (event_id, key) DO UPDATE SET value = value + ?
       RETURNING value`
    )
    .bind(eventId, key, n, n)
    .first<{ value: number }>();
  const end = row?.value ?? n;
  return end - n + 1;
}
