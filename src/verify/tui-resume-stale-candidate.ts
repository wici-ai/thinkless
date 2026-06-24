import { rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const target = resolve('fixture/tui-resume-stale-candidate-target');
const staleSession = join(target, '.thinkless2');
const decoySession = join(target, '.thinkless3');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await rm(target, { recursive: true, force: true });
  await createSampleTarget(target, true);
  await writeRunnableRun(runPaths(target, decoySession), {
    runId: 'tui-resume-stale-candidate-decoy',
    requirement: 'Runnable decoy for stale candidate preflight',
    chat: 'stale candidate runnable decoy chat',
    planner: 'stale-candidate-decoy-planner',
    executor: 'stale-candidate-decoy-executor',
    appThread: 'stale-candidate-decoy-app-thread'
  });
  await writeRunnableRun(runPaths(target, staleSession), {
    runId: 'tui-resume-stale-candidate',
    requirement: 'Initially runnable stale resume candidate',
    chat: 'stale candidate selected chat',
    planner: 'stale-candidate-planner',
    executor: 'stale-candidate-executor',
    appThread: 'stale-candidate-app-thread'
  });

  const stalePaths = runPaths(target, staleSession);
  const decoyPaths = runPaths(target, decoySession);
  const staleBefore = await readJsonLines<RunEvent>(stalePaths.events);
  const decoyBefore = await readJsonLines<RunEvent>(decoyPaths.events);
  const result = await execa('expect', ['-c', staleExpectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      HOME: join(target, '.home'),
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: target,
      WICI_THINKLESS_BIN: builtCli,
      STALE_CHECKPOINT: stalePaths.checkpoint
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `stale resume candidate PTY path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('.thinkless2 [runnable] STOP'), `stale candidate was not initially visible as runnable:\n${output}`);

  const staleAfter = await readJsonLines<RunEvent>(stalePaths.events);
  const decoyAfter = await readJsonLines<RunEvent>(decoyPaths.events);
  const staleNewEvents = staleAfter.slice(staleBefore.length);
  const decoyNewEvents = decoyAfter.slice(decoyBefore.length);
  const validated = staleNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `stale candidate should validate degraded resume context: ${JSON.stringify(staleNewEvents)}`);
  assert((validated.data as { fallback?: string | null } | undefined)?.fallback === 'planner_rerun', `stale candidate fallback mismatch: ${JSON.stringify(validated)}`);
  assert(staleNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `stale candidate should launch supervisor through planner rerun: ${JSON.stringify(staleNewEvents)}`);
  assert(!staleNewEvents.some((event) => event.type === 'RESUME_CONTEXT_BLOCKED'), `stale candidate should not block after checkpoint loss: ${JSON.stringify(staleNewEvents)}`);
  assert(decoyNewEvents.length === 0, `stale candidate selection should not mutate runnable decoy events: ${JSON.stringify(decoyNewEvents)}`);

  console.log(JSON.stringify({ ok: true, target, staleSession, decoySession, staleRerun: true, decoyUnchanged: true }, null, 2));
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

function staleExpectScript(): string {
  return `
log_user 1
set timeout 25
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect ".thinkless2 \\[runnable\\] STOP"
file delete -force "$env(STALE_CHECKPOINT)"
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

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-stale-candidate requires expect on PATH');
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
