import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const target = resolve('fixture/tui-resume-selector-built-target');
const escapeTarget = resolve('fixture/tui-resume-selector-built-escape-target');
const chatOnlyTarget = resolve('fixture/trsb-chat-only-target');
const selectedSession = join(target, '.thinkless2');
const decoySession = join(target, '.thinkless3');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await verifyArrowEnterLaunchesSelectedSession();
  await verifyEscapeCancelsWithoutLaunch();
  await verifyChatOnlyCandidateResumesWithoutSupervisor();
}

async function verifyArrowEnterLaunchesSelectedSession(): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await createSampleTarget(target, true);
  await writeRunnableRun(runPaths(target, selectedSession), {
    runId: 'tui-resume-selector-built',
    requirement: 'Selected built PTY resume goal',
    chat: 'selected built run chat',
    planner: 'resume-selector-built-planner',
    executor: 'resume-selector-built-executor',
    appThread: 'resume-selector-built-app-thread'
  });
  await writeRunnableRun(runPaths(target, decoySession), {
    runId: 'tui-resume-selector-built-decoy',
    requirement: 'Decoy built PTY resume goal',
    chat: 'decoy built run chat',
    planner: 'resume-selector-built-decoy-planner',
    executor: 'resume-selector-built-decoy-executor',
    appThread: 'resume-selector-built-decoy-app-thread'
  });

  const selectedPaths = runPaths(target, selectedSession);
  const before = await readJsonLines<RunEvent>(selectedPaths.events);
  const decoyPaths = runPaths(target, decoySession);
  const decoyBefore = await readJsonLines<RunEvent>(decoyPaths.events);
  const result = await execa('expect', ['-c', arrowEnterExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      HOME: join(target, '.home'),
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: target,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `built PTY resume selector failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('[runnable] STOP'), `built CLI runnable candidate was not visible:\n${output}`);
  assert(output.includes('.thinkless3 [runnable] STOP'), `built CLI decoy runnable candidate was not visible before navigation:\n${output}`);
  assert(output.includes('.thinkless2 [runnable] STOP'), `built CLI selected runnable candidate was not visible before navigation:\n${output}`);

  const events = await readJsonLines<RunEvent>(selectedPaths.events);
  const newEvents = events.slice(before.length);
  assert(newEvents.some((event) => event.type === 'SUPERVISOR_START'), `built CLI selected session should launch supervisor after Enter:\n${output}`);
  const validated = newEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `built CLI selected session should validate resume context before launch:\n${output}`);
  const validation = validated.data as {
    target?: string;
    session_dir?: string | null;
    planner_session?: string | null;
    executor_session?: string | null;
    executor_app_thread?: string | null;
  } | undefined;
  assert(validation?.target === target, `validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === selectedSession, `validated session dir mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === 'resume-selector-built-planner', `validated planner session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === 'resume-selector-built-executor', `validated executor session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === 'resume-selector-built-app-thread', `validated executor app thread missing: ${JSON.stringify(validation)}`);

  const checkpoint = await readFile(selectedPaths.checkpoint, 'utf8');
  assert(checkpoint.includes('resume-selector-built-planner'), 'selected session checkpoint should preserve planner session');
  assert(checkpoint.includes('resume-selector-built-executor'), 'selected session checkpoint should preserve executor session');
  assert(checkpoint.includes('resume-selector-built-app-thread'), 'selected session checkpoint should preserve executor app thread');
  const goalDoc = await readFile(selectedPaths.goalDoc, 'utf8');
  assert(goalDoc.includes('Selected built PTY resume goal'), 'selected session GOAL.md should remain the active context');
  const chat = await readFile(selectedPaths.chat, 'utf8');
  assert(chat.includes('selected built run chat'), 'selected session chat transcript should remain available');
  const decoyEvents = await readJsonLines<RunEvent>(decoyPaths.events);
  assert(decoyEvents.length === decoyBefore.length, 'down-arrow selection should not launch the initial decoy runnable session');

  console.log(JSON.stringify({ ok: true, case: 'arrow-enter', target, selectedSession, decoySession, builtCli, newEvents: newEvents.length, resume_validated: true }, null, 2));
}

async function verifyEscapeCancelsWithoutLaunch(): Promise<void> {
  await rm(escapeTarget, { recursive: true, force: true });
  await createSampleTarget(escapeTarget, true);
  const escapeSession = join(escapeTarget, '.thinkless2');
  await writeChatOnly(runPaths(escapeTarget, join(escapeTarget, '.thinkless')));
  await writeRunnableRun(runPaths(escapeTarget, escapeSession), {
    runId: 'tui-resume-selector-built-escape',
    requirement: 'Escape built PTY resume goal',
    chat: 'escape built run chat',
    planner: 'resume-selector-built-escape-planner',
    executor: 'resume-selector-built-escape-executor',
    appThread: 'resume-selector-built-escape-app-thread'
  });
  const escapePaths = runPaths(escapeTarget, escapeSession);
  const before = await readJsonLines<RunEvent>(escapePaths.events);
  const result = await execa('expect', ['-c', escapeExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      HOME: join(escapeTarget, '.home'),
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: escapeTarget,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `built PTY resume selector Escape path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('[runnable] STOP'), `built CLI Escape path did not open selector:\n${output}`);
  assert(output.includes('resume: cancelled'), `built CLI Escape path did not report cancellation:\n${output}`);
  const after = await readJsonLines<RunEvent>(escapePaths.events);
  assert(after.length === before.length, 'Escape cancellation should not launch or preflight any candidate session');
  console.log(JSON.stringify({ ok: true, case: 'escape-cancel', target: escapeTarget, selectedSession: escapeSession, noLaunch: true }, null, 2));
}

async function verifyChatOnlyCandidateResumesWithoutSupervisor(): Promise<void> {
  await rm(chatOnlyTarget, { recursive: true, force: true });
  await createSampleTarget(chatOnlyTarget, true);
  const runnableSession = join(chatOnlyTarget, '.thinkless2');
  const chatOnlySession = join(chatOnlyTarget, '.thinkless3');
  await writeRunnableRun(runPaths(chatOnlyTarget, runnableSession), {
    runId: 'tui-resume-selector-built-blocked-runnable',
    requirement: 'Runnable decoy for chat-only selection',
    chat: 'runnable decoy chat must not launch',
    planner: 'resume-selector-built-blocked-runnable-planner',
    executor: 'resume-selector-built-blocked-runnable-executor',
    appThread: 'resume-selector-built-blocked-runnable-app-thread'
  });
  await writeChatOnly(runPaths(chatOnlyTarget, chatOnlySession));

  const runnablePaths = runPaths(chatOnlyTarget, runnableSession);
  const chatOnlyPaths = runPaths(chatOnlyTarget, chatOnlySession);
  const runnableBefore = await readJsonLines<RunEvent>(runnablePaths.events);
  const chatOnlyBefore = await readJsonLines<RunEvent>(chatOnlyPaths.events);
  const result = await execa('expect', ['-c', chatOnlyCandidateExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      HOME: join(chatOnlyTarget, '.home'),
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: chatOnlyTarget,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `built PTY chat-only resume selector path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('.thinkless3 [runnable]'), `built CLI chat-only candidate was not visible as runnable:\n${output}`);
  assert(output.includes('NO_CHECKPOINT'), `built CLI chat-only candidate should show no checkpoint state:\n${output}`);
  assert(output.includes('chat session can be') && output.includes('without supervisor'), `built CLI chat-only reason was not visible:\n${output}`);
  assert(output.includes('resume chat:'), `built CLI did not report chat resume selection:\n${output}`);

  const runnableAfter = await readJsonLines<RunEvent>(runnablePaths.events);
  const chatOnlyAfter = await readJsonLines<RunEvent>(chatOnlyPaths.events);
  const runnableNewEvents = runnableAfter.slice(runnableBefore.length);
  const chatOnlyNewEvents = chatOnlyAfter.slice(chatOnlyBefore.length);
  const forbiddenTypes = new Set(['RESUME_CONTEXT_VALIDATED', 'SUPERVISOR_START', 'EXECUTOR_RESUME_FALLBACK']);
  assert(runnableNewEvents.length === 0, `chat-only selection should not mutate runnable decoy events: ${JSON.stringify(runnableNewEvents)}`);
  assert(!chatOnlyNewEvents.some((event) => forbiddenTypes.has(event.type)), `chat-only selection emitted supervisor events: ${JSON.stringify(chatOnlyNewEvents)}`);
  console.log(JSON.stringify({ ok: true, case: 'chat-only-candidate', target: chatOnlyTarget, chatOnlySession, runnableSession, noLaunch: true, chatResumeVisible: true }, null, 2));
}

async function writeChatOnly(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'built chat-only candidate' });
}

interface RunnableFixture {
  runId: string;
  requirement: string;
  chat: string;
  planner: string;
  executor: string;
  appThread: string;
}

async function writeRunnableRun(paths: ReturnType<typeof runPaths>, fixture: RunnableFixture): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal(fixture));
  await atomicWriteJson(paths.checkpoint, checkpoint(fixture));
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: 'ready to resume' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: fixture.chat });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex' } });
  await writeText(paths.goalDoc, `# GOAL\n\n${fixture.requirement}.\n`);
  await writeText(paths.plan, '# PLAN\n\n- [x] S1 Already complete\n');
  await writeText(paths.ledger, '');
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
    ledger_seq: 0,
    events_seq: 1,
    sessions: {
      planner: fixture.planner,
      executor: fixture.executor,
      executorApp: {
        threadId: fixture.appThread,
        updatedAt: ts(),
        phase: 'idle'
      }
    },
    drained_inbox: [],
    updated_at: ts()
  };
}

function arrowEnterExpectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect ".thinkless3 \\[runnable\\] STOP"
send -- "\\033\\[B"
sleep 2
send -- "\\n"
sleep 3
send -- "\\003"
expect eof
exit 0
`;
}

function escapeExpectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect "\\[runnable\\] STOP"
send -- "\\033"
expect "resume: cancelled"
sleep 1
send -- "\\003"
expect eof
exit 0
`;
}

function chatOnlyCandidateExpectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect ".thinkless3 \\[runnable\\] NO_CHECKPOINT"
send -- "\\n"
expect "resume chat:"
sleep 1
send -- "\\003"
expect eof
exit 0
`;
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-selector-built requires expect on PATH');
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
