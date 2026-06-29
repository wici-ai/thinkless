import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { writeInjection } from '../supervisor/inbox.js';

const target = resolve('fixture/app-server-hotreload-target');
const fakeBin = resolve('fixture/app-server-hotreload-bin');
const initialGoal = 'Verify app-server hot reload steers the active Codex turn.';
const followupText = 'Apply this requirement through turn steer, not exec resume.';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFakeClaude();
  await writeFakeCodex();

  const paths = runPaths(target);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', initialGoal, '--max-iters', '1', '--mode', 'real'],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        WICI_FAKE_TARGET: target,
        WICI_FAKE_STATE_DIR: paths.wici,
        WICI_PLANNER_AGENT: 'claude',
        WICI_CODEX_EXECUTOR_BACKEND: 'app-server'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  await waitForEvent(paths.events, 'EXECUTE_APP_SERVER_START', 20_000);
  const injection = await writeInjection(paths, {
    kind: 'add_requirement',
    text: followupText,
    priority: 'normal'
  });

  const exit = await waitForExit(child, 30_000);
  assert(exit.code === 0, `app-server hot reload run exited code=${exit.code} signal=${exit.signal}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'EXECUTE_STEERED'), 'missing EXECUTE_STEERED event');
  assert(!events.some((event) => event.type === 'EXECUTE_PREEMPTED'), 'app-server hot reload must not preempt active Codex turn');
  assert(events.some((event) => event.type === 'PLAN_DIFF_APPLIED'), 'missing PLAN_DIFF_APPLIED before steer');

  const rpc = (await readFile(join(paths.wici, 'fake-app-server-rpc.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
  assert(rpc.some((message) => message.method === 'turn/steer'), `fake app-server did not receive turn/steer: ${JSON.stringify(rpc)}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger[0]?.status === 'keep', `expected keep ledger row, got ${JSON.stringify(ledger)}`);
  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.sessions.executorApp?.threadId === 'thread-app-1', `checkpoint missing app-server thread: ${JSON.stringify(checkpoint.sessions)}`);

  const transcript = await readFile(paths.codexRun, 'utf8');
  assert(transcript.includes('"method":"turn/started"'), 'raw app-server transcript missing turn/started notification');
  assert(transcript.includes('"method":"turn/completed"'), 'raw app-server transcript missing turn/completed notification');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree should be clean after app-server hot reload:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        injection_drained: injection.id,
        app_server_steer: true
      },
      null,
      2
    )
  );
}

async function writeFakeClaude(): Promise<void> {
  const path = await fakeCommandPath('claude');
  await writeFile(
    path,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.1.999 (Fake Claude Code)');
  process.exit(0);
}
if (args[0] === 'update') {
  console.log('updated');
  process.exit(0);
}
if (args.includes('--json-schema')) {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
const isResume = args.includes('--resume');
console.log(JSON.stringify({
  type: 'assistant',
  session_id: 'fake-app-server-planner',
  message: { usage: { input_tokens: isResume ? 31 : 29, output_tokens: isResume ? 9 : 11 } }
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'fake-app-server-planner',
  result: isResume ? [
    '## PLAN.md',
    '',
    '# Plan',
    '',
    '- [ ] S1 Complete after active turn steer',
    '  - Action: ${followupText}',
    '  - Validation: fake app-server writes a successful receipt.'
  ].join('\\n') : [
    '## GOAL.md',
    '',
    '# GOAL',
    '',
    '${initialGoal}',
    '',
    '## PLAN.md',
    '',
    '# Plan',
    '',
    '- [ ] S1 Start a steerable app-server turn'
  ].join('\\n')
}));
`
  );
  await chmod(path, 0o755);
}

async function writeFakeCodex(): Promise<void> {
  const path = await fakeCommandPath('codex');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.999.0');
  process.exit(0);
}
if (args[0] === 'update') {
  console.log('updated');
  process.exit(0);
}
if (args[0] === 'doctor') {
  console.log('0 fail degraded');
  process.exit(0);
}
if (args[0] !== 'app-server') {
  console.error('expected app-server, got ' + JSON.stringify(args));
  process.exit(2);
}

const target = process.env.WICI_FAKE_TARGET;
const wici = process.env.WICI_FAKE_STATE_DIR ?? join(target, '.thinkless');
mkdirSync(join(wici, 'artifacts'), { recursive: true });
const log = join(wici, 'fake-app-server-rpc.jsonl');
const rl = createInterface({ input: process.stdin });
let turnStarted = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function record(message) {
  appendFileSync(log, JSON.stringify(message) + '\\n');
}
function turnShape(status = 'inProgress') {
  return { id: 'turn-app-1', items: [], itemsView: { type: 'all' }, status, error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null };
}

rl.on('line', (line) => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake', platformFamily: 'macos', platformOs: 'darwin' } });
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-app-1', sessionId: 'session-app-1', turns: [], status: { type: 'idle' }, preview: '', ephemeral: false, modelProvider: 'openai', createdAt: 0, updatedAt: 0, cwd: target, cliVersion: 'fake', source: 'appServer', threadSource: 'user', forkedFromId: null, parentThreadId: null, path: null, gitInfo: null, name: null, agentNickname: null, agentRole: null }, model: 'fake', modelProvider: 'openai', serviceTier: null, cwd: target, instructionSources: [], approvalPolicy: 'never', approvalsReviewer: null, sandbox: { type: 'dangerFullAccess' }, reasoningEffort: null } });
  } else if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: 'thread-app-1', sessionId: 'session-app-1', turns: [], status: { type: 'idle' }, preview: '', ephemeral: false, modelProvider: 'openai', createdAt: 0, updatedAt: 0, cwd: target, cliVersion: 'fake', source: 'appServer', threadSource: 'user', forkedFromId: null, parentThreadId: null, path: null, gitInfo: null, name: null, agentNickname: null, agentRole: null }, model: 'fake', modelProvider: 'openai', serviceTier: null, cwd: target, instructionSources: [], approvalPolicy: 'never', approvalsReviewer: null, sandbox: { type: 'dangerFullAccess' }, reasoningEffort: null } });
  } else if (message.method === 'turn/start') {
    turnStarted = true;
    send({ id: message.id, result: { turn: turnShape() } });
    send({ method: 'turn/started', params: { threadId: 'thread-app-1', turn: turnShape() } });
    send({ method: 'item/completed', params: { threadId: 'thread-app-1', turnId: 'turn-app-1', completedAtMs: Date.now(), item: { type: 'agentMessage', id: 'msg-1', text: 'waiting for steer', phase: null, memoryCitation: null } } });
  } else if (message.method === 'turn/steer') {
    if (!turnStarted || message.params.expectedTurnId !== 'turn-app-1') {
      send({ id: message.id, error: { code: -32000, message: 'bad turn precondition' } });
      return;
    }
    send({ id: message.id, result: { turnId: 'turn-app-1' } });
    const result = { step_done: true, tests_pass: true, notes: 'fake app-server completed after steer', changed_files: [], next: null };
    writeFileSync(join(wici, 'artifacts', 'iter-1.json'), JSON.stringify(result, null, 2) + '\\n');
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-app-1', turnId: 'turn-app-1', tokenUsage: { total: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0 }, last: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0 }, modelContextWindow: 100000 } } });
    send({ method: 'turn/completed', params: { threadId: 'thread-app-1', turn: { ...turnShape('completed'), completedAt: Date.now() / 1000, durationMs: 25 } } });
    setTimeout(() => process.exit(0), 25);
  } else if (message.method === 'initialized') {
  } else {
    send({ id: message.id, result: {} });
  }
});
setTimeout(() => process.exit(3), 25000);
`
  );
  await chmod(path, 0o755);
}

async function waitForEvent(path: string, type: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await readJsonLines<RunEvent>(path).catch(() => []);
    if (events.some((event) => event.type === type)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for event ${type}`);
}

async function fakeCommandPath(name: string): Promise<string> {
  if (process.platform !== 'win32') return join(fakeBin, name);
  const cmd = join(fakeBin, `${name}.cmd`);
  await writeFile(cmd, `@echo off\r\nnode "%~dp0\\${name}.js" %*\r\n`);
  return join(fakeBin, `${name}.js`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs).then(() => {
      child.kill('SIGKILL');
      throw new Error(`Timed out waiting for supervisor exit after ${timeoutMs}ms`);
    })
  ]);
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
