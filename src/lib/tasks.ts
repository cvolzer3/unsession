/**
 * Task engine — OWNED BY TRACK B5 (SPECS/B5-speakers.md). This file starts as
 * a functional stub so `confirm.ts` and the decision engine can call task
 * generation before B5 lands. B5: replace the bodies, keep the signatures.
 */
import type { Bindings } from '../types';

export type TaskTrigger = 'acceptance' | 'confirmation';

/**
 * Stamp task instances for a submission's speakers/session from the event's
 * active task templates whose trigger + clauses match. Idempotent per
 * (template, target).
 */
export async function generateTasksOnTrigger(
  _env: Bindings,
  opts: { submissionId: string; trigger: TaskTrigger }
): Promise<{ created: number }> {
  console.log(`[tasks] generateTasksOnTrigger stub — ${opts.trigger} for ${opts.submissionId} (B5 implements)`);
  return { created: 0 };
}

/** Cancel a submission's open tasks on withdrawal (B5 implements). */
export async function cancelOpenTasks(_env: Bindings, submissionId: string): Promise<void> {
  console.log(`[tasks] cancelOpenTasks stub — ${submissionId} (B5 implements)`);
}
