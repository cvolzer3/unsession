/** Tiny typed query helpers over env.DB. */

export async function one<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  return (await stmt.first<T>()) ?? null;
}

export async function all<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  const res = await stmt.all<T>();
  return res.results ?? [];
}

export async function run(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<D1Result> {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  return await stmt.run();
}

/** Batch a list of [sql, params] tuples into one D1 round-trip. */
export async function batch(
  db: D1Database,
  statements: Array<[string, unknown[]]>
): Promise<void> {
  if (!statements.length) return;
  // Each batch is one subrequest, so chunk generously — seeding fires hundreds
  // of statements and the free plan allows 50 subrequests per invocation.
  const CHUNK = 100;
  for (let i = 0; i < statements.length; i += CHUNK) {
    const slice = statements.slice(i, i + CHUNK);
    await db.batch(slice.map(([sql, params]) => db.prepare(sql).bind(...params)));
  }
}

/** ISO-8601 UTC timestamp, second precision — the storage format for every `*_at` column. */
export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function jsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function jsonCol(value: unknown): string {
  return JSON.stringify(value ?? null);
}
