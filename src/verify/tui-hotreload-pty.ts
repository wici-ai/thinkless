import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/tui-hotreload-pty-target');
const firstChat = 'Improve the fixture implementation from a PTY Chat-first TUI run.';
const followupChat = 'Also require PTY hot reload to preserve the public uniqueSorted API.';

async function main(): Promise<void> {
  await requireExpect();
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  assert(!(await exists(paths.goalDoc)), 'fresh PTY hot-reload target should start without GOAL.md');

  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      WICI_NODE: process.execPath,
      WICI_PAUSE_AFTER_EVENT: 'EXECUTE_DONE:5000',
      WICI_PTY_CHAT: firstChat,
      WICI_PTY_FOLLOWUP: followupChat,
      WICI_PTY_TARGET: target
    },
    reject: false,
    all: true,
    timeout: 70_000,
    maxBuffer: 1024 * 1024 * 5
  });
  assert(result.exitCode === 0 || result.exitCode === 143, `PTY hot-reload run failed with code ${result.exitCode}:\n${stripAnsi(result.all ?? '')}`);

  const goal = await readJsonFile<GoalFile>(paths.goal);
  assert(goal.requirements.some((req) => req.source === 'initial' && req.text.includes(firstChat)), 'goal should contain initial PTY Chat requirement');
  assert(goal.requirements.some((req) => req.source === 'chat' && req.text === followupChat), 'goal should contain follow-up PTY Chat requirement');
  assert(goal.version >= 2, `follow-up Chat should bump goal version, got ${goal.version}`);

  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes(firstChat), 'GOAL.md should contain initial PTY Chat input');
  assert(goalDoc.includes(followupChat), 'GOAL.md should contain follow-up PTY Chat input');

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes(followupChat), 'PLAN.md should contain follow-up PTY Chat requirement after plan diff');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.goal_source === 'tui_chat', `initial provenance should remain tui_chat, got ${checkpoint.goal_source}`);
  assert(checkpoint.drained_inbox.length >= 1, 'follow-up Chat injection should be drained into checkpoint');
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP after two PTY iterations, got ${checkpoint.supervisor_state}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const firstExecuteDone = events.findIndex((event) => event.type === 'EXECUTE_DONE');
  const injectionDrained = events.findIndex((event) => event.type === 'INJECTION_DRAINED');
  const planDiff = events.findIndex((event) => event.type === 'PLAN_DIFF_APPLIED');
  const secondExecuteStart = events.findIndex((event, index) => index > planDiff && event.type === 'EXECUTE_START');
  assert(firstExecuteDone >= 0, 'events should include first EXECUTE_DONE before PTY follow-up');
  assert(injectionDrained > firstExecuteDone, 'follow-up Chat should drain after first execution completes');
  assert(planDiff > injectionDrained, 'PLAN_DIFF_APPLIED should follow PTY Chat drain');
  assert(secondExecuteStart > planDiff, 'next executor iteration should start after PTY hot reload plan diff');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 2, `expected two PTY hot-reload ledger rows, got ${ledger.length}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `PTY hot-reload target worktree should be clean:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        pty_hot_reload: true,
        goal_source: checkpoint.goal_source,
        goal_version: goal.version,
        events: events.length,
        ledger_rows: ledger.length
      },
      null,
      2
    )
  );
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-hotreload-pty requires expect on PATH');
}

function expectScript(): string {
  return `
log_user 0
set timeout 55
spawn "$env(WICI_NODE)" --import tsx src/cli.tsx tui --target "$env(WICI_PTY_TARGET)" --max-iters 2 --mode stub --no-fullscreen
expect "CHAT"
sleep 1
send -- "$env(WICI_PTY_CHAT)\\r"
expect "EXECUTE_DONE"
sleep 1
send -- "$env(WICI_PTY_FOLLOWUP)\\r"
expect {
  "PLAN_DIFF_APPLIED" {
    exp_continue
  }
  "Reached max_iters=2" {
    exit 0
  }
  timeout {
    exit 2
  }
  eof {
    exit 3
  }
}
`;
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
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
