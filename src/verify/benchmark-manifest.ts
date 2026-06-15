import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson } from '../shared/atomic.js';
import { loadConfig } from '../shared/config.js';
import { runPaths } from '../shared/paths.js';
import type { BaselineFile, BenchmarkManifest, GoalFile, RunEvent } from '../shared/types.js';
import { ensureAcceptanceSpec } from '../supervisor/acceptance.js';
import { initializeBaseline } from '../supervisor/evaluate.js';
import { saveGoalFiles } from '../supervisor/goalDoc.js';
import { writeBenchmarkManifest } from '../supervisor/benchmark.js';

const target = resolve('fixture/benchmark-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const setup = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Select and lock a planner-generated validation tool for the fixture runtime', '--max-iters', '1', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(setup.exitCode === 0, `benchmark manifest setup run failed:\n${setup.all}`);

  const goal = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  const manifest = JSON.parse(await readFile(paths.benchmarkManifest, 'utf8')) as BenchmarkManifest;
  assert(manifest.version === 1, `unexpected benchmark manifest version ${manifest.version}`);
  assert(manifest.goal_run_id === goal.run_id, `benchmark manifest run_id mismatch: ${manifest.goal_run_id} !== ${goal.run_id}`);
  assert(manifest.tool === 'node', `stub benchmark should select node, got ${manifest.tool}`);
  assert(manifest.command === './.opt/measure.sh', `unexpected benchmark command: ${manifest.command}`);
  assert(manifest.metric === 'fixture runtime', `unexpected benchmark metric: ${manifest.metric}`);
  assert(manifest.min_reps >= 5, `benchmark min_reps should be >=5, got ${manifest.min_reps}`);
  assert(manifest.warmup_discarded >= 0, `invalid warmup_discarded ${manifest.warmup_discarded}`);
  assert(manifest.reason.length > 0, 'benchmark manifest missing selection reason');

  const legacyGoal: GoalFile = {
    ...goal,
    acceptance_criteria: [
      {
        id: 'A1',
        text: 'Fixture checks pass and the planner-selected measurement runs.',
        check: './.opt/checks.sh && ./.opt/measure.sh'
      }
    ]
  };
  await saveGoalFiles(paths, legacyGoal);
  const acceptance = await ensureAcceptanceSpec(paths, legacyGoal);
  assert(acceptance.ok, `legacy acceptance spec should be created: ${JSON.stringify(acceptance)}`);
  const config = await loadConfig('stub');
  await initializeBaseline(paths, legacyGoal, config);
  await git(['add', 'GOAL.md', 'baseline.json', 'acceptance.spec.json', '.opt/benchmark.json', '.opt/checks.sh', '.opt/measure.sh']);
  const baselineCommit = await git(['commit', '-m', 'test: initialize legacy benchmark baseline']);
  const baselineHash = baselineCommit.match(/\[[^\s]+ ([0-9a-f]{7,40})\]/)?.[1] ?? (await git(['rev-parse', 'HEAD'])).trim();
  const initializedBaseline = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  await atomicWriteJson(paths.baseline, {
    ...initializedBaseline,
    best_commit: baselineHash,
    updated_at: new Date().toISOString()
  });
  await git(['add', 'baseline.json']);
  await git(['commit', '-m', 'test: record legacy benchmark baseline anchor']);
  await git(['tag', '-f', 'wici/best']);

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--max-iters', '2', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `benchmark manifest legacy supervisor run failed:\n${result.all}`);

  const baseline = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(typeof baseline.eval_sha256.benchmark_manifest === 'string' && baseline.eval_sha256.benchmark_manifest.length > 0, 'baseline did not pin benchmark manifest hash');

  const secondPrompt = await readFile(join(paths.artifacts, 'iter-2.prompt.txt'), 'utf8');
  assert(secondPrompt.includes('Frozen benchmark selection'), 'iter-2 prompt missing benchmark selection');
  assert(secondPrompt.includes('.opt/benchmark.json'), 'iter-2 prompt missing benchmark manifest path');
  assert(secondPrompt.includes('tool: node'), 'iter-2 prompt missing selected benchmark tool');

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'PLAN_DONE'), 'missing PLAN_DONE event');
  assert(events.some((event) => event.type === 'BENCHMARK_SELECTED'), 'missing BENCHMARK_SELECTED event');
  const benchmarkEvent = events.find((event) => event.type === 'BENCHMARK_SELECTED');
  assert(JSON.stringify(benchmarkEvent?.data ?? {}).includes('"source":"planner"'), `benchmark event did not identify planner source: ${JSON.stringify(benchmarkEvent)}`);

  await chmod(paths.benchmarkManifest, 0o644);
  await atomicWriteJson(paths.benchmarkManifest, { ...manifest, tool: 'tampered-benchmark' });
  const rejected = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--max-iters', '3', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(rejected.exitCode !== 0, 'tampered benchmark manifest was not rejected');
  assert(
    (rejected.all ?? '').includes('.opt/benchmark.json') || (await readFile(paths.events, 'utf8')).includes('.opt/benchmark.json'),
    `tamper error did not mention benchmark manifest:\n${rejected.all}`
  );
  await verifyIncompleteBenchmarkRejected(goal);
  await verifyPlannerDefaults(goal);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        benchmark_tool: manifest.tool,
        benchmark_hash_pinned: true,
        prompt_reused_benchmark: true,
        tamper_rejected: true,
        incomplete_benchmark_rejected: true,
        missing_reps_defaulted: true
      },
      null,
      2
    )
  );
}

async function verifyIncompleteBenchmarkRejected(goal: GoalFile): Promise<void> {
  const badPaths = runPaths(resolve('fixture/benchmark-missing-target'));
  let error: unknown;
  try {
    await writeBenchmarkManifest(badPaths, goal, {});
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error, 'incomplete planner benchmark should be rejected');
  assert(error.message.includes('Planner benchmark is incomplete'), `unexpected incomplete benchmark error: ${error.message}`);
}

async function verifyPlannerDefaults(goal: GoalFile): Promise<void> {
  const defaultPaths = runPaths(resolve('fixture/benchmark-defaults-target'));
  const manifest = await writeBenchmarkManifest(defaultPaths, goal, {
    tool: 'curl',
    command: './.opt/measure.sh',
    metric: 'generation_throughput',
    direction: 'maximize',
    target: 700,
    unit: 'token/s',
    reason: 'Planner selected an endpoint throughput harness; supervisor should not reject missing optional repetition metadata.'
  });
  assert(manifest.min_reps === 5, `missing planner min_reps should default to 5, got ${manifest.min_reps}`);
  assert(manifest.warmup_discarded === 0, `missing planner warmup_discarded should default to 0, got ${manifest.warmup_discarded}`);
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

async function writeDeterministicMeasure(): Promise<void> {
  await writeFile(
    `${target}/measure.mjs`,
    `import { readFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
const optimized = source.includes('new Set');
const samples = optimized ? [10, 10, 10, 10, 10, 10, 10] : [100, 100, 100, 100, 100, 100, 100];
const value = samples[6];
console.log(\`METRIC value=\${value} unit=ms n=\${samples.length} warmup_discarded=2 samples=\${samples.join(',')}\`);
`
  );
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
