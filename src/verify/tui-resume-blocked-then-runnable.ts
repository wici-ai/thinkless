import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const target = resolve('fixture/rbt-target');
const staleSession = join(target, '.thinkless2');
const runnableSession = join(target, '.thinkless3');
const builtCli = resolve('dist/src/cli.js');
const staleReason = 'planner session is missing durable transcript state';
const forbiddenTypes = new Set(['RESUME_CONTEXT_VALIDATED', 'SUPERVISOR_START', 'EXECUTOR_RESUME_FALLBACK']);

async function main(): Promise<void> {
  await requireExpect();
  await rm(target, { recursive: true, force: true });
  await createSampleTarget(target, true);

  const stalePaths = runPaths(target, staleSession);
  const runnablePaths = runPaths(target, runnableSession);
  await writeRunnableRun(runnablePaths);
  await writeStalePlannerRun(stalePaths);

  const staleBefore = await readJsonLines<RunEvent>(stalePaths.events);
  const runnableBefore = await readJsonLines<RunEvent>(runnablePaths.events);
  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      WICI_PTY_TARGET: target,
      WICI_THINKLESS_BIN: builtCli,
      STALE_PLANNER_TRANSCRIPT: join(stalePaths.artifacts, 'planner-initial.stdout.jsonl')
    },
    reject: false,
    all: true,
    timeout: 35_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `blocked-then-runnable PTY path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('.thinkless2 [runnable] PLAN'), `stale candidate was not initially visible as runnable:\n${output}`);
  assert(output.includes(`resume blocked: ${staleReason}`), `blocked reason was not visible:\n${output}`);
  assert(output.includes('Runnable decoy after blocked selection'), `runnable decoy was not visible after blocked selection:\n${output}`);

  const staleAfter = await readJsonLines<RunEvent>(stalePaths.events);
  const runnableAfter = await readJsonLines<RunEvent>(runnablePaths.events);
  const staleNewEvents = staleAfter.slice(staleBefore.length);
  const runnableNewEvents = runnableAfter.slice(runnableBefore.length);
  const blocked = staleNewEvents.find((event) => event.type === 'RESUME_CONTEXT_BLOCKED');
  assert(blocked, `stale candidate should emit RESUME_CONTEXT_BLOCKED: ${JSON.stringify(staleNewEvents)}`);
  assert((blocked.data as { reason?: string } | undefined)?.reason === staleReason, `stale candidate blocked reason mismatch: ${JSON.stringify(blocked)}`);
  assert(!staleNewEvents.some((event) => forbiddenTypes.has(event.type)), `stale candidate emitted launch events: ${JSON.stringify(staleNewEvents)}`);

  const validated = runnableNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `runnable decoy should validate after blocked selection recovery: ${JSON.stringify(runnableNewEvents)}\n${output}`);
  assert(runnableNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `runnable decoy should launch supervisor: ${JSON.stringify(runnableNewEvents)}\n${output}`);
  assert(!runnableNewEvents.some((event) => event.type === 'RESUME_CONTEXT_BLOCKED' || event.type === 'EXECUTOR_RESUME_FALLBACK'), `runnable decoy emitted unexpected events: ${JSON.stringify(runnableNewEvents)}`);
  const validation = validated.data as {
    target?: string;
    session_dir?: string | null;
    planner_session?: string | null;
    executor_session?: string | null;
    executor_app_thread?: string | null;
  } | undefined;
  assert(validation?.target === target, `validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === runnableSession, `validated session dir mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === 'blocked-then-runnable-planner', `validated planner session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === 'blocked-then-runnable-executor', `validated executor session missing: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === 'blocked-then-runnable-app-thread', `validated executor app thread missing: ${JSON.stringify(validation)}`);

  const checkpoint = await readFile(runnablePaths.checkpoint, 'utf8');
  assert(checkpoint.includes('blocked-then-runnable-planner'), 'runnable checkpoint should preserve planner session');
  assert(checkpoint.includes('blocked-then-runnable-executor'), 'runnable checkpoint should preserve executor session');
  assert(checkpoint.includes('blocked-then-runnable-app-thread'), 'runnable checkpoint should preserve executor app thread');
  const chat = await readFile(runnablePaths.chat, 'utf8');
  assert(chat.includes('blocked then runnable selected chat'), 'runnable chat transcript should remain available');
  const runtime = await readFile(runnablePaths.runtimeSelection, 'utf8');
  assert(runtime.includes('blocked-then-runnable-chat-model'), 'runnable runtime selection should remain available');
  const goalDoc = await readFile(runnablePaths.goalDoc, 'utf8');
  assert(goalDoc.includes('Runnable decoy after blocked selection'), 'runnable GOAL.md should remain active context');
  const plan = await readFile(runnablePaths.plan, 'utf8');
  assert(plan.includes('Resume after blocked selector step'), 'runnable PLAN.md should remain available');
  const ledger = await readFile(runnablePaths.ledger, 'utf8');
  assert(ledger.includes('blocked-then-runnable-ledger'), 'runnable ledger should remain available');

  console.log(JSON.stringify({
    ok: true,
    target,
    staleSession,
    runnableSession,
    staleBlocked: true,
    runnableLaunchedAfterBlock: true,
    resume_validated: true
  }, null, 2));
}

async function writeStalePlannerRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal('tui-resume-blocked-then-runnable-stale', 'Initially runnable planner state that goes stale'));
  await atomicWriteJson(paths.checkpoint, checkpoint('PLAN', { planner: 'blocked-then-runnable-stale-planner' }));
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'PLAN_START', level: 'info', message: 'planner candidate ready before transcript removal' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'blocked stale planner chat' });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: 'blocked-stale-chat-model' } });
  await writeText(paths.goalDoc, '# GOAL\n\nInitially runnable planner state that goes stale.\n');
  await writeText(paths.plan, '# PLAN\n\n- [>] S1 Stale planner step\n');
  await writeText(paths.ledger, '');
  await ensureDir(paths.artifacts);
  await writeFile(join(paths.artifacts, 'planner-initial.stdout.jsonl'), `${JSON.stringify({ type: 'result', session_id: 'blocked-then-runnable-stale-planner' })}\n`);
}

async function writeRunnableRun(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal('tui-resume-blocked-then-runnable', 'Runnable decoy after blocked selection'));
  await atomicWriteJson(paths.checkpoint, checkpoint('STOP', {
    planner: 'blocked-then-runnable-planner',
    executor: 'blocked-then-runnable-executor',
    executorApp: {
      threadId: 'blocked-then-runnable-app-thread',
      updatedAt: ts(),
      phase: 'idle'
    }
  }));
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: 'runnable decoy ready to resume' });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: 'blocked then runnable selected chat' });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: 'blocked-then-runnable-chat-model' } });
  await writeText(paths.goalDoc, '# GOAL\n\nRunnable decoy after blocked selection.\n');
  await writeText(paths.plan, '# PLAN\n\n- [x] S1 Resume after blocked selector step\n');
  await writeText(paths.ledger, `${JSON.stringify({
    id: 'blocked-then-runnable-ledger',
    ts: ts(),
    iter: 0,
    step_id: 'S1',
    commit: null,
    hypothesis: 'resume selector recovery fixture',
    metric: null,
    baseline: null,
    delta_pct: null,
    confidence: 'fixture',
    cost: { wall_ms: 0, tokens_input: 0, tokens_output: 0, usd: 0 },
    guards: {},
    status: 'keep',
    reflection: 'runnable decoy ledger row'
  })}\n`);
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content);
}

function expectScript(): string {
  return `
log_user 1
set timeout 25
stty rows 40 columns 180
set env(COLUMNS) 180
set env(LINES) 40
spawn "$env(WICI_THINKLESS_BIN)" tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode stub --no-fullscreen
expect "CHAT"
send -- "/resume\\r"
expect -ex ".thinkless2 \\[runnable\\] PLAN"
file delete -force "$env(STALE_PLANNER_TRANSCRIPT)"
send -- "\\n"
expect -ex "resume blocked: ${staleReason}"
expect -ex ".thinkless3 \\[runnable\\] STOP"
send -- "\\033\\[B"
expect -ex "Selected runnable: stopped run can be explicitly resumed"
sleep 1
send -- "\\r"
sleep 2
send -- "\\003"
expect eof
exit 0
`;
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
  assert(found.exitCode === 0, 'verify:tui-resume-blocked-then-runnable requires expect on PATH');
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
