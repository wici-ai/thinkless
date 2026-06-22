import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { RunEvent } from '../shared/types.js';
import { writeInjection } from '../supervisor/inbox.js';

const target = resolve('fixture/hotreload-resume-target');
const fakeBin = resolve('fixture/hotreload-resume-bin');
const initialGoal = 'Verify real-mode hot reload keeps Codex execution continuity.';
const followupText = 'After hot reload, keep using the active Codex execution context.';

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
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        WICI_PLANNER_AGENT: 'claude',
        WICI_FAKE_TARGET: target,
        WICI_PAUSE_AFTER_EVENT: 'EXECUTE_DONE:5000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  await waitForEvent(paths.events, 'EXECUTE_DONE', 20_000);
  const injection = await writeInjection(paths, {
    kind: 'add_requirement',
    text: followupText,
    priority: 'normal'
  });

  const exit = await waitForExit(child, 30_000);
  assert(exit.code === 0, `real-mode hot reload resume run exited code=${exit.code} signal=${exit.signal}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  const drainIndex = events.findIndex((event) => event.type === 'INJECTION_DRAINED');
  const planDiffIndex = events.findIndex((event) => event.type === 'PLAN_DIFF_APPLIED');
  const secondExecuteIndex = events.findIndex((event, index) => index > planDiffIndex && event.type === 'EXECUTE_START');
  assert(drainIndex >= 0, 'missing hot reload INJECTION_DRAINED event');
  assert(planDiffIndex > drainIndex, 'PLAN_DIFF_APPLIED should follow hot reload inbox drain');
  assert(secondExecuteIndex > planDiffIndex, 'second Codex execution should start after hot reload plan diff');

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[] });
  const execCalls = argsLog.filter((entry) => entry.args[0] === 'exec');
  assert(execCalls.length === 2, `expected two Codex exec calls, got ${execCalls.length}: ${JSON.stringify(argsLog)}`);
  assert(execCalls[0].args[1] !== 'resume', `first Codex call should start a fresh exec: ${JSON.stringify(execCalls[0].args)}`);
  assert(execCalls[0].args.includes('-C'), `first Codex call should set target cwd: ${JSON.stringify(execCalls[0].args)}`);
  assert(execCalls[1].args[1] === 'resume', `second Codex call should use exec resume after hot reload: ${JSON.stringify(execCalls[1].args)}`);
  assert(execCalls[1].args.includes('--last'), `Codex resume should continue the last session: ${JSON.stringify(execCalls[1].args)}`);
  assert(!execCalls[1].args.includes('-C'), `Codex resume must not use unsupported -C: ${JSON.stringify(execCalls[1].args)}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes(followupText), 'PLAN.md should include hot reload follow-up requirement');
  const secondPrompt = await readFile(join(paths.artifacts, 'iter-2.prompt.txt'), 'utf8');
  assert(secondPrompt.includes('Continue the existing Codex session for this WiCi run.'), 'second Codex prompt should continue the existing Codex session');
  assert(secondPrompt.includes(followupText), 'second Codex prompt should include hot reload steering text');

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `target worktree should be clean after hot reload resume:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        hot_reload_real_mode: true,
        injection_drained: injection.id,
        codex_resume_after_hot_reload: true,
        codex_exec_calls: execCalls.length
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
const isResume = args.includes('--resume');
console.log(JSON.stringify({
  type: 'assistant',
  session_id: 'fake-hot-reload-planner',
  message: { usage: { input_tokens: isResume ? 31 : 29, output_tokens: isResume ? 9 : 11 } }
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'fake-hot-reload-planner',
  result: isResume ? [
    '## PLAN.md',
    '',
    '# Plan',
    '',
    '- [x] S1 Run the first executor turn <!-- status:done iter:1 -->',
    '- [ ] S2 Continue after hot reload with the active Codex context',
    '  - Action: ${followupText}',
    '  - Validation: report that the resumed Codex turn saw the updated GOAL.md and PLAN.md.'
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
    '- [ ] S1 Run the first executor turn',
    '- [ ] S2 Continue after hot reload with the active Codex context'
  ].join('\\n')
}));
`
  );
  await chmod(path, 0o755);
}

async function writeFakeCodex(): Promise<void> {
  const path = join(fakeBin, 'codex');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
const wici = join(target, '.thinkless');
mkdirSync(wici, { recursive: true });
appendFileSync(join(wici, 'fake-codex-args.jsonl'), JSON.stringify({ args }) + '\\n');
const outIndex = args.indexOf('--output-last-message');
const out = outIndex >= 0 ? args[outIndex + 1] : join(wici, 'artifacts', 'unknown.txt');
mkdirSync(dirname(out), { recursive: true });
const match = /iter-(\\d+)\\.txt$/.exec(out);
const iter = match ? Number(match[1]) : 0;
const result = {
  step_done: true,
  tests_pass: true,
  notes: 'fake codex hot reload iter ' + iter,
  changed_files: [],
  next: null
};
writeFileSync(out.replace(/\\.txt$/, '.json'), JSON.stringify(result, null, 2));
writeFileSync(out, result.notes + '\\n');
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 100 + iter, output_tokens: 10 + iter }
}));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'message' } }));
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
