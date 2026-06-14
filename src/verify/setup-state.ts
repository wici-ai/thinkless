import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, RunEvent } from '../shared/types.js';

const planTarget = resolve('fixture/setup-state-plan-target');
const measureTarget = resolve('fixture/setup-state-measure-target');

async function main(): Promise<void> {
  const plan = await verifyPausedSetupState({
    target: planTarget,
    pauseAfter: 'PLAN_START',
    expectedState: 'PLAN'
  });
  const measure = await verifyPausedSetupState({
    target: measureTarget,
    pauseAfter: 'BASELINE_START',
    expectedState: 'MEASURE',
    assertCheckpoint: (checkpoint) => {
      assert(checkpoint.sessions.planner === 'stub-planner', `checkpoint did not preserve initial planner session: ${JSON.stringify(checkpoint.sessions)}`);
      assert(typeof checkpoint.plan_hash === 'string' && checkpoint.plan_hash.length > 0, `checkpoint missing plan hash before baseline: ${checkpoint.plan_hash}`);
    }
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        plan_state: plan.supervisor_state,
        measure_state: measure.supervisor_state,
        planner_session: measure.sessions.planner
      },
      null,
      2
    )
  );
}

async function verifyPausedSetupState(input: {
  target: string;
  pauseAfter: 'PLAN_START' | 'BASELINE_START';
  expectedState: Checkpoint['supervisor_state'];
  assertCheckpoint?: (checkpoint: Checkpoint) => void;
}): Promise<Checkpoint> {
  await createSampleTarget(input.target, true);
  const paths = runPaths(input.target);
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli.tsx',
      'run',
      '--target',
      input.target,
      '--goal',
      `Verify durable setup state at ${input.pauseAfter}`,
      '--max-iters',
      '1',
      '--mode',
      'stub'
    ],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        WICI_PAUSE_AFTER_EVENT: `${input.pauseAfter}:5000`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  try {
    await waitForEvent(paths.events, input.pauseAfter, 15_000);
    const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
    assert(
      checkpoint.supervisor_state === input.expectedState,
      `expected checkpoint ${input.expectedState} during ${input.pauseAfter}, got ${checkpoint.supervisor_state}`
    );
    assert(checkpoint.goal_version === 1, `expected setup checkpoint goal_version=1, got ${checkpoint.goal_version}`);
    input.assertCheckpoint?.(checkpoint);
    return checkpoint;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nchild output:\n${output}`);
  } finally {
    await stopChild(child);
  }
}

async function waitForEvent(path: string, type: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await readJsonLines<RunEvent>(path).catch(() => []);
    if (events.some((event) => event.type === type)) return;
    await delay(100);
  }
  const raw = await readFile(path, 'utf8').catch(() => '');
  throw new Error(`Timed out waiting for event ${type}; events:\n${raw}`);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
