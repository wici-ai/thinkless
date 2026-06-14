import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { exists } from '../shared/atomic.js';
import { runPaths, type RunPaths } from '../shared/paths.js';
import type { BaselineFile, GoalFile, MetricStats, WiCiConfig } from '../shared/types.js';
import { runChecks, runMeasure } from './evaluate.js';

export interface ScorerSelftestScenario {
  name: 'good' | 'bad';
  patch_applied: boolean;
  checks_ok: boolean;
  metric: MetricStats | null;
  delta_pct: number | null;
  verdict: 'accept' | 'reject';
  output_tail: string;
}

export interface ScorerSelftestResult {
  good: ScorerSelftestScenario;
  bad: ScorerSelftestScenario;
}

export async function hasScorerSelftest(paths: RunPaths): Promise<boolean> {
  return (await exists(paths.selftestGoodPatch)) && (await exists(paths.selftestBadPatch));
}

export async function runScorerSelftest(paths: RunPaths, goal: GoalFile, baseline: BaselineFile, config: WiCiConfig): Promise<ScorerSelftestResult | null> {
  if (!(await hasScorerSelftest(paths))) return null;

  const good = await runScenario(paths, goal, baseline, config, 'good', paths.selftestGoodPatch);
  if (!good.patch_applied || good.verdict !== 'accept') {
    throw new Error(`Scorer self-test failed: known-good patch was not accepted (${describeScenario(good)})`);
  }

  const bad = await runScenario(paths, goal, baseline, config, 'bad', paths.selftestBadPatch);
  if (!bad.patch_applied) {
    throw new Error(`Scorer self-test failed: known-bad patch could not be applied (${describeScenario(bad)})`);
  }
  if (bad.verdict !== 'reject') {
    throw new Error(`Scorer self-test failed: known-bad patch was accepted (${describeScenario(bad)})`);
  }

  return { good, bad };
}

async function runScenario(
  paths: RunPaths,
  goal: GoalFile,
  baseline: BaselineFile,
  config: WiCiConfig,
  name: 'good' | 'bad',
  patchPath: string
): Promise<ScorerSelftestScenario> {
  const temp = await mkdtemp(join(tmpdir(), `wici-selftest-${name}-`));
  try {
    await execa('git', ['-C', paths.target, 'worktree', 'add', '--detach', temp, baseline.best_commit], { all: true });
    const apply = await execa('git', ['-C', temp, 'apply', patchPath], { all: true, reject: false });
    if (apply.exitCode !== 0) {
      return {
        name,
        patch_applied: false,
        checks_ok: false,
        metric: null,
        delta_pct: null,
        verdict: 'reject',
        output_tail: tail(apply.all ?? apply.stderr)
      };
    }

    const scenarioPaths = runPaths(temp);
    const checks = await runChecks(scenarioPaths, config);
    if (!checks.ok) {
      return {
        name,
        patch_applied: true,
        checks_ok: false,
        metric: null,
        delta_pct: null,
        verdict: 'reject',
        output_tail: tail(checks.output)
      };
    }

    const measure = await runMeasure(scenarioPaths, config);
    const deltaPct = metricDeltaPct(baseline.best_metric.p99, measure.metric.p99, goal.metric.direction);
    const verdict = deltaPct > config.evaluation.noise_threshold ? 'accept' : 'reject';
    return {
      name,
      patch_applied: true,
      checks_ok: true,
      metric: measure.metric,
      delta_pct: deltaPct,
      verdict,
      output_tail: tail(measure.output)
    };
  } finally {
    await execa('git', ['-C', paths.target, 'worktree', 'remove', '--force', temp], { reject: false }).catch(() => undefined);
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function metricDeltaPct(base: number, next: number, direction: GoalFile['metric']['direction']): number {
  if (base === 0) return next === 0 ? 0 : direction === 'minimize' ? -1 : 1;
  return direction === 'minimize' ? (base - next) / base : (next - base) / Math.abs(base);
}

function describeScenario(scenario: ScorerSelftestScenario): string {
  const metric = scenario.metric ? `p99=${scenario.metric.p99}${scenario.metric.unit}` : 'no metric';
  const delta = scenario.delta_pct === null ? 'delta=n/a' : `delta=${(scenario.delta_pct * 100).toFixed(2)}%`;
  return `${scenario.name} patch_applied=${scenario.patch_applied} checks_ok=${scenario.checks_ok} ${metric} ${delta} verdict=${scenario.verdict}`;
}

function tail(text: string | undefined): string {
  return (text ?? '').slice(-2000);
}
