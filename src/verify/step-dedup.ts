import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';
import { parsePlanSteps } from '../supervisor/plan.js';
import { readOutbox } from '../supervisor/outbox.js';
import { findNearDuplicateContinuationStep, stepTitleSimilarity } from '../supervisor/stepSimilarity.js';

const target = resolve('fixture/step-dedup-target');
const fakeBin = resolve('fixture/step-dedup-bin');

async function main(): Promise<void> {
  assert(stepTitleSimilarity('Draft final report', 'Draft final readiness report') >= 0.78, 'near-duplicate report titles should be similar');
  assert(
    !findNearDuplicateContinuationStep(
      parsePlanSteps('# PLAN\n\n- [x] S1 Draft final report\n'),
      parsePlanSteps('# PLAN\n\n- [x] S1 Draft final report\n- [ ] S2 Implement checksum validation\n')
    ),
    'distinct continuation steps should pass dedup'
  );

  await installFakeCodex();
  const originalPath = process.env.PATH ?? '';
  const originalPlanner = process.env.WICI_PLANNER_AGENT;
  const originalAutoUpdate = process.env.WICI_AUTO_UPDATE_TOOLS;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  process.env.WICI_PLANNER_AGENT = 'codex';
  process.env.WICI_AUTO_UPDATE_TOOLS = '0';
  try {
    await createSampleTarget(target, true);
    const paths = runPaths(target);
    await writeFile(paths.plan, '# PLAN\n\n- [x] S1 Draft final report <!-- status:done iter:1 -->\n');

    const result = await runSupervisor({
      target,
      goal: 'Finish the report work without generating near-duplicate continuation steps.',
      maxIters: 3,
      mode: 'auto'
    });
    assert(result.state === 'STOP', `dedup run should stop, got ${JSON.stringify(result)}`);
    assert(result.reason.includes('near-duplicate step'), `dedup stop reason should mention duplicate step: ${result.reason}`);

    const plan = await readFile(paths.plan, 'utf8');
    assert(plan.includes('S1 Draft final report'), `original plan step was lost:\n${plan}`);
    assert(!plan.includes('S2 Draft final readiness report'), `near-duplicate step should not remain appended:\n${plan}`);

    const outbox = await readOutbox(paths, 20);
    const question = outbox.find((message) => message.kind === 'question' && message.reply_key?.startsWith('continuation-stall-') && message.reply_key.includes('dedup'));
    assert(question, `missing dedup escalation question: ${JSON.stringify(outbox)}`);

    const events = await readJsonLines<RunEvent>(paths.events);
    assert(events.some((event) => event.type === 'CONTINUATION_DEDUP_ESCALATED'), 'missing CONTINUATION_DEDUP_ESCALATED event');
    const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
    assert(checkpoint.supervisor_state === 'STOP', `checkpoint should stop after dedup escalation: ${checkpoint.supervisor_state}`);
    assert(checkpoint.consecutive_duplicate_continuation_steps === 1, `duplicate counter not recorded: ${JSON.stringify(checkpoint)}`);

    console.log(JSON.stringify({ ok: true, near_duplicate_escalated: true, distinct_steps_pass: true, restored_plan: true }, null, 2));
  } finally {
    process.env.PATH = originalPath;
    if (originalPlanner === undefined) delete process.env.WICI_PLANNER_AGENT;
    else process.env.WICI_PLANNER_AGENT = originalPlanner;
    if (originalAutoUpdate === undefined) delete process.env.WICI_AUTO_UPDATE_TOOLS;
    else process.env.WICI_AUTO_UPDATE_TOOLS = originalAutoUpdate;
    await rm(target, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
}

async function installFakeCodex(): Promise<void> {
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  const path = join(fakeBin, 'codex');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] === 'doctor') {
  console.log('ok');
  process.exit(0);
}
if (args[0] !== 'exec') {
  console.error('unexpected fake codex args ' + JSON.stringify(args));
  process.exit(2);
}
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (!outputPath) {
  console.error('missing --output-last-message');
  process.exit(2);
}
const prompt = args[args.length - 1] || '';
if (prompt.includes('Bias toward') && prompt.includes('ASSUMPTIONS.md')) {
  writeFileSync(outputPath, '{"decision":"continue","reason":"fake continuation verdict says continue"}\\n');
  console.log(JSON.stringify({ type: 'agent_message', text: '{"decision":"continue","reason":"fake continuation verdict says continue"}' }));
  process.exit(0);
}
if (prompt.includes('Run as the Thinkless planner-diff agent')) {
  const artifact = [
    '## PLAN.md',
    '',
    '# PLAN',
    '',
    '- [x] S1 Draft final report <!-- status:done iter:1 -->',
    '- [ ] S2 Draft final readiness report',
    '',
    '## ASSUMPTIONS.md',
    '',
    '# Assumptions',
    '',
    '- Fake planner proposed duplicate report work.'
  ].join('\\n');
  writeFileSync(outputPath, artifact + '\\n');
  console.log(JSON.stringify({ type: 'agent_message', text: artifact }));
  process.exit(0);
}
writeFileSync(outputPath, 'unexpected fake codex prompt\\n');
console.error('unexpected fake codex prompt');
process.exit(2);
`
  );
  await chmod(path, 0o755);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
