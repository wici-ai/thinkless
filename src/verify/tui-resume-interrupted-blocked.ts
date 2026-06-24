import { rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, OutboxMessage, RunEvent } from '../shared/types.js';

const plannerTarget = resolve('fixture/tui-resume-interrupted-blocked-planner-target');
const executorTarget = resolve('fixture/tui-resume-interrupted-blocked-executor-target');
const builtCli = resolve('dist/src/cli.js');
const forbiddenTypes = new Set(['RESUME_CONTEXT_VALIDATED', 'SUPERVISOR_START', 'EXECUTOR_RESUME_FALLBACK']);

async function main(): Promise<void> {
  await requireExpect();
  await verifyPlannerClarificationWithoutSessionRefusesLaunch();
  await verifyExecutorWithoutReplayStateRefusesLaunch();
}

async function verifyPlannerClarificationWithoutSessionRefusesLaunch(): Promise<void> {
  await rm(plannerTarget, { recursive: true, force: true });
  await createSampleTarget(plannerTarget, true);
  const runnableSession = join(plannerTarget, '.thinkless2');
  const blockedSession = join(plannerTarget, '.thinkless3');
  await writeRunnableRun(runPaths(plannerTarget, runnableSession), {
    runId: 'tui-resume-interrupted-blocked-planner-runnable',
    requirement: 'Runnable decoy for interrupted planner block',
    chat: 'interrupted planner runnable decoy chat',
    planner: 'interrupted-planner-decoy-planner',
    executor: 'interrupted-planner-decoy-executor',
    appThread: 'interrupted-planner-decoy-app-thread'
  });
  await writeInterruptedPlannerRun(runPaths(plannerTarget, blockedSession));

  await assertBlockedSelection({
    target: plannerTarget,
    caseName: 'planner-clarification-blocked',
    blockedSession,
    runnableSession,
    blockedState: 'PLAN',
    visibleReason: 'planner clarification is pending but no planner session was persisted'
  });
}

async function verifyExecutorWithoutReplayStateRefusesLaunch(): Promise<void> {
  await rm(executorTarget, { recursive: true, force: true });
  await createSampleTarget(executorTarget, true);
  const runnableSession = join(executorTarget, '.thinkless2');
  const blockedSession = join(executorTarget, '.thinkless3');
  await writeRunnableRun(runPaths(executorTarget, runnableSession), {
    runId: 'tui-resume-interrupted-blocked-executor-runnable',
    requirement: 'Runnable decoy for interrupted executor block',
    chat: 'interrupted executor runnable decoy chat',
    planner: 'interrupted-executor-decoy-planner',
    executor: 'interrupted-executor-decoy-executor',
    appThread: 'interrupted-executor-decoy-app-thread'
  });
  await writeInterruptedExecutorRun(runPaths(executorTarget, blockedSession));

  await assertBlockedSelection({
    target: executorTarget,
    caseName: 'executor-unreplayable-blocked',
    blockedSession,
    runnableSession,
    blockedState: 'EXECUTE',
    visibleReason: 'executor resume needs PLAN.md'
  });
}

async function assertBlockedSelection(input: {
  target: string;
  caseName: string;
  blockedSession: string;
  runnableSession: string;
  blockedState: string;
  visibleReason: string;
}): Promise<void> {
  const runnablePaths = runPaths(input.target, input.runnableSession);
  const blockedPaths = runPaths(input.target, input.blockedSession);
  const runnableBefore = await readJsonLines<RunEvent>(runnablePaths.events);
  const blockedBefore = await readJsonLines<RunEvent>(blockedPaths.events);
  const result = await execa('expect', ['-c', blockedExpectScript(input.blockedState, input.visibleReason)], {
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
  assert(output.includes('.thinkless3 [blocked]'), `${input.caseName} candidate was not visible:\n${output}`);
  assert(output.includes(input.visibleReason), `${input.caseName} reason was not visible:\n${output}`);
  assert(!output.includes('QUEUED COMMAND'), `${input.caseName} should not render a queued command block:\n${output}`);

  const runnableAfter = await readJsonLines<RunEvent>(runnablePaths.events);
  const blockedAfter = await readJsonLines<RunEvent>(blockedPaths.events);
  const runnableNewEvents = runnableAfter.slice(runnableBefore.length);
  const blockedNewEvents = blockedAfter.slice(blockedBefore.length);
  assert(runnableNewEvents.length === 0, `${input.caseName} should not mutate runnable decoy events: ${JSON.stringify(runnableNewEvents)}`);
  assert(!blockedNewEvents.some((event) => forbiddenTypes.has(event.type)), `${input.caseName} emitted launch/preflight events: ${JSON.stringify(blockedNewEvents)}`);
  console.log(JSON.stringify({ ok: true, case: input.caseName, target: input.target, blockedSession: input.blockedSession, runnableSession: input.runnableSession, noLaunch: true, blockedReasonVisible: true }, null, 2));
}

async function writeRunnableRun(paths: ReturnType<typeof runPaths>, fixture: RunnableFixture): Promise<void> {
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
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: 'ready to resume' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: fixture.chat });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex' } });
  await writeText(paths.goalDoc, `# GOAL\n\n${fixture.requirement}.\n`);
  await writeText(paths.plan, '# PLAN\n\n- [x] S1 Already complete\n');
  await writeText(paths.ledger, '');
}

async function writeInterruptedPlannerRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal('tui-resume-interrupted-blocked-planner', 'Interrupted planner without persisted planner session'));
  await atomicWriteJson(paths.checkpoint, checkpoint('PLAN'));
  await writeOutbox(paths, {
    id: 'out-planner-clarification',
    ts: ts(),
    kind: 'question',
    text: 'Need planner clarification',
    reply_key: 'planner-clarify-interrupted-blocked'
  });
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'PLAN_START', level: 'info', message: 'planner was interrupted before session persisted' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'interrupted planner candidate chat' });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex' } });
  await writeText(paths.goalDoc, '# GOAL\n\nInterrupted planner without persisted planner session.\n');
  await writeText(paths.plan, '# PLAN\n\n- [>] S1 Waiting for planner clarification\n');
  await writeText(paths.ledger, '');
}

async function writeInterruptedExecutorRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal('tui-resume-interrupted-blocked-executor', 'Interrupted executor without replayable state'));
  await atomicWriteJson(paths.checkpoint, checkpoint('EXECUTE'));
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'EXECUTOR_START', level: 'info', message: 'executor was interrupted before session persisted' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'interrupted executor candidate chat' });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex' } });
  await writeText(paths.goalDoc, '# GOAL\n\nInterrupted executor without replayable state.\n');
}

async function writeOutbox(paths: ReturnType<typeof runPaths>, message: OutboxMessage): Promise<void> {
  await ensureDir(paths.outbox);
  await atomicWriteJson(join(paths.outbox, `${message.id}.json`), message);
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content);
}

function blockedExpectScript(blockedState: string, visibleReason: string): string {
  return `
log_user 1
set timeout 25
stty rows 40 columns 180
set env(COLUMNS) 180
set env(LINES) 40
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect ".thinkless3 \\[blocked\\] ${blockedState}"
send -- "\\033\\[A"
expect "${visibleReason}"
sleep 1
send -- "\\n"
sleep 1
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
    next_step: null,
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
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-interrupted-blocked requires expect on PATH');
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
