import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const openOnlyTarget = resolve('fixture/tui-resume-current-candidate-open-target');
const selectTarget = resolve('fixture/tui-resume-current-candidate-target');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await verifyOpenSelectorDoesNotLaunchCurrentRun();
  await verifyEnterSelectsCurrentRun();
}

async function verifyOpenSelectorDoesNotLaunchCurrentRun(): Promise<void> {
  const { currentSession, decoySession } = await writeFixture(openOnlyTarget);
  const currentPaths = runPaths(openOnlyTarget, currentSession);
  const decoyPaths = runPaths(openOnlyTarget, decoySession);
  const currentBefore = await readJsonLines<RunEvent>(currentPaths.events);
  const decoyBefore = await readJsonLines<RunEvent>(decoyPaths.events);

  const result = await execa('expect', ['-c', openOnlyExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: openOnlyTarget,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `current resume selector open-only path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes(`${basename(openOnlyTarget)} .thinkless [runnable] STOP`), `current candidate was not visible before selection:\n${output}`);
  assert(output.includes(`${basename(openOnlyTarget)} .thinkless2 [runnable] STOP`), `decoy candidate was not visible before selection:\n${output}`);

  const currentAfter = await readJsonLines<RunEvent>(currentPaths.events);
  const decoyAfter = await readJsonLines<RunEvent>(decoyPaths.events);
  assert(currentAfter.length === currentBefore.length, 'opening the selector should not preflight or launch the current candidate');
  assert(decoyAfter.length === decoyBefore.length, 'opening the selector should not preflight or launch the decoy candidate');

  console.log(JSON.stringify({ ok: true, case: 'open-only', target: openOnlyTarget, currentSession, decoySession, noLaunchBeforeSelection: true }, null, 2));
}

async function verifyEnterSelectsCurrentRun(): Promise<void> {
  const { currentSession, decoySession } = await writeFixture(selectTarget);
  const currentPaths = runPaths(selectTarget, currentSession);
  const decoyPaths = runPaths(selectTarget, decoySession);
  const currentBefore = await readJsonLines<RunEvent>(currentPaths.events);
  const decoyBefore = await readJsonLines<RunEvent>(decoyPaths.events);

  const result = await execa('expect', ['-c', selectCurrentExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: selectTarget,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `current resume selector select path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes(`${basename(selectTarget)} .thinkless [runnable] STOP`), `current candidate was not visible before Enter:\n${output}`);

  const currentAfter = await readJsonLines<RunEvent>(currentPaths.events);
  const decoyAfter = await readJsonLines<RunEvent>(decoyPaths.events);
  const currentNewEvents = currentAfter.slice(currentBefore.length);
  const decoyNewEvents = decoyAfter.slice(decoyBefore.length);
  const validated = currentNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `current candidate did not validate resume context:\n${output}`);
  assert(currentNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `current candidate did not launch supervisor after explicit Enter:\n${output}`);
  const validation = validated.data as {
    target?: string;
    session_dir?: string | null;
    planner_session?: string | null;
    executor_session?: string | null;
    executor_app_thread?: string | null;
  } | undefined;
  assert(validation?.target === selectTarget, `validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === currentSession, `validated current session mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === 'current-resume-planner-session', `validated planner session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === 'current-resume-executor-session', `validated executor session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === 'current-resume-app-thread', `validated executor app thread missing: ${JSON.stringify(validation)}`);
  assert(decoyNewEvents.length === 0, `current selection should not mutate decoy events: ${JSON.stringify(decoyNewEvents)}`);

  const checkpoint = await readFile(currentPaths.checkpoint, 'utf8');
  assert(checkpoint.includes('current-resume-planner-session'), 'current checkpoint should preserve planner session');
  assert(checkpoint.includes('current-resume-executor-session'), 'current checkpoint should preserve executor session');
  assert(checkpoint.includes('current-resume-app-thread'), 'current checkpoint should preserve executor app thread');
  const goalDoc = await readFile(currentPaths.goalDoc, 'utf8');
  assert(goalDoc.includes('Selected current resume goal'), 'current GOAL.md should remain active context');
  const plan = await readFile(currentPaths.plan, 'utf8');
  assert(plan.includes('Current resume step'), 'current PLAN.md should remain available');
  const ledger = await readFile(currentPaths.ledger, 'utf8');
  assert(ledger.includes('current-ledger-row'), 'current ledger should remain available');
  const chat = await readFile(currentPaths.chat, 'utf8');
  assert(chat.includes('current runnable chat transcript'), 'current chat transcript should remain available');
  const runtime = await readFile(currentPaths.runtimeSelection, 'utf8');
  assert(runtime.includes('current-chat-model'), 'current runtime selection should remain available');

  console.log(JSON.stringify({ ok: true, case: 'select-current', target: selectTarget, currentSession, decoySession, currentNewEvents: currentNewEvents.length, decoyNewEvents: decoyNewEvents.length, resume_validated: true }, null, 2));
}

async function writeFixture(target: string): Promise<{ currentSession: string; decoySession: string }> {
  await rm(target, { recursive: true, force: true });
  await createSampleTarget(target, true);
  const currentSession = join(target, '.thinkless');
  const decoySession = join(target, '.thinkless2');
  await writeRunnableRun(runPaths(target, decoySession), {
    runId: 'tui-resume-current-decoy',
    requirement: 'Decoy numbered resume goal',
    chat: 'decoy runnable chat must not launch',
    planner: 'current-resume-decoy-planner',
    executor: 'current-resume-decoy-executor',
    appThread: 'current-resume-decoy-app-thread',
    chatModel: 'decoy-chat-model',
    step: 'Decoy resume step',
    ledgerId: 'decoy-ledger-row',
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  await writeRunnableRun(runPaths(target, currentSession), {
    runId: 'tui-resume-current',
    requirement: 'Selected current resume goal',
    chat: 'current runnable chat transcript',
    planner: 'current-resume-planner-session',
    executor: 'current-resume-executor-session',
    appThread: 'current-resume-app-thread',
    chatModel: 'current-chat-model',
    step: 'Current resume step',
    ledgerId: 'current-ledger-row',
    updatedAt: '2026-01-02T00:00:00.000Z'
  });
  return { currentSession, decoySession };
}

interface RunnableFixture {
  runId: string;
  requirement: string;
  chat: string;
  planner: string;
  executor: string;
  appThread: string;
  chatModel: string;
  step: string;
  ledgerId: string;
  updatedAt: string;
}

async function writeRunnableRun(paths: ReturnType<typeof runPaths>, fixture: RunnableFixture): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal(fixture));
  await atomicWriteJson(paths.checkpoint, checkpoint(fixture));
  await appendJsonLine(paths.events, { seq: 1, ts: fixture.updatedAt, type: 'STOP', level: 'info', message: 'current candidate ready to resume' });
  await appendJsonLine(paths.chat, { ts: fixture.updatedAt, role: 'user', text: fixture.chat });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: fixture.chatModel } });
  await writeText(paths.goalDoc, `# GOAL\n\n${fixture.requirement}.\n`);
  await writeText(paths.plan, `# PLAN\n\n- [x] S1 ${fixture.step}\n`);
  await writeText(paths.ledger, `{"id":"${fixture.ledgerId}","status":"keep","cost":{"wall_ms":0,"tokens_input":0,"tokens_output":0,"usd":0}}\n`);
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path, content));
}

function goal(fixture: RunnableFixture): GoalFile {
  return {
    run_id: fixture.runId,
    version: 1,
    requirements: [{ id: 'R1', text: fixture.requirement, source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'tests', direction: 'maximize', unit: 'pass' },
    budget: { max_iters: 0, max_cost_usd: 0, deadline: null },
    stop: { tau: 0, K: 0, N: 0, mode: 'auto' }
  };
}

function checkpoint(fixture: RunnableFixture): Checkpoint {
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
      planner: fixture.planner,
      executor: fixture.executor,
      executorApp: {
        threadId: fixture.appThread,
        updatedAt: fixture.updatedAt,
        phase: 'idle'
      }
    },
    drained_inbox: [],
    updated_at: fixture.updatedAt
  };
}

function openOnlyExpectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect ".thinkless \\[runnable\\] STOP"
expect ".thinkless2 \\[runnable\\] STOP"
sleep 2
send -- "\\003"
expect eof
exit 0
`;
}

function selectCurrentExpectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect ".thinkless \\[runnable\\] STOP"
sleep 1
send -- "\\n"
sleep 3
send -- "\\003"
expect eof
exit 0
`;
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-current-candidate requires expect on PATH');
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
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
