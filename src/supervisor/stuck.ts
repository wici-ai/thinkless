import type { LedgerEntry, RetryConfig } from '../shared/types.js';

const failureStatuses = new Set<LedgerEntry['status']>(['reject', 'revert', 'checks_failed', 'crash']);

export interface StuckDecision {
  stuck: boolean;
  reason: string;
  attempts: number;
  consecutiveFailures: number;
}

export function shouldReplanStuckStep(entries: LedgerEntry[], stepId: string, retry: RetryConfig): StuckDecision {
  const attempts = entries.filter((entry) => entry.step_id === stepId && failureStatuses.has(entry.status)).length;
  const consecutiveFailures = consecutiveFailuresForStep(entries, stepId);
  const maxAttempts = Math.max(1, retry.max_attempts_per_step);
  const stallAfter = Math.max(1, retry.stall_replan_after);

  if (attempts >= maxAttempts) {
    return {
      stuck: true,
      reason: `${stepId} exhausted retry budget: ${attempts}/${maxAttempts} failed attempt(s)`,
      attempts,
      consecutiveFailures
    };
  }

  if (consecutiveFailures >= stallAfter) {
    return {
      stuck: true,
      reason: `${stepId} appears stuck: ${consecutiveFailures} consecutive failed attempt(s)`,
      attempts,
      consecutiveFailures
    };
  }

  return {
    stuck: false,
    reason: `${stepId} retry budget remains: ${attempts}/${maxAttempts} failed attempt(s)`,
    attempts,
    consecutiveFailures
  };
}

export function consecutiveGlobalFailures(entries: LedgerEntry[]): number {
  let count = 0;
  for (const entry of [...entries].reverse()) {
    if (!failureStatuses.has(entry.status)) break;
    count += 1;
  }
  return count;
}

function consecutiveFailuresForStep(entries: LedgerEntry[], stepId: string): number {
  let count = 0;
  for (const entry of [...entries].reverse()) {
    if (entry.step_id !== stepId) break;
    if (!failureStatuses.has(entry.status)) break;
    count += 1;
  }
  return count;
}
