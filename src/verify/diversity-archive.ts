import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { ArchiveState, BaselineFile, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/diversity-archive-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);
  await ensureRunDirs(paths);
  await writeFile(join(paths.wici, 'stub-two-keeps'), '1\n');

  const result = await execa(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Branch from an archived stepping stone after a plateau', '--max-iters', '5', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000,
      env: {
        ...process.env,
        WICI_THOMPSON_SEED: '11'
      }
    }
  );
  assert(result.exitCode === 0, `diversity archive verifier supervisor run failed:\n${result.all}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 5, `expected 5 ledger rows, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected iter-1 keep, got ${ledger[0].status}`);
  assert(ledger[1].status === 'keep', `expected iter-2 keep, got ${ledger[1].status}`);
  assert(ledger.slice(2).every((entry) => entry.status === 'reject'), `expected iter-3..5 rejects: ${ledger.map((entry) => entry.status).join(',')}`);

  const archive = JSON.parse(await readFile(paths.archive, 'utf8')) as ArchiveState;
  assert(archive.entries.length === 2, `expected two archive entries, got ${archive.entries.length}`);
  const first = archive.entries.find((entry) => entry.ledger_id === 'iter-1');
  const second = archive.entries.find((entry) => entry.ledger_id === 'iter-2');
  assert(first, `missing iter-1 archive entry: ${JSON.stringify(archive)}`);
  assert(second, `missing iter-2 archive entry: ${JSON.stringify(archive)}`);
  assert((first.branch_count ?? 0) >= 1, `iter-1 archive entry was not branched: ${JSON.stringify(first)}`);

  const baseline = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(second.perf_commit === baseline.best_commit, `expected iter-2 perf commit to be global best ${baseline.best_commit}, got ${second.perf_commit}`);
  assert(first.commit !== second.commit, 'archive entries should point at different commits');

  const events = await readJsonLines<RunEvent>(paths.events);
  const checkout = events.find((event) => event.type === 'ARCHIVE_BRANCH_CHECKOUT');
  assert(checkout, 'missing ARCHIVE_BRANCH_CHECKOUT event');
  const checkoutData = checkout.data as { ledger_id?: string; non_best?: boolean; best_commit?: string; commit?: string } | undefined;
  assert(checkoutData?.ledger_id === 'iter-1', `expected checkout from iter-1, got ${JSON.stringify(checkoutData)}`);
  assert(checkoutData.non_best === true, `expected archive checkout to be non-best: ${JSON.stringify(checkoutData)}`);
  assert(checkoutData.best_commit === baseline.best_commit, 'checkout event did not report baseline best commit');

  const replan = events.find((event) => event.type === 'REPLAN_STUCK');
  assert(replan, 'missing REPLAN_STUCK event');
  assert((replan.data as { parent_id?: string } | undefined)?.parent_id === 'iter-1', `replan parent was not archive iter-1: ${JSON.stringify(replan.data)}`);

  const branchOutcome = ledger[4];
  assert(branchOutcome.parent_id === 'iter-1', `branch outcome did not record archive parent: ${JSON.stringify(branchOutcome)}`);
  assert(branchOutcome.guards.avenue, `branch outcome missing avenue guard: ${JSON.stringify(branchOutcome.guards)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after diversity archive run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        archive_entries: archive.entries.length,
        branch_parent: branchOutcome.parent_id,
        non_best_checkout: true
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
const marker = source.includes('wici-stub-v2');
const optimized = source.includes('new Set');
const samples = marker ? [5, 5, 5, 5, 5, 5, 5] : optimized ? [10, 10, 10, 10, 10, 10, 10] : [100, 100, 100, 100, 100, 100, 100];
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
