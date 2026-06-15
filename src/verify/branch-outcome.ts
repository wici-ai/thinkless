import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/branch-outcome-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Use planner-selected branch continuation after a stall', '--max-iters', '4', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000,
    env: {
      ...process.env,
      WICI_THOMPSON_SEED: '11'
    }
  });
  assert(result.exitCode === 0, `branch outcome verifier supervisor run failed:\n${result.all}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const requestEvent = events.find((event) => event.type === 'BRANCH_REPLAN_REQUEST');
  assert(requestEvent, 'missing BRANCH_REPLAN_REQUEST event');
  const replanEvent = events.find((event) => event.type === 'REPLAN_STUCK');
  assert(replanEvent, 'missing REPLAN_STUCK event');
  const replanData = replanEvent.data as { avenue?: string; parent_id?: string | null; planner_selects_direction?: boolean } | undefined;
  assert(replanData?.planner_selects_direction === true, `expected planner-selected branch direction, got ${JSON.stringify(replanData)}`);
  assert(replanData.avenue === undefined, `replan should not include supervisor-selected avenue: ${JSON.stringify(replanData)}`);
  assert(replanData.parent_id === 'iter-1', `expected branch parent iter-1, got ${replanData.parent_id}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 4, `expected 4 ledger rows, got ${ledger.length}`);
  const branchOutcome = ledger[3];
  assert(branchOutcome.parent_id === 'iter-1', `branch outcome missing parent_id iter-1: ${JSON.stringify(branchOutcome)}`);
  assert(branchOutcome.guards.avenue === undefined, `branch outcome should not record a supervisor-selected avenue: ${JSON.stringify(branchOutcome.guards)}`);
  assert(typeof branchOutcome.guards.branch_reason === 'string', `branch outcome missing generic branch reason: ${JSON.stringify(branchOutcome.guards)}`);
  assert(branchOutcome.status === 'reject', `expected branch outcome reject, got ${branchOutcome.status}`);

  const outcomeEvent = events.find((event) => event.type === 'BRANCH_OUTCOME');
  assert(outcomeEvent, 'missing BRANCH_OUTCOME event');

  const checkpoint = JSON.parse(await readFile(paths.checkpoint, 'utf8')) as Checkpoint;
  assert(!checkpoint.active_branch, `active branch was not cleared after outcome: ${JSON.stringify(checkpoint.active_branch)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after branch outcome run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        planner_selects_direction: true,
        branch_parent: replanData.parent_id,
        outcome_ledger: branchOutcome.id
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
