import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const fixtureRoot = resolve('fixture/tui-resume-many-candidates');
const home = join(fixtureRoot, 'home');
const currentTarget = join(fixtureRoot, 'current-target');
const workspaceRoot = join(home, 'thinkless-workspaces');
const historicalTarget = join(workspaceRoot, 'many-candidates-target');
const selectedSession = join(historicalTarget, '.thinkless10');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await rm(fixtureRoot, { recursive: true, force: true });
  await createSampleTarget(currentTarget, true);
  await createSampleTarget(historicalTarget, true);

  const decoySessions: string[] = [];
  for (let index = 2; index <= 12; index += 1) {
    const session = join(historicalTarget, `.thinkless${index}`);
    if (session !== selectedSession) decoySessions.push(session);
    await writeRunnableRun(runPaths(historicalTarget, session), {
      runId: `tui-resume-many-candidates-${index}`,
      requirement: `Many candidate resume goal ${index}`,
      chat: `many candidate chat ${index}`,
      planner: `many-candidates-planner-${index}`,
      executor: `many-candidates-executor-${index}`,
      appThread: `many-candidates-app-thread-${index}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 20 - index)).toISOString()
    });
  }

  const selectedPaths = runPaths(historicalTarget, selectedSession);
  const selectedBefore = await readJsonLines<RunEvent>(selectedPaths.events);
  const decoyBefore = new Map<string, RunEvent[]>();
  for (const session of decoySessions) {
    decoyBefore.set(session, await readJsonLines<RunEvent>(runPaths(historicalTarget, session).events));
  }

  const result = await execa('expect', ['-c', manyCandidatesExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      HOME: home,
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: currentTarget,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 40_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `many-candidate resume selector PTY failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('.thinkless10 [runnable] STOP'), `selected candidate beyond the first viewport was not visible before Enter:\n${output}`);
  assert(output.includes('> many-candidates-target .thinkless10 [runnable] STOP'), `later candidate was not visibly highlighted before Enter:\n${output}`);

  const selectedAfter = await readJsonLines<RunEvent>(selectedPaths.events);
  const selectedNewEvents = selectedAfter.slice(selectedBefore.length);
  assert(selectedNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `selected later candidate should launch supervisor after Enter:\n${output}`);
  const validated = selectedNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `selected later candidate should validate resume context before launch:\n${output}`);
  const validation = validated.data as {
    target?: string;
    session_dir?: string | null;
    planner_session?: string | null;
    executor_session?: string | null;
    executor_app_thread?: string | null;
  } | undefined;
  assert(validation?.target === historicalTarget, `validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === selectedSession, `validated session dir mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === 'many-candidates-planner-10', `validated planner session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === 'many-candidates-executor-10', `validated executor session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === 'many-candidates-app-thread-10', `validated executor app thread missing: ${JSON.stringify(validation)}`);

  const checkpoint = await readFile(selectedPaths.checkpoint, 'utf8');
  assert(checkpoint.includes('many-candidates-planner-10'), 'selected later session checkpoint should preserve planner session');
  assert(checkpoint.includes('many-candidates-executor-10'), 'selected later session checkpoint should preserve executor session');
  assert(checkpoint.includes('many-candidates-app-thread-10'), 'selected later session checkpoint should preserve executor app thread');
  const chat = await readFile(selectedPaths.chat, 'utf8');
  assert(chat.includes('many candidate chat 10'), 'selected later session chat transcript should remain available');

  for (const [session, before] of decoyBefore) {
    const after = await readJsonLines<RunEvent>(runPaths(historicalTarget, session).events);
    assert(after.length === before.length, `many-candidate selection should not mutate decoy session ${session}`);
  }

  console.log(JSON.stringify({ ok: true, currentTarget, historicalTarget, selectedSession, selectedNewEvents: selectedNewEvents.length, decoysChecked: decoyBefore.size, resume_validated: true }, null, 2));
}

function manyCandidatesExpectScript(): string {
  return `
log_user 1
set timeout 30
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect "many-candidates-target .thinkless2"
send -- "\\033\\[B"
expect "*> many-candidates-target .thinkless3*"
send -- "\\033\\[B"
expect "*> many-candidates-target .thinkless4*"
send -- "\\033\\[B"
expect "*> many-candidates-target .thinkless5*"
send -- "\\033\\[B"
expect "*> many-candidates-target .thinkless6*"
send -- "\\033\\[B"
expect "*> many-candidates-target .thinkless7*"
send -- "\\033\\[B"
expect "*> many-candidates-target .thinkless8*"
send -- "\\033\\[B"
expect "*> many-candidates-target .thinkless9*"
send -- "\\033\\[B"
expect "*> many-candidates-target .thinkless10*"
send -- "\\n"
sleep 8
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
  updatedAt: string;
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
  await writeFile(path, content);
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
        updatedAt: fixture.updatedAt,
        phase: 'idle'
      }
    },
    drained_inbox: [],
    updated_at: fixture.updatedAt
  };
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-many-candidates requires expect on PATH');
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
