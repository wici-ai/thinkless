import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/direct-plan-continuation-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await writeFile(
    paths.plan,
    [
      '# PLAN',
      '',
      '- [x] S1 Completed setup work <!-- status:done iter:1 -->',
      '  - Action: already complete.',
      '  - Validation: already complete.',
      ''
    ].join('\n')
  );

  const result = await runSupervisor({
    target,
    goal: 'Keep deriving useful direct steps after the current markdown plan is exhausted.',
    maxIters: 1,
    mode: 'stub'
  });

  assert(result.state === 'STOP', `expected hard limit stop after one continued iteration: ${JSON.stringify(result)}`);
  assert(result.reason === 'Reached max_iters=1', `direct run should stop only at max_iters, got ${result.reason}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'PLAN_EXHAUSTED'), 'missing PLAN_EXHAUSTED event');
  assert(events.some((event) => event.type === 'PLAN_CONTINUATION_APPLIED'), 'missing PLAN_CONTINUATION_APPLIED event');
  assert(events.some((event) => event.type === 'EXECUTE_START' && event.message.includes('S2')), 'continued direct run did not execute the planner-added step');
  assert(!events.some((event) => event.type === 'STOP' && event.message === 'PLAN.md has no pending executable steps.'), 'direct run stopped merely because PLAN.md was exhausted');

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('S2'), `planner continuation did not add S2:\n${plan}`);
  assert(plan.includes('- [x] S2') || plan.includes('S2') && plan.includes('status:done'), `continued step was not completed:\n${plan}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1 && ledger[0].step_id === 'S2', `expected one ledger row for continued S2: ${JSON.stringify(ledger)}`);

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP after max_iters, got ${checkpoint.supervisor_state}`);

  console.log(JSON.stringify({ ok: true, exhausted_plan_replanned: true, continued_step: 'S2' }, null, 2));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  await main();
} finally {
  await rm(target, { recursive: true, force: true });
}
