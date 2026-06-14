import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSampleTarget } from '../sample.js';
import { exists } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { RunState } from '../tui/useRunState.js';
import { shouldAcceptInitialGoalFromChat } from '../tui/App.js';
import { isInitialGoalText } from '../tui/ChatPane.js';

const target = resolve('fixture/tui-chat-intake-target');

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
  assert(isInitialGoalText('听说diffussionGemma很快，要求达到700token/s以上'), 'natural-language chat should be accepted as initial goal');
  assert(!isInitialGoalText('/steer keep going'), 'slash commands must not be treated as initial goals');

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        fresh_tui_writes_no_goal_files: true,
        chat_routes_to_initial_goal_when_blank: true,
        slash_commands_not_initial_goal: true
      },
      null,
      2
    )
  );
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
    outbox: []
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
