import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/stuck-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await writeDeterministicMeasure();
  const paths = runPaths(target);

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Replan after repeated no-op optimization attempts', '--max-iters', '3', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `stuck verifier supervisor run failed:\n${result.all}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 3, `expected 3 ledger rows, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected first row keep, got ${ledger[0].status}`);
  assert(ledger[1].status === 'reject', `expected second row reject, got ${ledger[1].status}`);
  assert(ledger[2].status === 'reject', `expected third row reject, got ${ledger[2].status}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('- [!] S2'), 'expected S2 to be marked blocked after retry exhaustion');
  assert(plan.includes('S2 exhausted retry budget'), 'expected stub replan to include retry exhaustion reason');
  assert(plan.includes('planner-chosen direction'), 'expected replan to delegate direction choice to planner');
  assert(!plan.includes('Avenue:'), 'replan must not include a supervisor-selected avenue');

  const events = await readJsonLines<RunEvent>(paths.events);
  const replanEvent = events.find((event) => event.type === 'REPLAN_STUCK');
  assert(replanEvent, 'missing REPLAN_STUCK event');
  const replanData = replanEvent.data as { planner_selects_direction?: boolean; avenue?: string } | undefined;
  assert(replanData?.planner_selects_direction === true, `REPLAN_STUCK should delegate direction choice to planner: ${JSON.stringify(replanData)}`);
  assert(replanData.avenue === undefined, `REPLAN_STUCK must not include a supervisor-selected avenue: ${JSON.stringify(replanData)}`);

  const replanCommits = await git(['log', '--oneline', '--grep', 'chore: replan after stalled S2']);
  assert(replanCommits.trim().length > 0, 'missing replan chore commit');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after stuck replan:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        ledger_rows: ledger.length,
        replan_stuck: true,
        s2_blocked: true,
        planner_selects_direction: true
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
