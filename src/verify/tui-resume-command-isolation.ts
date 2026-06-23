import { readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const target = resolve('fixture/tui-resume-command-isolation-target');
const currentSession = join(target, '.thinkless');
const selectedSession = join(target, '.wici');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await rm(target, { recursive: true, force: true });
  await createSampleTarget(target, true);
  const currentPaths = runPaths(target, currentSession);
  const selectedPaths = runPaths(target, selectedSession);
  await writeRunnableRun(currentPaths, {
    runId: 'tui-resume-command-isolation-current',
    requirement: 'Current session must ignore resume command text',
    chat: 'current command isolation chat transcript',
    planner: 'command-isolation-current-planner',
    executor: 'command-isolation-current-executor',
    appThread: 'command-isolation-current-app-thread',
    chatModel: 'command-isolation-current-chat-model',
    step: 'Current command isolation step',
    ledgerId: 'command-isolation-current-ledger',
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  await writeRunnableRun(selectedPaths, {
    runId: 'tui-resume-command-isolation-selected',
    requirement: 'Selected resume command isolation candidate',
    chat: 'selected command isolation chat transcript',
    planner: 'command-isolation-selected-planner',
    executor: 'command-isolation-selected-executor',
    appThread: 'command-isolation-selected-app-thread',
    chatModel: 'command-isolation-selected-chat-model',
    step: 'Selected command isolation step',
    ledgerId: 'command-isolation-selected-ledger',
    updatedAt: '2026-01-02T00:00:00.000Z'
  });

  const currentSnapshot = await snapshotCurrentSession(currentPaths);
  const selectedBefore = await readJsonLines<RunEvent>(selectedPaths.events);
  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: target,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 45_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `resume command isolation PTY path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('resume: cancelled'), `Escape cancellation was not visible:\n${output}`);
  assert(output.includes('Current session must ignore resume command text'), `current candidate was not visible:\n${output}`);
  assert(output.includes('Selected resume command isolation candidate'), `selected candidate was not visible:\n${output}`);

  const currentAfter = await snapshotCurrentSession(currentPaths);
  assertSnapshotsEqual(currentSnapshot, currentAfter);
  for (const [name, content] of Object.entries(currentAfter.files)) {
    assert(!content.includes('/resume'), `current ${name} leaked /resume command text`);
  }
  assert(!currentAfter.inboxEntries.some((entry) => entry.includes('/resume')), `current inbox leaked /resume command text: ${currentAfter.inboxEntries.join('\n')}`);
  assert(!currentAfter.inboxDoneEntries.some((entry) => entry.includes('/resume')), `current inbox_done leaked /resume command text: ${currentAfter.inboxDoneEntries.join('\n')}`);

  const selectedAfter = await readJsonLines<RunEvent>(selectedPaths.events);
  const selectedNewEvents = selectedAfter.slice(selectedBefore.length);
  const validated = selectedNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `selected candidate should validate resume context: ${JSON.stringify(selectedNewEvents)}\n${output}`);
  assert(selectedNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `selected candidate should launch supervisor: ${JSON.stringify(selectedNewEvents)}\n${output}`);
  assert(!selectedNewEvents.some((event) => event.type === 'RESUME_CONTEXT_BLOCKED' || event.type === 'EXECUTOR_RESUME_FALLBACK'), `selected candidate emitted unexpected events: ${JSON.stringify(selectedNewEvents)}`);
  const validation = validated.data as {
    target?: string;
    session_dir?: string | null;
    planner_session?: string | null;
    executor_session?: string | null;
    executor_app_thread?: string | null;
  } | undefined;
  assert(validation?.target === target, `validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === selectedSession, `validated selected session mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === 'command-isolation-selected-planner', `validated planner session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === 'command-isolation-selected-executor', `validated executor session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === 'command-isolation-selected-app-thread', `validated executor app thread missing: ${JSON.stringify(validation)}`);

  const selectedCheckpoint = await readFile(selectedPaths.checkpoint, 'utf8');
  assert(selectedCheckpoint.includes('command-isolation-selected-planner'), 'selected checkpoint should preserve planner session');
  assert(selectedCheckpoint.includes('command-isolation-selected-executor'), 'selected checkpoint should preserve executor session');
  assert(selectedCheckpoint.includes('command-isolation-selected-app-thread'), 'selected checkpoint should preserve app thread');
  const selectedChat = await readFile(selectedPaths.chat, 'utf8');
  assert(selectedChat.includes('selected command isolation chat transcript'), 'selected chat transcript should remain available');
  assert(!selectedChat.includes('/resume'), 'selected chat transcript should not contain typed /resume command');
  const selectedRuntime = await readFile(selectedPaths.runtimeSelection, 'utf8');
  assert(selectedRuntime.includes('command-isolation-selected-chat-model'), 'selected runtime selection should remain available');
  const selectedGoal = await readFile(selectedPaths.goalDoc, 'utf8');
  assert(selectedGoal.includes('Selected resume command isolation candidate'), 'selected GOAL.md should remain available');
  const selectedPlan = await readFile(selectedPaths.plan, 'utf8');
  assert(selectedPlan.includes('Selected command isolation step'), 'selected PLAN.md should remain available');
  const selectedLedger = await readFile(selectedPaths.ledger, 'utf8');
  assert(selectedLedger.includes('command-isolation-selected-ledger'), 'selected ledger should remain available');

  console.log(JSON.stringify({
    ok: true,
    target,
    currentSession,
    selectedSession,
    commandIsolated: true,
    escapeCancelled: true,
    selectedOnlyLaunch: true,
    resume_validated: true
  }, null, 2));
}

interface Snapshot {
  files: Record<string, string>;
  inboxEntries: string[];
  inboxDoneEntries: string[];
}

async function snapshotCurrentSession(paths: ReturnType<typeof runPaths>): Promise<Snapshot> {
  return {
    files: {
      chat: await readMaybe(paths.chat),
      goalDoc: await readMaybe(paths.goalDoc),
      plan: await readMaybe(paths.plan),
      checkpoint: await readMaybe(paths.checkpoint),
      ledger: await readMaybe(paths.ledger),
      events: await readMaybe(paths.events)
    },
    inboxEntries: await readDirEntries(paths.inbox),
    inboxDoneEntries: await readDirEntries(paths.inboxDone)
  };
}

function assertSnapshotsEqual(before: Snapshot, after: Snapshot): void {
  for (const name of Object.keys(before.files)) {
    assert(after.files[name] === before.files[name], `current ${name} changed after /resume command`);
  }
  assert(JSON.stringify(after.inboxEntries) === JSON.stringify(before.inboxEntries), `current inbox changed after /resume command: before=${JSON.stringify(before.inboxEntries)} after=${JSON.stringify(after.inboxEntries)}`);
  assert(JSON.stringify(after.inboxDoneEntries) === JSON.stringify(before.inboxDoneEntries), `current inbox_done changed after /resume command: before=${JSON.stringify(before.inboxDoneEntries)} after=${JSON.stringify(after.inboxDoneEntries)}`);
}

async function readMaybe(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function readDirEntries(path: string): Promise<string[]> {
  try {
    const names = (await readdir(path)).sort();
    const entries = await Promise.all(names.map(async (name) => `${name}\n${await readMaybe(join(path, name))}`));
    return entries;
  } catch {
    return [];
  }
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
  await appendJsonLine(paths.events, { seq: 1, ts: fixture.updatedAt, type: 'STOP', level: 'info', message: 'command isolation candidate ready to resume' });
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

function expectScript(): string {
  return `
log_user 1
set timeout 30
stty rows 40 columns 180
set env(COLUMNS) 180
set env(LINES) 40
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect -ex ".wici \\[runnable\\] STOP"
send -- "\\033"
expect -ex "resume: cancelled"
send -- "/resume\\r"
expect -ex ".wici \\[runnable\\] STOP"
sleep 2
send -- "x"
sleep 3
send -- "\\003"
expect eof
exit 0
`;
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-command-isolation requires expect on PATH');
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
