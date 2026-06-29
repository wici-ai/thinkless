import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonFileMaybe, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';
import { previewRollback } from '../supervisor/rollback.js';
import { assertNoActiveToolVersionDrift } from '../supervisor/selfupdate.js';
import { requireExpectOrSkip } from './expect.js';

const fixtureRoot = resolve('fixture/tui-resume-supervisor-safety');
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

  const currentBest = await git(currentTarget, ['rev-parse', 'HEAD']);
  await writeText(join(currentTarget, 'selected-rollback.txt'), 'selected rollback point\n');
  await git(currentTarget, ['add', 'selected-rollback.txt']);
  await git(currentTarget, ['commit', '-m', 'test: selected resume rollback point']);
  const selectedBest = await git(currentTarget, ['rev-parse', 'HEAD']);
  const decoyBest = await git(decoyTarget, ['rev-parse', 'HEAD']);

  const currentPaths = runPaths(currentTarget, currentSession);
  const selectedPaths = runPaths(currentTarget, selectedSession);
  const decoyPaths = runPaths(decoyTarget, decoySession);
  await writeRunnableRun(currentPaths, fixture({
    runId: 'tui-resume-supervisor-safety-current',
    requirement: 'Current safety context must not be resumed',
    marker: 'current',
    bestCommit: currentBest,
    toolVersions: toolVersions('current')
  }));
  await writeRunnableRun(decoyPaths, fixture({
    runId: 'tui-resume-supervisor-safety-decoy',
    requirement: 'Decoy safety context must not be resumed',
    marker: 'decoy',
    bestCommit: decoyBest,
    toolVersions: toolVersions('decoy')
  }));
  await writeRunnableRun(selectedPaths, fixture({
    runId: 'tui-resume-supervisor-safety-selected',
    requirement: 'Selected supervisor safety context must be resumed',
    marker: 'selected',
    bestCommit: selectedBest,
    toolVersions: toolVersions('selected')
  }));

  const preview = await previewRollback(selectedPaths);
  assert(preview.source === 'checkpoint.best_commit', `selected rollback preview should use checkpoint.best_commit: ${JSON.stringify(preview)}`);
  assert(preview.rollback_commit === selectedBest, `selected rollback preview commit mismatch: ${JSON.stringify(preview)} expected ${selectedBest}`);
  assert(preview.wici?.package_version === '0.1.selected', `selected rollback preview should expose selected WiCi metadata: ${JSON.stringify(preview.wici)}`);
  assertWiCiDriftIsRejected();

  const currentBeforeCheckpoint = await readFile(currentPaths.checkpoint, 'utf8');
  const selectedBeforeCheckpoint = await readFile(selectedPaths.checkpoint, 'utf8');
  const decoyBeforeCheckpoint = await readFile(decoyPaths.checkpoint, 'utf8');
  const currentBeforeEvents = await readJsonLines<RunEvent>(currentPaths.events);
  const selectedBeforeEvents = await readJsonLines<RunEvent>(selectedPaths.events);
  const decoyBeforeEvents = await readJsonLines<RunEvent>(decoyPaths.events);

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
  assert(result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143, `resume supervisor safety PTY path failed with code ${result.exitCode}:\n${output}`);
  assert(output.includes('.wici [runnable] STOP'), `selected safety candidate was not visible as runnable:\n${output}`);
  assert(output.includes('Selected supervisor safety context must be resumed'), `selected safety goal was not visible:\n${output}`);
  assert(!output.includes('resume blocked:'), `selected safety candidate should not be blocked:\n${output}`);

  const selectedAfterEvents = await readJsonLines<RunEvent>(selectedPaths.events);
  const currentAfterEvents = await readJsonLines<RunEvent>(currentPaths.events);
  const decoyAfterEvents = await readJsonLines<RunEvent>(decoyPaths.events);
  const selectedNewEvents = selectedAfterEvents.slice(selectedBeforeEvents.length);
  const currentNewEvents = currentAfterEvents.slice(currentBeforeEvents.length);
  const decoyNewEvents = decoyAfterEvents.slice(decoyBeforeEvents.length);
  const validated = selectedNewEvents.find((event) => event.type === 'RESUME_CONTEXT_VALIDATED');
  const started = selectedNewEvents.find((event) => event.type === 'SUPERVISOR_START');
  assert(validated, `selected candidate should validate resume context: ${JSON.stringify(selectedNewEvents)}\n${output}`);
  assert(started, `selected candidate should launch supervisor: ${JSON.stringify(selectedNewEvents)}\n${output}`);
  assert(!selectedNewEvents.some((event) => event.type === 'RESUME_CONTEXT_BLOCKED' || event.type === 'EXECUTOR_RESUME_FALLBACK'), `selected candidate emitted unexpected resume events: ${JSON.stringify(selectedNewEvents)}`);
  assert(!currentNewEvents.some(isResumeLaunchEvent), `current target received resume launch events: ${JSON.stringify(currentNewEvents)}`);
  assert(!decoyNewEvents.some(isResumeLaunchEvent), `decoy target received resume launch events: ${JSON.stringify(decoyNewEvents)}`);

  const validation = validated.data as SafetyEventData | undefined;
  assert(validation?.target === currentTarget, `validated target mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.session_dir === selectedSession, `validated session mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.planner_session === 'supervisor-safety-selected-planner', `validated planner mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.executor_session === 'supervisor-safety-selected-executor', `validated executor mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.executor_app_thread === 'supervisor-safety-selected-app-thread', `validated app thread mismatch: ${JSON.stringify(validation)}`);
  assert(validation?.best_commit === selectedBest, `validated best_commit should come from selected checkpoint: ${JSON.stringify(validation)}`);
  assert(validation?.tool_versions?.wici?.package_version === '0.1.selected', `validated tool_versions should come from selected checkpoint: ${JSON.stringify(validation)}`);
  assert(validation?.tool_versions?.codex === 'codex-selected', `validated Codex version should come from selected checkpoint: ${JSON.stringify(validation)}`);

  const startData = started.data as { resume_best_commit?: string | null; resume_tool_versions?: Checkpoint['tool_versions'] } | undefined;
  assert(startData?.resume_best_commit === selectedBest, `SUPERVISOR_START should preserve selected rollback commit: ${JSON.stringify(startData)}`);
  assert(startData?.resume_tool_versions?.wici?.package_version === '0.1.selected', `SUPERVISOR_START should preserve selected WiCi metadata: ${JSON.stringify(startData)}`);
  assert(startData?.resume_tool_versions?.codex === 'codex-selected', `SUPERVISOR_START should preserve selected Codex metadata: ${JSON.stringify(startData)}`);

  const selectedCheckpoint = await readJsonFileMaybe<Checkpoint>(selectedPaths.checkpoint);
  assert(selectedCheckpoint?.best_commit === selectedBest, `selected checkpoint best_commit should remain selected: ${JSON.stringify(selectedCheckpoint)}`);
  assert(await readFile(currentPaths.checkpoint, 'utf8') === currentBeforeCheckpoint, 'current checkpoint safety metadata should not be mutated');
  assert(await readFile(decoyPaths.checkpoint, 'utf8') === decoyBeforeCheckpoint, 'decoy checkpoint safety metadata should not be mutated');
  assert(selectedBeforeCheckpoint.includes('0.1.selected'), 'selected fixture should start with selected tool metadata');
  assert((await readFile(selectedPaths.chat, 'utf8')).includes('selected supervisor safety chat'), 'selected chat transcript should remain available');
  assert((await readFile(selectedPaths.runtimeSelection, 'utf8')).includes('supervisor-safety-selected-chat-model'), 'selected runtime should remain available');
  assert((await readFile(selectedPaths.goalDoc, 'utf8')).includes('Selected supervisor safety context must be resumed'), 'selected GOAL.md should remain available');
  assert((await readFile(selectedPaths.plan, 'utf8')).includes('selected supervisor safety step'), 'selected PLAN.md should remain available');
  assert((await readFile(selectedPaths.ledger, 'utf8')).includes('supervisor-safety-selected-ledger'), 'selected ledger should remain available');

  console.log(JSON.stringify({
    ok: true,
    target: currentTarget,
    selectedSession,
    decoyTarget,
    selectedRollbackCommit: selectedBest,
    rollbackPreviewSource: preview.source,
    selectedToolMetadataPreserved: true,
    currentAndDecoyUnchanged: true,
    wiciDriftRejected: true,
    resume_validated: true,
    supervisor_started: true
  }, null, 2));
}

interface SafetyEventData {
  target?: string;
  session_dir?: string | null;
  planner_session?: string | null;
  executor_session?: string | null;
  executor_app_thread?: string | null;
  best_commit?: string | null;
  tool_versions?: Checkpoint['tool_versions'];
}

interface SafetyFixture {
  runId: string;
  requirement: string;
  marker: string;
  bestCommit: string;
  toolVersions: NonNullable<Checkpoint['tool_versions']>;
  planner: string;
  executor: string;
  appThread: string;
  chatModel: string;
}

function fixture(input: {
  runId: string;
  requirement: string;
  marker: 'current' | 'selected' | 'decoy';
  bestCommit: string;
  toolVersions: NonNullable<Checkpoint['tool_versions']>;
}): SafetyFixture {
  return {
    ...input,
    planner: `supervisor-safety-${input.marker}-planner`,
    executor: `supervisor-safety-${input.marker}-executor`,
    appThread: `supervisor-safety-${input.marker}-app-thread`,
    chatModel: `supervisor-safety-${input.marker}-chat-model`
  };
}

async function writeRunnableRun(paths: ReturnType<typeof runPaths>, item: SafetyFixture): Promise<void> {
  await ensureDir(paths.stateDir);
  await atomicWriteJson(paths.goal, goal(item));
  await atomicWriteJson(paths.checkpoint, checkpoint(item));
  await appendJsonLine(paths.events, { seq: 1, ts: ts(), type: 'STOP', level: 'info', message: `${item.marker} supervisor safety candidate ready` });
  await appendJsonLine(paths.chat, { ts: ts(), role: 'user', text: `${item.marker} supervisor safety chat` });
  await atomicWriteJson(paths.runtimeSelection, { chat: { agent: 'codex', model: item.chatModel } });
  await writeText(paths.goalDoc, `# GOAL\n\n${item.requirement}.\n`);
  await writeText(paths.plan, `# PLAN\n\n- [x] S1 ${item.marker} supervisor safety step\n`);
  await writeText(paths.ledger, `{"id":"supervisor-safety-${item.marker}-ledger","status":"keep","cost":{"wall_ms":0,"tokens_input":0,"tokens_output":0,"usd":0}}\n`);
}

function checkpoint(item: SafetyFixture): Checkpoint {
  return {
    supervisor_state: 'STOP',
    next_step: null,
    iter: 0,
    goal_version: 1,
    plan_hash: null,
    best_commit: item.bestCommit,
    ledger_seq: 1,
    events_seq: 1,
    sessions: {
      planner: item.planner,
      executor: item.executor,
      executorApp: {
        threadId: item.appThread,
        updatedAt: ts(),
        phase: 'idle'
      }
    },
    tool_versions: item.toolVersions,
    drained_inbox: [],
    updated_at: ts()
  };
}

function goal(item: SafetyFixture): GoalFile {
  return {
    run_id: item.runId,
    version: 1,
    requirements: [{ id: 'R1', text: item.requirement, source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'tests', direction: 'maximize', unit: 'pass' },
    budget: { max_iters: 0, max_cost_usd: 0, deadline: null },
    stop: { tau: 0, K: 0, N: 0, mode: 'auto' }
  };
}

function toolVersions(marker: 'current' | 'selected' | 'decoy'): NonNullable<Checkpoint['tool_versions']> {
  return {
    mode: 'stub',
    codex: `codex-${marker}`,
    claude: `claude-${marker}`,
    github: `github-${marker}`,
    wici: {
      package_version: `0.1.${marker}`,
      git_commit: marker === 'selected' ? '1111111111111111111111111111111111111111' : marker === 'current' ? '2222222222222222222222222222222222222222' : '3333333333333333333333333333333333333333',
      git_dirty: marker !== 'selected'
    },
    checked_at: marker === 'selected' ? '2026-01-03T00:00:00.000Z' : marker === 'current' ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z'
  };
}

function assertWiCiDriftIsRejected(): void {
  const active = checkpoint(fixture({
    runId: 'tui-resume-supervisor-safety-drift',
    requirement: 'Drift fixture',
    marker: 'selected',
    bestCommit: '1111111111111111111111111111111111111111',
    toolVersions: toolVersions('selected')
  }));
  active.supervisor_state = 'EXECUTE';
  try {
    assertNoActiveToolVersionDrift(active, {
      ...toolVersions('selected'),
      wici: {
        package_version: '0.1.other',
        git_commit: '9999999999999999999999999999999999999999',
        git_dirty: false
      },
      checked_at: ts()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes('Non-recoverable tool version drift') && message.includes('wici package') && message.includes('wici git'), `unexpected drift rejection message: ${message}`);
    return;
  }
  throw new Error('non-recoverable WiCi drift should be rejected before unsafe active-run relaunch');
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content.endsWith('\n') ? content : `${content}\n`);
}

async function git(target: string, args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return (result.all ?? result.stdout).trim();
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
  await requireExpectOrSkip('tui-resume-supervisor-safety');
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
