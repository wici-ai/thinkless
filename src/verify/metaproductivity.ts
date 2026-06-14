import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson } from '../shared/atomic.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { AvenueState, Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/metaproductivity-target');
const expectedAvenue = 'caching or memoization';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);
  await ensureRunDirs(paths);
  await atomicWriteJson(paths.avenues, {
    version: 4,
    stats: [
      {
        name: 'algorithmic complexity',
        selected: 8,
        successes: 0,
        failures: 10,
        downstream_delta_pct: 0
      },
      {
        name: expectedAvenue,
        selected: 2,
        successes: 3,
        failures: 1,
        downstream_delta_pct: 50
      }
    ]
  });

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Use metaproductive branch selection after a stall', '--max-iters', '4', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000,
    env: {
      ...process.env,
      WICI_THOMPSON_SEED: '11'
    }
  });
  assert(result.exitCode === 0, `metaproductivity verifier supervisor run failed:\n${result.all}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const replanEvent = events.find((event) => event.type === 'REPLAN_STUCK');
  assert(replanEvent, 'missing REPLAN_STUCK event');
  const replanData = replanEvent.data as { avenue?: string; parent_id?: string | null; sample?: number } | undefined;
  assert(replanData?.avenue === expectedAvenue, `expected avenue ${expectedAvenue}, got ${JSON.stringify(replanData)}`);
  assert(replanData.parent_id === 'iter-1', `expected branch parent iter-1, got ${replanData.parent_id}`);
  assert(typeof replanData.sample === 'number', 'REPLAN_STUCK event missing Thompson sample');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 4, `expected 4 ledger rows, got ${ledger.length}`);
  const branchOutcome = ledger[3];
  assert(branchOutcome.parent_id === 'iter-1', `branch outcome missing parent_id iter-1: ${JSON.stringify(branchOutcome)}`);
  assert(branchOutcome.guards.avenue === expectedAvenue, `branch outcome missing avenue guard: ${JSON.stringify(branchOutcome.guards)}`);
  assert(branchOutcome.status === 'reject', `expected branch outcome reject, got ${branchOutcome.status}`);

  const outcomeEvent = events.find((event) => event.type === 'AVENUE_OUTCOME');
  assert(outcomeEvent, 'missing AVENUE_OUTCOME event');
  const avenueState = JSON.parse(await readFile(paths.avenues, 'utf8')) as AvenueState;
  const stat = avenueState.stats.find((item) => item.name === expectedAvenue);
  assert(stat, `missing avenue stat for ${expectedAvenue}`);
  assert(stat.selected === 3, `expected selected count 3, got ${stat.selected}`);
  assert(stat.failures === 2, `expected failures 2, got ${stat.failures}`);
  assert(stat.successes === 3, `expected successes to stay 3, got ${stat.successes}`);
  assert(stat.last_parent_id === 'iter-1', `expected last_parent_id iter-1, got ${stat.last_parent_id}`);
  assert(stat.last_outcome_ledger_id === 'iter-4', `expected last outcome iter-4, got ${stat.last_outcome_ledger_id}`);

  const checkpoint = JSON.parse(await readFile(paths.checkpoint, 'utf8')) as Checkpoint;
  assert(!checkpoint.active_avenue, `active avenue was not cleared after outcome: ${JSON.stringify(checkpoint.active_avenue)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after metaproductivity run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        selected_avenue: expectedAvenue,
        branch_parent: replanData.parent_id,
        outcome_ledger: branchOutcome.id,
        failures: stat.failures
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

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
