import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { continuationFallbackState } from '../supervisor/continuation.js';
import { writeInjection } from '../supervisor/inbox.js';
import { runSupervisor } from '../supervisor/index.js';
import { readOutbox } from '../supervisor/outbox.js';

const target = resolve('fixture/continuation-escalation-target');

async function main(): Promise<void> {
  const originalThreshold = process.env.WICI_CONTINUATION_FALLBACK_THRESHOLD;
  process.env.WICI_CONTINUATION_FALLBACK_THRESHOLD = '2';
  try {
    verifyFallbackStateDeduplication();
    await createSampleTarget(target, true);
    const paths = runPaths(target);
    await writeExhaustedPlan(paths.plan);

    const first = await runSupervisor({
      target,
      goal: 'Keep deriving useful direct steps after the current markdown plan is exhausted, but escalate if the completion gate cannot evaluate.',
      maxIters: 5,
      mode: 'stub'
    });
    assert(first.state === 'STOP', `fallback escalation should stop, got ${JSON.stringify(first)}`);
    assert(first.reason.includes('Continuation gate fell back 2 consecutive time'), `unexpected escalation reason: ${first.reason}`);

    const messages = await readOutbox(paths, 20);
    const question = messages.find((message) => message.kind === 'question' && message.reply_key?.startsWith('continuation-stall-'));
    assert(question?.reply_key, `missing continuation-stall question: ${JSON.stringify(messages)}`);
    assert(question.text.includes('pausing instead of continuing'), `unexpected escalation question: ${question.text}`);
    assert(question.text.includes('Progress:') && question.text.includes('Bottleneck:') && question.text.includes('Possible next actions:'), `continuation question lacks decision context:\n${question.text}`);
    assert(question.text.includes('Ask a status question in Chat'), `continuation question must explain that status questions remain conversational:\n${question.text}`);
    const questionData = question.data as { recent_ledger?: unknown[]; pending_steps?: unknown[] } | undefined;
    assert(Array.isArray(questionData?.recent_ledger), `continuation question missing recent ledger data: ${JSON.stringify(question.data)}`);
    assert(Array.isArray(questionData?.pending_steps), `continuation question missing pending step data: ${JSON.stringify(question.data)}`);

    const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
    assert(checkpoint.supervisor_state === 'STOP', `checkpoint should stop after escalation: ${checkpoint.supervisor_state}`);
    assert(checkpoint.consecutive_continuation_fallbacks === 2, `fallback counter not persisted: ${JSON.stringify(checkpoint)}`);

    const events = await readJsonLines<RunEvent>(paths.events);
    assert(events.some((event) => event.type === 'CONTINUATION_ESCALATED'), 'missing CONTINUATION_ESCALATED event');
    assert(events.filter((event) => event.type === 'DIRECT_CONTINUATION_VERDICT' && event.message.includes('continue')).length >= 2, 'missing fallback verdict events');

    const ledgerBeforeWait = await readJsonLines<LedgerEntry>(paths.ledger);
    const waiting = await runSupervisor({ target, maxIters: 5, mode: 'stub' });
    assert(waiting.state === 'STOP' && waiting.reason === 'awaiting stop answer', `run should wait for continuation-stall answer: ${JSON.stringify(waiting)}`);
    const ledgerAfterWait = await readJsonLines<LedgerEntry>(paths.ledger);
    assert(ledgerAfterWait.length === ledgerBeforeWait.length, `waiting run unexpectedly advanced ledger: ${ledgerBeforeWait.length}->${ledgerAfterWait.length}`);

    const steer = await writeInjection(paths, {
      kind: 'steer',
      text: 'Resume with one concrete verification step and avoid duplicate busywork.',
      reply_to: question.reply_key,
      priority: 'normal'
    });
    const resumed = await runSupervisor({ target, maxIters: 2, mode: 'stub' });
    assert(resumed.state === 'STOP' && resumed.reason === 'Reached max_iters=2', `steer resume should continue to max_iters=2: ${JSON.stringify(resumed)}`);
    const afterResumeCheckpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
    assert(afterResumeCheckpoint.drained_inbox.includes(steer.id), `steer injection was not drained: ${JSON.stringify(afterResumeCheckpoint.drained_inbox)}`);
    assert((afterResumeCheckpoint.consecutive_continuation_fallbacks ?? 0) <= 1, `fallback counter should reset before resumed work: ${JSON.stringify(afterResumeCheckpoint)}`);
    const answered = (await readOutbox(paths, 20)).find((message) => message.id === question.id);
    assert(answered?.answered === true && answered.answer_text?.includes('steer:'), `continuation-stall question was not marked answered: ${JSON.stringify(answered)}`);
    const ledgerAfterResume = await readJsonLines<LedgerEntry>(paths.ledger);
    assert(ledgerAfterResume.length > ledgerAfterWait.length, `steer resume did not execute new work: ${ledgerAfterWait.length}->${ledgerAfterResume.length}`);
    const plan = await readFile(paths.plan, 'utf8');
    assert(plan.includes('Resume with one concrete verification step'), `resumed continuation did not add steer-driven work:\n${plan}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          continuation_escalated: true,
          repeated_state_counted_once: true,
          waits_without_input: true,
          steer_resumes: true,
          reply_key: question.reply_key
        },
        null,
        2
      )
    );
  } finally {
    if (originalThreshold === undefined) delete process.env.WICI_CONTINUATION_FALLBACK_THRESHOLD;
    else process.env.WICI_CONTINUATION_FALLBACK_THRESHOLD = originalThreshold;
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
