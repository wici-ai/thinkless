import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { exists, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, RunEvent } from '../shared/types.js';
import { writeInjection } from '../supervisor/inbox.js';
import { readOutbox } from '../supervisor/outbox.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/planner-clarification-target');
const diffTarget = resolve('fixture/planner-diff-clarification-target');
const fakeBin = resolve('fixture/planner-clarification-bin');
const answerText = 'Use the SSH target from the original chat and let Codex perform remote discovery.';
const diffInjectedText = 'Before continuing, require a deployment window and ask if it is missing.';
const diffAnswerText = 'Use a non-production validation window and keep all deployment work inside Codex.';

async function main(): Promise<void> {
  await installFakeClaude();
  const originalPath = process.env.PATH ?? '';
  const originalPlannerAgent = process.env.WICI_PLANNER_AGENT;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  process.env.WICI_PLANNER_AGENT = 'claude';
  try {
    const initial = await verifyInitialPlannerClarification();
    const diff = await verifyPlanDiffPlannerClarification();

    console.log(
      JSON.stringify(
        {
          ok: true,
          target,
          planner_question: initial.questionKey,
          answer_drained: initial.answerId,
          resumed_session: initial.session,
          plan_diff_question: diff.questionKey,
          plan_diff_answer_drained: diff.answerId,
          plan_diff_resumed_session: diff.session
        },
        null,
        2
      )
    );
  } finally {
    process.env.PATH = originalPath;
    if (originalPlannerAgent === undefined) delete process.env.WICI_PLANNER_AGENT;
    else process.env.WICI_PLANNER_AGENT = originalPlannerAgent;
  }
}

async function verifyInitialPlannerClarification(): Promise<{ questionKey: string; answerId: string; session: string | undefined }> {
  await createSampleTarget(target, true);
  const first = await runSupervisor({
    target,
    goal: 'Plan a remote benchmark but ask for a planner clarification first.',
    maxIters: 0,
    mode: 'auto'
  });
  assert(first.state === 'STOP', `first run should stop for planner clarification, got ${JSON.stringify(first)}`);
  assert(first.reason === 'awaiting planner clarification', `unexpected first stop reason: ${first.reason}`);

  const paths = runPaths(target);
  assert(!(await exists(paths.plan)), 'PLAN.md must not be materialized before planner clarification is answered');
  const outbox = await readOutbox(paths, 20);
  const question = outbox.find((message) => message.reply_key?.startsWith('planner-clarify-') && !message.answered);
  assert(question?.reply_key, `missing planner clarification question: ${JSON.stringify(outbox)}`);
  assert(question.text.includes('Which remote target'), `unexpected planner question text: ${question.text}`);

  const answer = await writeInjection(paths, {
    kind: 'answer',
    text: answerText,
    reply_to: question.reply_key,
    priority: 'normal'
  });

  const second = await runSupervisor({
    target,
    maxIters: 0,
    mode: 'auto'
  });
  assert(second.state === 'STOP', `second run should stop cleanly after setup, got ${JSON.stringify(second)}`);
  assert(second.reason === 'Reached max_iters=0', `unexpected second stop reason: ${second.reason}`);

  const goal = await readJsonFile<GoalFile>(paths.goal);
  assert(goal.constraints.some((constraint) => constraint.includes(question.reply_key!) && constraint.includes(answerText)), 'GOAL.md state missing planner clarification answer');
  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes(answerText), 'GOAL.md missing planner clarification answer');
  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('Remote benchmark bootstrap'), 'PLAN.md was not produced by resumed planner');

  const answered = (await readOutbox(paths, 20)).find((message) => message.reply_key === question.reply_key);
  assert(answered?.answered === true, `planner question was not marked answered: ${JSON.stringify(answered)}`);
  assert(answered.answer_text === answerText, 'planner answer text not recorded');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.drained_inbox.includes(answer.id), 'checkpoint did not record planner clarification answer as drained');
  assert(checkpoint.sessions.planner === 'fake-planner-session', `planner session not preserved: ${JSON.stringify(checkpoint.sessions)}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'PLANNER_CLARIFY_REQUIRED'), 'missing PLANNER_CLARIFY_REQUIRED event');
  assert(events.some((event) => event.type === 'OUTBOX_ANSWERED'), 'missing OUTBOX_ANSWERED event');
  assert(events.some((event) => event.type === 'PLAN_DONE'), 'missing PLAN_DONE event after planner clarification answer');
  return { questionKey: question.reply_key, answerId: answer.id, session: checkpoint.sessions.planner };
}

async function verifyPlanDiffPlannerClarification(): Promise<{ questionKey: string; answerId: string; session: string | undefined }> {
  await createSampleTarget(diffTarget, true);
  const paths = runPaths(diffTarget);
  const setup = await runSupervisor({
    target: diffTarget,
    goal: 'Plan a direct hot reload clarification run.',
    maxIters: 0,
    mode: 'auto'
  });
  assert(setup.state === 'STOP', `setup run should stop after initial plan, got ${JSON.stringify(setup)}`);
  assert(await exists(paths.plan), 'initial PLAN.md should exist before hot reload clarification');

  await writeInjection(paths, {
    kind: 'add_requirement',
    text: diffInjectedText,
    priority: 'normal'
  });
  const asked = await runSupervisor({
    target: diffTarget,
    maxIters: 1,
    mode: 'auto'
  });
  assert(asked.state === 'STOP', `plan diff clarification run should stop for Chat answer, got ${JSON.stringify(asked)}`);
  assert(asked.reason === 'awaiting planner clarification', `unexpected plan diff stop reason: ${asked.reason}`);

  const outbox = await readOutbox(paths, 20);
  const question = outbox.find((message) => message.reply_key?.startsWith('planner-clarify-') && !message.answered);
  assert(question?.reply_key, `missing plan diff planner question: ${JSON.stringify(outbox)}`);
  assert(question.text.includes('deployment window'), `unexpected plan diff planner question text: ${question.text}`);

  const answer = await writeInjection(paths, {
    kind: 'answer',
    text: diffAnswerText,
    reply_to: question.reply_key,
    priority: 'normal'
  });
  const resumed = await runSupervisor({
    target: diffTarget,
    maxIters: 0,
    mode: 'auto'
  });
  assert(resumed.state === 'STOP', `plan diff resume should stop cleanly, got ${JSON.stringify(resumed)}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('Clarified deployment window'), 'PLAN.md missing resumed plan diff clarification update');
  assert(plan.includes(diffAnswerText), 'PLAN.md missing Chat answer from plan diff clarification');

  const answered = (await readOutbox(paths, 20)).find((message) => message.reply_key === question.reply_key);
  assert(answered?.answered === true, `plan diff question was not marked answered: ${JSON.stringify(answered)}`);
  assert(answered.answer_text === diffAnswerText, 'plan diff answer text not recorded');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.drained_inbox.includes(answer.id), 'checkpoint did not record plan diff clarification answer as drained');
  assert(checkpoint.sessions.planner === 'fake-planner-session', `plan diff planner session not preserved: ${JSON.stringify(checkpoint.sessions)}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.some((event) => event.type === 'PLANNER_CLARIFY_REQUIRED'), 'missing plan diff PLANNER_CLARIFY_REQUIRED event');
  assert(events.some((event) => event.type === 'PLAN_DIFF_APPLIED'), 'missing PLAN_DIFF_APPLIED after plan diff clarification answer');
  return { questionKey: question.reply_key, answerId: answer.id, session: checkpoint.sessions.planner };
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
const isResume = args.includes('--resume');
function emit(payload) {
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'fake-planner-session',
    result: payload
  }));
}
if (!isResume && prompt.includes('Plan a remote benchmark but ask for a planner clarification first')) {
  emit('## QUESTION\\n\\nWhich remote target should the planner use for this benchmark?');
  process.exit(0);
}
if (!isResume) {
  emit([
    '## PLAN.md',
    '',
    '# WiCi Direct Plan',
    '',
    '- [ ] S1 Initial direct step',
    '  - Action: prepare the direct hot reload fixture.',
    '  - Validation: inspect PLAN.md'
  ].join('\\n'));
  process.exit(0);
}
if (prompt.includes('${diffAnswerText}')) {
  emit([
    '## PLAN.md',
    '',
    '# WiCi Direct Plan',
    '',
    '- [ ] S1 Initial direct step',
    '  - Action: prepare the direct hot reload fixture.',
    '  - Validation: inspect PLAN.md',
    '- [ ] S2 Clarified deployment window',
    '  - Action: ${diffAnswerText}',
    '  - Validation: Codex reports the selected validation window before deployment.'
  ].join('\\n'));
  process.exit(0);
}
if (prompt.includes('${diffInjectedText}')) {
  emit('## QUESTION\\n\\nWhich deployment window should Codex use before continuing?');
  process.exit(0);
}
if (!prompt.includes('${answerText}')) {
  console.error('planner resume prompt did not include clarification answer');
  process.exit(2);
}
emit([
  '## PLAN.md',
  '',
  '# WiCi Optimization Plan',
  '',
  '- [ ] S1 Remote benchmark bootstrap',
  '  - Experiment: let Codex discover the remote runtime and run the benchmark harness.',
  '  - Validation: ./.opt/checks.sh && ./.opt/measure.sh',
  '',
  '## .opt/measure.sh',
  '',
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'node measure.mjs',
  '',
  '## .opt/checks.sh',
  '',
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'node test.mjs'
].join('\\n'));
`;
  const fakeClaude = join(fakeBin, 'claude');
  await writeFile(fakeClaude, script);
  await chmod(fakeClaude, 0o755);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
