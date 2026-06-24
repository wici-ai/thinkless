import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWriteJson, appendJsonLine, ensureDir } from '../shared/atomic.js';
import { discoverResumeCandidates, loadResumeContext, preflightResumeCandidate } from '../shared/resume.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, OutboxMessage } from '../shared/types.js';

const target = resolve('fixture/resume-selector-target');

async function main(): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  const current = runPaths(target, join(target, '.thinkless'));
  await writeRun(current, checkpoint('STOP'), true);
  await appendJsonLine(current.chat, { ts: ts(), role: 'user', text: 'chat context' });
  await atomicWriteJson(current.runtimeSelection, { chat: { agent: 'codex', model: 'gpt-5' } });

  const numbered = join(target, '.thinkless2');
  const numberedPaths = runPaths(target, numbered);
  await writeRun(numberedPaths, checkpoint('PLAN', { planner: 'planner-session' }), true);
  await writePlannerTranscript(numberedPaths);

  const legacy = join(target, '.wici');
  await writeRun(runPaths(target, legacy), checkpoint('EXECUTE', {}, 'S1'), true);

  const blockedPlanner = join(target, '.thinkless3');
  await writeRun(runPaths(target, blockedPlanner), checkpoint('PLAN'), true);
  await writeOutbox(runPaths(target, blockedPlanner), {
    id: 'out-planner',
    ts: ts(),
    kind: 'question',
    text: 'Need clarification',
    reply_key: 'planner-clarify-test'
  });

  const chatOnly = join(target, '.thinkless4');
  await ensureDir(chatOnly);
  await appendJsonLine(join(chatOnly, 'chat.jsonl'), { ts: ts(), role: 'user', text: 'chat only' });

  const chatOnlyWithRunNoise = join(target, '.thinkless5');
  const chatOnlyWithRunNoisePaths = runPaths(target, chatOnlyWithRunNoise);
  await ensureDir(chatOnlyWithRunNoisePaths.stateDir);
  await appendJsonLine(chatOnlyWithRunNoisePaths.chat, { ts: ts(), role: 'user', text: 'chat only without goal but with prior events' });
  await appendJsonLine(chatOnlyWithRunNoisePaths.events, { seq: 1, ts: ts(), type: 'CHAT_ONLY', level: 'info', message: 'chat happened before any goal' });
  await appendJsonLine(chatOnlyWithRunNoisePaths.ledger, { id: 'noise', ts: ts(), status: 'chat-only' });
  await atomicWriteJson(chatOnlyWithRunNoisePaths.runtimeSelection, { chat: { agent: 'codex', model: 'gpt-5.5' } });

  const candidates = await discoverResumeCandidates({ currentTarget: target, limit: 20 });
  const currentCandidate = candidates.find((candidate) => candidate.stateDir === current.stateDir);
  const numberedCandidate = candidates.find((candidate) => candidate.sessionDir === numbered);
  const legacyCandidate = candidates.find((candidate) => candidate.sessionDir === legacy);
  const blockedCandidate = candidates.find((candidate) => candidate.sessionDir === blockedPlanner);
  const chatCandidate = candidates.find((candidate) => candidate.sessionDir === chatOnly);
  const chatNoiseCandidate = candidates.find((candidate) => candidate.sessionDir === chatOnlyWithRunNoise);

  assert(currentCandidate?.runnable, `current run should be runnable: ${JSON.stringify(currentCandidate)}`);
  assert(currentCandidate.hasChat && currentCandidate.hasRuntimeSelection, 'candidate should expose chat/runtime presence');
  assert(numberedCandidate?.runnable && numberedCandidate.plannerSessionId === 'planner-session', `numbered planner run missing: ${JSON.stringify(numberedCandidate)}`);
  assert(legacyCandidate?.runnable && legacyCandidate.fallback === 'executor_rerun', `legacy executor fallback missing: ${JSON.stringify(legacyCandidate)}`);
  assert(
    blockedCandidate?.runnable &&
      blockedCandidate.fallback === 'planner_rerun' &&
      blockedCandidate.reason.includes('clarification session was not persisted'),
    `planner run without a persisted clarification session should rerun instead of blocking resume: ${JSON.stringify(blockedCandidate)}`
  );
  assert(chatCandidate?.runnable && chatCandidate.fallback === 'chat_only', `chat-only run should resume chat context: ${JSON.stringify(chatCandidate)}`);
  assert(
    chatNoiseCandidate?.runnable &&
      chatNoiseCandidate.fallback === 'chat_only' &&
      chatNoiseCandidate.reason.includes('without GOAL.md') &&
      chatNoiseCandidate.goalSummary.includes('chat only without goal'),
    `chat-only run with events/ledger and no goal should still resume Chat: ${JSON.stringify(chatNoiseCandidate)}`
  );

  const context = await loadResumeContext(numberedCandidate);
  assert(context.goal?.run_id === 'resume-selector-run', 'loadResumeContext should preserve selected goal');
  assert(context.checkpoint?.sessions.planner === 'planner-session', 'loadResumeContext should preserve selected planner session');
  assert(context.paths.stateDir === numbered, 'loadResumeContext should use selected session dir');

  const preflight = await preflightResumeCandidate(target, legacy);
  assert(preflight.runnable && preflight.fallback === 'executor_rerun', `preflight should report executor rerun fallback: ${JSON.stringify(preflight)}`);

  console.log(JSON.stringify({ ok: true, candidates: candidates.length, current: currentCandidate.id, numbered: numberedCandidate.id }, null, 2));
}

async function writeRun(paths: ReturnType<typeof runPaths>, checkpointFile: Checkpoint, withPlan: boolean): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal());
  await writeFile(paths.goalDoc, '# GOAL\n\nResume selector test goal.\n');
  if (withPlan) await writeFile(paths.plan, '# PLAN\n\n- [ ] S1 Resume selector step\n');
  await writeFile(paths.ledger, '');
  await atomicWriteJson(paths.checkpoint, checkpointFile);
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'SUPERVISOR_START', level: 'info', message: 'start' });
}

async function writeOutbox(paths: ReturnType<typeof runPaths>, message: OutboxMessage): Promise<void> {
  await ensureDir(paths.outbox);
  await atomicWriteJson(join(paths.outbox, `${message.id}.json`), message);
}

async function writePlannerTranscript(paths: ReturnType<typeof runPaths>): Promise<void> {
  await ensureDir(paths.artifacts);
  await writeFile(join(paths.artifacts, 'planner-initial.stdout.jsonl'), `${JSON.stringify({ type: 'result', session_id: 'planner-session' })}\n`);
}

function goal(): GoalFile {
  return {
    run_id: 'resume-selector-run',
    version: 1,
    requirements: [{ id: 'R1', text: 'Resume selector test goal', source: 'initial', status: 'active' }],
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
