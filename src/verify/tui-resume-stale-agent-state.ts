import { rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';
import { requireExpectOrSkip } from './expect.js';

const plannerTarget = resolve('fixture/tui-resume-stale-agent-state-planner-target');
const executorTarget = resolve('fixture/tui-resume-stale-agent-state-executor-target');
const builtCli = resolve('dist/src/cli.js');
const forbiddenTypes = new Set(['RESUME_CONTEXT_VALIDATED', 'SUPERVISOR_START', 'EXECUTOR_RESUME_FALLBACK']);

async function main(): Promise<void> {
  await requireExpect();
  await verifyPlannerTranscriptRevalidated();
  await verifyExecutorTranscriptRevalidated();
}

async function verifyPlannerTranscriptRevalidated(): Promise<void> {
  await rm(plannerTarget, { recursive: true, force: true });
  await createSampleTarget(plannerTarget, true);
  const staleSession = join(plannerTarget, '.thinkless2');
  const decoySession = join(plannerTarget, '.thinkless3');
  await writeRunnableStopRun(runPaths(plannerTarget, decoySession), {
    runId: 'tui-resume-stale-agent-state-planner-decoy',
    requirement: 'Runnable decoy for stale planner state',
    chat: 'stale planner runnable decoy chat',
    planner: 'stale-agent-planner-decoy-planner',
    executor: 'stale-agent-planner-decoy-executor',
    appThread: 'stale-agent-planner-decoy-app-thread'
  });
  const stalePaths = runPaths(plannerTarget, staleSession);
  await writePlannerRun(stalePaths);
  await assertStaleSelection({
    target: plannerTarget,
    staleSession,
    decoySession,
    staleFile: join(stalePaths.artifacts, 'planner-initial.stdout.jsonl'),
    visibleState: 'PLAN',
    revalidatedReason: 'planner can rerun from durable goal state because transcript state is missing',
    caseName: 'stale-planner-transcript',
    expectedMode: 'supervisor',
    expectedFallback: 'planner_rerun'
  });
}

async function verifyExecutorTranscriptRevalidated(): Promise<void> {
  await rm(executorTarget, { recursive: true, force: true });
  await createSampleTarget(executorTarget, true);
  const staleSession = join(executorTarget, '.thinkless2');
  const decoySession = join(executorTarget, '.thinkless3');
  await writeRunnableStopRun(runPaths(executorTarget, decoySession), {
    runId: 'tui-resume-stale-agent-state-executor-decoy',
    requirement: 'Runnable decoy for stale executor state',
    chat: 'stale executor runnable decoy chat',
    planner: 'stale-agent-executor-decoy-planner',
    executor: 'stale-agent-executor-decoy-executor',
    appThread: 'stale-agent-executor-decoy-app-thread'
  });
  const stalePaths = runPaths(executorTarget, staleSession);
  await writeExecutorRun(stalePaths);
  await assertStaleSelection({
    target: executorTarget,
    staleSession,
    decoySession,
    staleFile: stalePaths.codexRun,
    visibleState: 'EXECUTE',
    revalidatedReason: 'executor context can be reopened as Chat because durable transcript state is missing',
    caseName: 'stale-executor-transcript',
    expectedMode: 'chat_only',
    expectedFallback: 'chat_only',
    expectedChat: 'stale executor selected chat'
  });
}

async function assertStaleSelection(input: {
  target: string;
  staleSession: string;
  decoySession: string;
  staleFile: string;
  visibleState: string;
  revalidatedReason: string;
  caseName: string;
  expectedMode: 'supervisor' | 'chat_only';
  expectedFallback: string;
  expectedChat?: string;
}): Promise<void> {
  const stalePaths = runPaths(input.target, input.staleSession);
  const decoyPaths = runPaths(input.target, input.decoySession);
  const staleBefore = await readJsonLines<RunEvent>(stalePaths.events);
  const decoyBefore = await readJsonLines<RunEvent>(decoyPaths.events);
  const result = await execa('expect', ['-c', staleExpectScript(input.visibleState, input.expectedChat)], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      HOME: join(input.target, '.home'),
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: input.target,
      WICI_THINKLESS_BIN: builtCli,
      STALE_AGENT_FILE: input.staleFile
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `${input.caseName} PTY path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes(`.thinkless2 [runnable] ${input.visibleState}`), `${input.caseName} candidate was not initially visible as runnable:\n${output}`);
  if (input.expectedChat) assert(output.includes(input.expectedChat), `${input.caseName} did not restore selected chat transcript:\n${output}`);

  const staleAfter = await readJsonLines<RunEvent>(stalePaths.events);
  const decoyAfter = await readJsonLines<RunEvent>(decoyPaths.events);
  const staleNewEvents = staleAfter.slice(staleBefore.length);
  const decoyNewEvents = decoyAfter.slice(decoyBefore.length);
  if (input.expectedMode === 'supervisor') {
    const validated = staleNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
    assert(validated, `${input.caseName} should validate degraded resume context: ${JSON.stringify(staleNewEvents)}`);
    assert(validated.message.includes(input.revalidatedReason), `${input.caseName} validated reason mismatch: ${JSON.stringify(validated)}`);
    assert((validated.data as { fallback?: string | null } | undefined)?.fallback === input.expectedFallback, `${input.caseName} fallback mismatch: ${JSON.stringify(validated)}`);
    assert(staleNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `${input.caseName} should launch supervisor: ${JSON.stringify(staleNewEvents)}`);
    assert(!staleNewEvents.some((event) => event.type === 'RESUME_CONTEXT_BLOCKED'), `${input.caseName} should not block resume: ${JSON.stringify(staleNewEvents)}`);
  } else {
    assert(!staleNewEvents.some((event) => forbiddenTypes.has(event.type)), `${input.caseName} emitted supervisor events: ${JSON.stringify(staleNewEvents)}`);
  }
  assert(decoyNewEvents.length === 0, `${input.caseName} should not mutate runnable decoy events: ${JSON.stringify(decoyNewEvents)}`);
  console.log(JSON.stringify({ ok: true, case: input.caseName, target: input.target, staleSession: input.staleSession, mode: input.expectedMode, decoyUnchanged: true }, null, 2));
}

async function writeRunnableStopRun(paths: ReturnType<typeof runPaths>, fixture: RunnableFixture): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal(fixture.runId, fixture.requirement));
  await atomicWriteJson(paths.checkpoint, checkpoint('STOP', {
    planner: fixture.planner,
    executor: fixture.executor,
    executorApp: {
      threadId: fixture.appThread,
      updatedAt: ts(),
      phase: 'idle'
    }
  }));
  await writeCommonRunFiles(paths, fixture.requirement, fixture.chat);
}

async function writePlannerRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal('tui-resume-stale-agent-state-planner', 'Initially runnable planner resume state'));
  await atomicWriteJson(paths.checkpoint, checkpoint('PLAN', { planner: 'stale-agent-planner-session' }));
  await writeCommonRunFiles(paths, 'Initially runnable planner resume state', 'stale planner selected chat');
  await ensureDir(paths.artifacts);
  await writeFile(join(paths.artifacts, 'planner-initial.stdout.jsonl'), `${JSON.stringify({ type: 'result', session_id: 'stale-agent-planner-session' })}\n`);
}

async function writeExecutorRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal('tui-resume-stale-agent-state-executor', 'Initially runnable executor resume state'));
  await atomicWriteJson(paths.checkpoint, checkpoint('EXECUTE', {
    planner: 'stale-agent-executor-planner',
    executor: 'stale-agent-executor-session',
    executorApp: {
      threadId: 'stale-agent-executor-app-thread',
      updatedAt: ts(),
      phase: 'idle'
    }
  }));
  await writeCommonRunFiles(paths, 'Initially runnable executor resume state', 'stale executor selected chat');
  await writeFile(paths.codexRun, `${JSON.stringify({ type: 'turn.completed', threadId: 'stale-agent-executor-app-thread' })}\n`);
}

async function writeCommonRunFiles(paths: ReturnType<typeof runPaths>, requirement: string, chat: string): Promise<void> {
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: 'ready to resume' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: chat });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex' } });
  await writeText(paths.goalDoc, `# GOAL\n\n${requirement}.\n`);
  await writeText(paths.plan, '# PLAN\n\n- [>] S1 Resume interrupted agent state\n');
  await writeText(paths.ledger, '');
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content);
}

function staleExpectScript(visibleState: string, expectedChat?: string): string {
  return `
log_user 1
set timeout 25
stty rows 40 columns 180
set env(COLUMNS) 180
set env(LINES) 40
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect ".thinkless2 \\[runnable\\] ${visibleState}"
file delete -force "$env(STALE_AGENT_FILE)"
send -- "\\n"
sleep 1
${expectedChat ? `expect "${expectedChat}"` : ''}
send -- "\\003"
expect eof
exit 0
`;
}

interface RunnableFixture {
  runId: string;
  requirement: string;
  chat: string;
  planner: string;
  executor: string;
  appThread: string;
}

function goal(runId: string, requirement: string): GoalFile {
  return {
    run_id: runId,
    version: 1,
    requirements: [{ id: 'R1', text: requirement, source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'tests', direction: 'maximize', unit: 'pass' },
    budget: { max_iters: 0, max_cost_usd: 0, deadline: null },
    stop: { tau: 0, K: 0, N: 0, mode: 'auto' }
  };
}

function checkpoint(state: Checkpoint['supervisor_state'], sessions: Checkpoint['sessions'] = {}): Checkpoint {
  return {
    supervisor_state: state,
    next_step: state === 'EXECUTE' ? 'S1' : null,
    iter: 0,
    goal_version: 1,
    plan_hash: null,
    best_commit: null,
    ledger_seq: 0,
    events_seq: 1,
    sessions,
    drained_inbox: [],
    updated_at: ts()
  };
}

async function requireExpect(): Promise<void> {
  await requireExpectOrSkip('tui-resume-stale-agent-state');
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
