import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/direct-no-scripts-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await writeFile(
    paths.plan,
    [
      '# PLAN',
      '',
      '- [ ] S1 Improve the fixture implementation while preserving exact output correctness',
      '  - Action: inspect the target and make the smallest useful change.',
      '  - Validation: report what was changed and whether the step is complete.',
      ''
    ].join('\n')
  );
  await writeFile(paths.baseline, `${JSON.stringify({ legacy_fixture: true }, null, 2)}\n`);

  const result = await runSupervisor({
    target,
    goal: 'Execute the existing markdown PLAN.md without requiring planner-generated scripts.',
    maxIters: 1,
    mode: 'stub'
  });

  assert(result.state === 'STOP', `direct no-script run should stop cleanly, got ${JSON.stringify(result)}`);
  assert(result.reason === 'Reached max_iters=1', `unexpected stop reason: ${result.reason}`);
  assert(!(await exists(paths.checks)), 'fresh direct run should not require .opt/checks.sh');
  assert(!(await exists(paths.measure)), 'fresh direct run should not require .opt/measure.sh');
  assert(!(await exists(paths.benchmarkManifest)), 'fresh direct run should not require .opt/benchmark.json');

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'EXECUTE_START'), 'missing EXECUTE_START for no-script direct run');
  assert(events.some((event) => event.type === 'EXECUTE_DONE'), 'missing EXECUTE_DONE for no-script direct run');
  assert(events.some((event) => event.type === 'LEGACY_BASELINE_IGNORED'), 'historical baseline.json should be ignored by default V1 execution');
  assert(!events.some((event) => event.type === 'PLAN_START'), 'existing PLAN.md should not force planner before direct execution');
  assert(!events.some((event) => event.type === 'BASELINE_START'), 'no-script direct run must not initialize baseline');
  assert(!events.some((event) => event.type === 'EVALUATE_START'), 'no-script direct run must not run evaluator gate');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP checkpoint, got ${checkpoint.supervisor_state}`);
  assert(checkpoint.ledger_seq === 1, `expected one no-script ledger row, got ${checkpoint.ledger_seq}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one ledger row, got ${ledger.length}`);
  assert(ledger[0].guards.direct === true, `ledger row should be direct: ${JSON.stringify(ledger[0])}`);
  assert(ledger[0].cost.tokens_input !== undefined, `ledger row missing token usage: ${JSON.stringify(ledger[0])}`);

  const prompt = await readFile(`${paths.artifacts}/iter-1.prompt.txt`, 'utf8');
  assert(prompt.includes('Treat existing scripts under .opt as planner-provided validation artifacts'), 'executor prompt should treat .opt scripts as optional artifacts');
  assert(prompt.includes('Current GOAL.md:'), 'executor prompt missing GOAL.md');
  assert(prompt.includes('Current PLAN.md:'), 'executor prompt missing PLAN.md');
  assert(prompt.includes('Thinkless will not run git add or git commit for direct V1 execution'), 'executor prompt must keep commits executor-owned');

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('- [x] S1') || plan.includes('status:done'), `PLAN.md was not updated after direct execution:\n${plan}`);

  const status = await git(['status', '--short']);
  assert(!status.includes('src/') && !status.includes('test.mjs') && !status.includes('measure.mjs'), `executor-owned target files should not be left dirty:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        executed_without_opt_scripts: true,
        ignored_historical_baseline: true,
        events: events.length,
        ledger_rows: ledger.length
      },
      null,
      2
    )
  );
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
