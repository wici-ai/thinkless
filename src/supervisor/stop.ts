import { readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { promptPath, type RunPaths } from '../shared/paths.js';
import type { GoalFile, LedgerEntry, WiCiConfig } from '../shared/types.js';

export interface StopDecision {
  stop: boolean;
  candidate: boolean;
  reason: string;
}

export async function shouldStop(paths: RunPaths, goal: GoalFile, ledger: LedgerEntry[], config: WiCiConfig): Promise<StopDecision> {
  const targetMet = isTargetMet(goal, ledger);
  const noRecentKeep = ledger.slice(-goal.stop.N).every((entry) => entry.status !== 'keep');
  const ewma = marginalValueEwma(ledger, goal.stop.K);
  const candidate = (targetMet || noRecentKeep) && ewma < goal.stop.tau;
  if (!candidate) {
    return { stop: false, candidate: false, reason: `continue: targetMet=${targetMet} noRecentKeep=${noRecentKeep} ewma=${ewma.toFixed(4)}` };
  }

  const verdict = await worthItVerdict(paths, ledger, config);
  return {
    stop: verdict.decision === 'stop',
    candidate: true,
    reason: verdict.reason
  };
}

function isTargetMet(goal: GoalFile, ledger: LedgerEntry[]): boolean {
  const metric = [...ledger].reverse().find((entry) => entry.status === 'keep' && entry.metric)?.metric;
  if (!metric || goal.metric.target === undefined || goal.metric.target === null) return false;
  return goal.metric.direction === 'minimize' ? metric.p99 <= goal.metric.target : metric.p99 >= goal.metric.target;
}

function marginalValueEwma(ledger: LedgerEntry[], k: number): number {
  const keeps = ledger.filter((entry) => entry.status === 'keep' && typeof entry.delta_pct === 'number');
  const slice = keeps.slice(-Math.max(1, k));
  if (slice.length === 0) return Number.POSITIVE_INFINITY;
  const alpha = 2 / (slice.length + 1);
  let value = Math.max(0, slice[0].delta_pct ?? 0) / Math.max(1, slice[0].cost.wall_ms ?? 1);
  for (const entry of slice.slice(1)) {
    const marginal = Math.max(0, entry.delta_pct ?? 0) / Math.max(1, entry.cost.wall_ms ?? 1);
    value = alpha * marginal + (1 - alpha) * value;
  }
  return value * 1000;
}

async function worthItVerdict(paths: RunPaths, ledger: LedgerEntry[], config: WiCiConfig): Promise<{ decision: 'continue' | 'stop'; reason: string }> {
  if (config.tools.mode !== 'stub') {
    const exists = await execa('command', ['-v', config.tools.planner.command], { shell: true, reject: false });
    if (exists.exitCode === 0) {
      try {
        const prompt = await readFile(promptPath('stop-verdict'), 'utf8');
        const result = await execa(
          config.tools.planner.command,
          [
            '-p',
            `${prompt}\n\nLedger:\n${JSON.stringify(ledger.slice(-12), null, 2)}`,
            '--output-format',
            'json',
            '--dangerously-skip-permissions'
          ],
          { cwd: paths.target, reject: true, all: true, maxBuffer: 1024 * 1024 * 5 }
        );
        const parsed = JSON.parse(result.stdout) as { decision?: 'continue' | 'stop'; reason?: string };
        if (parsed.decision === 'continue' || parsed.decision === 'stop') {
          return { decision: parsed.decision, reason: parsed.reason ?? 'LLM stop verdict' };
        }
      } catch (error) {
        if (config.tools.mode === 'real') throw error;
      }
    }
  }

  return {
    decision: 'stop',
    reason: 'Recent marginal improvement is below the configured cost-benefit threshold.'
  };
}
