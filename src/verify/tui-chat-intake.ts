import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSampleTarget } from '../sample.js';
import { exists } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { GoalFile, Checkpoint } from '../shared/types.js';
import type { RunState } from '../tui/useRunState.js';
import { shouldAcceptInitialGoalFromChat, shouldAutoStartExistingRun } from '../tui/App.js';
import { isInitialGoalText } from '../tui/ChatPane.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/tui-chat-intake-target');
const provenanceTarget = resolve('fixture/tui-chat-intake-provenance-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'tui', '--target', target, '--max-iters', '1', '--mode', 'stub', '--no-fullscreen'],
    {
      cwd: resolve('.'),
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'xterm-256color' },
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

  await delay(900);
  await stopChild(child);

  assert(!(await exists(paths.goal)), 'fresh TUI without chat must not write .wici/goal.json');
  assert(!(await exists(paths.goalDoc)), 'fresh TUI without chat must not write GOAL.md');
  assert(!(await exists(paths.plan)), 'fresh TUI without chat must not write PLAN.md');
  assert(!(await exists(paths.checkpoint)), 'fresh TUI without chat must not write checkpoint.json');
  assert(!(await exists(paths.events)), 'fresh TUI without chat must not write events.jsonl');

  const ui = stripAnsi(output);
  assert(!ui.includes('waiting for events'), `empty ExecPane should not render fake waiting text:\n${ui}`);
  assert(!ui.includes('Reduce p99 latency while preserving correctness'), 'TUI must not seed the old default goal before chat input');

  const blank = blankState(target);
  assert(
    shouldAcceptInitialGoalFromChat({ supervisorEnabled: true, supervisorStarted: false, state: blank }),
    'fresh supervisor-enabled TUI should route chat to initial goal'
  );
  assert(
    !shouldAcceptInitialGoalFromChat({ supervisorEnabled: true, supervisorStarted: true, state: blank }),
    'started supervisor must route chat to inbox, not initial goal'
  );
  assert(
    !shouldAcceptInitialGoalFromChat({ supervisorEnabled: false, supervisorStarted: false, state: blank }),
    'read-only TUI must not launch from chat'
  );
  assert(
    !shouldAcceptInitialGoalFromChat({ supervisorEnabled: true, supervisorStarted: false, state: { ...blank, goalDoc: '# GOAL\n' } }),
    'existing run blackboard must not treat chat as initial goal'
  );
  assert(
    shouldAcceptInitialGoalFromChat({
      supervisorEnabled: true,
      supervisorStarted: false,
      state: {
        ...blank,
        baseline: {
          best_commit: '0000000000000000000000000000000000000000',
          best_metric: { p50: 1, p95: 1, p99: 1, unit: 'legacy', n: 1 },
          eval_sha256: { measure: 'legacy', checks: 'legacy' },
          plan_hash: 'legacy',
          created_at: '2026-06-14T00:00:00.000Z',
          updated_at: '2026-06-14T00:00:00.000Z'
        }
      }
    }),
    'a historical baseline.json alone must not block fresh Chat-first intake'
  );
  assert(shouldAutoStartExistingRun({ ...blank, goal: goal() }), 'existing goal without a STOP checkpoint should auto-start');
  assert(!shouldAutoStartExistingRun({ ...blank, goal: goal(), checkpoint: checkpoint('STOP') }), 'stopped run should not auto-restart without new chat');
  assert(!shouldAutoStartExistingRun({ ...blank, goal: goal(), checkpoint: checkpoint('FAILED') }), 'failed run should not auto-restart without new chat');
  assert(shouldAutoStartExistingRun({ ...blank, goal: goal(), checkpoint: checkpoint('PLAN') }), 'active plan state should auto-start on TUI attach');
  assert(isInitialGoalText('听说diffussionGemma很快，要求达到700token/s以上'), 'natural-language chat should be accepted as initial goal');
  assert(!isInitialGoalText('/steer keep going'), 'slash commands must not be treated as initial goals');
  await verifyGoalSourceNotRetroactive();

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        fresh_tui_writes_no_goal_files: true,
        chat_routes_to_initial_goal_when_blank: true,
        historical_baseline_does_not_block_chat: true,
        goal_source_not_retroactive: true,
        slash_commands_not_initial_goal: true
      },
      null,
      2
    )
  );
}

async function verifyGoalSourceNotRetroactive(): Promise<void> {
  await createSampleTarget(provenanceTarget, true);
  const first = await runSupervisor({
    target: provenanceTarget,
    goal: 'Original goal created from the first Chat message.',
    goalSource: 'tui_chat',
    maxIters: 0,
    mode: 'stub'
  });
  assert(first.state === 'STOP', `initial provenance run should stop cleanly: ${JSON.stringify(first)}`);
  const paths = runPaths(provenanceTarget);
  const checkpointPath = paths.checkpoint;
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as Checkpoint;
  assert(checkpoint.goal_source === 'tui_chat', `initial goal source should be tui_chat, got ${checkpoint.goal_source}`);
  delete checkpoint.goal_source;
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

  const second = await runSupervisor({
    target: provenanceTarget,
    goal: 'This later CLI goal must not rewrite provenance for the existing run.',
    goalSource: 'cli_goal',
    maxIters: 0,
    mode: 'stub'
  });
  assert(second.state === 'STOP', `retroactive provenance run should stop cleanly: ${JSON.stringify(second)}`);
  const after = JSON.parse(await readFile(checkpointPath, 'utf8')) as Checkpoint;
  assert(after.goal_source === undefined, `existing run goal_source should not be written retroactively, got ${after.goal_source}`);
}

function blankState(root: string): RunState {
  return {
    target: root,
    goal: null,
    checkpoint: null,
    baseline: null,
    ledger: [],
    goalDoc: '',
    plan: '',
    events: [],
    outbox: [],
    injections: [],
    chat: []
  };
}

function goal(): GoalFile {
  return {
    run_id: 'tui-chat-intake',
    version: 1,
    requirements: [{ id: 'R1', text: 'test', source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'planner-selected validation', direction: 'maximize', target: null, unit: 'score' },
    budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
    stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' }
  };
}

function checkpoint(supervisor_state: Checkpoint['supervisor_state']): Checkpoint {
  return {
    supervisor_state,
    next_step: null,
    iter: 0,
    goal_version: 1,
    plan_hash: null,
    ledger_seq: 0,
    events_seq: 0,
    sessions: {},
    drained_inbox: [],
    updated_at: '2026-06-14T00:00:00.000Z'
  };
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    delay(1000).then(() => false)
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[=>]/g, '');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
