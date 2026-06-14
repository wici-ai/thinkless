import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import { writeInjection } from '../supervisor/inbox.js';
import { readOutbox, writeOutbox } from '../supervisor/outbox.js';
import type { GoalFile, RunEvent } from '../shared/types.js';

const target = resolve('fixture/clarify-target');
const replyKey = 'q-public-api';
const answerText = 'Keep the exported function name and argument contract stable.';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await ensureRunDirs(paths);

  await writeOutbox(paths, {
    kind: 'question',
    text: 'Should the public API stay exactly the same?',
    replyKey
  });
  const injection = await writeInjection(paths, {
    kind: 'answer',
    text: answerText,
    reply_to: replyKey,
    priority: 'normal'
  });

  const result = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Process clarifying answer and optimize', '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(result.exitCode === 0, `clarify verifier supervisor run failed:\n${result.all}`);

  const goal = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  assert(goal.version === 2, `expected goal version 2 after answer, got ${goal.version}`);
  assert(goal.constraints.some((constraint) => constraint.includes(replyKey) && constraint.includes(answerText)), 'goal constraints missing clarifying answer');

  const outbox = await readOutbox(paths, 10);
  const answered = outbox.find((message) => message.reply_key === replyKey);
  assert(answered?.answered === true, `outbox question not marked answered: ${JSON.stringify(outbox)}`);
  assert(answered.answer_text === answerText, 'outbox answer text not recorded');

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes(`Answer to ${replyKey}: ${answerText}`), 'PLAN.md missing clarifying answer diff');

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'OUTBOX_ANSWERED'), 'missing OUTBOX_ANSWERED event');
  assert(events.some((event) => event.type === 'PLAN_DIFF_APPLIED'), 'missing PLAN_DIFF_APPLIED event');

  const checkpoint = JSON.parse(await readFile(paths.checkpoint, 'utf8')) as { drained_inbox: string[] };
  assert(checkpoint.drained_inbox.includes(injection.id), 'checkpoint did not record answer injection as drained');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree dirty after clarify run:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        answer_drained: injection.id,
        question_answered: true,
        goal_version: goal.version
      },
      null,
      2
    )
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
