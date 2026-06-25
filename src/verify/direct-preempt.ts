import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { LedgerEntry, RunEvent } from '../shared/types.js';
import { writeInjection } from '../supervisor/inbox.js';

const target = resolve('fixture/direct-preempt-target');
const fakeBin = resolve('fixture/direct-preempt-bin');
const initialGoal = 'Verify pending Chat input preempts an active direct Codex run.';
const followupText = 'Apply this safety constraint before continuing execution.';

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFakeClaude();
  await writeFakeCodex();

  const paths = runPaths(target);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', initialGoal, '--max-iters', '2', '--mode', 'real'],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        WICI_FAKE_TARGET: target,
        WICI_FAKE_STATE_DIR: paths.wici,
        WICI_PLANNER_AGENT: 'claude',
        WICI_CODEX_EXECUTOR_BACKEND: 'exec'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  await waitForEvent(paths.events, 'EXECUTE_PROGRESS', 20_000);
  const injection = await writeInjection(paths, {
    kind: 'add_requirement',
    text: followupText,
    priority: 'normal'
  });

  const exit = await waitForExit(child, 30_000);
  assert(exit.code === 0, `direct preempt run exited code=${exit.code} signal=${exit.signal}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'EXECUTE_PREEMPTED'), 'missing EXECUTE_PREEMPTED event');
  assert(events.some((event) => event.type === 'INJECTION_DRAINED'), 'missing INJECTION_DRAINED after preempt');
  assert(events.some((event) => event.type === 'PLAN_DIFF_APPLIED'), 'missing PLAN_DIFF_APPLIED after preempt');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger[0]?.status === 'preempted', `first ledger row should be preempted: ${JSON.stringify(ledger)}`);
  assert(ledger[1]?.status === 'keep', `second ledger row should be keep: ${JSON.stringify(ledger)}`);

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[] });
  const execCalls = argsLog.filter((entry) => entry.args[0] === 'exec');
  assert(execCalls.length === 2, `expected two Codex calls, got ${execCalls.length}`);
  assert(execCalls[1].args[1] === 'resume', `second Codex call should resume after preempt: ${JSON.stringify(execCalls[1].args)}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes(followupText), 'PLAN.md should include preempted follow-up requirement');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree should be clean after direct preempt:\n${status}`);
  await verifyDirectAbortStop();

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        injection_drained: injection.id,
        preempted_active_executor: true,
        resumed_executor: true,
        urgent_abort_stops_executor: true
      },
      null,
      2
    )
  );
}

async function verifyDirectAbortStop(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Verify urgent Chat abort stops an active direct Codex run.', '--max-iters', '2', '--mode', 'real'],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        WICI_FAKE_TARGET: target,
        WICI_FAKE_STATE_DIR: paths.wici,
        WICI_PLANNER_AGENT: 'claude',
        WICI_CODEX_EXECUTOR_BACKEND: 'exec'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  await waitForEvent(paths.events, 'EXECUTE_PROGRESS', 20_000);
  await writeInjection(paths, {
    kind: 'abort',
    text: 'stop requested from Chat',
    priority: 'urgent'
  });

  const exit = await waitForExit(child, 30_000);
  assert(exit.code === 0, `direct abort run exited code=${exit.code} signal=${exit.signal}`);
  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'EXECUTE_PREEMPTED'), 'urgent abort should preempt active executor');
  assert(events.some((event) => event.type === 'STOP' && event.message.includes('Urgent abort')), 'urgent abort should stop the run');
  assert(!events.some((event) => event.type === 'PLAN_DIFF_APPLIED'), 'urgent abort should not start planner diff');
  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger[0]?.status === 'preempted', `urgent abort should record preempted executor row: ${JSON.stringify(ledger)}`);
  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[] });
  const execCalls = argsLog.filter((entry) => entry.args[0] === 'exec');
  assert(execCalls.length === 1, `urgent abort should not resume executor, got calls: ${JSON.stringify(execCalls)}`);
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
const isResume = args.includes('--resume');
console.log(JSON.stringify({
  type: 'assistant',
  session_id: 'fake-preempt-planner',
  message: { usage: { input_tokens: isResume ? 30 : 20, output_tokens: isResume ? 9 : 8 } }
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'fake-preempt-planner',
  result: isResume ? [
    '## PLAN.md',
    '',
    '# Plan',
    '',
    '- [ ] S1 Continue after preempt',
    '  - Action: ${followupText}',
    '  - Validation: finish with the updated requirement.'
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
    '- [ ] S1 Start a long Codex run'
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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
const target = process.env.WICI_FAKE_TARGET;
const wici = process.env.WICI_FAKE_STATE_DIR || join(target, '.thinkless');
mkdirSync(wici, { recursive: true });
appendFileSync(join(wici, 'fake-codex-args.jsonl'), JSON.stringify({ args }) + '\\n');
const countPath = join(wici, 'fake-codex-count.txt');
let count = 0;
try { count = Number(readFileSync(countPath, 'utf8').trim()); } catch {}
count += 1;
writeFileSync(countPath, String(count));

const outIndex = args.indexOf('--output-last-message');
const out = outIndex >= 0 ? args[outIndex + 1] : join(wici, 'artifacts', 'unknown.txt');
mkdirSync(dirname(out), { recursive: true });

if (count === 1) {
  process.on('SIGTERM', () => process.exit(143));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fake codex still running' } }));
  setInterval(() => {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fake codex heartbeat' } }));
  }, 200);
  setTimeout(() => {}, 60_000);
} else {
  const result = {
    step_done: true,
    tests_pass: true,
    notes: 'fake Codex resumed after preempt and completed the updated goal',
    changed_files: [],
    next: null
  };
  writeFileSync(out.replace(/\\.txt$/, '.json'), JSON.stringify(result, null, 2) + '\\n');
  writeFileSync(out, result.notes + '\\n');
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 111, output_tokens: 22 } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: result.notes } }));
}
`
  );
  await chmod(path, 0o755);
}

async function fakeCommandPath(name: string): Promise<string> {
  if (process.platform !== 'win32') return join(fakeBin, name);
  const cmd = join(fakeBin, `${name}.cmd`);
  await writeFile(cmd, `@echo off\r\nnode "%~dp0\\${name}.js" %*\r\n`);
  return join(fakeBin, `${name}.js`);
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
