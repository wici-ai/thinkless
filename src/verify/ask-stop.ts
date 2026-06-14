import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson } from '../shared/atomic.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { GoalFile } from '../shared/types.js';
import { readOutbox } from '../supervisor/outbox.js';

const target = resolve('fixture/ask-stop-target');

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
  assert(messages.some((message) => message.kind === 'question' && message.text.includes('Stop candidate:')), `missing ask-mode question: ${JSON.stringify(messages)}`);
  assert(!messages.some((message) => message.kind === 'stop_verdict'), `ask-mode wrote stop_verdict instead of question: ${JSON.stringify(messages)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after ask stop:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        ask_mode_question_written: true,
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
