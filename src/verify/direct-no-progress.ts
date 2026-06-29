import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/direct-no-progress-target');
const fakeBin = resolve('fixture/direct-no-progress-bin');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFakeCodex();

  const paths = runPaths(target);
  await writeFile(
    paths.plan,
    [
      '# PLAN',
      '',
      '- [ ] S1 Diagnose remote state before activating the concrete repair',
      '  - Action: inspect status and report whether more specific follow-up work is needed.',
      '  - Validation: do not modify files until PLAN.md activates the repair.',
      ''
    ].join('\n')
  );

  const oldPath = process.env.PATH;
  const oldThreshold = process.env.WICI_DIRECT_NO_PROGRESS_THRESHOLD;
  const oldAutoUpdate = process.env.WICI_AUTO_UPDATE_TOOLS;
  process.env.PATH = `${fakeBin}${delimiter}${oldPath ?? ''}`;
  process.env.WICI_DIRECT_NO_PROGRESS_THRESHOLD = '2';
  process.env.WICI_AUTO_UPDATE_TOOLS = '0';
  try {
    const result = await runSupervisor({
      target,
      goal: 'Stop repeating no-op status receipts by doing a bottleneck review and choosing a concrete PLAN.md step.',
      maxIters: 3,
      mode: 'real'
    });
    assert(result.state === 'STOP', `expected STOP at maxIters after replan recovery, got ${JSON.stringify(result)}`);
    assert(result.reason === 'Reached max_iters=3', `unexpected stop reason: ${result.reason}`);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldThreshold === undefined) delete process.env.WICI_DIRECT_NO_PROGRESS_THRESHOLD;
    else process.env.WICI_DIRECT_NO_PROGRESS_THRESHOLD = oldThreshold;
    if (oldAutoUpdate === undefined) delete process.env.WICI_AUTO_UPDATE_TOOLS;
    else process.env.WICI_AUTO_UPDATE_TOOLS = oldAutoUpdate;
  }

  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 3, `expected first status receipt to close S1 and continuation to run S2 within maxIters, got ${ledger.length}`);
  assert(ledger[0].status === 'reject' && ledger[0].step_id === 'S1', `expected first row to record incomplete acceptance without repeating S1: ${JSON.stringify(ledger)}`);
  assert(ledger[1].status === 'keep' && ledger[1].step_id === 'S2', `expected S2 keep after planner bottleneck review: ${JSON.stringify(ledger)}`);

  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.filter((event) => event.type === 'EXECUTE_START' && event.message.includes('executing S1')).length === 1, 'step_done=true/tests_pass=false must not re-execute S1');
  assert(events.some((event) => event.type === 'PLAN_CONTINUATION_APPLIED'), 'missing PLAN_CONTINUATION_APPLIED event after closing status-only step');
  assert(!events.some((event) => event.type === 'DIRECT_NO_PROGRESS_ESCALATED'), 'planner recovery should avoid human escalation');

  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.supervisor_state === 'STOP', `checkpoint should stop: ${JSON.stringify(checkpoint)}`);
  assert(checkpoint.consecutive_duplicate_direct_rejects === 0, `checkpoint should not carry duplicate reject count after moving past S1: ${JSON.stringify(checkpoint)}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('- [x] S1'), `repeated no-progress step should be closed before bottleneck review:\n${plan}`);
  assert(plan.includes('## Bottleneck Review') || plan.includes('Bottleneck Review'), `planner should record bottleneck review or continuation rationale:\n${plan}`);
  assert(plan.includes('S2 Add targeted instrumentation after no-progress loop'), `planner should add concrete S2:\n${plan}`);

  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes('## Bottleneck Review'), `planner should update GOAL.md with bottleneck review:\n${goalDoc}`);

  console.log(JSON.stringify({ ok: true, direct_no_progress_replanned: true, ledger_rows: ledger.length }, null, 2));
}

async function writeFakeCodex(): Promise<void> {
  const path = join(fakeBin, 'codex');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.999.0');
  process.exit(0);
}
if (args[0] === 'doctor' || args[0] === 'update') {
  console.log('ok');
  process.exit(0);
}
if (args[0] !== 'exec') {
  console.error('unexpected fake codex args ' + JSON.stringify(args));
  process.exit(2);
}
const outIndex = args.indexOf('--output-last-message');
const out = outIndex >= 0 ? args[outIndex + 1] : '';
if (!out) {
  console.error('missing --output-last-message');
  process.exit(2);
}
const promptArg = args.at(-1) ?? '';
const prompt = promptArg === '-' ? readFileSync(0, 'utf8') : promptArg;
mkdirSync(dirname(out), { recursive: true });
if (prompt.includes('Run as the Thinkless planner-diff agent')) {
  const artifact = [
    '## GOAL.md',
    '',
    '# GOAL',
    '',
    '## Bottleneck Review',
    '- Repeated S1 only reread GOAL/PLAN and remote drift evidence. The plan lacked an active concrete repair or instrumentation substep, so executor kept refusing to mutate files.',
    '',
    '## PLAN.md',
    '',
    '# PLAN',
    '',
    '- [x] S1 Diagnose remote state before activating the concrete repair <!-- status:done iter:2 -->',
    '  - Bottleneck: repeated status-only receipts proved this step was too vague.',
    '',
    '## Bottleneck Review',
    '- S1 produced repeated no-progress receipts. Close it and activate a concrete bounded instrumentation step instead of asking the user to intervene.',
    '',
    '- [ ] S2 Add targeted instrumentation after no-progress loop',
    '  - Action: add the narrow instrumentation or evidence-gathering change needed to test the next hypothesis.',
    '  - Validation: run one targeted trace and report the raw evidence path.',
    '',
    '## ASSUMPTIONS.md',
    '',
    '# Assumptions',
    '',
    '- Repeated no-progress receipts should trigger planner bottleneck review before human escalation.'
  ].join('\\n');
  writeFileSync(out, artifact + '\\n');
  console.log(JSON.stringify({ type: 'agent_message', text: artifact }));
  process.exit(0);
}
if (prompt.includes('Supervisor receipt focus: S2') || prompt.includes('S2 Add targeted instrumentation after no-progress loop')) {
  const result = {
    step_done: true,
    tests_pass: true,
    notes: 'Completed S2 targeted instrumentation after planner bottleneck review and recorded the raw evidence path.',
    changed_files: ['src/main.cpp'],
    next: null
  };
  writeFileSync(out.replace(/\\.txt$/, '.json'), JSON.stringify(result, null, 2) + '\\n');
  writeFileSync(out, result.notes + '\\n');
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } }));
  process.exit(0);
}
const result = {
  step_done: true,
  tests_pass: false,
  notes: 'Re-read GOAL.md and PLAN.md. PLAN marks S1 active; S1a and S1b remain pending/inactive. Remote drift check succeeded. No files were changed because PLAN has not activated the concrete repair.',
  changed_files: [],
  next: null
};
writeFileSync(out.replace(/\\.txt$/, '.json'), JSON.stringify(result, null, 2) + '\\n');
writeFileSync(out, result.notes + '\\n');
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'message' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
process.exit(0);
`
  );
  await chmod(path, 0o755);
  await writeFile(join(fakeBin, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex" %*\r\n');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
