import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';

const target = resolve('fixture/tui-real-fake-chat-target');
const fakeBin = resolve('fixture/tui-real-fake-chat-bin');
const firstChat = 'Use real-mode fake CLIs from a PTY Chat-first TUI input.';

async function main(): Promise<void> {
  await requireExpect();
  await createSampleTarget(target, true);
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFakeClaude();
  await writeFakeCodex();

  const paths = runPaths(target);
  assert(!(await exists(paths.goalDoc)), 'fresh real-mode fake TUI target should start without GOAL.md');
  assert(!(await exists(paths.plan)), 'fresh real-mode fake TUI target should start without PLAN.md');

  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      WICI_PLANNER_AGENT: 'claude',
      WICI_NODE: process.execPath,
      WICI_FAKE_TARGET: target,
      WICI_PTY_CHAT: firstChat,
      WICI_PTY_TARGET: target
    },
    reject: false,
    all: true,
    timeout: 55_000,
    maxBuffer: 1024 * 1024 * 5
  });
  const uiOutput = stripAnsi(result.all ?? '');
  assert(result.exitCode === 0, `real-mode fake PTY Chat-first TUI run failed with code ${result.exitCode}:\n${uiOutput}`);
  assert(await exists(paths.goalDoc), `real-mode fake PTY run did not create GOAL.md:\n${uiOutput}`);

  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes(firstChat), 'GOAL.md should contain the real-mode fake first Chat input');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.goal_source === 'tui_chat', `real-mode fake TUI should preserve goal_source=tui_chat, got ${checkpoint.goal_source}`);
  assert(checkpoint.tool_versions?.mode === 'real', `checkpoint should record real tool mode: ${JSON.stringify(checkpoint.tool_versions)}`);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP checkpoint, got ${checkpoint.supervisor_state}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'PLAN_DONE'), 'real-mode fake TUI should materialize PLAN.md');
  assert(events.some((event) => event.type === 'EXECUTE_PROGRESS'), 'real-mode fake TUI should stream Codex progress');
  assert(events.some((event) => event.type === 'EXECUTE_DONE' && (event.data as { mode?: string } | undefined)?.mode === 'direct'), 'real-mode fake TUI should complete direct execution');

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[] });
  const execCall = argsLog.find((entry) => entry.args[0] === 'exec');
  assert(execCall, `fake Codex did not receive an exec call: ${JSON.stringify(argsLog)}`);
  assert(execCall.args.includes('--dangerously-bypass-approvals-and-sandbox'), `Codex exec missing autonomy flag: ${JSON.stringify(execCall.args)}`);
  assert(execCall.args.includes('--json'), `Codex exec missing json flag: ${JSON.stringify(execCall.args)}`);
  assert(execCall.args.includes('-C'), `first Codex exec should set target cwd: ${JSON.stringify(execCall.args)}`);

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 1, `expected one real-mode fake TUI ledger row, got ${ledger.length}`);
  assert(ledger[0].cost.tokens_input === 121, `ledger should capture fake Codex token usage: ${JSON.stringify(ledger[0].cost)}`);

  const status = await git(['status', '--short']);
  assert(status.trim() === '', `real-mode fake TUI target should be clean:\n${status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        pty_chat_first_real_mode_fake_clis: true,
        goal_source: checkpoint.goal_source,
        planner_materialized: true,
        execute_progress: true,
        ledger_rows: ledger.length
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
const prompt = args[args.indexOf('-p') + 1] || '';
const systemPrompt = args[args.indexOf('--append-system-prompt') + 1] || '';
if (systemPrompt.includes("WiCi's Chat agent") || prompt.includes('User message:')) {
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'fake-real-tui-chat',
    result: [
      '## REPLY',
      '',
      'I have enough to start planning.',
      '',
      '## UPDATE',
      '',
      'kind: requirement',
      '${firstChat}'
    ].join('\\n')
  }));
  process.exit(0);
}
console.log(JSON.stringify({
  type: 'assistant',
  session_id: 'fake-real-tui-planner',
  message: { usage: { input_tokens: 41, output_tokens: 13 } }
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'fake-real-tui-planner',
  result: [
    '## GOAL.md',
    '',
    '# GOAL',
    '',
    '${firstChat}',
    '',
    '## PLAN.md',
    '',
    '# Plan',
    '',
    '- [ ] S1 Run fake real-mode Codex execution from the Chat-first TUI',
    '  - Action: prove WiCi invoked real-mode Codex through the TUI path.',
    '  - Validation: fake Codex writes the required thin receipt and token stream.'
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
const outIndex = args.indexOf('--output-last-message');
const out = outIndex >= 0 ? args[outIndex + 1] : join(wici, 'artifacts', 'iter-1.txt');
mkdirSync(dirname(out), { recursive: true });
if (!args.includes('--output-schema')) {
  writeFileSync(out, [
    '## GOAL.md',
    '',
    '# GOAL',
    '',
    '${firstChat}',
    '',
    '## PLAN.md',
    '',
    '# Plan',
    '',
    '- [ ] S1 Run fake real-mode Codex execution from the Chat-first TUI',
    '  - Action: prove WiCi invoked real-mode Codex through the TUI path.',
    '  - Validation: fake Codex writes the required thin receipt and token stream.'
  ].join('\\n') + '\\n');
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 41, output_tokens: 13 } }));
  process.exit(0);
}
appendFileSync(join(wici, 'fake-codex-args.jsonl'), JSON.stringify({ args }) + '\\n');
const result = {
  step_done: true,
  tests_pass: true,
  notes: 'fake real-mode TUI Codex completed Chat-first execution',
  changed_files: [],
  next: null
};
writeFileSync(out.replace(/\\.txt$/, '.json'), JSON.stringify(result, null, 2));
writeFileSync(out, result.notes + '\\n');
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 121, output_tokens: 17 }
}));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'message' } }));
`
  );
  await chmod(path, 0o755);
}

async function requireExpect(): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-real-fake-chat requires expect on PATH');
}

function expectScript(): string {
  return `
log_user 0
set timeout 45
spawn "$env(WICI_NODE)" --import tsx src/cli.tsx tui --target "$env(WICI_PTY_TARGET)" --max-iters 1 --mode real --no-fullscreen
expect "CHAT"
sleep 1
send -- "$env(WICI_PTY_CHAT)\\r"
send -- "\\033\\[C"
expect -- "--- PLAN.md ---"
send -- "\\033\\[C"
expect {
  "turn completed" {
    send -- "\\003"
    expect eof
    exit 0
  }
  timeout {
    send -- "\\003"
    expect eof
    exit 2
  }
  eof {
    exit 3
  }
}
`;
}

async function git(args: string[]): Promise<string> {
  const result = await execa('git', ['-C', target, ...args], { all: true });
  return result.all ?? result.stdout;
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
