import { atomicWriteJson, exists, readJsonFile } from '../shared/atomic.js';
import type { BenchmarkManifest, GoalFile } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

export interface PlannerBenchmark {
  tool?: string;
  command?: string;
  metric?: string;
  direction?: GoalFile['metric']['direction'];
  target?: number | null;
  unit?: string;
  min_reps?: number;
  warmup_discarded?: number;
  reason?: string;
  alternatives?: BenchmarkManifest['alternatives'];
}

const DEFAULT_MIN_REPS = 5;
const DEFAULT_WARMUP_DISCARDED = 0;

export async function writeBenchmarkManifest(paths: RunPaths, goal: GoalFile, benchmark: PlannerBenchmark): Promise<BenchmarkManifest> {
  const manifest = buildBenchmarkManifest(goal, benchmark);
  await atomicWriteJson(paths.benchmarkManifest, manifest);
  return manifest;
}

export async function readBenchmarkManifest(paths: RunPaths): Promise<BenchmarkManifest> {
  const manifest = await readJsonFile<BenchmarkManifest>(paths.benchmarkManifest);
  validateBenchmarkManifest(manifest);
  return manifest;
}

export async function readBenchmarkForPrompt(paths: RunPaths): Promise<string> {
  if (!(await exists(paths.benchmarkManifest))) return '';
  return formatBenchmarkForPrompt(await readBenchmarkManifest(paths));
}

export function formatBenchmarkForPrompt(manifest: BenchmarkManifest): string {
  return [
    'Frozen benchmark selection (authoritative; re-read from .opt/benchmark.json this iteration):',
    `- tool: ${manifest.tool}`,
    `- command: ${manifest.command}`,
    `- metric: ${manifest.metric}`,
    `- direction: ${manifest.direction}`,
    `- target: ${manifest.target === null || manifest.target === undefined ? 'none' : `${manifest.target}${manifest.unit ?? ''}`}`,
    `- min_reps: ${manifest.min_reps}`,
    `- warmup_discarded: ${manifest.warmup_discarded}`,
    `- reason: ${manifest.reason}`
  ].join('\n');
}

function buildBenchmarkManifest(goal: GoalFile, benchmark: PlannerBenchmark): BenchmarkManifest {
  const tool = clean(benchmark.tool);
  const command = clean(benchmark.command);
  const metric = clean(benchmark.metric);
  const direction = benchmark.direction === 'minimize' || benchmark.direction === 'maximize' ? benchmark.direction : undefined;
  const reason = clean(benchmark.reason);
  const minReps = positiveInt(benchmark.min_reps) ?? DEFAULT_MIN_REPS;
  const warmupDiscarded = nonNegativeInt(benchmark.warmup_discarded) ?? DEFAULT_WARMUP_DISCARDED;
  if (!tool || !command || !metric || !direction || !reason) {
    throw new Error(`Planner benchmark is incomplete; expected tool, command, metric, direction, and reason: ${JSON.stringify(benchmark)}`);
  }
  return {
    version: 1,
    goal_run_id: goal.run_id,
    selected_at: new Date().toISOString(),
    tool,
    command,
    metric,
    direction,
    target: benchmark.target ?? null,
    unit: clean(benchmark.unit) || undefined,
    min_reps: minReps,
    warmup_discarded: warmupDiscarded,
    reason,
    alternatives: benchmark.alternatives?.filter((item) => clean(item.tool)).map((item) => ({ tool: item.tool, reason: item.reason }))
  };
}

function validateBenchmarkManifest(manifest: BenchmarkManifest): void {
  if (
    manifest.version !== 1 ||
    !manifest.goal_run_id ||
    !manifest.tool ||
    !manifest.command ||
    !manifest.metric ||
    (manifest.direction !== 'minimize' && manifest.direction !== 'maximize') ||
    !Number.isInteger(manifest.min_reps) ||
    manifest.min_reps < 1 ||
    !Number.isInteger(manifest.warmup_discarded) ||
    manifest.warmup_discarded < 0 ||
    !manifest.reason
  ) {
    throw new Error(`Invalid benchmark manifest: ${JSON.stringify(manifest)}`);
  }
}

function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value: number | undefined): number | null {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : null;
}

function nonNegativeInt(value: number | undefined): number | null {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : null;
}
