import { atomicWriteJson, exists, readJsonFile } from '../shared/atomic.js';
import type { BenchmarkManifest, GoalFile } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

export interface PlannerBenchmark {
  tool?: string;
  command?: string;
  metric?: string;
  min_reps?: number;
  warmup_discarded?: number;
  reason?: string;
  alternatives?: BenchmarkManifest['alternatives'];
}

export async function writeBenchmarkManifest(paths: RunPaths, goal: GoalFile, benchmark?: PlannerBenchmark): Promise<BenchmarkManifest> {
  const manifest = buildBenchmarkManifest(goal, benchmark);
  await atomicWriteJson(paths.benchmarkManifest, manifest);
  return manifest;
}

export async function ensureBenchmarkManifest(paths: RunPaths, goal: GoalFile): Promise<{ manifest: BenchmarkManifest; created: boolean }> {
  if (await exists(paths.benchmarkManifest)) {
    return { manifest: await readBenchmarkManifest(paths), created: false };
  }
  return { manifest: await writeBenchmarkManifest(paths, goal), created: true };
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
    `- min_reps: ${manifest.min_reps}`,
    `- warmup_discarded: ${manifest.warmup_discarded}`,
    `- reason: ${manifest.reason}`
  ].join('\n');
}

function buildBenchmarkManifest(goal: GoalFile, benchmark: PlannerBenchmark = {}): BenchmarkManifest {
  return {
    version: 1,
    goal_run_id: goal.run_id,
    selected_at: new Date().toISOString(),
    tool: clean(benchmark.tool) || defaultTool(goal),
    command: clean(benchmark.command) || './.opt/measure.sh',
    metric: clean(benchmark.metric) || goal.metric.name || 'p99 latency',
    min_reps: positiveInt(benchmark.min_reps, 5),
    warmup_discarded: nonNegativeInt(benchmark.warmup_discarded, 2),
    reason:
      clean(benchmark.reason) ||
      'Default fixture benchmark: .opt/measure.sh wraps the target-specific workload and emits the locked WiCi METRIC line.',
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
    !Number.isInteger(manifest.min_reps) ||
    manifest.min_reps < 1 ||
    !Number.isInteger(manifest.warmup_discarded) ||
    manifest.warmup_discarded < 0 ||
    !manifest.reason
  ) {
    throw new Error(`Invalid benchmark manifest: ${JSON.stringify(manifest)}`);
  }
}

function defaultTool(goal: GoalFile): string {
  const text = goal.requirements.map((req) => req.text).join(' ').toLowerCase();
  if (/\b(http|api|service|endpoint|server|rps|throughput)\b/.test(text)) return 'k6/wrk';
  if (/\b(pytest|python)\b/.test(text)) return 'pytest-benchmark';
  if (/\b(rust|criterion)\b/.test(text)) return 'criterion';
  if (/\b(command|cli|binary|process)\b/.test(text)) return 'hyperfine';
  return 'node';
}

function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : fallback;
}
