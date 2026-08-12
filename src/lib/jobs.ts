/**
 * Scheduled work shell. Real logic (CFP-closing notices, task nags, reviewer
 * reminders) lands in Phase C — for now the cron fires and logs so the trigger
 * and handler wiring is proven end to end.
 */
import type { Bindings } from '../types';

export async function runScheduledJobs(env: Bindings, event: ScheduledController): Promise<void> {
  const at = new Date(event.scheduledTime).toISOString();
  // Cheap liveness probe: proves the DB binding works from the cron context.
  let events = 0;
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>();
    events = row?.n ?? 0;
  } catch (err) {
    console.error('[cron] db probe failed', err);
  }
  console.log(`[cron] runScheduledJobs noop cron=${event.cron} at=${at} events=${events}`);
}
