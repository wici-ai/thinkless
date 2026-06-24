import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const runnableTarget = resolve('fixture/tui-resume-legacy-candidate-target');
const blockedTarget = resolve('fixture/tui-resume-legacy-candidate-blocked-target');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await verifyRunnableLegacyCandidate();
  await verifyChatOnlyLegacyCandidate();
}

async function verifyRunnableLegacyCandidate(): Promise<void> {
  await rm(runnableTarget, { recursive: true, force: true });
  await createSampleTarget(runnableTarget, true);

  const currentSession = join(runnableTarget, '.thinkless');
  const legacySession = join(runnableTarget, '.wici');
  const currentPaths = runPaths(runnableTarget, currentSession);
  const legacyPaths = runPaths(runnableTarget, legacySession);
  await writeRunnableRun(legacyPaths, {
    runId: 'tui-resume-legacy-runnable',
    requirement: 'Selected legacy resume goal',
    chat: 'legacy runnable chat transcript',
    planner: 'legacy-runnable-planner-session',
    executor: 'legacy-runnable-executor-session',
    appThread: 'legacy-runnable-app-thread'
  });

  const currentBefore = await readJsonLines<RunEvent>(currentPaths.events);
  const legacyBefore = await readJsonLines<RunEvent>(legacyPaths.events);
  const result = await execa('expect', ['-c', runnableExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: runnableTarget,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `legacy runnable PTY path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes(`${basename(runnableTarget)} .wici [runnable] STOP`), `legacy runnable candidate was not visible:\n${output}`);
  assert(output.includes('Selected'), `legacy goal summary prefix was not visible:\n${output}`);

  const legacyAfter = await readJsonLines<RunEvent>(legacyPaths.events);
  const legacyNewEvents = legacyAfter.slice(legacyBefore.length);
  const validated = legacyNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `legacy candidate did not validate resume context:\n${output}`);
  assert(legacyNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `legacy candidate did not launch supervisor:\n${output}`);
  const validation = validated.data as {
    target?: string;
    session_dir?: string | null;
    planner_session?: string | null;
    executor_session?: string | null;
    executor_app_thread?: string | null;
  } | undefined;
  assert(validation?.target === runnableTarget, `validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === legacySession, `validated legacy session mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === 'legacy-runnable-planner-session', `validated planner session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === 'legacy-runnable-executor-session', `validated executor session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === 'legacy-runnable-app-thread', `validated executor app thread missing: ${JSON.stringify(validation)}`);

  const currentAfter = await readJsonLines<RunEvent>(currentPaths.events);
  const currentNewEvents = currentAfter.slice(currentBefore.length);
  assert(!currentNewEvents.some((event) => event.type === 'RESUME_CONTEXT_VALIDATED' || event.type === 'SUPERVISOR_START'), `current decoy received legacy launch events: ${JSON.stringify(currentNewEvents)}`);

  const checkpoint = await readFile(legacyPaths.checkpoint, 'utf8');
  assert(checkpoint.includes('legacy-runnable-planner-session'), 'legacy checkpoint should preserve planner session');
  assert(checkpoint.includes('legacy-runnable-executor-session'), 'legacy checkpoint should preserve executor session');
  assert(checkpoint.includes('legacy-runnable-app-thread'), 'legacy checkpoint should preserve executor app thread');
  const goalDoc = await readFile(legacyPaths.goalDoc, 'utf8');
  assert(goalDoc.includes('Selected legacy resume goal'), 'legacy GOAL.md should remain active context');
  const plan = await readFile(legacyPaths.plan, 'utf8');
  assert(plan.includes('Legacy resume step'), 'legacy PLAN.md should remain available');
  const ledger = await readFile(legacyPaths.ledger, 'utf8');
  assert(ledger.includes('legacy-ledger-row'), 'legacy ledger should remain available');
  const chat = await readFile(legacyPaths.chat, 'utf8');
  assert(chat.includes('legacy runnable chat transcript'), 'legacy chat transcript should remain available');
  const runtime = await readFile(legacyPaths.runtimeSelection, 'utf8');
  assert(runtime.includes('legacy-chat-model'), 'legacy runtime selection should remain available');

  console.log(JSON.stringify({ ok: true, case: 'legacy-runnable', target: runnableTarget, legacySession, currentSession, legacyNewEvents: legacyNewEvents.length, currentNewEvents: currentNewEvents.length, resume_validated: true }, null, 2));
}

async function verifyChatOnlyLegacyCandidate(): Promise<void> {
  await rm(blockedTarget, { recursive: true, force: true });
  await createSampleTarget(blockedTarget, true);

  const runnableSession = join(blockedTarget, '.thinkless2');
  const legacySession = join(blockedTarget, '.wici');
  const runnablePaths = runPaths(blockedTarget, runnableSession);
  const legacyPaths = runPaths(blockedTarget, legacySession);
  await writeRunnableRun(runnablePaths, {
    runId: 'tui-resume-legacy-blocked-decoy',
    requirement: 'Runnable decoy for chat-only legacy selection',
    chat: 'blocked legacy runnable decoy chat',
    planner: 'legacy-blocked-decoy-planner',
    executor: 'legacy-blocked-decoy-executor',
    appThread: 'legacy-blocked-decoy-app-thread'
  });
  await writeChatOnly(legacyPaths, 'legacy chat-only candidate can resume chat');

  const runnableBefore = await readJsonLines<RunEvent>(runnablePaths.events);
  const legacyBefore = await readJsonLines<RunEvent>(legacyPaths.events);
  const result = await execa('expect', ['-c', blockedExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: blockedTarget,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `legacy chat-only PTY path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes(`${basename(blockedTarget)} .wici [runnable]`), `legacy chat-only candidate was not visible as runnable:\n${output}`);
  assert(output.includes('chat session can be') && output.includes('without supervisor'), `legacy chat-only reason was not visible:\n${output}`);
  assert(output.includes('resume chat:'), `legacy chat-only candidate did not report chat resume selection:\n${output}`);

  const runnableAfter = await readJsonLines<RunEvent>(runnablePaths.events);
  const legacyAfter = await readJsonLines<RunEvent>(legacyPaths.events);
  const runnableNewEvents = runnableAfter.slice(runnableBefore.length);
  const legacyNewEvents = legacyAfter.slice(legacyBefore.length);
  const forbiddenTypes = new Set(['RESUME_CONTEXT_VALIDATED', 'SUPERVISOR_START', 'EXECUTOR_RESUME_FALLBACK']);
  assert(runnableNewEvents.length === 0, `chat-only legacy selection should not mutate runnable decoy events: ${JSON.stringify(runnableNewEvents)}`);
  assert(!legacyNewEvents.some((event) => forbiddenTypes.has(event.type)), `chat-only legacy selection emitted supervisor events: ${JSON.stringify(legacyNewEvents)}`);

  console.log(JSON.stringify({ ok: true, case: 'legacy-chat-only', target: blockedTarget, legacySession, runnableSession, noLaunch: true, chatResumeVisible: true }, null, 2));
}

async function writeChatOnly(paths: ReturnType<typeof runPaths>, text: string): Promise<void> {
  await ensureDir(paths.stateDir);
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text });
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
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: 'ready to resume legacy candidate' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: fixture.chat });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: 'legacy-chat-model' } });
  await writeText(paths.goalDoc, `# GOAL\n\n${fixture.requirement}.\n`);
  await writeText(paths.plan, '# PLAN\n\n- [x] S1 Legacy resume step\n');
  await writeText(paths.ledger, '{"id":"legacy-ledger-row","status":"keep","cost":{"wall_ms":0,"tokens_input":0,"tokens_output":0,"usd":0}}\n');
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
        updatedAt: ts(),
        phase: 'idle'
      }
    },
    drained_inbox: [],
    updated_at: ts()
  };
}

function runnableExpectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect ".wici \\[runnable\\] STOP"
sleep 1
send -- "\\n"
sleep 3
send -- "\\003"
expect eof
exit 0
`;
}

function blockedExpectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect ".wici \\[runnable\\]"
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
  assert(found.exitCode === 0, 'verify:tui-resume-legacy-candidate requires expect on PATH');
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

function ts(): string {
  return new Date().toISOString();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
