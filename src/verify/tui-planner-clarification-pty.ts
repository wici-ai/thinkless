import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import { readOutbox } from '../supervisor/outbox.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';
import { requireExpectOrSkip } from './expect.js';

const target = resolve('fixture/tui-planner-clarification-pty-target');
const fakeBin = resolve('fixture/tui-planner-clarification-pty-bin');
const firstChat = 'Plan a remote benchmark but ask for a planner clarification first.';
const answerText = 'Use the SSH target from the original chat and let Codex do remote discovery.';

async function main(): Promise<void> {
  await requireExpect();
  await installFakeClaude();
  await installFakeCodex();
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  assert(!(await exists(paths.plan)), 'fresh PTY clarification target should start without PLAN.md');

  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      WICI_NODE: process.execPath,
      WICI_PTY_CHAT: firstChat,
      WICI_PTY_ANSWER: answerText,
      WICI_PTY_TARGET: target
    },
    reject: false,
    all: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 5
  });
  assert(
    result.exitCode === 0 || result.exitCode === 143,
    `PTY planner clarification run failed with code ${result.exitCode}:\n${stripAnsi(result.all ?? '')}`
  );

  const goal = await readJsonFile<GoalFile>(paths.goal);
  assert(goal.requirements.some((req) => req.text.includes(firstChat)), 'goal state should contain the first Chat requirement');
  assert(goal.constraints.some((constraint) => constraint.includes(answerText)), 'goal state should contain the Chat clarification answer');

  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes(firstChat), 'GOAL.md should contain the first Chat input');
  assert(goalDoc.includes(answerText), 'GOAL.md should contain the planner clarification answer');

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('Remote benchmark bootstrap'), 'PLAN.md should be materialized after the Chat answer resumes planner');

  const outbox = await readOutbox(paths, 20);
  const question = outbox.find((message) => message.reply_key?.startsWith('planner-clarify-'));
  assert(question?.answered === true, `planner clarification question should be marked answered: ${JSON.stringify(outbox)}`);
  assert(question.answer_text === answerText, `planner clarification answer should be recorded: ${JSON.stringify(question)}`);

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.goal_source === 'tui_chat', `first Chat source should remain tui_chat, got ${checkpoint.goal_source}`);
  assert(checkpoint.sessions.planner === 'fake-planner-session', `planner session should be preserved for resume: ${JSON.stringify(checkpoint.sessions)}`);
  assert(checkpoint.supervisor_state === 'STOP', `expected STOP after max_iters=0, got ${checkpoint.supervisor_state}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'PLANNER_CLARIFY_REQUIRED'), 'events should include planner clarification request');
  assert(events.some((event) => event.type === 'OUTBOX_ANSWERED'), 'events should include outbox answer application');
  assert(events.some((event) => event.type === 'PLAN_DONE'), 'events should include resumed PLAN_DONE');

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        pty_planner_clarification: true,
        goal_source: checkpoint.goal_source,
        planner_session: checkpoint.sessions.planner,
        question_answered: true,
        events: events.length
      },
      null,
      2
    )
  );
}

async function requireExpect(): Promise<void> {
  await requireExpectOrSkip('tui-planner-clarification-pty');
}

function expectScript(): string {
  return `
log_user 0
set timeout 45
spawn "$env(WICI_NODE)" --import tsx src/cli.tsx tui --target "$env(WICI_PTY_TARGET)" --max-iters 0 --mode auto --no-fullscreen
expect "CHAT"
sleep 1
send -- "$env(WICI_PTY_CHAT)\\r"
expect "Which remote target"
sleep 1
send -- "$env(WICI_PTY_ANSWER)\\r"
send -- "\\033\\[C"
expect "Remote benchmark bootstrap"
send -- "\\033\\[C"
expect {
  "Reached max_iters=0" {
    exit 0
  }
  timeout {
    exit 2
  }
  eof {
    exit 3
  }
}
`;
}

async function installFakeClaude(): Promise<void> {
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.1.999 (Fake Claude Code)');
  process.exit(0);
}
if (args[0] === 'update') {
  console.log('updated');
  process.exit(0);
}
const prompt = args[args.indexOf('-p') + 1] || '';
const systemPrompt = args[args.indexOf('--append-system-prompt') + 1] || '';
const isResume = args.includes('--resume');
function emit(payload) {
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'fake-planner-session',
    result: payload
  }));
}
if (systemPrompt.includes("WiCi's Chat agent") || prompt.includes('User message:')) {
  emit([
    '## REPLY',
    '',
    'I will start the planner with this benchmark request.',
    '',
    '## UPDATE',
    '',
    'kind: requirement',
    '${firstChat}'
  ].join('\\n'));
  process.exit(0);
}
if (!isResume && prompt.includes('${firstChat}')) {
  emit('## QUESTION\\n\\nWhich remote target should the planner use for this benchmark?');
  process.exit(0);
}
if (!isResume) {
  console.error('fake claude expected initial PTY clarification goal');
  process.exit(2);
}
if (!prompt.includes('${answerText}')) {
  console.error('planner resume prompt did not include PTY clarification answer');
  process.exit(3);
}
emit([
  '## PLAN.md',
  '',
  '# WiCi PTY Clarification Plan',
  '',
  '- [ ] S1 Remote benchmark bootstrap',
  '  - Action: let Codex inspect the clarified remote target and prepare the benchmark.',
  '  - Validation: Codex reports the remote runtime discovery result.'
].join('\\n'));
`;
  const fakeClaude = await fakeCommandPath('claude');
  await writeFile(fakeClaude, script);
  await chmod(fakeClaude, 0o755);

  const fakeCodex = await fakeCommandPath('codex');
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
const outIndex = args.indexOf('--output-last-message');
const out = outIndex >= 0 ? args[outIndex + 1] : '';
if (!out) {
  console.error('missing --output-last-message');
  process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch {}
const prompt = stdin || args.at(-1) || '';
const isResume = args[0] === 'exec' && args[1] === 'resume';
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-planner-session' }));
if (!isResume && prompt.includes('${firstChat}')) {
  writeFileSync(out, '## QUESTION\\n\\nWhich remote target should the planner use for this benchmark?\\n');
  process.exit(0);
}
if (!isResume) {
  console.error('fake codex expected initial PTY clarification goal');
  process.exit(3);
}
if (!prompt.includes('${answerText}')) {
  console.error('planner resume prompt did not include PTY clarification answer');
  process.exit(4);
}
writeFileSync(out, [
  '## PLAN.md',
  '',
  '# WiCi PTY Clarification Plan',
  '',
  '- [ ] S1 Remote benchmark bootstrap',
  '  - Action: let Codex inspect the clarified remote target and prepare the benchmark.',
  '  - Validation: Codex reports the remote runtime discovery result.'
].join('\\n') + '\\n');
`
  );
  await chmod(fakeCodex, 0o755);
}

async function installFakeCodex(): Promise<void> {
  const script = `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.999.0');
  process.exit(0);
}
if (args[0] === 'update' || args[0] === 'doctor') {
  console.log('ok');
  process.exit(0);
}
const outIndex = args.indexOf('--output-last-message');
if (outIndex < 0) {
  console.error('fake codex planner expected --output-last-message');
  process.exit(2);
}
const out = args[outIndex + 1];
let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch {}
const prompt = stdin || args.at(-1) || '';
mkdirSync(dirname(out), { recursive: true });
if (prompt.includes('${answerText}')) {
  writeFileSync(out, [
    '## PLAN.md',
    '',
    '# WiCi PTY Clarification Plan',
    '',
    '- [ ] S1 Remote benchmark bootstrap',
    '  - Action: let Codex inspect the clarified remote target and prepare the benchmark.',
    '  - Validation: Codex reports the remote runtime discovery result.'
  ].join('\\n'));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-planner-session' }));
  process.exit(0);
}
if (prompt.includes('${firstChat}')) {
  writeFileSync(out, '## QUESTION\\n\\nWhich remote target should the planner use for this benchmark?');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-planner-session' }));
  process.exit(0);
}
console.error('fake codex planner received unexpected prompt');
process.exit(3);
`;
  const fakeCodex = await fakeCommandPath('codex');
  await writeFile(fakeCodex, script);
  await chmod(fakeCodex, 0o755);
}

async function fakeCommandPath(name: string): Promise<string> {
  if (process.platform !== 'win32') return join(fakeBin, name);
  const cmd = join(fakeBin, `${name}.cmd`);
  await writeFile(cmd, `@echo off\r\nnode "%~dp0\\${name}.js" %*\r\n`);
  return join(fakeBin, `${name}.js`);
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
