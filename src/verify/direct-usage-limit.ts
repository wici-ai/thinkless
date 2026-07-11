import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { crashFailureSignature, isToolUsageLimitFailure, toolUsageLimitReason } from '../supervisor/agentFailure.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/direct-usage-limit-target');
const fakeBin = resolve('fixture/direct-usage-limit-bin');

async function main(): Promise<void> {
  verifyFailureClassification();
  await createSampleTarget(target, true);
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFakeAgents();
  const paths = runPaths(target);
  await writeFile(paths.plan, '# PLAN\n\n- [ ] S1 Stop once when Codex quota is exhausted\n');

  const oldPath = process.env.PATH;
  const oldTarget = process.env.WICI_FAKE_TARGET;
  const oldAutoUpdate = process.env.WICI_AUTO_UPDATE_TOOLS;
  process.env.PATH = `${fakeBin}${delimiter}${oldPath ?? ''}`;
  process.env.WICI_FAKE_TARGET = target;
  process.env.WICI_AUTO_UPDATE_TOOLS = '0';
  try {
    const result = await runSupervisor({
      target,
      goal: 'Pause on an agent usage limit without manufacturing crash iterations.',
      maxIters: 20,
      mode: 'real'
    });
    assert(result.state === 'STOP' && result.reason.includes('usage limit'), `usage limit must pause instead of fail/retry: ${JSON.stringify(result)}`);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTarget === undefined) delete process.env.WICI_FAKE_TARGET;
    else process.env.WICI_FAKE_TARGET = oldTarget;
    if (oldAutoUpdate === undefined) delete process.env.WICI_AUTO_UPDATE_TOOLS;
    else process.env.WICI_AUTO_UPDATE_TOOLS = oldAutoUpdate;
  }

  const invocations = Number(await readFile(join(paths.stateDir, 'usage-limit-invocations.txt'), 'utf8'));
  assert(invocations === 1, `usage limit should make one executor attempt, got ${invocations}`);
  const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
  assert(ledger.length === 0, `quota exhaustion is not a coding iteration and must not pollute ledger: ${JSON.stringify(ledger)}`);
  const events = await readJsonLines<RunEvent>(paths.events);
  assert(events.filter((event) => event.type === 'TOOL_USAGE_LIMIT_STOP').length === 1, `missing single usage-limit stop event: ${JSON.stringify(events)}`);
  assert(!events.some((event) => event.type === 'EXECUTE_RECOVERABLE_FAILURE' || event.type === 'FAILED'), 'usage limit must not enter recoverable-crash or FAILED paths');
  const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
  assert(checkpoint.supervisor_state === 'STOP' && checkpoint.iter === 0, `usage-limit checkpoint must stay retryable at the same iteration: ${JSON.stringify(checkpoint)}`);
  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('- [ ] S1'), `usage-limit stop must leave the step pending for explicit resume:\n${plan}`);

  console.log(JSON.stringify({ ok: true, usage_limit_pauses_once: true, crash_ids_normalized: true, ledger_rows: ledger.length }, null, 2));
}

function verifyFailureClassification(): void {
  const first = '{"type":"error","message":"You\'ve hit your usage limit. Visit settings or try again at 10:02 PM.","thread_id":"019f46e8-4511-7c90-a457-09de8aeaab3a"}';
  const second = '{"type":"error","message":"You\'ve hit your usage limit. Visit settings or try again at 10:02 PM.","thread_id":"019f46ec-c58f-78c2-ae3b-dccd9e7f5e89"}';
  assert(isToolUsageLimitFailure(first), 'Codex usage-limit message was not classified');
  assert(toolUsageLimitReason(first).includes('usage limit'), 'usage-limit reason should retain the actionable message');
  assert(crashFailureSignature(first) === crashFailureSignature(second), 'ephemeral thread ids must not defeat crash-loop fingerprints');
}

async function writeFakeAgents(): Promise<void> {
  const codex = join(fakeBin, 'codex');
  await writeFile(
    codex,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.999.0'); process.exit(0); }
if (args[0] === 'doctor' || args[0] === 'update') { console.log('ok'); process.exit(0); }
const state = join(process.env.WICI_FAKE_TARGET, '.thinkless');
const countPath = join(state, 'usage-limit-invocations.txt');
const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) || 0 : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify({ type: 'thread.started', thread_id: '019f46e8-4511-7c90-a457-09de8aeaab3a' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'error', message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:02 PM." }));
console.log(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:02 PM." } }));
process.exit(1);
`
  );
  await chmod(codex, 0o755);
  await writeFile(join(fakeBin, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex" %*\r\n');

  const claude = join(fakeBin, 'claude');
  await writeFile(claude, '#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("2.1.999"); else console.log("ok");\n');
  await chmod(claude, 0o755);
  await writeFile(join(fakeBin, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude" %*\r\n');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  await main();
} finally {
  await rm(target, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
}
