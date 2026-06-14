import { readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { promptPath, type RunPaths } from '../shared/paths.js';
import type { GoalFile, LedgerEntry, WiCiConfig } from '../shared/types.js';

export interface StopDecision {
  stop: boolean;
  candidate: boolean;
  reason: string;
  analysis: StopAnalysis;
  verdict?: {
    decision: 'continue' | 'stop';
    reason: string;
  };
}

export interface StopCostSummary {
  wall_ms: number;
  tokens_input: number;
  tokens_output: number;
  usd: number;
  effective_cost_units: number;
}

export interface StopCurvePoint {
  id: string;
  iter: number;
  delta_pct: number;
  cost: StopCostSummary;
  marginal_value: number;
}

export interface StopAnalysis {
  target_met: boolean;
  no_recent_keep: boolean;
  ewma_marginal_value: number;
  tau: number;
  K: number;
  N: number;
  cumulative_cost: StopCostSummary;
  recent_curve: StopCurvePoint[];
}

export async function shouldStop(paths: RunPaths, goal: GoalFile, ledger: LedgerEntry[], config: WiCiConfig): Promise<StopDecision> {
  const analysis = buildStopAnalysis(goal, ledger);
  const candidate = (analysis.target_met || analysis.no_recent_keep) && analysis.ewma_marginal_value < goal.stop.tau;
  if (!candidate) {
    return {
      stop: false,
      candidate: false,
      reason: `continue: targetMet=${analysis.target_met} noRecentKeep=${analysis.no_recent_keep} ewma=${formatNumber(analysis.ewma_marginal_value)}`,
      analysis
    };
  }

  const verdict = await worthItVerdict(paths, ledger, config, analysis);
  return {
    stop: verdict.decision === 'stop',
    candidate: true,
    reason: verdict.reason,
    analysis,
    verdict
  };
}

export function buildStopAnalysis(goal: GoalFile, ledger: LedgerEntry[]): StopAnalysis {
  const curve = keepCurve(ledger);
  const recentCurve = curve.slice(-Math.max(1, goal.stop.K));
  return {
    target_met: isTargetMet(goal, ledger),
    no_recent_keep: ledger.length > 0 && ledger.slice(-Math.max(1, goal.stop.N)).every((entry) => entry.status !== 'keep'),
    ewma_marginal_value: marginalValueEwma(recentCurve),
    tau: goal.stop.tau,
    K: goal.stop.K,
    N: goal.stop.N,
    cumulative_cost: summarizeCost(ledger),
    recent_curve: recentCurve
  };
}

function isTargetMet(goal: GoalFile, ledger: LedgerEntry[]): boolean {
  const metric = [...ledger].reverse().find((entry) => entry.status === 'keep' && entry.metric)?.metric;
  if (!metric || goal.metric.target === undefined || goal.metric.target === null) return false;
  return goal.metric.direction === 'minimize' ? metric.p99 <= goal.metric.target : metric.p99 >= goal.metric.target;
}

function marginalValueEwma(slice: StopCurvePoint[]): number {
  if (slice.length === 0) return Number.POSITIVE_INFINITY;
  const alpha = 2 / (slice.length + 1);
  let value = slice[0].marginal_value;
  for (const entry of slice.slice(1)) {
    value = alpha * entry.marginal_value + (1 - alpha) * value;
  }
  return value;
}

async function worthItVerdict(
  paths: RunPaths,
  ledger: LedgerEntry[],
  config: WiCiConfig,
  analysis: StopAnalysis
): Promise<{ decision: 'continue' | 'stop'; reason: string }> {
  if (config.tools.mode !== 'stub') {
    const exists = await execa('command', ['-v', config.tools.planner.command], { shell: true, reject: false });
    if (exists.exitCode === 0) {
      try {
        const prompt = await readFile(promptPath('stop-verdict'), 'utf8');
        const result = await execa(
          config.tools.planner.command,
          [
            '-p',
            `${prompt}\n\nStop analysis:\n${JSON.stringify(analysis, null, 2)}\n\nRecent ledger:\n${JSON.stringify(ledger.slice(-12), null, 2)}`,
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
    reason: `Recent marginal improvement ${formatNumber(analysis.ewma_marginal_value)} is below threshold ${formatNumber(analysis.tau)} after wall=${Math.round(analysis.cumulative_cost.wall_ms)}ms tokens=${analysis.cumulative_cost.tokens_input + analysis.cumulative_cost.tokens_output} usd=${formatNumber(analysis.cumulative_cost.usd)}.`
  };
}

function keepCurve(ledger: LedgerEntry[]): StopCurvePoint[] {
  return ledger
    .filter((entry) => entry.status === 'keep' && typeof entry.delta_pct === 'number')
    .map((entry) => {
      const cost = summarizeCost([entry]);
      return {
        id: entry.id,
        iter: entry.iter,
        delta_pct: entry.delta_pct ?? 0,
        cost,
        marginal_value: Math.max(0, entry.delta_pct ?? 0) / cost.effective_cost_units
      };
    });
}

function summarizeCost(ledger: LedgerEntry[]): StopCostSummary {
  const cost = ledger.reduce(
    (sum, entry) => ({
      wall_ms: sum.wall_ms + (entry.cost.wall_ms ?? 0),
      tokens_input: sum.tokens_input + (entry.cost.tokens_input ?? 0),
      tokens_output: sum.tokens_output + (entry.cost.tokens_output ?? 0),
      usd: sum.usd + (entry.cost.usd ?? 0)
    }),
    { wall_ms: 0, tokens_input: 0, tokens_output: 0, usd: 0 }
  );
  return {
    ...cost,
    usd: Number(cost.usd.toFixed(8)),
    effective_cost_units: effectiveCostUnits(cost)
  };
}

function effectiveCostUnits(cost: Omit<StopCostSummary, 'effective_cost_units'>): number {
  const wallSeconds = cost.wall_ms / 1000;
  const tokenK = (cost.tokens_input + cost.tokens_output) / 1000;
  return Math.max(0.001, wallSeconds + tokenK + cost.usd);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(6);
}
