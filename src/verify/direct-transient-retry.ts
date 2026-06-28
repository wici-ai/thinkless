import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/direct-transient-retry-target');
const fakeBin = resolve('fixture/direct-transient-retry-bin');

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
      '- [ ] S1 Retry transient Codex transport failures',
      '  - Action: continue the same step until Codex transport recovers.',
      '  - Validation: repeated request timeouts must not mark the step blocked.',
      ''
    ].join('\n')
  );

  const oldPath = process.env.PATH;
  const oldTarget = process.env.WICI_FAKE_TARGET;
  const oldStateDir = process.env.WICI_FAKE_STATE_DIR;
  const oldRetryDelay = process.env.WICI_TRANSIENT_RETRY_DELAY_MS;
  process.env.PATH = `${fakeBin}${delimiter}${oldPath ?? ''}`;
  process.env.WICI_FAKE_TARGET = target;
  process.env.WICI_FAKE_STATE_DIR = paths.wici;
  process.env.WICI_TRANSIENT_RETRY_DELAY_MS = '0';
  try {
    const result = await runSupervisor({
      target,
      goal: 'Retry Codex transport failures without blocking the active plan step.',
      maxIters: 1,
      mode: 'real'
    });
    assert(result.state === 'STOP', `expected STOP after completing the single planned step, got ${JSON.stringify(result)}`);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTarget === undefined) delete process.env.WICI_FAKE_TARGET;
    else process.env.WICI_FAKE_TARGET = oldTarget;
    if (oldStateDir === undefined) delete process.env.WICI_FAKE_STATE_DIR;
    else process.env.WICI_FAKE_STATE_DIR = oldStateDir;
    if (oldRetryDelay === undefined) delete process.env.WICI_TRANSIENT_RETRY_DELAY_MS;
    else process.env.WICI_TRANSIENT_RETRY_DELAY_MS = oldRetryDelay;
  }

  const events = await readJsonLines<RunEvent>(paths.events);
  const retryWaits = events.filter((event) => event.type === 'EXECUTE_RETRY_WAIT');
  assert(retryWaits.length === 3, `expected three transient retry waits, got ${retryWaits.length}`);
  assert(!events.some((event) => event.type === 'EXECUTE_CRASH_LOOP_BLOCKED'), 'transient Codex timeouts must not trip crash loop blocker');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1 && ledger[0].status === 'keep', `expected only final keep row, got ${JSON.stringify(ledger)}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('- [x] S1 Retry transient Codex transport failures'), `step should be done after transient recovery:\n${plan}`);

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  assert(argsLog.length === 4, `expected three failed attempts plus one successful retry, got ${argsLog.length}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        transient_retries: retryWaits.length,
        codex_invocations: argsLog.length,
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
if (count <= 3) {
  console.error('codex app-server request timed out: thread/start');
  process.exit(42);
}

const outIndex = args.indexOf('--output-last-message');
const out = outIndex >= 0 ? args[outIndex + 1] : join(wici, 'artifacts', 'iter-1.txt');
mkdirSync(dirname(out), { recursive: true });
const result = {
  step_done: true,
  tests_pass: true,
  notes: 'fake Codex recovered after transient transport failures',
  changed_files: [],
  next: null
};
writeFileSync(out.replace(/\\.txt$/, '.json'), JSON.stringify(result, null, 2) + '\\n');
writeFileSync(out, result.notes + '\\n');
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 321, output_tokens: 54 } }));
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
