import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';
import { requireExpectOrSkip } from './expect.js';

const fixtureRoot = resolve('fixture/tui-resume-cross-target');
const home = join(fixtureRoot, 'home');
const currentTarget = join(fixtureRoot, 'current-target');
const workspaceRoot = join(home, 'thinkless-workspaces');
const historicalTarget = join(workspaceRoot, 'historical-target');
const currentSession = join(currentTarget, '.thinkless');
const selectedSession = join(historicalTarget, '.thinkless2');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await rm(fixtureRoot, { recursive: true, force: true });
  await createSampleTarget(currentTarget, true);
  await createSampleTarget(historicalTarget, true);

  const currentPaths = runPaths(currentTarget, currentSession);
  await writeCurrentRun(currentPaths);
  const selectedPaths = runPaths(historicalTarget, selectedSession);
  await writeHistoricalRun(selectedPaths);

  const currentBefore = await readJsonLines<RunEvent>(currentPaths.events);
  const selectedBefore = await readJsonLines<RunEvent>(selectedPaths.events);
  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      HOME: home,
      WICI_PTY_TARGET: currentTarget,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `cross-target resume PTY failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('historical-target .thinkless2 [runnable] STOP'), `historical workspace candidate was not visible:\n${output}`);
  assert(output.includes('Selected cross-target'), `historical candidate goal summary was not visible:\n${output}`);

  const selectedAfter = await readJsonLines<RunEvent>(selectedPaths.events);
  const selectedNewEvents = selectedAfter.slice(selectedBefore.length);
  const validated = selectedNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `selected historical session did not validate resume context:\n${output}`);
  assert(selectedNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `selected historical session did not launch supervisor:\n${output}`);
  const validation = validated.data as {
    target?: string;
    session_dir?: string | null;
    planner_session?: string | null;
    executor_session?: string | null;
    executor_app_thread?: string | null;
  } | undefined;
  assert(validation?.target === historicalTarget, `validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === selectedSession, `validated session dir mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === 'cross-target-planner-session', `validated planner session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === 'cross-target-executor-session', `validated executor session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === 'cross-target-app-thread', `validated executor app thread missing: ${JSON.stringify(validation)}`);

  const currentAfter = await readJsonLines<RunEvent>(currentPaths.events);
  const currentNewEvents = currentAfter.slice(currentBefore.length);
  assert(!currentNewEvents.some((event) => event.type === 'RESUME_CONTEXT_VALIDATED' || event.type === 'SUPERVISOR_START'), `current target received resume launch events: ${JSON.stringify(currentNewEvents)}`);

  const checkpoint = await readFile(selectedPaths.checkpoint, 'utf8');
  assert(checkpoint.includes('cross-target-planner-session'), 'selected checkpoint should preserve planner session');
  assert(checkpoint.includes('cross-target-executor-session'), 'selected checkpoint should preserve executor session');
  assert(checkpoint.includes('cross-target-app-thread'), 'selected checkpoint should preserve executor app thread');
  const goalDoc = await readFile(selectedPaths.goalDoc, 'utf8');
  assert(goalDoc.includes('Selected cross-target resume goal'), 'selected GOAL.md should remain the active historical context');
  const plan = await readFile(selectedPaths.plan, 'utf8');
  assert(plan.includes('Historical resume step'), 'selected PLAN.md should remain available');
  const ledger = await readFile(selectedPaths.ledger, 'utf8');
  assert(ledger.includes('historical-ledger-row'), 'selected ledger should remain available');
  const chat = await readFile(selectedPaths.chat, 'utf8');
  assert(chat.includes('historical selected chat transcript'), 'selected chat transcript should remain available');
  const runtime = await readFile(selectedPaths.runtimeSelection, 'utf8');
  assert(runtime.includes('cross-target-chat-model'), 'selected runtime selection should remain available');

  console.log(JSON.stringify({
    ok: true,
    currentTarget,
    historicalTarget,
    selectedSession,
    selectedNewEvents: selectedNewEvents.length,
    currentNewEvents: currentNewEvents.length,
    resume_validated: true,
    isolated: true
  }, null, 2));
}

async function writeCurrentRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: 'current target idle' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'current target chat should not be resumed' });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: 'current-target-model' } });
}

async function writeHistoricalRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal());
  await atomicWriteJson(paths.checkpoint, checkpoint());
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: 'historical target ready to resume' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'historical selected chat transcript' });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: 'cross-target-chat-model' } });
  await writeText(paths.goalDoc, '# GOAL\n\nSelected cross-target resume goal.\n');
  await writeText(paths.plan, '# PLAN\n\n- [x] S1 Historical resume step\n');
  await writeText(paths.ledger, '{"id":"historical-ledger-row","status":"keep"}\n');
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path, content));
}

function goal(): GoalFile {
  return {
    run_id: 'tui-resume-cross-target',
    version: 1,
    requirements: [{ id: 'R1', text: 'Selected cross-target resume goal', source: 'initial', status: 'active' }],
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
    ledger_seq: 1,
    events_seq: 1,
    sessions: {
      planner: 'cross-target-planner-session',
      executor: 'cross-target-executor-session',
      executorApp: {
        threadId: 'cross-target-app-thread',
        updatedAt: ts(),
        phase: 'idle'
      }
    },
    drained_inbox: [],
    updated_at: ts()
  };
}

function expectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect "historical-target .thinkless2 \\[runnable\\] STOP"
sleep 1
send -- "\\n"
sleep 3
send -- "\\003"
expect eof
exit 0
`;
}

async function requireExpect(): Promise<void> {
  await requireExpectOrSkip('tui-resume-cross-target');
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
