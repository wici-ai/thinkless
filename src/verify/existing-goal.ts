import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, LedgerEntry } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/existing-goal-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  const goalText = 'Continue this existing markdown goal later without passing a new --goal.';

  const setup = await runSupervisor({
    target,
    goal: goalText,
    goalSource: 'cli_goal',
    maxIters: 0,
    mode: 'stub'
  });
  assert(setup.state === 'STOP', `setup run should stop cleanly, got ${JSON.stringify(setup)}`);
  assert(setup.reason === 'Reached max_iters=0', `setup run should only materialize the goal and plan, got ${setup.reason}`);

  const goalBefore = await readJsonFile<GoalFile>(paths.goal);
  const goalDocBefore = await readFile(paths.goalDoc, 'utf8');
  const planBefore = await readFile(paths.plan, 'utf8');
  assert(goalDocBefore.includes(goalText), 'GOAL.md should preserve the original goal before continuation');
  assert(planBefore.includes('S1'), 'PLAN.md should contain a pending executable step before continuation');

  const continued = await runSupervisor({
    target,
    maxIters: 1,
    mode: 'stub'
  });
  assert(continued.state === 'STOP', `continuation without --goal should stop cleanly, got ${JSON.stringify(continued)}`);
  assert(continued.reason === 'Reached max_iters=1', `unexpected continuation stop reason: ${continued.reason}`);

  const goalAfter = await readJsonFile<GoalFile>(paths.goal);
  assert(goalAfter.run_id === goalBefore.run_id, 'continuation without --goal should reuse the existing goal run_id');
  assert(goalAfter.requirements.some((req) => req.text === goalText), 'continuation without --goal lost the original requirement');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.goal_source === 'cli_goal', `continuation should preserve original goal_source, got ${checkpoint.goal_source}`);
  assert(checkpoint.ledger_seq === 1, `continuation should record one ledger row, got ${checkpoint.ledger_seq}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one ledger row after continuation, got ${ledger.length}`);
  assert(ledger[0].guards.direct === true, `continuation ledger row should be direct: ${JSON.stringify(ledger[0])}`);

  const prompt = await readFile(`${paths.artifacts}/iter-1.prompt.txt`, 'utf8');
  assert(prompt.includes('Current GOAL.md:'), 'continuation executor prompt missing GOAL.md');
  assert(prompt.includes(goalText), 'continuation executor prompt did not include the existing goal text');
  assert(prompt.includes('Current PLAN.md:'), 'continuation executor prompt missing PLAN.md');

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        continued_without_new_goal: true,
        reused_goal_run_id: true,
        ledger_rows: ledger.length,
        goal_source: checkpoint.goal_source
      },
      null,
      2
    )
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
