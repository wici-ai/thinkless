import { execa } from 'execa';
import { atomicWriteJson, exists, readJsonFileMaybe } from '../shared/atomic.js';
import type { BaselineFile, GoalFile, LedgerEntry, MetricStats, WiCiConfig } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';
import { currentCommit } from './gitgate.js';
import { hashFile } from './checkpoint.js';
import { evalHashes, lockEvalScripts, verifyEvalHashes } from './planner.js';

export interface CommandOutcome {
  ok: boolean;
  exitCode: number;
  output: string;
  wallMs: number;
}

export interface CandidateEvaluation {
  checks: CommandOutcome;
  prescreen?: CommandOutcome;
  measure?: CommandOutcome;
  heldout?: CommandOutcome;
  prescreenMetric?: MetricStats;
  metric?: MetricStats;
  heldoutMetric?: MetricStats;
  improved: boolean;
  deltaPct: number | null;
  prescreenDeltaPct?: number | null;
  heldoutDeltaPct?: number | null;
  confidence: string;
  ciLow?: number | null;
  ciHigh?: number | null;
  reason: string;
}

export async function runChecks(paths: RunPaths, config: WiCiConfig): Promise<CommandOutcome> {
  return runScript(paths.checks, paths.target, config.evaluation.checks_timeout_ms);
}

export async function runMeasure(paths: RunPaths, config: WiCiConfig): Promise<CommandOutcome & { metric: MetricStats }> {
  const outcome = await runScript(paths.measure, paths.target, config.evaluation.measure_timeout_ms);
  if (!outcome.ok) throw new Error(`measure.sh failed:\n${outcome.output}`);
  return { ...outcome, metric: parseMetric(outcome.output) };
}

export async function runPrescreen(paths: RunPaths, config: WiCiConfig): Promise<(CommandOutcome & { metric: MetricStats }) | null> {
  if (!(await exists(paths.prescreen))) return null;
  const outcome = await runScript(paths.prescreen, paths.target, config.evaluation.measure_timeout_ms);
  if (!outcome.ok) throw new Error(`prescreen.sh failed:\n${outcome.output}`);
  return { ...outcome, metric: parseMetric(outcome.output) };
}

export async function runHeldout(paths: RunPaths, config: WiCiConfig): Promise<(CommandOutcome & { metric: MetricStats }) | null> {
  if (!(await exists(paths.validate))) return null;
  const outcome = await runScript(paths.validate, paths.target, config.evaluation.measure_timeout_ms);
  if (!outcome.ok) throw new Error(`validate.sh failed:\n${outcome.output}`);
  return { ...outcome, metric: parseMetric(outcome.output) };
}

export async function initializeBaseline(paths: RunPaths, goal: GoalFile, config: WiCiConfig): Promise<BaselineFile> {
  const existing = await readJsonFileMaybe<BaselineFile>(paths.baseline);
  if (existing) {
    await verifyEvalHashes(paths, existing.eval_sha256);
    return existing;
  }

  const hashes = await lockEvalScripts(paths);
  const checks = await runChecks(paths, config);
  if (!checks.ok) {
    throw new Error(`Cannot initialize baseline: checks failed\n${checks.output}`);
  }
  const measure = await runMeasure(paths, config);
  if (measure.metric.n < config.evaluation.min_reps) {
    throw new Error(`Cannot initialize baseline: measure emitted n=${measure.metric.n}, expected at least ${config.evaluation.min_reps}`);
  }
  const heldout = await runHeldout(paths, config);
  if (heldout && heldout.metric.n < config.evaluation.min_reps) {
    throw new Error(`Cannot initialize baseline: validate.sh emitted n=${heldout.metric.n}, expected at least ${config.evaluation.min_reps}`);
  }
  const baseline: BaselineFile = {
    best_commit: await currentCommit(paths),
    best_metric: measure.metric,
    heldout_metric: heldout?.metric ?? null,
    eval_sha256: hashes,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    plan_hash: (await hashFile(paths.plan)) ?? ''
  };
  await atomicWriteJson(paths.baseline, baseline);
  void goal;
  return baseline;
}

export async function loadBaseline(paths: RunPaths): Promise<BaselineFile> {
  const baseline = await readJsonFileMaybe<BaselineFile>(paths.baseline);
  if (!baseline) throw new Error(`Missing baseline: ${paths.baseline}`);
  await verifyEvalHashes(paths, baseline.eval_sha256);
  return baseline;
}

export async function refreshEvalLock(paths: RunPaths, baseline: BaselineFile): Promise<BaselineFile> {
  const hashes = await evalHashes(paths);
  const next = {
    ...baseline,
    eval_sha256: hashes,
    updated_at: new Date().toISOString()
  };
  await atomicWriteJson(paths.baseline, next);
  return next;
}

export async function evaluateCandidate(paths: RunPaths, goal: GoalFile, baseline: BaselineFile, config: WiCiConfig): Promise<CandidateEvaluation> {
  await verifyEvalHashes(paths, baseline.eval_sha256);
  const checks = await runChecks(paths, config);
  if (!checks.ok) {
    return {
      checks,
      improved: false,
      deltaPct: null,
      confidence: 'checks-failed',
      reason: 'checks.sh failed'
    };
  }

  const prescreen = await runPrescreen(paths, config);
  const prescreenDecision = prescreen ? decidePrescreen(baseline.best_metric, prescreen.metric, goal) : null;
  if (prescreen && prescreenDecision && !prescreenDecision.ok) {
    return {
      checks,
      prescreen,
      prescreenMetric: prescreen.metric,
      improved: false,
      deltaPct: prescreenDecision.deltaPct,
      prescreenDeltaPct: prescreenDecision.deltaPct,
      confidence: 'prescreen-reject',
      reason: prescreenDecision.reason
    };
  }

  const measure = await runMeasure(paths, config);
  const decision = decideImprovement(baseline.best_metric, measure.metric, goal, config);
  if (!decision.improved) {
    return {
      checks,
      prescreen: prescreen ?? undefined,
      measure,
      prescreenMetric: prescreen?.metric,
      metric: measure.metric,
      improved: false,
      deltaPct: decision.deltaPct,
      prescreenDeltaPct: prescreenDecision?.deltaPct ?? null,
      confidence: decision.confidence,
      ciLow: decision.ciLow,
      ciHigh: decision.ciHigh,
      reason: decision.reason
    };
  }

  const heldout = await runHeldout(paths, config);
  const heldoutDecision = heldout && baseline.heldout_metric ? decideHeldoutValidation(baseline.heldout_metric, heldout.metric, goal, config) : null;
  if (heldoutDecision && !heldoutDecision.ok) {
    return {
      checks,
      prescreen: prescreen ?? undefined,
      measure,
      heldout: heldout ?? undefined,
      prescreenMetric: prescreen?.metric,
      metric: measure.metric,
      heldoutMetric: heldout?.metric,
      improved: false,
      deltaPct: decision.deltaPct,
      prescreenDeltaPct: prescreenDecision?.deltaPct ?? null,
      heldoutDeltaPct: heldoutDecision.deltaPct,
      confidence: 'heldout-regression',
      ciLow: decision.ciLow,
      ciHigh: decision.ciHigh,
      reason: heldoutDecision.reason
    };
  }
  return {
    checks,
    prescreen: prescreen ?? undefined,
    measure,
    heldout: heldout ?? undefined,
    prescreenMetric: prescreen?.metric,
    metric: measure.metric,
    heldoutMetric: heldout?.metric,
    improved: decision.improved,
    deltaPct: decision.deltaPct,
    prescreenDeltaPct: prescreenDecision?.deltaPct ?? null,
    heldoutDeltaPct: heldoutDecision?.deltaPct ?? null,
    confidence: decision.confidence,
    ciLow: decision.ciLow,
    ciHigh: decision.ciHigh,
    reason: decision.reason
  };
}

export function updateBaselineAfterKeep(baseline: BaselineFile, commit: string, metric: MetricStats, planHash: string, heldoutMetric?: MetricStats): BaselineFile {
  return {
    ...baseline,
    best_commit: commit,
    best_metric: metric,
    heldout_metric: heldoutMetric ?? baseline.heldout_metric ?? null,
    updated_at: new Date().toISOString(),
    plan_hash: planHash
  };
}

export function ledgerFromEvaluation(args: {
  iter: number;
  stepId: string;
  status: LedgerEntry['status'];
  hypothesis: string;
  commit: string | null;
  baseline: MetricStats | null;
  evaluation: CandidateEvaluation | null;
  wallMs: number;
  reflection: string;
  parentId?: string | null;
  avenue?: string;
}): LedgerEntry {
  return {
    id: `iter-${args.iter}`,
    ts: new Date().toISOString(),
    iter: args.iter,
    step_id: args.stepId,
    commit: args.commit,
    hypothesis: args.hypothesis,
    metric: args.evaluation?.metric ?? null,
    baseline: args.baseline,
    delta_pct: args.evaluation?.deltaPct ?? null,
    confidence: args.evaluation?.confidence ?? 'none',
    ci_low: args.evaluation?.ciLow ?? null,
    ci_high: args.evaluation?.ciHigh ?? null,
    p_value: null,
    cost: { wall_ms: args.wallMs },
    guards: {
      checks: args.evaluation?.checks.ok ?? false,
      reason: args.evaluation?.reason ?? 'no evaluation',
      ...(args.evaluation?.prescreenMetric ? { prescreen_p99: args.evaluation.prescreenMetric.p99 } : {}),
      ...(args.evaluation?.prescreenMetric && args.evaluation.prescreenDeltaPct !== undefined && args.evaluation.prescreenDeltaPct !== null
        ? { prescreen_delta_pct: args.evaluation.prescreenDeltaPct }
        : {}),
      ...(args.evaluation?.heldoutMetric ? { heldout_p99: args.evaluation.heldoutMetric.p99 } : {}),
      ...(args.evaluation?.heldoutMetric && args.evaluation.heldoutDeltaPct !== undefined && args.evaluation.heldoutDeltaPct !== null
        ? { heldout_delta_pct: args.evaluation.heldoutDeltaPct }
        : {}),
      ...(args.avenue ? { avenue: args.avenue } : {})
    },
    status: args.status,
    reflection: args.reflection,
    parent_id: args.parentId ?? null
  };
}

function decidePrescreen(baseline: MetricStats, candidate: MetricStats, goal: GoalFile): { ok: boolean; deltaPct: number; reason: string } {
  const deltaPct = metricDeltaPct(baseline.p99, candidate.p99, goal.metric.direction);
  if (deltaPct <= 0) {
    return {
      ok: false,
      deltaPct,
      reason: `cascade pre-screen rejected candidate: delta ${(deltaPct * 100).toFixed(2)}% <= 0.00%`
    };
  }
  return { ok: true, deltaPct, reason: 'cascade pre-screen passed' };
}

function decideHeldoutValidation(baseline: MetricStats, candidate: MetricStats, goal: GoalFile, config: WiCiConfig): { ok: boolean; deltaPct: number; reason: string } {
  const direction = goal.metric.direction;
  const deltaPct = metricDeltaPct(baseline.p99, candidate.p99, direction);
  if (!guardsOk(baseline, candidate, direction)) {
    return { ok: false, deltaPct, reason: 'held-out validation guard regressed' };
  }
  if (deltaPct < -config.evaluation.noise_threshold) {
    return {
      ok: false,
      deltaPct,
      reason: `held-out validation regressed ${formatPct(-deltaPct)} > allowed ${formatPct(config.evaluation.noise_threshold)}`
    };
  }
  return { ok: true, deltaPct, reason: 'held-out validation passed' };
}

export function parseMetric(output: string): MetricStats {
  const line = output
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .reverse()
    .find((item) => item.startsWith('METRIC '));
  if (!line) throw new Error(`measure.sh did not emit a METRIC line:\n${output}`);

  const fields = new Map<string, string>();
  for (const token of line.slice('METRIC '.length).split(/\s+/)) {
    const index = token.indexOf('=');
    if (index <= 0) continue;
    fields.set(token.slice(0, index), token.slice(index + 1));
  }

  const required = ['p50', 'p95', 'p99', 'unit', 'n'];
  for (const key of required) {
    if (!fields.has(key)) throw new Error(`METRIC line missing ${key}: ${line}`);
  }

  const samplesRaw = fields.get('samples');
  return {
    p50: numberField(fields, 'p50'),
    p95: numberField(fields, 'p95'),
    p99: numberField(fields, 'p99'),
    unit: fields.get('unit') ?? 'ms',
    n: Math.trunc(numberField(fields, 'n')),
    warmup_discarded: fields.has('warmup_discarded') ? Math.trunc(numberField(fields, 'warmup_discarded')) : undefined,
    samples: samplesRaw ? samplesRaw.split(',').map((value) => Number(value)).filter((value) => Number.isFinite(value)) : undefined
  };
}

function numberField(fields: Map<string, string>, key: string): number {
  const value = Number(fields.get(key));
  if (!Number.isFinite(value)) throw new Error(`Invalid METRIC ${key}: ${fields.get(key)}`);
  return value;
}

function decideImprovement(baseline: MetricStats, candidate: MetricStats, goal: GoalFile, config: WiCiConfig): {
  improved: boolean;
  deltaPct: number;
  confidence: string;
  ciLow?: number | null;
  ciHigh?: number | null;
  reason: string;
} {
  const direction = goal.metric.direction;
  const deltaPct = metricDeltaPct(baseline.p99, candidate.p99, direction);
  if (candidate.n < config.evaluation.min_reps) {
    return { improved: false, deltaPct, confidence: 'insufficient-reps', reason: `n=${candidate.n} below min_reps=${config.evaluation.min_reps}` };
  }
  if (!guardsOk(baseline, candidate, direction)) {
    return { improved: false, deltaPct, confidence: 'guard-regression', reason: 'p50 or p95 guard regressed beyond threshold' };
  }
  if (deltaPct <= config.evaluation.noise_threshold) {
    return { improved: false, deltaPct, confidence: 'below-noise-threshold', reason: `delta ${formatPct(deltaPct)} <= threshold ${formatPct(config.evaluation.noise_threshold)}` };
  }

  if ((baseline.samples?.length ?? 0) >= config.evaluation.min_reps && (candidate.samples?.length ?? 0) >= config.evaluation.min_reps) {
    const ci = bootstrapDeltaPct(baseline.samples!, candidate.samples!, direction, config.evaluation.bootstrap_resamples);
    const excludesZero = ci.low > 0 || ci.high < 0;
    return {
      improved: excludesZero,
      deltaPct,
      confidence: excludesZero ? 'bootstrap-ci-excludes-zero' : 'bootstrap-ci-overlaps-zero',
      ciLow: ci.low,
      ciHigh: ci.high,
      reason: excludesZero ? 'accepted by bootstrap CI' : 'bootstrap CI overlaps zero'
    };
  }

  return {
    improved: true,
    deltaPct,
    confidence: 'point-estimate',
    reason: 'accepted by threshold without samples'
  };
}

function guardsOk(baseline: MetricStats, candidate: MetricStats, direction: GoalFile['metric']['direction']): boolean {
  const p50 = metricDeltaPct(baseline.p50, candidate.p50, direction);
  const p95 = metricDeltaPct(baseline.p95, candidate.p95, direction);
  return p50 > -0.1 && p95 > -0.1;
}

function metricDeltaPct(base: number, next: number, direction: GoalFile['metric']['direction']): number {
  if (base === 0) return next === 0 ? 0 : direction === 'minimize' ? -1 : 1;
  return direction === 'minimize' ? (base - next) / base : (next - base) / Math.abs(base);
}

function bootstrapDeltaPct(base: number[], next: number[], direction: GoalFile['metric']['direction'], resamples: number): { low: number; high: number } {
  const rng = mulberry32(0x57494349);
  const deltas: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const baseSample = sampleWithReplacement(base, rng);
    const nextSample = sampleWithReplacement(next, rng);
    deltas.push(metricDeltaPct(percentile(baseSample, 0.99), percentile(nextSample, 0.99), direction));
  }
  deltas.sort((a, b) => a - b);
  return {
    low: percentile(deltas, 0.025),
    high: percentile(deltas, 0.975)
  };
}

function sampleWithReplacement(values: number[], rng: () => number): number[] {
  return values.map(() => values[Math.floor(rng() * values.length)]);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function runScript(script: string, cwd: string, timeout: number): Promise<CommandOutcome> {
  const started = Date.now();
  const result = await execa(script, [], {
    cwd,
    shell: false,
    reject: false,
    all: true,
    timeout,
    maxBuffer: 1024 * 1024 * 20
  });
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode ?? 1,
    output: result.all ?? `${result.stdout}\n${result.stderr}`,
    wallMs: Date.now() - started
  };
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
