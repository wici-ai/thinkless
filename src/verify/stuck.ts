import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { LedgerEntry, RunEvent } from '../shared/types.js';
import { shouldReplanStuckStep } from '../supervisor/stuck.js';

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
  assert(!plan.includes('- [!] S2'), 'stalled retry exhaustion must not mark S2 blocked');
  assert(plan.includes('- [x] S2'), 'stalled no-improvement step should be closed so it is not retried before bottleneck review');
  assert(plan.includes('S2 needs bottleneck review'), 'expected stub replan to include bottleneck review reason');
  assert(plan.includes('not a user-blocking condition'), 'expected replan to avoid user-blocking semantics');
  assert(plan.includes('current bottleneck') || plan.includes('failed hypothesis'), 'expected replan to require bottleneck or hypothesis analysis');
  assert(plan.includes('deeper debugging') || plan.includes('targeted experiments'), 'expected replan to allow deeper bounded debugging');
  assert(plan.includes('GOAL/PLAN'), 'expected no-improvement replan to update goal and plan framing');
  assert(plan.includes('next highest-value attempt'), 'expected replan to require planner-selected next value attempt');
  assert(!plan.includes('Avenue:'), 'replan must not include a supervisor-selected avenue');
  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes('## Bottleneck Review'), `expected GOAL.md bottleneck review update:\n${goalDoc}`);
  assert(!goalDoc.includes('Condensed WiCi run context'), `GOAL.md bottleneck review should be compact, not a pasted context dump:\n${goalDoc}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const replanEvent = events.find((event) => event.type === 'REPLAN_STUCK');
  assert(replanEvent, 'missing REPLAN_STUCK event');
  const replanData = replanEvent.data as { planner_selects_direction?: boolean; avenue?: string; blocked?: boolean } | undefined;
  assert(replanData?.planner_selects_direction === true, `REPLAN_STUCK should delegate direction choice to planner: ${JSON.stringify(replanData)}`);
  assert(replanData.blocked === false, `REPLAN_STUCK should not report a user-blocking state: ${JSON.stringify(replanData)}`);
  assert(replanData.avenue === undefined, `REPLAN_STUCK must not include a supervisor-selected avenue: ${JSON.stringify(replanData)}`);
  verifyHeldoutStuckReplansWithoutBlocking();

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after stuck replan:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        ledger_rows: ledger.length,
        replan_stuck: true,
        s2_blocked: false,
        planner_selects_direction: true
      },
      null,
      2
    )
  );
}

function verifyHeldoutStuckReplansWithoutBlocking(): void {
  const entries = [1, 2, 3].map((iter) => ({
    id: `iter-${iter}`,
    ts: new Date(0).toISOString(),
    iter,
    step_id: 'S9',
    commit: null,
    hypothesis: 'holdout-safe attempt',
    metric: null,
    baseline: null,
    delta_pct: null,
    confidence: 'heldout-regression',
    cost: {},
    guards: {},
    status: 'reject',
    reflection: 'heldout-safe rejected the current approach'
  }) satisfies LedgerEntry);
  const decision = shouldReplanStuckStep(entries, 'S9', {
    max_attempts_per_step: 3,
    reverts_before_reset: 5,
    stall_replan_after: 3
  });
  assert(decision.stuck, `heldout-safe repeats should trigger bottleneck replan: ${JSON.stringify(decision)}`);
  assert(decision.reason.includes('safe-validation bottleneck review'), `heldout-safe repeats should be framed as bottleneck review: ${decision.reason}`);
  assert(!decision.reason.includes('blocked'), `heldout-safe repeats must not be framed as blocked: ${decision.reason}`);
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
