import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { exists, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import { readOutbox } from '../supervisor/outbox.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';

const target = resolve('fixture/tui-planner-clarification-pty-target');
const fakeBin = resolve('fixture/tui-planner-clarification-pty-bin');
const firstChat = 'Plan a remote benchmark but ask for a planner clarification first.';
const answerText = 'Use the SSH target from the original chat and let Codex do remote discovery.';

async function main(): Promise<void> {
  await requireExpect();
  await installFakeClaude();
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  assert(!(await exists(paths.plan)), 'fresh PTY clarification target should start without PLAN.md');

  const result = await execa('expect', ['-c', expectScript()], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
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
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  assert(found.exitCode === 0, 'verify:tui-planner-clarification-pty requires expect on PATH');
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
const prompt = args[args.indexOf('-p') + 1] || '';
const isResume = args.includes('--resume');
function emit(payload) {
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'fake-planner-session',
    result: payload
  }));
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
  const fakeClaude = join(fakeBin, 'claude');
  await writeFile(fakeClaude, script);
  await chmod(fakeClaude, 0o755);
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
