import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, OutboxMessage, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/resume-rerunnable-target');

async function main(): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await initGit(target);

  const plannerSession = join(target, '.thinkless-planner');
  const plannerPaths = runPaths(target, plannerSession);
  await writeRun(plannerPaths, checkpoint('PLAN'));
  await writeOutbox(plannerPaths, {
    id: 'out-planner',
    ts: ts(),
    kind: 'question',
    text: 'Need planner clarification',
    reply_key: 'planner-clarify-rerunnable'
  });
  const planner = await runSupervisor({ target, sessionDir: plannerSession, resumePreflight: true, mode: 'stub', maxIters: 0 });
  assert(planner.state === 'STOP' || planner.state === 'RUNNING', `planner rerun resume should not fail: ${JSON.stringify(planner)}`);
  const plannerEvents = await readJsonLines<RunEvent>(plannerPaths.events);
  const plannerValidated = plannerEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(plannerValidated, 'planner rerun resume should emit RESUME_CONTEXT_VALIDATED');
  assert((plannerValidated.data as { fallback?: string | null } | undefined)?.fallback === 'planner_rerun', `planner rerun fallback mismatch: ${JSON.stringify(plannerValidated)}`);
  assert(plannerEvents.some((event) => event.type === 'SUPERVISOR_START'), 'planner rerun resume should actually launch the supervisor');
  assert(!plannerEvents.some((event) => event.type === 'RESUME_CONTEXT_BLOCKED'), 'planner rerun resume must not emit blocked');

  const executorSession = join(target, '.thinkless-executor');
  const executorPaths = runPaths(target, executorSession);
  await writeRun(executorPaths, checkpoint('EXECUTE', {}, 'S1'));
  const resumed = await runSupervisor({ target, sessionDir: executorSession, resumePreflight: true, mode: 'stub', maxIters: 0 });
  assert(resumed.state === 'STOP' || resumed.state === 'RUNNING', `executor fallback resume should not fail: ${JSON.stringify(resumed)}`);
  const executorEvents = await readJsonLines<RunEvent>(executorPaths.events);
  assert(executorEvents.some((event) => event.type === 'RESUME_CONTEXT_VALIDATED'), 'executor fallback resume should emit RESUME_CONTEXT_VALIDATED');
  assert(executorEvents.some((event) => event.type === 'EXECUTOR_RESUME_FALLBACK'), 'executor fallback resume should emit EXECUTOR_RESUME_FALLBACK');
  assert(executorEvents.some((event) => event.type === 'SUPERVISOR_START'), 'executor fallback resume should actually launch the supervisor');

  console.log(JSON.stringify({ ok: true, plannerEvents: plannerEvents.length, executorEvents: executorEvents.length }, null, 2));
}

async function initGit(root: string): Promise<void> {
  await writeFile(join(root, 'package.json'), '{"type":"module","scripts":{"test":"node test.mjs"}}\n');
  await writeFile(join(root, 'test.mjs'), 'console.log("ok");\n');
  const { execa } = await import('execa');
  await execa('git', ['-C', root, 'init']);
  await execa('git', ['-C', root, 'config', 'user.name', 'WiCi Fixture']);
  await execa('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  await execa('git', ['-C', root, 'add', '-A']);
  await execa('git', ['-C', root, 'commit', '-m', 'chore: initial fixture']);
}

async function writeRun(paths: ReturnType<typeof runPaths>, checkpointFile: Checkpoint): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal());
  await writeFile(paths.goalDoc, '# GOAL\n\nResume rerunnable test goal.\n');
  await writeFile(paths.plan, '# PLAN\n\n- [ ] S1 Resume rerunnable step\n  - Action: keep fixture stable.\n  - Validation: node test.mjs\n');
  await writeFile(paths.ledger, '');
  await atomicWriteJson(paths.checkpoint, checkpointFile);
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'SUPERVISOR_START', level: 'info', message: 'previous start' });
}

async function writeOutbox(paths: ReturnType<typeof runPaths>, message: OutboxMessage): Promise<void> {
  await ensureDir(paths.outbox);
  await atomicWriteJson(join(paths.outbox, `${message.id}.json`), message);
}

function goal(): GoalFile {
  return {
    run_id: 'resume-rerunnable',
    version: 1,
    requirements: [{ id: 'R1', text: 'Resume rerunnable test goal', source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'tests', direction: 'maximize', unit: 'pass' },
    budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
    stop: { tau: 0, K: 0, N: 0, mode: 'auto' }
  };
}

function checkpoint(state: Checkpoint['supervisor_state'], sessions: Checkpoint['sessions'] = {}, nextStep: string | null = null): Checkpoint {
  return {
    supervisor_state: state,
    next_step: nextStep,
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

function ts(): string {
  return new Date().toISOString();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
