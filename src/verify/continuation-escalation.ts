import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, RunEvent } from '../shared/types.js';
import { continuationFallbackState } from '../supervisor/continuation.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/continuation-escalation-target');

async function main(): Promise<void> {
  const originalThreshold = process.env.WICI_CONTINUATION_FALLBACK_THRESHOLD;
  const originalDedupThreshold = process.env.WICI_STEP_DEDUP_CONSECUTIVE;
  process.env.WICI_CONTINUATION_FALLBACK_THRESHOLD = '2';
  process.env.WICI_STEP_DEDUP_CONSECUTIVE = '99';
  try {
    verifyFallbackStateDeduplication();
    await createSampleTarget(target, true);
    const paths = runPaths(target);
    await writeExhaustedPlan(paths.plan);

    const first = await runSupervisor({
      target,
      goal: 'Keep deriving useful direct steps after the current markdown plan is exhausted; fallback completion verdicts must not preempt planner recovery.',
      maxIters: 3,
      mode: 'stub'
    });
    assert(first.state === 'STOP' && first.reason === 'Reached max_iters=3', `fallback recovery should continue until the explicit iteration bound: ${JSON.stringify(first)}`);

    const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
    assert(checkpoint.supervisor_state === 'STOP', `checkpoint should stop only at max_iters: ${checkpoint.supervisor_state}`);
    assert((checkpoint.consecutive_continuation_fallbacks ?? 0) >= 2, `fallback counter not persisted across distinct recovery states: ${JSON.stringify(checkpoint)}`);

    const events = await readJsonLines<RunEvent>(paths.events);
    assert(events.some((event) => event.type === 'CONTINUATION_FALLBACK_RECOVERY'), 'missing CONTINUATION_FALLBACK_RECOVERY event');
    assert(!events.some((event) => event.type === 'CONTINUATION_ESCALATED'), 'fallback verdict alone must not escalate to human STOP');
    assert(events.filter((event) => event.type === 'DIRECT_CONTINUATION_VERDICT' && event.message.includes('continue')).length >= 2, 'missing fallback verdict events');
    assert(events.filter((event) => event.type === 'EXECUTE_START').length === 3, 'planner fallback recovery must execute through the explicit iteration bound');
    const plan = await readFile(paths.plan, 'utf8');
    assert(plan.includes('status:done iter:3'), `planner recovery did not continue producing executable work through the explicit bound:\n${plan}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          fallback_recovery_continues: true,
          repeated_state_counted_once: true,
          human_stop_not_preemptive: true
        },
        null,
        2
      )
    );
  } finally {
    if (originalThreshold === undefined) delete process.env.WICI_CONTINUATION_FALLBACK_THRESHOLD;
    else process.env.WICI_CONTINUATION_FALLBACK_THRESHOLD = originalThreshold;
    if (originalDedupThreshold === undefined) delete process.env.WICI_STEP_DEDUP_CONSECUTIVE;
    else process.env.WICI_STEP_DEDUP_CONSECUTIVE = originalDedupThreshold;
    await rm(target, { recursive: true, force: true });
  }
}

function verifyFallbackStateDeduplication(): void {
  const initial = continuationFallbackState(
    { ledger_seq: 22, plan_hash: 'same-plan', consecutive_continuation_fallbacks: 1 },
    'fallback'
  );
  assert(initial.count === 2 && initial.counted, `new fallback state should increment once: ${JSON.stringify(initial)}`);

  const repeated = continuationFallbackState(
    {
      ledger_seq: 22,
      plan_hash: 'same-plan',
      consecutive_continuation_fallbacks: initial.count,
      last_continuation_fallback_state_key: initial.stateKey
    },
    'fallback'
  );
  assert(repeated.count === 2 && !repeated.counted, `same ledger/plan state must not increment after resume: ${JSON.stringify(repeated)}`);

  const advanced = continuationFallbackState(
    {
      ledger_seq: 23,
      plan_hash: 'new-plan',
      consecutive_continuation_fallbacks: repeated.count,
      last_continuation_fallback_state_key: repeated.stateKey
    },
    'fallback'
  );
  assert(advanced.count === 3 && advanced.counted, `changed ledger/plan state should count as real progress boundary: ${JSON.stringify(advanced)}`);

  const recovered = continuationFallbackState(
    {
      ledger_seq: 23,
      plan_hash: 'new-plan',
      consecutive_continuation_fallbacks: advanced.count,
      last_continuation_fallback_state_key: advanced.stateKey
    },
    'llm'
  );
  assert(recovered.count === 0 && recovered.stateKey === undefined, `non-fallback verdict should reset the fallback streak: ${JSON.stringify(recovered)}`);
}

async function writeExhaustedPlan(path: string): Promise<void> {
  await writeFile(
    path,
    [
      '# PLAN',
      '',
      '- [x] S1 Completed setup work <!-- status:done iter:1 -->',
      '  - Action: already complete.',
      '  - Validation: already complete.',
      ''
    ].join('\n')
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
