import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { iterationSnapshotPath } from '../supervisor/checkpoint.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, CheckpointSnapshot, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/resume-iteration-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const first = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Load a prior WiCi iteration snapshot deterministically', '--max-iters', '2', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(first.exitCode === 0, `initial resume-iteration run failed:\n${first.all}`);

  const initialLedger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(initialLedger.length === 2, `expected two ledger rows before restore, got ${initialLedger.length}`);
  assert(initialLedger[0].status === 'keep', `expected first row keep, got ${initialLedger[0].status}`);
  assert(initialLedger[1].status === 'reject', `expected second row reject, got ${initialLedger[1].status}`);

  const iter0 = await readSnapshot(paths, 0);
  const iter1 = await readSnapshot(paths, 1);
  const iter2 = await readSnapshot(paths, 2);
  assert(iter0.checkpoint.iter === 0, `iter-0 snapshot has iter=${iter0.checkpoint.iter}`);
  assert(iter1.checkpoint.ledger_seq === 1, `iter-1 snapshot ledger_seq=${iter1.checkpoint.ledger_seq}`);
  assert(iter2.checkpoint.ledger_seq === 2, `iter-2 snapshot ledger_seq=${iter2.checkpoint.ledger_seq}`);
  assert(iter1.files.context?.includes('iter-1'), 'iter-1 snapshot context missing iter-1');
  assert(!iter1.files.context?.includes('iter-2'), 'iter-1 snapshot context should not include future iter-2');

  const second = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--resume-iteration', '1', '--max-iters', '1', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(second.exitCode === 0, `restore to iteration 1 failed:\n${second.all}`);

  const restoredLedger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(restoredLedger.length === 1, `expected one ledger row after restore, got ${restoredLedger.length}`);
  assert(restoredLedger[0].id === 'iter-1', `expected restored ledger to end at iter-1, got ${restoredLedger[0].id}`);

  const checkpoint = JSON.parse(await readFile(paths.checkpoint, 'utf8')) as Checkpoint;
  assert(checkpoint.iter === 1, `expected checkpoint iter=1 after restore, got ${checkpoint.iter}`);
  assert(checkpoint.ledger_seq === 1, `expected checkpoint ledger_seq=1 after restore, got ${checkpoint.ledger_seq}`);

  const head = (await git(['rev-parse', 'HEAD'])).trim();
  assert(head === iter1.head_commit, `HEAD ${head} did not reset to iter-1 snapshot ${iter1.head_commit}`);

  const context = await readFile(paths.context, 'utf8');
  assert(context.includes('iter-1'), 'restored context missing iter-1');
  assert(!context.includes('iter-2'), 'restored context leaked future iter-2');

  const events = await readJsonLines<RunEvent>(paths.events);
  const loaded = events.find((event) => event.type === 'RESUME_ITERATION_LOADED');
  assert(loaded, 'missing RESUME_ITERATION_LOADED event');
  assert((loaded.data as { iteration?: number } | undefined)?.iteration === 1, `resume event used wrong iteration: ${JSON.stringify(loaded)}`);
  assert(!events.some((event) => event.message.includes('Iteration 2:')), 'events log retained future iteration 2 after restore');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after resume-iteration restore:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        restored_iteration: 1,
        ledger_rows: restoredLedger.length,
        head
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

async function readSnapshot(paths: ReturnType<typeof runPaths>, iter: number): Promise<CheckpointSnapshot> {
  return JSON.parse(await readFile(iterationSnapshotPath(paths, iter), 'utf8')) as CheckpointSnapshot;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
