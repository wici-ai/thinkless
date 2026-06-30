import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/direct-executor-epoch-target');
const fakeBin = resolve('fixture/direct-executor-epoch-bin');

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
      ...Array.from({ length: 6 }, (_, index) => {
        const id = `S${index + 1}`;
        return [`- [ ] ${id} Complete epoch fixture step ${index + 1}`, `  - Action: write a receipt for ${id}.`, ''].join('\n');
      })
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
      goal: 'Verify executor short epochs preserve progress through durable handoff.',
      maxIters: 6,
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

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  assert(argsLog.length === 6, `expected 6 executor calls, got ${argsLog.length}`);
  assert(argsLog[0].args[0] === 'exec' && argsLog[0].args[1] !== 'resume', `iter 1 should be fresh: ${JSON.stringify(argsLog[0].args)}`);
  assert(argsLog[1].args[1] === 'resume', `iter 2 should resume below the context pressure threshold: ${JSON.stringify(argsLog[1].args)}`);
  assert(argsLog[2].args[0] === 'exec' && argsLog[2].args[1] !== 'resume', `iter 3 should start a fresh epoch from context token pressure: ${JSON.stringify(argsLog[2].args)}`);
  assert(argsLog[3].args[1] === 'resume', `iter 4 should resume the new short epoch: ${JSON.stringify(argsLog[3].args)}`);
  assert(argsLog[4].args[0] === 'exec' && argsLog[4].args[1] !== 'resume', `iter 5 should start another fresh epoch from context token pressure: ${JSON.stringify(argsLog[4].args)}`);
  assert(argsLog[5].args[1] === 'resume', `iter 6 should resume below the max-iteration fallback: ${JSON.stringify(argsLog[5].args)}`);
  assert(argsLog[2].prompt.includes('durable handoff') || argsLog[2].prompt.includes('Durable Handoff'), 'fresh epoch prompt should orient through durable handoff');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 6, `expected 6 ledger rows, got ${ledger.length}`);
  for (const entry of ledger) {
    assert(entry.cost.tokens_input === 100_000, `ledger should store per-turn input delta, got ${JSON.stringify(entry.cost)} for ${entry.id}`);
    assert(entry.cost.tokens_output === 10_000, `ledger should store per-turn output delta, got ${JSON.stringify(entry.cost)} for ${entry.id}`);
  }

  const context = await readFile(paths.context, 'utf8');
  assert(context.length <= 16_000, `handoff context exceeded cap: ${context.length}`);
  assert(context.includes('# Thinkless Durable Handoff'), 'context should be durable handoff format');

  const events = await readJsonLines<RunEvent>(paths.events);
  const epochResetEvents = events.filter((event) => event.type === 'EXECUTOR_EPOCH_RESET');
  assert(epochResetEvents.some((event) => /context_input_tokens_200000/.test(event.message)), `missing context-pressure epoch reset event: ${JSON.stringify(epochResetEvents)}`);

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(!checkpoint.sessions.executorReset, `executor reset marker should clear after fresh epoch success: ${JSON.stringify(checkpoint.sessions)}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        fresh_epoch_iters: [3, 5],
        ledger_rows: ledger.length,
        handoff_chars: context.length
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

const threadPath = join(wici, 'fake-codex-thread-turns.txt');
let threadTurns = args[1] === 'resume' ? Number(readFileSync(threadPath, 'utf8').trim()) : 0;
threadTurns += 1;
writeFileSync(threadPath, String(threadTurns));

const outIndex = args.indexOf('--output-last-message');
const out = outIndex >= 0 ? args[outIndex + 1] : join(wici, 'artifacts', \`iter-\${count}.txt\`);
mkdirSync(dirname(out), { recursive: true });
const result = {
  step_done: true,
  tests_pass: true,
  notes: \`fake Codex completed epoch fixture iteration \${count}\`,
  changed_files: [],
  next: null,
  durable_facts: [\`iteration \${count} completed from durable state\`],
  evidence_paths: ['ledger.jsonl'],
  ruled_out: [],
  next_actions: []
};
writeFileSync(out.replace(/\\.txt$/, '.json'), JSON.stringify(result, null, 2) + '\\n');
writeFileSync(out, result.notes + '\\n');
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: threadTurns * 100000, output_tokens: threadTurns * 10000 } }));
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
