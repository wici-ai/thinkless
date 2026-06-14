import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { BaselineFile, BenchmarkManifest, GoalFile, RunEvent } from '../shared/types.js';

const target = resolve('fixture/benchmark-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Select and lock a benchmark tool for p99 latency', '--max-iters', '2', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(result.exitCode === 0, `benchmark manifest supervisor run failed:\n${result.all}`);

  const goal = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  const manifest = JSON.parse(await readFile(paths.benchmarkManifest, 'utf8')) as BenchmarkManifest;
  assert(manifest.version === 1, `unexpected benchmark manifest version ${manifest.version}`);
  assert(manifest.goal_run_id === goal.run_id, `benchmark manifest run_id mismatch: ${manifest.goal_run_id} !== ${goal.run_id}`);
  assert(manifest.tool === 'node', `stub benchmark should select node, got ${manifest.tool}`);
  assert(manifest.command === './.opt/measure.sh', `unexpected benchmark command: ${manifest.command}`);
  assert(manifest.metric === 'p99 latency', `unexpected benchmark metric: ${manifest.metric}`);
  assert(manifest.min_reps >= 5, `benchmark min_reps should be >=5, got ${manifest.min_reps}`);
  assert(manifest.warmup_discarded >= 0, `invalid warmup_discarded ${manifest.warmup_discarded}`);
  assert(manifest.reason.length > 0, 'benchmark manifest missing selection reason');

  const baseline = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(typeof baseline.eval_sha256.benchmark_manifest === 'string' && baseline.eval_sha256.benchmark_manifest.length > 0, 'baseline did not pin benchmark manifest hash');

  const secondPrompt = await readFile(join(paths.artifacts, 'iter-2.prompt.txt'), 'utf8');
  assert(secondPrompt.includes('Frozen benchmark selection'), 'iter-2 prompt missing benchmark selection');
  assert(secondPrompt.includes('.opt/benchmark.json'), 'iter-2 prompt missing benchmark manifest path');
  assert(secondPrompt.includes('tool: node'), 'iter-2 prompt missing selected benchmark tool');

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'PLAN_DONE'), 'missing PLAN_DONE event');
  assert(events.some((event) => event.type === 'BENCHMARK_SELECTED'), 'missing BENCHMARK_SELECTED event');

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

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        benchmark_tool: manifest.tool,
        benchmark_hash_pinned: true,
        prompt_reused_benchmark: true,
        tamper_rejected: true
      },
      null,
      2
    )
  );
}

async function writeDeterministicMeasure(): Promise<void> {
  await writeFile(
    `${target}/measure.mjs`,
    `import { readFileSync } from 'node:fs';

const source = readFileSync('./src/hotpath.js', 'utf8');
const optimized = source.includes('new Set');
const samples = optimized ? [10, 10, 10, 10, 10, 10, 10] : [100, 100, 100, 100, 100, 100, 100];
const p50 = samples[3];
const p95 = samples[6];
const p99 = samples[6];
console.log(\`METRIC p50=\${p50} p95=\${p95} p99=\${p99} unit=ms n=\${samples.length} warmup_discarded=2 samples=\${samples.join(',')}\`);
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
