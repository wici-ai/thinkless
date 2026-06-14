import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import { writeInjection } from '../supervisor/inbox.js';
import type { Checkpoint, GoalFile, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/hotreload-target');
const injectedText = 'Require the optimized implementation to keep the public uniqueSorted API unchanged.';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Reduce p99 latency and accept chat steering', '--max-iters', '2', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        WICI_PAUSE_AFTER_EVENT: 'STOP_CHECK:5000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  await waitForEvent(paths.events, 'STOP_CHECK', 15_000);
  const injection = await writeInjection(paths, {
    kind: 'add_requirement',
    text: injectedText,
    priority: 'normal'
  });

  const exit = await waitForExit(child, 20_000);
  assert(exit.code === 0, `supervisor exited with code=${exit.code} signal=${exit.signal}`);

  const goal = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  assert(goal.version === 2, `expected goal version 2, got ${goal.version}`);
  assert(goal.requirements.some((req) => req.text === injectedText && req.status === 'active'), 'injected requirement missing from goal.json');

  const checkpoint = JSON.parse(await readFile(paths.checkpoint, 'utf8')) as Checkpoint;
  assert(checkpoint.drained_inbox.includes(injection.id), `checkpoint did not record drained injection ${injection.id}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes(injectedText), 'PLAN.md does not contain injected requirement after follow-up revert/commit');

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'INJECTION_DRAINED'), 'missing INJECTION_DRAINED event');
  assert(events.some((event) => event.type === 'PLAN_DIFF_APPLIED'), 'missing PLAN_DIFF_APPLIED event');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 2, `expected two ledger rows after two iterations, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected first row keep, got ${ledger[0].status}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree is dirty after hot reload:\n${status}`);

  const replanCommits = await git(['log', '--oneline', '--grep', 'chore: apply WiCi goal v2 plan update']);
  assert(replanCommits.trim().length > 0, 'missing chore commit for goal v2 plan update');

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        goal_version: goal.version,
        drained: injection.id,
        ledger_rows: ledger.length,
        plan_contains_injection: true
      },
      null,
      2
    )
  );
}

async function waitForEvent(path: string, type: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await readJsonLines<RunEvent>(path).catch(() => []);
    if (events.some((event) => event.type === type)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for event ${type}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs).then(() => {
      child.kill('SIGKILL');
      throw new Error(`Timed out waiting for supervisor exit after ${timeoutMs}ms`);
    })
  ]);
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
