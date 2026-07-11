import type { LedgerEntry } from '../shared/types.js';

export interface DirectProgressStall {
  kind: 'reject_loop' | 'no_run_loop';
  stalled: boolean;
  count: number;
  threshold: number;
  reason: string;
}

export function directRejectStall(ledger: LedgerEntry[], stepId: string, threshold: number): DirectProgressStall {
  let count = 0;
  let latestReason = '';
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index];
    if (!isNonAcceptanceReject(entry, stepId)) break;
    if (!latestReason) latestReason = normalizeReceiptReason(String(entry.guards.reason ?? entry.reflection));
    count += 1;
  }
  return {
    kind: 'reject_loop',
    stalled: count >= threshold,
    count,
    threshold,
    reason: count > 0
      ? `${count} consecutive non-acceptance receipt(s) for the same step; latest: ${latestReason}`
      : 'latest receipt was not a direct non-acceptance reject'
  };
}

export function directNoRunStall(ledger: LedgerEntry[], threshold: number): DirectProgressStall {
  const steps: string[] = [];
  let latestReason = '';
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index];
    if (!isExplicitNoRunReceipt(entry)) break;
    if (!latestReason) latestReason = normalizeReceiptReason(entry.reflection);
    steps.unshift(entry.step_id);
  }
  return {
    kind: 'no_run_loop',
    stalled: steps.length >= threshold,
    count: steps.length,
    threshold,
    reason: steps.length > 0
      ? `${steps.length} consecutive explicit NoRun receipt(s) across steps ${steps.join(', ')}; latest: ${latestReason}`
      : 'latest receipt was not an explicit NoRun'
  };
}

export function isExplicitNoRunReceipt(entry: LedgerEntry): boolean {
  if (entry.metric !== null || !entry.guards.direct || entry.status === 'crash' || entry.status === 'preempted') return false;
  return /\bno[- ]?run\b|\bno (?:benchmark|candidate|validation)(?: run)? was (?:launched|run)\b|\b(?:benchmark|candidate|validation)(?: run)? (?:did not run|was not launched)\b/i.test(entry.reflection);
}

function isNonAcceptanceReject(entry: LedgerEntry, stepId: string): boolean {
  return (
    entry.step_id === stepId &&
    entry.status === 'reject' &&
    entry.confidence === 'direct-executor-receipt' &&
    entry.metric === null &&
    entry.guards.direct === true
  );
}

function normalizeReceiptReason(reason: string): string {
  return reason
    .replace(/\biter(?:ation)?[-\s:]*\d+\b/gi, 'iter#')
    .replace(/\bS\d+[a-z]?\b/g, 'S#')
    .replace(/\b\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z\b/g, 'timestamp#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
