import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const target = resolve('fixture/tui-resume-selector-pty-target');
const selectedSession = join(target, '.thinkless2');

async function main(): Promise<void> {
  await requireExpect();
  await rm(target, { recursive: true, force: true });
  await createSampleTarget(target, true);
  await writeChatOnly(runPaths(target, join(target, '.thinkless')));
  await writeRunnableRun(runPaths(target, selectedSession));

  const before = await readJsonLines<RunEvent>(runPaths(target, selectedSession).events);
  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: target
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `PTY resume selector failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('[runnable] STOP'), `runnable candidate was not visible:\n${output}`);
  assert(output.includes('[runnable] NO_CHECKPOINT'), `chat-only candidate should be visible as runnable:\n${output}`);

  const events = await readJsonLines<RunEvent>(runPaths(target, selectedSession).events);
  assert(events.length > before.length, `selected session should receive new resume supervisor events:\n${output}`);
  assert(events.slice(before.length).some((event) => event.type === 'SUPERVISOR_START'), `selected session should launch supervisor after Enter:\n${output}`);
  const goalDoc = await readFile(runPaths(target, selectedSession).goalDoc, 'utf8');
  assert(goalDoc.includes('Selected PTY resume goal'), 'selected session GOAL.md should remain the active context');

  console.log(JSON.stringify({ ok: true, target, selectedSession, newEvents: events.length - before.length }, null, 2));
}

async function writeChatOnly(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'chat-only candidate' });
}

async function writeRunnableRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal());
  await atomicWriteJson(paths.checkpoint, checkpoint());
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: 'ready to resume' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'selected run chat' });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex' } });
  await writeText(paths.goalDoc, '# GOAL\n\nSelected PTY resume goal.\n');
  await writeText(paths.plan, '# PLAN\n\n- [x] S1 Already complete\n');
  await writeText(paths.ledger, '');
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path, content));
}

function goal(): GoalFile {
  return {
    run_id: 'tui-resume-selector',
    version: 1,
    requirements: [{ id: 'R1', text: 'Selected PTY resume goal', source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'tests', direction: 'maximize', unit: 'pass' },
    budget: { max_iters: 0, max_cost_usd: 0, deadline: null },
    stop: { tau: 0, K: 0, N: 0, mode: 'auto' }
  };
}

function checkpoint(): Checkpoint {
  return {
    supervisor_state: 'STOP',
    next_step: null,
    iter: 0,
    goal_version: 1,
    plan_hash: null,
    best_commit: null,
    ledger_seq: 0,
    events_seq: 1,
    sessions: { planner: 'resume-selector-planner', executor: 'resume-selector-executor' },
    drained_inbox: [],
    updated_at: ts()
  };
}

function expectScript(): string {
  return `
log_user 1
set timeout 25
spawn env FORCE_COLOR=0 TERM=xterm-256color node --import tsx src/cli.tsx tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect "\\[runnable\\] STOP"
send -- "x"
sleep 3
send -- "\\003"
expect eof
exit 0
`;
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-selector-pty requires expect on PATH');
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[=>]/g, '');
}

function ts(): string {
  return new Date().toISOString();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
