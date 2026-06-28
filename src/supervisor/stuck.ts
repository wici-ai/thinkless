import type { LedgerEntry, RetryConfig } from '../shared/types.js';

const failureStatuses = new Set<LedgerEntry['status']>(['reject', 'revert', 'checks_failed', 'crash']);

export interface StuckDecision {
  stuck: boolean;
  reason: string;
  attempts: number;
  consecutiveFailures: number;
}

export function shouldReplanStuckStep(entries: LedgerEntry[], stepId: string, retry: RetryConfig): StuckDecision {
  const failedAttempts = entries.filter((entry) => entry.step_id === stepId && failureStatuses.has(entry.status));
  const attempts = failedAttempts.length;
  const consecutiveFailures = consecutiveFailuresForStep(entries, stepId);
  const maxAttempts = Math.max(1, retry.max_attempts_per_step);
  const stallAfter = Math.max(1, retry.stall_replan_after);

  if (attempts >= maxAttempts) {
    return {
      stuck: true,
      reason: bottleneckReviewReason(stepId, failedAttempts, `${attempts}/${maxAttempts} failed safe attempt(s) without an accepted improvement`),
      attempts,
      consecutiveFailures
    };
  }

  if (consecutiveFailures >= stallAfter) {
    return {
      stuck: true,
      reason: bottleneckReviewReason(stepId, failedAttempts, `${consecutiveFailures} consecutive failed safe attempt(s) without an accepted improvement`),
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

function bottleneckReviewReason(stepId: string, failedAttempts: LedgerEntry[], suffix: string): string {
  const latest = failedAttempts.at(-1);
  if (failedAttempts.some((entry) => entry.confidence === 'heldout-regression')) {
    return `${stepId} needs safe-validation bottleneck review: heldout-safe validation rejected the current approach after ${suffix}`;
  }
  if (latest?.confidence && latest.confidence !== 'none') {
    return `${stepId} needs bottleneck review: latest evidence=${latest.confidence}; ${suffix}`;
  }
  return `${stepId} needs bottleneck review: ${suffix}`;
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
