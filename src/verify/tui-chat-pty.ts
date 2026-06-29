import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { requireExpectOrSkip } from './expect.js';

const target = resolve('fixture/tui-chat-pty-target');
const firstChat = 'Build a tiny verified CLI from a real PTY Chat-first TUI input';

async function main(): Promise<void> {
  await requireExpect();
  await createSampleTarget(target, true);
  const paths = runPaths(target);

  assert(!(await exists(paths.goalDoc)), 'fresh PTY target should start without GOAL.md');
  assert(!(await exists(paths.plan)), 'fresh PTY target should start without PLAN.md');
  assert(!(await exists(paths.checkpoint)), 'fresh PTY target should start without checkpoint.json');

  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      WICI_PTY_CHAT: firstChat,
      WICI_PTY_TARGET: target
    },
    reject: false,
    all: true,
    timeout: 45_000,
    maxBuffer: 1024 * 1024 * 5
  });
  assert(result.exitCode === 0, `PTY Chat-first TUI run failed with code ${result.exitCode}:\n${stripAnsi(result.all ?? '')}`);

  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes(firstChat), 'GOAL.md should contain the first PTY Chat input');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.goal_source === 'tui_chat', `PTY Chat-first run should record goal_source=tui_chat, got ${checkpoint.goal_source}`);
  assert(checkpoint.supervisor_state === 'STOP', `expected PTY Chat-first run to stop cleanly, got ${checkpoint.supervisor_state}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'SUPERVISOR_START' && (event.data as { goal_source?: string } | undefined)?.goal_source === 'tui_chat'), 'SUPERVISOR_START should report tui_chat goal source');
  assert(events.some((event) => event.type === 'PLAN_DONE'), 'PTY Chat-first run should materialize PLAN.md');
  assert(events.some((event) => event.type === 'EXECUTE_PROGRESS' || event.type === 'EXECUTE_DONE'), 'PTY Chat-first run should reach Codex execution stream');
  assert(events.some((event) => event.type === 'EXECUTE_DONE' && (event.data as { mode?: string } | undefined)?.mode === 'direct'), 'PTY Chat-first run should complete direct PLAN execution');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one PTY Chat-first ledger receipt, got ${ledger.length}`);
  assert(ledger[0].status === 'keep', `expected PTY Chat-first receipt status keep, got ${ledger[0].status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        pty_chat_first: true,
        goal_source: checkpoint.goal_source,
        events: events.length,
        ledger_rows: ledger.length
      },
      null,
      2
    )
  );
}

async function requireExpect(): Promise<void> {
  await requireExpectOrSkip('tui-chat-pty');
}

function expectScript(): string {
  return `
log_user 0
set timeout 35
spawn env FORCE_COLOR=0 TERM=xterm-256color node --import tsx src/cli.tsx tui --target "$env(WICI_PTY_TARGET)" --max-iters 1 --mode stub --no-fullscreen
expect "CHAT"
sleep 1
send -- "$env(WICI_PTY_CHAT)\\r"
send -- "\\033\\[C"
expect -- "--- PLAN.md ---"
send -- "\\033\\[C"
expect {
  "turn completed" {
    send -- "\\003"
    expect eof
    exit 0
  }
  timeout {
    send -- "\\003"
    expect eof
    exit 2
  }
  eof {
    exit 3
  }
}
`;
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
