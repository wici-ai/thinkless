import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, LedgerEntry, RunEvent } from '../shared/types.js';
import { writeInjection } from '../supervisor/inbox.js';
import { readOutbox } from '../supervisor/outbox.js';

const target = resolve('fixture/ask-stop-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await ensureRunDirs(paths);
  await atomicWriteJson(paths.goal, askGoal());

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--max-iters', '3', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `ask-stop supervisor run failed:\n${result.all}`);

  const messages = await readOutbox(paths, 10);
  const question = messages.find((message) => message.kind === 'question' && message.text.includes('Stop candidate:'));
  assert(question?.reply_key, `missing ask-mode question: ${JSON.stringify(messages)}`);
  assert(!messages.some((message) => message.kind === 'stop_verdict'), `ask-mode wrote stop_verdict instead of question: ${JSON.stringify(messages)}`);
  const ledgerBeforeWait = await readJsonLines<LedgerEntry>(paths.ledger);

  const waiting = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--max-iters', '3', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(waiting.exitCode === 0, `ask-stop wait run failed:\n${waiting.all}`);
  assert((waiting.all ?? '').includes('awaiting stop answer'), `ask-stop did not remain paused without new input:\n${waiting.all}`);
  const ledgerAfterWait = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledgerAfterWait.length === ledgerBeforeWait.length, `ask-stop wait unexpectedly advanced ledger: ${ledgerBeforeWait.length}->${ledgerAfterWait.length}`);

  const answer = await writeInjection(paths, { kind: 'answer', text: 'continue', reply_to: question.reply_key, priority: 'normal' });
  const resumed = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--max-iters', '3', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(resumed.exitCode === 0, `ask-stop resume run failed:\n${resumed.all}`);
  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.drained_inbox.includes(answer.id), `resume answer was not drained: ${JSON.stringify(checkpoint.drained_inbox)}`);
  const answered = (await readOutbox(paths, 20)).find((message) => message.id === question.id);
  assert(answered?.answered === true && answered.answer_text?.includes('continue'), `stop question was not marked answered: ${JSON.stringify(answered)}`);
  const ledgerAfterResume = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledgerAfterResume.length > ledgerAfterWait.length, `ask-stop resume did not continue execution: ${ledgerAfterWait.length}->${ledgerAfterResume.length}`);
  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'OUTBOX_ANSWERED' && event.message.includes('Resuming from stop question')), 'resume event missing OUTBOX_ANSWERED marker');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after ask stop:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        ask_mode_question_written: true,
        ask_mode_waits_without_input: true,
        ask_mode_resumes_after_continue: true,
        outbox_messages: messages.length
      },
      null,
      2
    )
  );
}

function askGoal(): GoalFile {
  return {
    run_id: `ask-stop-${Date.now()}`,
    version: 1,
    requirements: [{ id: 'R1', text: 'Reduce p99 latency then ask before stopping', source: 'initial', status: 'active' }],
    acceptance_criteria: [
      { id: 'A1', text: 'checks pass', check: './.opt/checks.sh' },
      { id: 'A2', text: 'measure emits metric', check: './.opt/measure.sh' }
    ],
    constraints: ['ask before cost-benefit stop'],
    metric: { name: 'p99 latency', direction: 'minimize', target: 1000, unit: 'ms' },
    budget: { max_iters: 3, max_cost_usd: 50, deadline: null },
    stop: { tau: 999, K: 1, N: 1, mode: 'ask' }
  };
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
