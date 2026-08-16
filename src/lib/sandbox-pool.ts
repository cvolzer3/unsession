/**
 * Pre-seeded sandbox pool. `POST /sandbox` used to run `seedSandbox` inline —
 * hundreds of D1 statements plus PDF generation and R2 uploads (~2s) — while
 * the visitor stared at a pending click. The pool keeps POOL_TARGET sandboxes
 * seeded ahead of time: a click claims one with a single DELETE and redirects,
 * and the pool refills in the background (request `waitUntil`, with the
 * 15-minute cron as backstop for failed refills and fresh deploys).
 */
import { now, one, run } from './db';
import { seedSandbox } from './seed';
import type { Bindings } from '../types';

export const POOL_TARGET = 2;

/**
 * Claim (and remove) the oldest pooled sandbox; null when the pool is empty —
 * or on any error (e.g. the migration hasn't run yet), so the caller's
 * seed-inline fallback keeps "Try the sandbox" working no matter what.
 */
export async function claimPooledSandbox(env: Bindings): Promise<string | null> {
  try {
    // Two attempts cover a concurrent visitor racing us to the same row — the
    // DELETE is atomic, so exactly one caller wins it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await one<{ org_id: string }>(env.DB, `SELECT org_id FROM sandbox_pool ORDER BY created_at LIMIT 1`);
      if (!row) return null;
      const res = await run(env.DB, `DELETE FROM sandbox_pool WHERE org_id = ?`, row.org_id);
      if (res.meta.changes === 1) return row.org_id;
    }
    return null;
  } catch (err) {
    console.error('[sandbox-pool] claim failed', err);
    return null;
  }
}

/** Seed sandboxes until the pool holds POOL_TARGET again. */
export async function topUpSandboxPool(env: Bindings): Promise<void> {
  const n = (await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM sandbox_pool`))?.n ?? 0;
  for (let i = n; i < POOL_TARGET; i++) {
    const sb = await seedSandbox(env);
    await run(env.DB, `INSERT INTO sandbox_pool (org_id, created_at) VALUES (?,?)`, sb.orgId, now());
  }
}
