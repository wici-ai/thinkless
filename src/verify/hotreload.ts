import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import { writeInjection } from '../supervisor/inbox.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';
import { ignoreFixturePlannerOpt } from './fixture-git.js';

const target = resolve('fixture/hotreload-target');
const safePointTarget = resolve('fixture/hotreload-safe-point-target');
const injectedText = 'Require the optimized implementation to keep the public uniqueSorted API unchanged.';
const steeringText = 'Prefer the smallest safe change after hot reload.';
const safePointInjectedText = 'Apply this requirement before evaluating the just-finished candidate.';

async function main(): Promise<void> {
  await verifyBetweenIterationsHotReload();
  await verifyEvaluateSafePointHotReload();
}

async function verifyBetweenIterationsHotReload(): Promise<void> {
  await createSampleTarget(target, true);
  await ignoreFixturePlannerOpt(target);
  const paths = runPaths(target);

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Improve the fixture implementation and accept chat steering', '--max-iters', '2', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        WICI_PAUSE_AFTER_EVENT: 'EXECUTE_DONE:5000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  await waitForEvent(paths.events, 'EXECUTE_DONE', 15_000);
  const injection = await writeInjection(paths, {
    kind: 'add_requirement',
    text: injectedText,
    priority: 'normal'
  });
  const steering = await writeInjection(paths, {
    kind: 'steer',
    text: steeringText,
    priority: 'normal'
  });

  const exit = await waitForExit(child, 20_000);
  assert(exit.code === 0, `supervisor exited with code=${exit.code} signal=${exit.signal}`);

  const goal = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  assert(goal.version === 2, `expected goal version 2, got ${goal.version}`);
  assert(goal.requirements.some((req) => req.text === injectedText && req.status === 'active'), 'injected requirement missing from internal goal state');
  assert(goal.constraints.some((constraint) => constraint.includes(steeringText)), 'steering text missing from internal goal constraints');
  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes(injectedText), 'GOAL.md missing injected requirement');
  assert(goalDoc.includes(`Steering: ${steeringText}`), 'GOAL.md missing persisted steering text');

  const checkpoint = JSON.parse(await readFile(paths.checkpoint, 'utf8')) as Checkpoint;
  assert(checkpoint.drained_inbox.includes(injection.id), `checkpoint did not record drained injection ${injection.id}`);
  assert(checkpoint.drained_inbox.includes(steering.id), `checkpoint did not record drained steering ${steering.id}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes(injectedText), 'PLAN.md does not contain injected requirement after follow-up revert/commit');

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'INJECTION_DRAINED'), 'missing INJECTION_DRAINED event');
  assert(events.some((event) => event.type === 'PLAN_DIFF_APPLIED'), 'missing PLAN_DIFF_APPLIED event');

  const secondPrompt = await readFile(`${paths.artifacts}/iter-2.prompt.txt`, 'utf8');
  assert(secondPrompt.includes(injectedText), 'injected steer text missing from next executor prompt');
  assert(secondPrompt.includes(steeringText), 'steering text missing from next executor prompt');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree is dirty after hot reload:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        case: 'between-iterations',
        target,
        goal_version: goal.version,
        drained: injection.id,
        steering_drained: steering.id,
        goal_doc_contains_steering: true,
        plan_contains_injection: true
      },
      null,
      2
    )
  );
}

async function verifyEvaluateSafePointHotReload(): Promise<void> {
  await createSampleTarget(safePointTarget, true);
  await ignoreFixturePlannerOpt(safePointTarget);
  const paths = runPaths(safePointTarget);

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', safePointTarget, '--goal', 'Drain chat steering before candidate evaluation', '--max-iters', '2', '--mode', 'stub'],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        WICI_PAUSE_AFTER_EVENT: 'EXECUTE_DONE:5000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  await waitForEvent(paths.events, 'EXECUTE_DONE', 15_000);
  const injection = await writeInjection(paths, {
    kind: 'add_requirement',
    text: safePointInjectedText,
    priority: 'normal'
  });

  const exit = await waitForExit(child, 25_000);
  assert(exit.code === 0, `safe-point supervisor exited with code=${exit.code} signal=${exit.signal}`);

  const goal = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  assert(goal.version === 2, `expected safe-point goal version 2, got ${goal.version}`);
  assert(goal.requirements.some((req) => req.text === safePointInjectedText && req.status === 'active'), 'safe-point injected requirement missing from internal goal state');

  const checkpoint = JSON.parse(await readFile(paths.checkpoint, 'utf8')) as Checkpoint;
  assert(checkpoint.drained_inbox.includes(injection.id), `safe-point checkpoint did not record drained injection ${injection.id}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const drainIndex = events.findIndex((event) => event.type === 'INJECTION_DRAINED');
  assert(drainIndex >= 0, 'missing direct safe-point INJECTION_DRAINED event');
  const secondExecute = events.findIndex((event, index) => index > drainIndex && event.type === 'EXECUTE_START');
  assert(secondExecute >= 0, 'missing next EXECUTE_START after direct hot reload');
  const earlySecondExecute = events.findIndex((event, index) => index < drainIndex && event.type === 'EXECUTE_START' && index > events.findIndex((item) => item.type === 'EXECUTE_DONE'));
  assert(earlySecondExecute === -1, 'next executor iteration started before draining direct hot reload');
  assert(events.some((event) => event.type === 'PLAN_DIFF_APPLIED'), 'missing direct PLAN_DIFF_APPLIED event');

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes(safePointInjectedText), 'safe-point PLAN.md does not contain injected requirement');
  const secondPrompt = await readFile(`${paths.artifacts}/iter-2.prompt.txt`, 'utf8');
  assert(secondPrompt.includes(safePointInjectedText), 'safe-point steer text missing from next executor prompt');

  const status = await gitFor(safePointTarget, ['status', '--short']);
  assert(status.trim() === '', `safe-point target worktree is dirty after hot reload:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        case: 'evaluate-safe-point',
        target: safePointTarget,
        drained: injection.id,
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
  return gitFor(target, args);
}

async function gitFor(root: string, args: string[]): Promise<string> {
  const result = await execa('git', ['-C', root, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
