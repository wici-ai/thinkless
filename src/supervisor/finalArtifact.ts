import { join } from 'node:path';
import { atomicWriteFile } from '../shared/atomic.js';
import type { RunPaths } from '../shared/paths.js';
import type { BaselineFile, GoalFile, LedgerEntry } from '../shared/types.js';
import { commitAllWithKey } from './gitgate.js';

export interface LimitArtifactResult {
  path: string;
  commit: string;
  reused: boolean;
  key: string;
}

export async function commitLimitArtifact(
  paths: RunPaths,
  goal: GoalFile,
  baseline: BaselineFile,
  ledger: LedgerEntry[],
  reason: string
): Promise<LimitArtifactResult> {
  const path = 'wici-limit-artifact.md';
  await atomicWriteFile(join(paths.target, path), formatLimitArtifact(goal, baseline, ledger, reason));
  const key = `run:${goal.run_id}:limit:iter:${ledger.length}:reason:${stableReason(reason)}`;
  const committed = await commitAllWithKey(paths, `chore: record WiCi limit artifact | ${reason}`, key);
  return {
    path,
    commit: committed.commit,
    reused: committed.reused,
    key
  };
}

function formatLimitArtifact(goal: GoalFile, baseline: BaselineFile, ledger: LedgerEntry[], reason: string): string {
  const latest = ledger.at(-1) ?? null;
  const keeps = ledger.filter((entry) => entry.status === 'keep');
  const rejects = ledger.filter((entry) => entry.status !== 'keep');
  return [
    '# WiCi Limit Artifact',
    '',
    `Reason: ${reason}`,
    `Run ID: ${goal.run_id}`,
    `Goal version: ${goal.version}`,
    `Best commit: ${baseline.best_commit}`,
    `Best p99: ${baseline.best_metric.p99}${baseline.best_metric.unit}`,
    `Ledger rows: ${ledger.length}`,
    `Accepted rows: ${keeps.length}`,
    `Rejected rows: ${rejects.length}`,
    latest ? `Latest ledger: ${latest.id} ${latest.status} ${latest.confidence}` : 'Latest ledger: none',
    '',
    '## Active Requirements',
    ...goal.requirements.filter((req) => req.status === 'active').map((req) => `- ${req.id}: ${req.text}`),
    '',
    '## Acceptance Checks',
    ...goal.acceptance_criteria.map((criterion) => `- ${criterion.id}: ${criterion.text} (${criterion.check})`),
    '',
    '## Recent Ledger',
    ...ledger.slice(-8).map(formatLedgerLine),
    ''
  ].join('\n');
}

function formatLedgerLine(entry: LedgerEntry): string {
  const metric = entry.metric ? `p99=${entry.metric.p99}${entry.metric.unit}` : 'p99=n/a';
  const delta = typeof entry.delta_pct === 'number' ? ` delta=${(entry.delta_pct * 100).toFixed(2)}%` : '';
  return `- ${entry.id}: ${entry.status} ${metric}${delta} confidence=${entry.confidence}`;
}

function stableReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
