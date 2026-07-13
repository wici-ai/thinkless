import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
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
  const oldStateDir = process.env.WICI_FAKE_STATE_DIR;
  process.env.PATH = `${fakeBin}${delimiter}${oldPath ?? ''}`;
  process.env.WICI_FAKE_TARGET = target;
  process.env.WICI_FAKE_STATE_DIR = paths.wici;
  try {
    const result = await runSupervisor({
      target,
      goal: 'Do not block after one executor failure; keep the goal alive long enough for Codex to debug and recover.',
      maxIters: 2,
      mode: 'auto'
    });

    assert(result.state === 'STOP', `expected STOP after maxIters, got ${JSON.stringify(result)}`);
    assert(result.reason === 'Reached max_iters=2', `unexpected stop reason: ${result.reason}`);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    delete process.env.WICI_FAKE_TARGET;
    if (oldStateDir === undefined) delete process.env.WICI_FAKE_STATE_DIR;
    else process.env.WICI_FAKE_STATE_DIR = oldStateDir;
  }

  const events = await readJsonLines<RunEvent>(paths.events);
  const recoverable = events.find((event) => event.type === 'EXECUTE_RECOVERABLE_FAILURE');
  assert(recoverable, 'missing recoverable failure event');
  assert(
    (recoverable.data as { failure_kind?: string } | undefined)?.failure_kind === 'cybersecurity_policy',
    `policy refusal should be recorded as a recoverable typed failure: ${JSON.stringify(recoverable)}`
  );
  assert(!events.some((event) => event.type === 'TOOL_USAGE_LIMIT_STOP'), 'historical usage-limit text in command output must not stop the run');
  assert(events.some((event) => event.type === 'EXECUTOR_POLICY_CONTEXT_RESET'), 'policy refusal should reset the executor thread before retry');
  assert(!events.some((event) => event.type === 'FAILED'), 'direct recovery should not mark supervisor FAILED');
  assert(events.some((event) => event.type === 'EXECUTE_DONE'), 'missing recovered EXECUTE_DONE');

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 2, `expected crash + keep ledger rows, got ${ledger.length}`);
  assert(ledger[0].status === 'crash', `first row should be crash: ${JSON.stringify(ledger[0])}`);
  assert(ledger[0].reflection === 'Codex safety policy refused the executor turn as possible cybersecurity risk.', `policy ledger reason must be sanitized: ${ledger[0].reflection}`);
  assert(ledger[1].status === 'keep', `second row should be keep: ${JSON.stringify(ledger[1])}`);

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP checkpoint, got ${checkpoint.supervisor_state}`);

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  assert(argsLog.length === 2, `expected two Codex invocations, got ${argsLog.length}`);
  assert(argsLog[0].args[0] === 'exec' && argsLog[0].args[1] !== 'resume', `first invocation should be fresh exec: ${JSON.stringify(argsLog[0].args)}`);
  assert(argsLog[1].args[0] === 'exec' && argsLog[1].args[1] !== 'resume', `policy retry should start a fresh executor thread: ${JSON.stringify(argsLog[1].args)}`);
  assert(argsLog[1].prompt.includes('Previous executor attempt 1 for S1 was refused by Codex safety policy before completion.'), 'recovery prompt should identify the policy refusal without replaying it');
  assert(argsLog[1].prompt.includes('Do not paste, summarize in detail, or replay the rejected command transcript verbatim.'), 'recovery prompt should prohibit transcript replay');
  assert(argsLog[1].prompt.includes('small repository-scoped build, test, and inspection actions'), 'recovery prompt should prescribe a safe bounded retry shape');
  assert(!argsLog[1].prompt.includes("You've hit your usage limit; this old incident is resolved"), 'recovery prompt leaked irrelevant command output from the rejected transcript');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree should be clean after recovery:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        recoverable_failure: true,
        cybersecurity_policy_retry: true,
        fresh_executor_retry: true,
        transcript_usage_text_ignored: true,
        ledger_rows: ledger.length,
        recovered_executor: true
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
  console.log(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      aggregated_output: "Historical GOAL text: You've hit your usage limit; this old incident is resolved."
    }
  }));
  const message = 'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.';
  console.log(JSON.stringify({ type: 'error', message }));
  console.log(JSON.stringify({ type: 'turn.failed', error: { message } }));
  process.exit(1);
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

async function fakeCommandPath(name: string): Promise<string> {
  if (process.platform !== 'win32') return join(fakeBin, name);
  const cmd = join(fakeBin, `${name}.cmd`);
  await writeFile(cmd, `@echo off\r\nnode "%~dp0\\${name}.js" %*\r\n`);
  return join(fakeBin, `${name}.js`);
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
