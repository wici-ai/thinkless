import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists } from '../shared/atomic.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import { writeInjection } from '../supervisor/inbox.js';
import { readOutbox } from '../supervisor/outbox.js';
import type { BaselineFile, Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/manual-lock-target');
const prematureTarget = resolve('fixture/manual-lock-preapprove-target');
process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  const approved = await runApprovedScenario(target);
  const premature = await runPrematureApprovalScenario(prematureTarget);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        question: approved.questionId,
        answer_drained: approved.answerDrained,
        baseline_pinned: true,
        ledger_rows: approved.ledgerRows,
        premature_approval_ignored: premature.ignored
      },
      null,
      2
    )
  );
}

async function runApprovedScenario(targetPath: string): Promise<{ questionId: string; answerDrained: string; ledgerRows: number }> {
  await createSampleTarget(targetPath, true);
  const paths = runPaths(targetPath);

  const first = await execa(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli.tsx',
      'run',
      '--target',
      targetPath,
      '--goal',
      'Require manual eval review before optimizing',
      '--max-iters',
      '1',
      '--mode',
      'stub',
      '--lock-mode',
      'manual'
    ],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(first.exitCode === 0, `manual-lock first run failed:\n${first.all}`);
  assert((first.all ?? '').includes('awaiting eval lock approval'), `first run did not stop for eval lock:\n${first.all}`);
  assert(await exists(paths.plan), 'PLAN.md was not materialized for review');
  assert(await exists(paths.measure), 'measure.sh was not materialized for review');
  assert(await exists(paths.checks), 'checks.sh was not materialized for review');
  assert(!(await exists(paths.baseline)), 'baseline initialized before manual approval');

  const questions = await readOutbox(paths, 10);
  const lockQuestion = questions.find((message) => message.reply_key === 'lock-eval' && message.kind === 'question');
  assert(lockQuestion, `missing lock-eval outbox question: ${JSON.stringify(questions)}`);
  assert(lockQuestion.answered === false, 'lock-eval question was already answered before approval');

  await ensureRunDirs(paths);
  const injection = await writeInjection(paths, {
    kind: 'answer',
    text: 'approved',
    reply_to: 'lock-eval',
    priority: 'normal'
  });

  const second = await execa(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli.tsx',
      'run',
      '--target',
      targetPath,
      '--goal',
      'Require manual eval review before optimizing',
      '--max-iters',
      '1',
      '--mode',
      'stub',
      '--lock-mode',
      'manual'
    ],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
  );
  assert(second.exitCode === 0, `manual-lock second run failed:\n${second.all}`);

  const baseline = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(Boolean(baseline.eval_sha256.measure), 'baseline missing measure hash');
  assert(Boolean(baseline.eval_sha256.checks), 'baseline missing checks hash');

  const answered = (await readOutbox(paths, 10)).find((message) => message.reply_key === 'lock-eval');
  assert(answered?.answered === true, `lock-eval question was not marked answered: ${JSON.stringify(answered)}`);
  assert(answered.answer_text === 'approved', 'lock-eval answer text not recorded');

  const checkpoint = JSON.parse(await readFile(paths.checkpoint, 'utf8')) as Checkpoint;
  assert(checkpoint.drained_inbox.includes(injection.id), 'checkpoint did not record eval lock answer as drained');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one ledger row after approved run, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected keep after approved run, got ${ledger[0].status}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'EVAL_LOCK_REQUIRED'), 'missing EVAL_LOCK_REQUIRED event');
  assert(events.some((event) => event.type === 'OUTBOX_ANSWERED'), 'missing OUTBOX_ANSWERED event');

  const status = await git(['status', '--short'], targetPath);
  assert(status.trim() === '', `target worktree dirty after approved manual-lock run:\n${status}`);

  return { questionId: lockQuestion.id, answerDrained: injection.id, ledgerRows: ledger.length };
}

async function runPrematureApprovalScenario(targetPath: string): Promise<{ ignored: boolean }> {
  await createSampleTarget(targetPath, true);
  const paths = runPaths(targetPath);
  await ensureRunDirs(paths);
  const stale = await writeInjection(paths, {
    kind: 'answer',
    text: 'approved',
    reply_to: 'lock-eval',
    priority: 'normal'
  });

  const first = await runManual(targetPath);
  assert(first.exitCode === 0, `premature approval first run failed:\n${first.all}`);
  assert(!(await exists(paths.baseline)), 'premature approval initialized baseline before review question existed');

  const second = await runManual(targetPath);
  assert(second.exitCode === 0, `premature approval second run failed:\n${second.all}`);
  assert(!(await exists(paths.baseline)), 'stale eval approval initialized baseline');

  const checkpoint = JSON.parse(await readFile(paths.checkpoint, 'utf8')) as Checkpoint;
  assert(checkpoint.drained_inbox.includes(stale.id), 'stale eval approval was not drained and recorded');
  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'EVAL_LOCK_ANSWER_IGNORED'), 'missing stale eval approval ignored event');

  await writeInjection(paths, {
    kind: 'answer',
    text: 'approved',
    reply_to: 'lock-eval',
    priority: 'normal'
  });
  const third = await runManual(targetPath);
  assert(third.exitCode === 0, `fresh approval run failed:\n${third.all}`);
  assert(await exists(paths.baseline), 'fresh eval approval did not initialize baseline');
  const status = await git(['status', '--short'], targetPath);
  assert(status.trim() === '', `premature target worktree dirty after fresh approval:\n${status}`);
  return { ignored: true };
}

async function runManual(targetPath: string) {
  return execa(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli.tsx',
      'run',
      '--target',
      targetPath,
      '--goal',
      'Require manual eval review before optimizing',
      '--max-iters',
      '1',
      '--mode',
      'stub',
      '--lock-mode',
      'manual'
    ],
    {
      cwd: resolve('.'),
      all: true,
      reject: false,
      timeout: 30_000
    }
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

async function git(args: string[], targetPath = target): Promise<string> {
  const result = await execa('git', ['-C', targetPath, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
