import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/direct-context-reset-target');
const fakeBin = resolve('fixture/direct-context-reset-bin');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFakeClaude();
  await writeFakeCodex();

  const paths = runPaths(target);
  await writeFile(
    paths.plan,
    [
      '# PLAN',
      '',
      '- [ ] S1 Recover from a full Codex executor context window',
      '  - Action: retry from durable state with a fresh executor thread.',
      '  - Validation: the second Codex invocation must be a fresh exec, not exec resume.',
      ''
    ].join('\n')
  );

  const oldPath = process.env.PATH;
  const oldTarget = process.env.WICI_FAKE_TARGET;
  const oldStateDir = process.env.WICI_FAKE_STATE_DIR;
  process.env.PATH = `${fakeBin}${delimiter}${oldPath ?? ''}`;
  process.env.WICI_FAKE_TARGET = target;
  process.env.WICI_FAKE_STATE_DIR = paths.wici;
  try {
    const result = await runSupervisor({
      target,
      goal: 'Recover from Codex context-window exhaustion by opening a fresh executor thread.',
      maxIters: 1,
      mode: 'real'
    });
    assert(result.state === 'STOP', `expected STOP after max_iters, got ${JSON.stringify(result)}`);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTarget === undefined) delete process.env.WICI_FAKE_TARGET;
    else process.env.WICI_FAKE_TARGET = oldTarget;
    if (oldStateDir === undefined) delete process.env.WICI_FAKE_STATE_DIR;
    else process.env.WICI_FAKE_STATE_DIR = oldStateDir;
  }

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'EXECUTOR_CONTEXT_WINDOW_RESET'), 'missing context-window reset event');
  assert(!events.some((event) => event.type === 'EXECUTE_CRASH_LOOP_BLOCKED'), 'context-window reset should not trip crash loop breaker');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1 && ledger[0].status === 'keep', `expected only recovered keep row, got ${JSON.stringify(ledger)}`);

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(!checkpoint.sessions.executorReset, `executor reset marker should be cleared after successful fresh run: ${JSON.stringify(checkpoint.sessions)}`);

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  assert(argsLog.length === 2, `expected full-context failure + fresh retry, got ${argsLog.length}`);
  assert(argsLog[0].args[0] === 'exec' && argsLog[0].args[1] !== 'resume', `first invocation should be fresh exec: ${JSON.stringify(argsLog[0].args)}`);
  assert(argsLog[1].args[0] === 'exec' && argsLog[1].args[1] !== 'resume', `context-window retry must not resume old full thread: ${JSON.stringify(argsLog[1].args)}`);
  assert(argsLog[1].prompt.includes('exhausted its model context window'), 'fresh retry prompt should explain the reset');

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        context_window_reset: true,
        fresh_retry: true,
        ledger_rows: ledger.length
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
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'unused', result: '' }));
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
if (!target) {
  console.error('WICI_FAKE_TARGET missing');
  process.exit(2);
}
const wici = process.env.WICI_FAKE_STATE_DIR || join(target, '.thinkless');
mkdirSync(wici, { recursive: true });
const promptArg = args.at(-1) ?? '';
const prompt = promptArg === '-' ? readFileSync(0, 'utf8') : promptArg;
appendFileSync(join(wici, 'fake-codex-args.jsonl'), JSON.stringify({ args, prompt }) + '\\n');
const countPath = join(wici, 'fake-codex-count.txt');
let count = 0;
try {
  count = Number(readFileSync(countPath, 'utf8').trim());
} catch {}
count += 1;
writeFileSync(countPath, String(count));

console.log(JSON.stringify({ type: 'turn.started' }));
if (count === 1) {
  console.error("error: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.");
  process.exit(42);
}
if (args[1] === 'resume') {
  console.error('unexpected resume after context-window reset');
  process.exit(43);
}

const outIndex = args.indexOf('--output-last-message');
const out = outIndex >= 0 ? args[outIndex + 1] : join(wici, 'artifacts', 'iter-1.txt');
mkdirSync(dirname(out), { recursive: true });
const result = {
  step_done: true,
  tests_pass: true,
  notes: 'fake Codex recovered after starting a fresh thread',
  changed_files: [],
  next: null
};
writeFileSync(out.replace(/\\.txt$/, '.json'), JSON.stringify(result, null, 2) + '\\n');
writeFileSync(out, result.notes + '\\n');
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 123, output_tokens: 45 } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'message' } }));
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
