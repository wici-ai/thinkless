import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const plannerTarget = resolve('fixture/tui-resume-interrupted-runnable-planner-target');
const executorTarget = resolve('fixture/tui-resume-interrupted-runnable-executor-target');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await verifyPlannerRerunLaunches();
  await verifyExecutorRerunLaunches();
}

async function verifyPlannerRerunLaunches(): Promise<void> {
  await rm(plannerTarget, { recursive: true, force: true });
  await createSampleTarget(plannerTarget, true);
  const selectedSession = join(plannerTarget, '.thinkless2');
  const decoySession = join(plannerTarget, '.thinkless3');
  const selectedPaths = runPaths(plannerTarget, selectedSession);
  const decoyPaths = runPaths(plannerTarget, decoySession);
  await writeStoppedDecoy(decoyPaths, {
    runId: 'tui-resume-interrupted-runnable-planner-decoy',
    requirement: 'Planner rerun decoy must not launch',
    chat: 'planner rerun decoy chat',
    planner: 'interrupted-runnable-planner-decoy-planner',
    executor: 'interrupted-runnable-planner-decoy-executor',
    appThread: 'interrupted-runnable-planner-decoy-app-thread'
  });
  await writePlannerRerunRun(selectedPaths);
  await assertRunnableSelection({
    target: plannerTarget,
    selectedSession,
    decoySession,
    visibleState: 'PLAN',
    visibleReason: 'planner can rerun from durable goal state',
    caseName: 'planner-rerun',
    expectedFallback: 'planner_rerun',
    expectedPlanner: null,
    expectedExecutor: 'interrupted-runnable-planner-previous-executor',
    expectedAppThread: 'interrupted-runnable-planner-previous-app-thread',
    expectExecutorFallbackEvent: false,
    expectedChat: 'interrupted runnable planner selected chat',
    expectedRuntime: 'interrupted-runnable-planner-chat-model',
    expectedGoal: 'Interrupted runnable planner rerun goal',
    expectedPlan: 'Planner rerun from durable goal step',
    expectedLedger: 'interrupted-runnable-planner-ledger'
  });
}

async function verifyExecutorRerunLaunches(): Promise<void> {
  await rm(executorTarget, { recursive: true, force: true });
  await createSampleTarget(executorTarget, true);
  const selectedSession = join(executorTarget, '.thinkless2');
  const decoySession = join(executorTarget, '.thinkless3');
  const selectedPaths = runPaths(executorTarget, selectedSession);
  const decoyPaths = runPaths(executorTarget, decoySession);
  await writeStoppedDecoy(decoyPaths, {
    runId: 'tui-resume-interrupted-runnable-executor-decoy',
    requirement: 'Executor rerun decoy must not launch',
    chat: 'executor rerun decoy chat',
    planner: 'interrupted-runnable-executor-decoy-planner',
    executor: 'interrupted-runnable-executor-decoy-executor',
    appThread: 'interrupted-runnable-executor-decoy-app-thread'
  });
  await writeExecutorRerunRun(selectedPaths);
  await assertRunnableSelection({
    target: executorTarget,
    selectedSession,
    decoySession,
    visibleState: 'EXECUTE',
    visibleReason: 'executor can replay from checkpointed PLAN/ledger state',
    caseName: 'executor-rerun',
    expectedFallback: 'executor_rerun',
    expectedPlanner: 'interrupted-runnable-executor-planner',
    expectedExecutor: null,
    expectedAppThread: null,
    expectExecutorFallbackEvent: true,
    expectedChat: 'interrupted runnable executor selected chat',
    expectedRuntime: 'interrupted-runnable-executor-chat-model',
    expectedGoal: 'Interrupted runnable executor replay goal',
    expectedPlan: 'Executor replay from checkpointed step',
    expectedLedger: 'interrupted-runnable-executor-ledger'
  });
}

async function assertRunnableSelection(input: {
  target: string;
  selectedSession: string;
  decoySession: string;
  visibleState: string;
  visibleReason: string;
  caseName: string;
  expectedFallback: 'planner_rerun' | 'executor_rerun';
  expectedPlanner: string | null;
  expectedExecutor: string | null;
  expectedAppThread: string | null;
  expectExecutorFallbackEvent: boolean;
  expectedChat: string;
  expectedRuntime: string;
  expectedGoal: string;
  expectedPlan: string;
  expectedLedger: string;
}): Promise<void> {
  const selectedPaths = runPaths(input.target, input.selectedSession);
  const decoyPaths = runPaths(input.target, input.decoySession);
  const selectedBefore = await readJsonLines<RunEvent>(selectedPaths.events);
  const decoyBefore = await readJsonLines<RunEvent>(decoyPaths.events);
  const result = await execa('expect', ['-c', expectScript(input.visibleState, input.visibleReason)], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      HOME: join(input.target, '.home'),
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: input.target,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `${input.caseName} PTY path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes(`.thinkless2 [runnable] ${input.visibleState}`), `${input.caseName} selected candidate was not visible as runnable:\n${output}`);
  assert(output.includes(input.visibleReason), `${input.caseName} runnable reason was not visible:\n${output}`);
  assert(!output.includes('resume blocked:'), `${input.caseName} should not report blocked resume:\n${output}`);

  const selectedAfter = await readJsonLines<RunEvent>(selectedPaths.events);
  const decoyAfter = await readJsonLines<RunEvent>(decoyPaths.events);
  const selectedNewEvents = selectedAfter.slice(selectedBefore.length);
  const decoyNewEvents = decoyAfter.slice(decoyBefore.length);
  const validated = selectedNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `${input.caseName} should emit RESUME_CONTEXT_VALIDATED: ${JSON.stringify(selectedNewEvents)}\n${output}`);
  assert(selectedNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `${input.caseName} should launch supervisor: ${JSON.stringify(selectedNewEvents)}\n${output}`);
  assert(!selectedNewEvents.some((event) => event.type === 'RESUME_CONTEXT_BLOCKED'), `${input.caseName} should not emit blocked events: ${JSON.stringify(selectedNewEvents)}`);
  const hasExecutorFallback = selectedNewEvents.some((event) => event.type === 'EXECUTOR_RESUME_FALLBACK');
  assert(hasExecutorFallback === input.expectExecutorFallbackEvent, `${input.caseName} executor fallback event mismatch: ${JSON.stringify(selectedNewEvents)}`);
  assert(decoyNewEvents.length === 0, `${input.caseName} should not mutate runnable decoy events: ${JSON.stringify(decoyNewEvents)}`);

  const validation = validated.data as {
    target?: string;
    session_dir?: string | null;
    planner_session?: string | null;
    executor_session?: string | null;
    executor_app_thread?: string | null;
    fallback?: string | null;
  } | undefined;
  assert(validation?.target === input.target, `${input.caseName} validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === input.selectedSession, `${input.caseName} validated session dir mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === input.expectedPlanner, `${input.caseName} planner session mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === input.expectedExecutor, `${input.caseName} executor session mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === input.expectedAppThread, `${input.caseName} executor app thread mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.fallback === input.expectedFallback, `${input.caseName} fallback mismatch: ${JSON.stringify(validation)}`);

  const checkpoint = await readFile(selectedPaths.checkpoint, 'utf8');
  if (input.expectedPlanner) assert(checkpoint.includes(input.expectedPlanner), `${input.caseName} checkpoint should preserve planner session`);
  if (input.expectedExecutor) assert(checkpoint.includes(input.expectedExecutor), `${input.caseName} checkpoint should preserve executor session`);
  if (input.expectedAppThread) assert(checkpoint.includes(input.expectedAppThread), `${input.caseName} checkpoint should preserve executor app thread`);
  const chat = await readFile(selectedPaths.chat, 'utf8');
  assert(chat.includes(input.expectedChat), `${input.caseName} chat transcript should remain available`);
  const runtime = await readFile(selectedPaths.runtimeSelection, 'utf8');
  assert(runtime.includes(input.expectedRuntime), `${input.caseName} runtime selection should remain available`);
  const goalDoc = await readFile(selectedPaths.goalDoc, 'utf8');
  assert(goalDoc.includes(input.expectedGoal), `${input.caseName} GOAL.md should remain active context`);
  const plan = await readFile(selectedPaths.plan, 'utf8');
  assert(plan.includes(input.expectedPlan), `${input.caseName} PLAN.md should remain available`);
  const ledger = await readFile(selectedPaths.ledger, 'utf8');
  assert(ledger.includes(input.expectedLedger), `${input.caseName} ledger should remain available`);

  console.log(JSON.stringify({
    ok: true,
    case: input.caseName,
    target: input.target,
    selectedSession: input.selectedSession,
    decoySession: input.decoySession,
    fallback: input.expectedFallback,
    resume_validated: true,
    supervisor_started: true,
    decoyUnchanged: true
  }, null, 2));
}

async function writePlannerRerunRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal('tui-resume-interrupted-runnable-planner', 'Interrupted runnable planner rerun goal'));
  await atomicWriteJson(paths.checkpoint, checkpoint('PLAN', {
    executor: 'interrupted-runnable-planner-previous-executor',
    executorApp: {
      threadId: 'interrupted-runnable-planner-previous-app-thread',
      updatedAt: ts(),
      phase: 'idle'
    }
  }, null, 1));
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'PLAN_START', level: 'info', message: 'planner interrupted before session persisted, rerunnable from goal' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'interrupted runnable planner selected chat' });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: 'interrupted-runnable-planner-chat-model' } });
  await writeText(paths.goalDoc, '# GOAL\n\nInterrupted runnable planner rerun goal.\n');
  await writeText(paths.plan, '# PLAN\n\n- [>] S1 Planner rerun from durable goal step\n');
  await writeLedger(paths, 'interrupted-runnable-planner-ledger');
}

async function writeExecutorRerunRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal('tui-resume-interrupted-runnable-executor', 'Interrupted runnable executor replay goal'));
  await atomicWriteJson(paths.checkpoint, checkpoint('EXECUTE', { planner: 'interrupted-runnable-executor-planner' }, 'S1', 1));
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'EXECUTOR_START', level: 'info', message: 'executor interrupted before live session persisted, replayable from plan' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'interrupted runnable executor selected chat' });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: 'interrupted-runnable-executor-chat-model' } });
  await writeText(paths.goalDoc, '# GOAL\n\nInterrupted runnable executor replay goal.\n');
  await writeText(paths.plan, '# PLAN\n\n- [>] S1 Executor replay from checkpointed step\n');
  await writeLedger(paths, 'interrupted-runnable-executor-ledger');
}

async function writeStoppedDecoy(paths: ReturnType<typeof runPaths>, fixture: RunnableFixture): Promise<void> {
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
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: 'runnable decoy ready to resume' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: fixture.chat });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: `${fixture.runId}-chat-model` } });
  await writeText(paths.goalDoc, `# GOAL\n\n${fixture.requirement}.\n`);
  await writeText(paths.plan, '# PLAN\n\n- [x] S1 Decoy already complete\n');
  await writeText(paths.ledger, '');
}

async function writeLedger(paths: ReturnType<typeof runPaths>, id: string): Promise<void> {
  await writeText(paths.ledger, `${JSON.stringify({
    id,
    ts: ts(),
    iter: 0,
    step_id: 'S1',
    commit: null,
    hypothesis: 'interrupted runnable resume fixture',
    metric: null,
    baseline: null,
    delta_pct: null,
    confidence: 'fixture',
    cost: { wall_ms: 0, tokens_input: 0, tokens_output: 0, usd: 0 },
    guards: {},
    status: 'keep',
    reflection: 'interrupted runnable resume ledger row'
  })}\n`);
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content);
}

function expectScript(visibleState: string, visibleReason: string): string {
  return `
log_user 1
set timeout 25
stty rows 40 columns 180
set env(COLUMNS) 180
set env(LINES) 40
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect -ex ".thinkless2 \\[runnable\\] ${visibleState}"
expect -ex "${visibleReason}"
send -- "\\n"
sleep 2
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

function checkpoint(state: Checkpoint['supervisor_state'], sessions: Checkpoint['sessions'] = {}, nextStep: string | null = null, ledgerSeq = 0): Checkpoint {
  return {
    supervisor_state: state,
    next_step: nextStep,
    iter: 0,
    goal_version: 1,
    plan_hash: null,
    best_commit: null,
    ledger_seq: ledgerSeq,
    events_seq: 1,
    sessions,
    drained_inbox: [],
    updated_at: ts()
  };
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-interrupted-runnable requires expect on PATH');
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
