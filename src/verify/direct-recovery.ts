import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/direct-recovery-target');
const fakeBin = resolve('fixture/direct-recovery-bin');

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
      '- [ ] S1 Exercise recoverable direct executor failure',
      '  - Action: let the first Codex invocation fail, then let the resumed invocation diagnose and finish.',
      '  - Validation: supervisor records the crash and continues the same markdown goal.',
      ''
    ].join('\n')
  );

  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ''}`;
  process.env.WICI_FAKE_TARGET = target;
  try {
    const result = await runSupervisor({
      target,
      goal: 'Do not block after one executor failure; keep the goal alive long enough for Codex to debug and recover.',
      maxIters: 2,
      mode: 'real'
    });

    assert(result.state === 'STOP', `expected STOP after maxIters, got ${JSON.stringify(result)}`);
    assert(result.reason === 'Reached max_iters=2', `unexpected stop reason: ${result.reason}`);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    delete process.env.WICI_FAKE_TARGET;
  }

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'EXECUTE_RECOVERABLE_FAILURE'), 'missing recoverable failure event');
  assert(!events.some((event) => event.type === 'FAILED'), 'direct recovery should not mark supervisor FAILED');
  assert(events.some((event) => event.type === 'EXECUTE_DONE'), 'missing recovered EXECUTE_DONE');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 2, `expected crash + keep ledger rows, got ${ledger.length}`);
  assert(ledger[0].status === 'crash', `first row should be crash: ${JSON.stringify(ledger[0])}`);
  assert(ledger[1].status === 'keep', `second row should be keep: ${JSON.stringify(ledger[1])}`);

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP checkpoint, got ${checkpoint.supervisor_state}`);

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  assert(argsLog.length === 2, `expected two Codex invocations, got ${argsLog.length}`);
  assert(argsLog[0].args[0] === 'exec' && argsLog[0].args[1] !== 'resume', `first invocation should be fresh exec: ${JSON.stringify(argsLog[0].args)}`);
  assert(argsLog[1].args[0] === 'exec' && argsLog[1].args[1] === 'resume', `second invocation should resume: ${JSON.stringify(argsLog[1].args)}`);
  assert(argsLog[1].prompt.includes('Previous executor attempt 1 for S1 failed'), 'recovery prompt should include previous failure');
  assert(argsLog[1].prompt.includes('If PLAN.md or .opt scripts caused the failure, update them before retrying.'), 'recovery prompt should authorize plan updates');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree should be clean after recovery:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        recoverable_failure: true,
        ledger_rows: ledger.length,
        resumed_executor: true
      },
      null,
      2
    )
  );
}

async function writeFakeClaude(): Promise<void> {
  const path = join(fakeBin, 'claude');
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
  const path = join(fakeBin, 'codex');
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
const wici = join(target, '.wici');
mkdirSync(wici, { recursive: true });
const prompt = args.at(-1) ?? '';
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
  console.error('simulated executor failure: first attempt hit a bad deployment path');
  process.exit(42);
}

const outIndex = args.indexOf('--output-last-message');
const out = outIndex >= 0 ? args[outIndex + 1] : join(wici, 'artifacts', 'iter-2.txt');
mkdirSync(dirname(out), { recursive: true });
const result = {
  step_done: true,
  tests_pass: true,
  notes: 'fake Codex diagnosed the prior failure, updated strategy, and completed the goal',
  changed_files: [],
  next: null
};
writeFileSync(out.replace(/\\.txt$/, '.json'), JSON.stringify(result, null, 2) + '\\n');
writeFileSync(out, result.notes + '\\n');
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 222, output_tokens: 33 } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'message' } }));
`
  );
  await chmod(path, 0o755);
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
