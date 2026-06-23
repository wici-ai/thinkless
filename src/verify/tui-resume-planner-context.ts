import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const fixtureRoot = resolve('fixture/tui-resume-planner-context');
const home = join(fixtureRoot, 'home');
const currentTarget = join(fixtureRoot, 'current-target');
const workspaceRoot = join(home, 'thinkless-workspaces');
const decoyTarget = join(workspaceRoot, 'decoy-target');
const currentSession = join(currentTarget, '.thinkless');
const selectedSession = join(currentTarget, '.wici');
const decoySession = join(decoyTarget, '.thinkless');
const builtCli = resolve('dist/src/cli.js');

async function main(): Promise<void> {
  await requireExpect();
  await rm(fixtureRoot, { recursive: true, force: true });
  await createSampleTarget(currentTarget, true);
  await createSampleTarget(decoyTarget, true);

  const currentPaths = runPaths(currentTarget, currentSession);
  const selectedPaths = runPaths(currentTarget, selectedSession);
  const decoyPaths = runPaths(decoyTarget, decoySession);
  await writePlannerCandidate(currentPaths, {
    runId: 'tui-resume-planner-context-current',
    requirement: 'Current planner context must not be resumed',
    chat: 'current planner context chat transcript',
    planner: 'planner-context-current-planner',
    executor: 'planner-context-current-executor',
    appThread: 'planner-context-current-app-thread',
    chatModel: 'planner-context-current-chat-model',
    step: 'Current planner context step',
    ledgerId: 'planner-context-current-ledger',
    assumptions: 'CURRENT_ASSUMPTIONS_SHOULD_NOT_BE_SELECTED',
    context: 'CURRENT_CONTEXT_SHOULD_NOT_BE_SELECTED',
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  await writePlannerCandidate(decoyPaths, {
    runId: 'tui-resume-planner-context-decoy',
    requirement: 'Decoy planner context must not be resumed',
    chat: 'decoy planner context chat transcript',
    planner: 'planner-context-decoy-planner',
    executor: 'planner-context-decoy-executor',
    appThread: 'planner-context-decoy-app-thread',
    chatModel: 'planner-context-decoy-chat-model',
    step: 'Decoy planner context step',
    ledgerId: 'planner-context-decoy-ledger',
    assumptions: 'DECOY_ASSUMPTIONS_SHOULD_NOT_BE_SELECTED',
    context: 'DECOY_CONTEXT_SHOULD_NOT_BE_SELECTED',
    updatedAt: '2026-01-02T00:00:00.000Z'
  });
  await writePlannerCandidate(selectedPaths, {
    runId: 'tui-resume-planner-context-selected',
    requirement: 'Selected planner context must be resumed',
    chat: 'selected planner context chat transcript',
    planner: 'planner-context-selected-planner',
    executor: 'planner-context-selected-executor',
    appThread: 'planner-context-selected-app-thread',
    chatModel: 'planner-context-selected-chat-model',
    step: 'Selected planner context step',
    ledgerId: 'planner-context-selected-ledger',
    assumptions: 'SELECTED_ASSUMPTIONS_MUST_REMAIN_ACTIVE',
    context: 'SELECTED_PLANNER_CONTEXT_MUST_REMAIN_ACTIVE',
    updatedAt: '2026-01-03T00:00:00.000Z'
  });

  const currentBeforeEvents = await readJsonLines<RunEvent>(currentPaths.events);
  const selectedBeforeEvents = await readJsonLines<RunEvent>(selectedPaths.events);
  const decoyBeforeEvents = await readJsonLines<RunEvent>(decoyPaths.events);
  const currentAssumptionsBefore = await readFile(currentPaths.assumptions, 'utf8');
  const selectedAssumptionsBefore = await readFile(selectedPaths.assumptions, 'utf8');
  const decoyAssumptionsBefore = await readFile(decoyPaths.assumptions, 'utf8');
  const currentContextBefore = await readFile(currentPaths.context, 'utf8');
  const selectedContextBefore = await readFile(selectedPaths.context, 'utf8');
  const decoyContextBefore = await readFile(decoyPaths.context, 'utf8');

  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      HOME: home,
      WICI_PTY_TARGET: currentTarget,
      WICI_THINKLESS_BIN: builtCli
    },
    reject: false,
    all: true,
    timeout: 40_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const output = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `resume planner context PTY path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('.wici [runnable] PLAN'), `selected planner candidate was not visible as runnable:\n${output}`);
  assert(output.includes('planner session is available for continuation'), `selected planner continuation reason was not visible:\n${output}`);
  assert(output.includes('Selected planner context must be resumed'), `selected goal summary was not visible:\n${output}`);
  assert(!output.includes('resume blocked:'), `selected planner candidate should not be blocked:\n${output}`);

  const selectedAfterEvents = await readJsonLines<RunEvent>(selectedPaths.events);
  const currentAfterEvents = await readJsonLines<RunEvent>(currentPaths.events);
  const decoyAfterEvents = await readJsonLines<RunEvent>(decoyPaths.events);
  const selectedNewEvents = selectedAfterEvents.slice(selectedBeforeEvents.length);
  const currentNewEvents = currentAfterEvents.slice(currentBeforeEvents.length);
  const decoyNewEvents = decoyAfterEvents.slice(decoyBeforeEvents.length);
  const validated = selectedNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  assert(validated, `selected candidate should validate resume context: ${JSON.stringify(selectedNewEvents)}\n${output}`);
  assert(selectedNewEvents.some((event) => event.type === 'SUPERVISOR_START'), `selected candidate should launch supervisor: ${JSON.stringify(selectedNewEvents)}\n${output}`);
  assert(!selectedNewEvents.some((event) => event.type === 'RESUME_CONTEXT_BLOCKED' || event.type === 'EXECUTOR_RESUME_FALLBACK'), `selected candidate emitted unexpected resume events: ${JSON.stringify(selectedNewEvents)}`);
  assert(!currentNewEvents.some(isResumeLaunchEvent), `current target received resume launch events: ${JSON.stringify(currentNewEvents)}`);
  assert(!decoyNewEvents.some(isResumeLaunchEvent), `decoy target received resume launch events: ${JSON.stringify(decoyNewEvents)}`);

  const validation = validated.data as {
    target?: string;
    session_dir?: string | null;
    planner_session?: string | null;
    executor_session?: string | null;
    executor_app_thread?: string | null;
    fallback?: string | null;
  } | undefined;
  assert(validation?.target === currentTarget, `validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === selectedSession, `validated selected session mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === 'planner-context-selected-planner', `validated planner session mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === 'planner-context-selected-executor', `validated executor session mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === 'planner-context-selected-app-thread', `validated app thread mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.fallback === null, `selected planner session should continue without rerun fallback: ${JSON.stringify(validation)}`);

  assert(await readFile(selectedPaths.assumptions, 'utf8') === selectedAssumptionsBefore, 'selected ASSUMPTIONS.md should remain available and unmodified');
  assert(await readFile(selectedPaths.context, 'utf8') === selectedContextBefore, 'selected planner context.md should remain available and unmodified');
  assert(selectedAssumptionsBefore.includes('SELECTED_ASSUMPTIONS_MUST_REMAIN_ACTIVE'), 'selected assumptions marker missing');
  assert(selectedContextBefore.includes('SELECTED_PLANNER_CONTEXT_MUST_REMAIN_ACTIVE'), 'selected planner context marker missing');
  assert(await readFile(currentPaths.assumptions, 'utf8') === currentAssumptionsBefore, 'current ASSUMPTIONS.md should not be mutated');
  assert(await readFile(decoyPaths.assumptions, 'utf8') === decoyAssumptionsBefore, 'decoy ASSUMPTIONS.md should not be mutated');
  assert(await readFile(currentPaths.context, 'utf8') === currentContextBefore, 'current planner context should not be mutated');
  assert(await readFile(decoyPaths.context, 'utf8') === decoyContextBefore, 'decoy planner context should not be mutated');

  const checkpoint = await readFile(selectedPaths.checkpoint, 'utf8');
  assert(checkpoint.includes('planner-context-selected-planner'), 'selected checkpoint should preserve planner session');
  assert(checkpoint.includes('planner-context-selected-executor'), 'selected checkpoint should preserve executor session');
  assert(checkpoint.includes('planner-context-selected-app-thread'), 'selected checkpoint should preserve executor app thread');
  assert((await readFile(selectedPaths.chat, 'utf8')).includes('selected planner context chat transcript'), 'selected chat transcript should remain available');
  assert((await readFile(selectedPaths.runtimeSelection, 'utf8')).includes('planner-context-selected-chat-model'), 'selected runtime selection should remain available');
  assert((await readFile(selectedPaths.goalDoc, 'utf8')).includes('Selected planner context must be resumed'), 'selected GOAL.md should remain available');
  assert((await readFile(selectedPaths.plan, 'utf8')).includes('Selected planner context step'), 'selected PLAN.md should remain available');
  assert((await readFile(selectedPaths.ledger, 'utf8')).includes('planner-context-selected-ledger'), 'selected ledger should remain available');

  console.log(JSON.stringify({
    ok: true,
    target: currentTarget,
    selectedSession,
    decoyTarget,
    selectedPlannerContextPreserved: true,
    currentAndDecoyUnchanged: true,
    resume_validated: true,
    supervisor_started: true
  }, null, 2));
}

interface PlannerFixture {
  runId: string;
  requirement: string;
  chat: string;
  planner: string;
  executor: string;
  appThread: string;
  chatModel: string;
  step: string;
  ledgerId: string;
  assumptions: string;
  context: string;
  updatedAt: string;
}

async function writePlannerCandidate(paths: ReturnType<typeof runPaths>, fixture: PlannerFixture): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal(fixture));
  await atomicWriteJson(paths.checkpoint, checkpoint(fixture));
  await appendJsonLine(paths.events, { seq: 1, ts: fixture.updatedAt, type: 'PLAN_START', level: 'info', message: 'planner context candidate ready to continue' });
  await appendJsonLine(paths.chat, { ts: fixture.updatedAt, role: 'user', text: fixture.chat });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: fixture.chatModel } });
  await writeText(paths.goalDoc, `# GOAL\n\n${fixture.requirement}.\n`);
  await writeText(paths.plan, `# PLAN\n\n- [>] S1 ${fixture.step}\n`);
  await writeText(paths.assumptions, [
    '# ASSUMPTIONS',
    '',
    '## Approaches considered',
    `- ${fixture.assumptions}`,
    '',
    '## Assumptions adopted',
    `- ${fixture.assumptions} is the authoritative planner self-interrogation context for this fixture.`,
    '',
    '## Open risks',
    '- Cross-wired resume context would select the wrong assumptions marker.'
  ].join('\n'));
  await writeText(paths.context, `# Planner Context\n\n${fixture.context}\n`);
  await writeText(paths.ledger, `{"id":"${fixture.ledgerId}","status":"keep","cost":{"wall_ms":0,"tokens_input":0,"tokens_output":0,"usd":0}}\n`);
  await writeText(join(paths.artifacts, `planner-${fixture.planner}.stdout.jsonl`), `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: fixture.planner,
    result: `planner transcript for ${fixture.assumptions}`
  })}\n`);
  await writeText(paths.codexRun, `${JSON.stringify({ session_id: fixture.executor, marker: fixture.appThread })}\n`);
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content.endsWith('\n') ? content : `${content}\n`);
}

function goal(fixture: PlannerFixture): GoalFile {
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

function checkpoint(fixture: PlannerFixture): Checkpoint {
  return {
    supervisor_state: 'PLAN',
    next_step: 'S1',
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
expect -ex ".wici \\[runnable\\] PLAN"
expect -ex "planner session is available for continuation"
send -- "\\n"
sleep 3
send -- "\\003"
expect eof
exit 0
`;
}

function isResumeLaunchEvent(event: RunEvent): boolean {
  return event.type === 'RESUME_CONTEXT_VALIDATED' || event.type === 'SUPERVISOR_START' || event.type === 'EXECUTOR_RESUME_FALLBACK';
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-resume-planner-context requires expect on PATH');
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
